import { getPropertiesVolumeSecrets, MonitoringService } from "@hmcts-cft/cloud-native-platform";
import { EXIT_COMPLETE, EXIT_FAILED } from "./exit-status.ts";

const CHART_PATH = "./charts/dtsse-github-metrics/values.yaml";

async function startPlatform(): Promise<MonitoringService | undefined> {
  try {
    await getPropertiesVolumeSecrets({ chartPath: CHART_PATH, failOnError: false });
  } catch (error) {
    console.warn(`could not load Key Vault secrets: ${error instanceof Error ? error.message : String(error)}`);
  }

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
   * this file's own imports — before `startPlatform` had put anything in the environment. The CronJob is the half
   * that depends on that ordering: the `job` chart mounts the vault as FILES under /mnt/secrets and injects no
   * environment variables, so `POSTGRES_*` exists only once `getPropertiesVolumeSecrets` has read the mount.
   *
   * Observed in a real cluster before this moved: the collector authenticated to GitHub and made every call
   * successfully, then failed every cache read and write, because Prisma had already been handed the local
   * fallback connection string. The web pod was unaffected — the `nodejs` chart aliases its secrets straight into
   * the environment — which is exactly what made it look like a database problem rather than an ordering one.
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
