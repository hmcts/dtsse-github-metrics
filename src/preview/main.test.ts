import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SOURCE_VARIABLES } from "./target.ts";

const loadAat = vi.hoisted(() => vi.fn());
const dependencies = vi.hoisted(() => ({ fake: true }));

vi.mock("./load-aat.ts", () => ({ loadAat }));
vi.mock("./processes.ts", () => ({ dependencies }));

async function runMain(): Promise<number> {
  const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  vi.resetModules();
  await import("./main.ts");
  await vi.waitFor(() => expect(exit).toHaveBeenCalled());
  return exit.mock.calls[0]?.[0] as number;
}

beforeEach(() => {
  vi.stubEnv("PG_CLIENT_IMAGE", "postgres:17");
  vi.stubEnv("KUBE_CONTEXT", undefined);
  vi.stubEnv(SOURCE_VARIABLES.host, "aat.postgres.example");
  vi.stubEnv(SOURCE_VARIABLES.password, "aat-password");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("preview:load-aat", () => {
  it("should fail without a client image", async () => {
    vi.stubEnv("PG_CLIENT_IMAGE", "");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(await runMain()).toBe(1);
    expect(error).toHaveBeenCalledWith("[preview:load-aat] PG_CLIENT_IMAGE is not set");
    expect(loadAat).not.toHaveBeenCalled();
  });

  it("should load AAT with the source taken out of this process's environment", async () => {
    loadAat.mockResolvedValue({});

    expect(await runMain()).toBe(0);
    const [options, deps] = loadAat.mock.calls[0] ?? [];
    expect(options).toMatchObject({
      image: "postgres:17",
      env: { [SOURCE_VARIABLES.host]: "aat.postgres.example", [SOURCE_VARIABLES.password]: "aat-password" }
    });
    expect(options).not.toHaveProperty("context");
    expect(deps).toBe(dependencies);
    expect(process.env[SOURCE_VARIABLES.password]).toBeUndefined();
    expect(process.env[SOURCE_VARIABLES.host]).toBeUndefined();
  });

  it("should pin every call to the kubeconfig context when one is given", async () => {
    vi.stubEnv("KUBE_CONTEXT", "cft-preview-01-aks");
    loadAat.mockResolvedValue({});

    expect(await runMain()).toBe(0);
    expect(loadAat.mock.calls[0]?.[0]).toMatchObject({ context: "cft-preview-01-aks" });
  });

  it("should exit failed with the reason when the load fails", async () => {
    loadAat.mockRejectedValue(new Error("refusing to restore onto AAT"));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(await runMain()).toBe(1);
    expect(error).toHaveBeenCalledWith("[preview:load-aat] FAILED: refusing to restore onto AAT");
  });
});
