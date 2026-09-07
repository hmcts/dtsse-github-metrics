import { getPropertiesVolumeSecrets, MonitoringService } from "@hmcts-cft/cloud-native-platform";
import { EXIT_COMPLETE, EXIT_FAILED } from "./exit-status.ts";
import { main } from "./index.ts";

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
