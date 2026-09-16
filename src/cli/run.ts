import { getPropertiesVolumeSecrets, MonitoringService } from "@hmcts-cft/cloud-native-platform";
import { loadSecrets } from "../platform/secrets.ts";
import { EXIT_COMPLETE, EXIT_FAILED } from "./exit-status.ts";

/**
 * The secrets, and then the telemetry, before anything reads either.
 *
 * THE VAULT IS OPT-IN OUTSIDE PRODUCTION, through the same guard the web pod uses — see `platform/secrets.ts`.
 * The CronJobs are unaffected: the runtime image sets `NODE_ENV=production`, so both of them still resolve
 * `dtsse-aat` and still get the GitHub App credentials that are the collector's alone.
 *
 * It matters more here than it does in the web pod. A local `yarn cli collect` was writing collected facts into
 * the production database, and `prune` DELETES from it — the same command against a compose stack is a scratch
 * database, and which of the two it was depended on nothing the command said.
 */
async function startPlatform(): Promise<MonitoringService | undefined> {
  await loadSecrets((chartPath) => getPropertiesVolumeSecrets({ chartPath, failOnError: false }));

  const connectionString = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
  if (!connectionString) {
    return undefined;
  }

  try {
    return new MonitoringService(connectionString, "dtsse-github-metrics-collector");
  } catch (error) {
    console.warn(`could not start Application Insights: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

async function run(): Promise<number> {
  const command = process.argv[2] ?? "none";
  const monitoring = await startPlatform();
  const startedAt = Date.now();

  /**
   * Imported HERE, after the secrets are loaded, and deliberately not at the top of the file.
   *
   * `store/prisma.ts` resolves its connection string at module scope, so a static import would run that during
   * this file's own imports — before `startPlatform` had put anything in the environment. Neither chart injects
   * `POSTGRES_*`: both mount the vault as FILES under /mnt/secrets, named after the alias, so those variables
   * exist only once `getPropertiesVolumeSecrets` has read the mount and set them.
   *
   * Observed in a real cluster before this moved: the collector authenticated to GitHub and made every call
   * successfully, then failed every cache read and write, because Prisma had already been handed the local
   * fallback connection string. The web pod was unaffected because Next.js awaits `instrumentation.ts`'s
   * `register()` before it loads any route module, so there the secrets are always in place first. This file is
   * the collector's equivalent of that hook, and the ordering has to be just as deliberate.
   */
  const { main } = await import("./index.ts");

  try {
    const status = await main();

    monitoring?.trackMetric("collector.exit_status", status, { command });
    monitoring?.trackMetric("collector.duration_ms", Date.now() - startedAt, { command });
    if (status !== EXIT_COMPLETE) {
      monitoring?.trackEvent("collector.incomplete", { command, status: String(status) });
    }
    return status;
  } catch (error) {
    const thrown = error instanceof Error ? error : new Error(String(error));
    process.stderr.write(`${thrown.stack ?? thrown.message}\n`);
    monitoring?.trackException(thrown, { command });
    monitoring?.trackMetric("collector.exit_status", EXIT_FAILED, { command });
    return EXIT_FAILED;
  } finally {
    await monitoring?.flush();
  }
}

run().then((status) => process.exit(status));
