import { createRequire } from "node:module";

type Platform = typeof import("@hmcts-cft/cloud-native-platform");

const load = createRequire(import.meta.url);

function platform(): Platform {
  return load("@hmcts-cft/cloud-native-platform") as Platform;
}

const CHART_PATH = "./charts/dtsse-github-metrics/values.yaml";

export async function register(): Promise<void> {
  await loadSecrets();
  startMonitoring();
  await startWarming();
}

async function loadSecrets(): Promise<void> {
  try {
    await platform().getPropertiesVolumeSecrets({ chartPath: CHART_PATH, failOnError: false });
  } catch (error) {
    console.warn(`could not load Key Vault secrets: ${error instanceof Error ? error.message : String(error)}`);
  }
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
 * connection string at MODULE LOAD, so anything reaching it before `loadSecrets` has run captures the local
 * compose default instead of the mounted `POSTGRES_*` — the pod would then warm against a database that is not
 * there while its health check, which connects later, passed. A dynamic import is what orders the two.
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
