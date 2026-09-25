import { createRequire } from "node:module";
import { loadSecrets } from "./platform/secrets.ts";

type Platform = typeof import("@hmcts-cft/cloud-native-platform");

const load = createRequire(import.meta.url);

function platform(): Platform {
  return load("@hmcts-cft/cloud-native-platform") as Platform;
}

/**
 * The web pod's start-up, reached only from the Node.js copy of `instrumentation.ts`, which says why it is a
 * module of its own.
 */
export async function registerNode(): Promise<void> {
  await readSecrets();
  startMonitoring();
  await startWarming();
}

/**
 * The deployed secrets, WHERE `platform/secrets.ts` ALLOWS THEM — outside production it takes an opt-in, and
 * this hook is the one `next dev` runs too.
 *
 * Only the platform call belongs here. The vault this resolves is `dtsse-aat`, which is the production estate
 * whether it is reached from a pod or from a laptop, so what decides whether to reach for it is shared with the
 * collector rather than written twice.
 */
async function readSecrets(): Promise<void> {
  await loadSecrets((chartPath) => platform().getPropertiesVolumeSecrets({ chartPath, failOnError: false }));
}

function startMonitoring(): void {
  const connectionString = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
  if (!connectionString) {
    return;
  }

  try {
    new (platform().MonitoringService)(connectionString, "dtsse-github-metrics-web");
  } catch (error) {
    console.warn(`could not start Application Insights: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Builds every span before the first reader asks, and again when a collection lands.
 *
 * IMPORTED HERE RATHER THAN AT THE TOP OF THE FILE, and that is load-bearing. `store/prisma.ts` resolves the
 * connection string at MODULE LOAD, so anything reaching it before `readSecrets` has finished captures the local
 * compose default instead of the mounted `POSTGRES_*` — the pod would then warm against a database that is not
 * there while its health check, which connects later, passed. A dynamic import is what orders the two.
 *
 * That holds whether or not the vault was read: what has to be settled first is the DECISION, and outside
 * production the decision is to leave the compose default in place. `platform/secrets.ts` holds it, and is
 * imported statically because it reads no `POSTGRES_*` of its own.
 *
 * What is awaited here is only STARTING the warmer, never the warm itself: `startReportWarmer` returns as soon
 * as the poll is scheduled, so the five builds run while the server is already accepting requests and a pod
 * comes ready on the schedule its startup probe expects rather than holding the boot open for them.
 */
async function startWarming(): Promise<void> {
  try {
    const { loadConfiguration } = await import("./evidence/policy/load.ts");
    const { startReportWarmer } = await import("./evidence/report/warmer.ts");
    const paths = (process.env.METRICS_CONFIG ?? "metrics.yaml").split(",").map((path) => path.trim());
    startReportWarmer(await loadConfiguration(...paths));
  } catch (error) {
    console.warn(`could not start the report warmer: ${error instanceof Error ? error.message : String(error)}`);
  }
}
