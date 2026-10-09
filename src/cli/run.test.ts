import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXIT_COMPLETE, EXIT_FAILED, EXIT_INCOMPLETE } from "./exit-status.ts";

const main = vi.hoisted(() => vi.fn<() => Promise<number>>());
const loadSecrets = vi.hoisted(() => vi.fn(async (read: (chartPath: string) => unknown) => read("/chart")));
const getPropertiesVolumeSecrets = vi.hoisted(() => vi.fn());
const monitoring = vi.hoisted(() => ({
  constructed: [] as string[][],
  fail: undefined as unknown,
  trackMetric: vi.fn(),
  trackEvent: vi.fn(),
  trackException: vi.fn(),
  flush: vi.fn(async () => undefined)
}));

vi.mock("@hmcts-cft/cloud-native-platform", () => ({
  getPropertiesVolumeSecrets,
  MonitoringService: class {
    trackMetric = monitoring.trackMetric;
    trackEvent = monitoring.trackEvent;
    trackException = monitoring.trackException;
    flush = monitoring.flush;
    constructor(connectionString: string, role: string) {
      if (monitoring.fail !== undefined) {
        throw monitoring.fail;
      }
      monitoring.constructed.push([connectionString, role]);
    }
  }
}));
vi.mock("../platform/secrets.ts", () => ({ loadSecrets }));

/**
 * The command's module, recording the `POSTGRES_HOST` it saw when it was evaluated — which is when
 * `store/prisma.ts` would resolve its connection string. Registered with `vi.doMock` in `runCli` rather than
 * `vi.mock`, whose factory result outlives `vi.resetModules` and so would be evaluated once for the whole file.
 */
const index = { evaluatedWith: undefined as string | undefined };
function indexModule() {
  index.evaluatedWith = process.env.POSTGRES_HOST;
  return { main };
}

const originalArgv = process.argv;

async function runCli(): Promise<number> {
  const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  vi.resetModules();
  vi.doMock("./index.ts", indexModule);
  await import("./run.ts");
  await vi.waitFor(() => expect(exit).toHaveBeenCalled());
  return exit.mock.calls[0]?.[0] as number;
}

beforeEach(() => {
  index.evaluatedWith = undefined;
  monitoring.constructed = [];
  monitoring.fail = undefined;
  process.argv = ["node", "run.ts", "collect"];
});

afterEach(() => {
  process.argv = originalArgv;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("run", () => {
  it("should load the secrets through the volume reader before the command runs", async () => {
    vi.stubEnv("APPLICATIONINSIGHTS_CONNECTION_STRING", "");
    main.mockResolvedValue(EXIT_COMPLETE);

    expect(await runCli()).toBe(EXIT_COMPLETE);
    expect(getPropertiesVolumeSecrets).toHaveBeenCalledWith({ chartPath: "/chart", failOnError: false });
    expect(monitoring.constructed).toEqual([]);
  });

  it("should load the command's module only once the secrets are in the environment", async () => {
    // A static import would evaluate it during run.ts's own imports, and Prisma would take the fallback connection
    // string. Stubbed first so that the value the secrets set is restored afterwards.
    vi.stubEnv("POSTGRES_HOST", undefined);
    vi.stubEnv("APPLICATIONINSIGHTS_CONNECTION_STRING", "");
    loadSecrets.mockImplementationOnce(async () => {
      process.env.POSTGRES_HOST = "from-vault";
    });
    main.mockResolvedValue(EXIT_COMPLETE);

    await runCli();

    expect(index.evaluatedWith).toBe("from-vault");
  });

  it("should report the exit status and duration of a complete run", async () => {
    vi.stubEnv("APPLICATIONINSIGHTS_CONNECTION_STRING", "InstrumentationKey=abc");
    main.mockResolvedValue(EXIT_COMPLETE);

    expect(await runCli()).toBe(EXIT_COMPLETE);
    expect(monitoring.constructed).toEqual([["InstrumentationKey=abc", "dtsse-github-metrics-collector"]]);
    expect(monitoring.trackMetric).toHaveBeenCalledWith("collector.exit_status", EXIT_COMPLETE, { command: "collect" });
    expect(monitoring.trackMetric).toHaveBeenCalledWith("collector.duration_ms", expect.any(Number), { command: "collect" });
    expect(monitoring.trackEvent).not.toHaveBeenCalled();
    expect(monitoring.flush).toHaveBeenCalled();
  });

  it("should record an incomplete run as an event", async () => {
    vi.stubEnv("APPLICATIONINSIGHTS_CONNECTION_STRING", "InstrumentationKey=abc");
    main.mockResolvedValue(EXIT_INCOMPLETE);

    expect(await runCli()).toBe(EXIT_INCOMPLETE);
    expect(monitoring.trackEvent).toHaveBeenCalledWith("collector.incomplete", { command: "collect", status: String(EXIT_INCOMPLETE) });
  });

  it("should name the command none when none was given", async () => {
    vi.stubEnv("APPLICATIONINSIGHTS_CONNECTION_STRING", "InstrumentationKey=abc");
    process.argv = ["node", "run.ts"];
    main.mockResolvedValue(EXIT_COMPLETE);

    await runCli();
    expect(monitoring.trackMetric).toHaveBeenCalledWith("collector.exit_status", EXIT_COMPLETE, { command: "none" });
  });

  it("should run without telemetry when Application Insights will not start", async () => {
    vi.stubEnv("APPLICATIONINSIGHTS_CONNECTION_STRING", "not-a-connection-string");
    monitoring.fail = new Error("invalid connection string");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    main.mockResolvedValue(EXIT_COMPLETE);

    expect(await runCli()).toBe(EXIT_COMPLETE);
    expect(warn).toHaveBeenCalledWith("could not start Application Insights: invalid connection string");
    expect(monitoring.trackMetric).not.toHaveBeenCalled();
  });

  it("should exit failed and report the exception when the command throws", async () => {
    vi.stubEnv("APPLICATIONINSIGHTS_CONNECTION_STRING", "InstrumentationKey=abc");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const error = new Error("database unreachable");
    main.mockRejectedValue(error);

    expect(await runCli()).toBe(EXIT_FAILED);
    expect(stderr).toHaveBeenCalledWith(`${error.stack}\n`);
    expect(monitoring.trackException).toHaveBeenCalledWith(error, { command: "collect" });
    expect(monitoring.trackMetric).toHaveBeenCalledWith("collector.exit_status", EXIT_FAILED, { command: "collect" });
    expect(monitoring.flush).toHaveBeenCalled();
  });

  it("should print the message of an error that has no stack", async () => {
    vi.stubEnv("APPLICATIONINSIGHTS_CONNECTION_STRING", "");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const error = new Error("no stack here");
    error.stack = undefined;
    main.mockRejectedValue(error);

    expect(await runCli()).toBe(EXIT_FAILED);
    expect(stderr).toHaveBeenCalledWith("no stack here\n");
  });

  it("should wrap a thrown value that is not an Error", async () => {
    vi.stubEnv("APPLICATIONINSIGHTS_CONNECTION_STRING", "InstrumentationKey=abc");
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    main.mockRejectedValue("a bare string");

    expect(await runCli()).toBe(EXIT_FAILED);
    expect(monitoring.trackException).toHaveBeenCalledWith(expect.objectContaining({ message: "a bare string" }), { command: "collect" });
  });
});
