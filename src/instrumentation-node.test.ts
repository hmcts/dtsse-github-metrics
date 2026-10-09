import { afterEach, describe, expect, it, vi } from "vitest";
import { registerNode } from "./instrumentation-node.ts";

const loadSecrets = vi.hoisted(() => vi.fn(async (read: (chartPath: string) => unknown) => read("/chart")));
const loadConfiguration = vi.hoisted(() => vi.fn(async (..._paths: string[]) => ({ teams: [] })));
const startReportWarmer = vi.hoisted(() => vi.fn());
const platform = vi.hoisted(() => ({
  getPropertiesVolumeSecrets: vi.fn(),
  constructed: [] as string[][],
  fail: undefined as unknown
}));

vi.mock("node:module", () => ({
  createRequire: () => (id: string) => {
    if (id !== "@hmcts-cft/cloud-native-platform") {
      throw new Error(`unexpected require of ${id}`);
    }
    return {
      getPropertiesVolumeSecrets: platform.getPropertiesVolumeSecrets,
      MonitoringService: class {
        constructor(connectionString: string, role: string) {
          if (platform.fail !== undefined) {
            throw platform.fail;
          }
          platform.constructed.push([connectionString, role]);
        }
      }
    };
  }
}));
vi.mock("./platform/secrets.ts", () => ({ loadSecrets }));
vi.mock("./evidence/policy/load.ts", () => ({ loadConfiguration }));
vi.mock("./evidence/report/warmer.ts", () => ({ startReportWarmer }));

afterEach(() => {
  platform.constructed = [];
  platform.fail = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("registerNode", () => {
  it("should read the secrets, start monitoring and start the warmer on the configured files", async () => {
    vi.stubEnv("APPLICATIONINSIGHTS_CONNECTION_STRING", "InstrumentationKey=abc");
    vi.stubEnv("METRICS_CONFIG", "metrics.yaml, local.yaml");

    await registerNode();

    expect(platform.getPropertiesVolumeSecrets).toHaveBeenCalledWith({ chartPath: "/chart", failOnError: false });
    expect(platform.constructed).toEqual([["InstrumentationKey=abc", "dtsse-github-metrics-web"]]);
    expect(loadConfiguration).toHaveBeenCalledWith("metrics.yaml", "local.yaml");
    expect(startReportWarmer).toHaveBeenCalledWith({ teams: [] });
  });

  it("should start the warmer only once the secrets are in the environment", async () => {
    // The warmer reaches Prisma, which resolves its connection string once; before the secrets it takes the
    // compose default. Stubbed first so that the value the secrets set is restored afterwards.
    vi.stubEnv("POSTGRES_HOST", undefined);
    vi.stubEnv("APPLICATIONINSIGHTS_CONNECTION_STRING", "");
    let seen: string | undefined;
    loadSecrets.mockImplementationOnce(async () => {
      process.env.POSTGRES_HOST = "from-vault";
    });
    loadConfiguration.mockImplementationOnce(async () => {
      seen = process.env.POSTGRES_HOST;
      return { teams: [] };
    });

    await registerNode();

    expect(seen).toBe("from-vault");
  });

  it("should skip monitoring without a connection string and default the configuration file", async () => {
    vi.stubEnv("APPLICATIONINSIGHTS_CONNECTION_STRING", "");
    vi.stubEnv("METRICS_CONFIG", undefined);

    await registerNode();

    expect(platform.constructed).toEqual([]);
    expect(loadConfiguration).toHaveBeenCalledWith("metrics.yaml");
  });

  it("should carry on when Application Insights will not start", async () => {
    vi.stubEnv("APPLICATIONINSIGHTS_CONNECTION_STRING", "not-a-connection-string");
    platform.fail = new Error("invalid connection string");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await registerNode();

    expect(warn).toHaveBeenCalledWith("could not start Application Insights: invalid connection string");
    expect(startReportWarmer).toHaveBeenCalled();
  });

  it("should carry on when the warmer cannot start", async () => {
    vi.stubEnv("APPLICATIONINSIGHTS_CONNECTION_STRING", "");
    loadConfiguration.mockRejectedValueOnce(new Error("metrics.yaml not found"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await registerNode();

    expect(warn).toHaveBeenCalledWith("could not start the report warmer: metrics.yaml not found");
    expect(startReportWarmer).not.toHaveBeenCalled();
  });
});
