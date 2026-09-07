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
