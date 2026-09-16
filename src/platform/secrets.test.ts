import { afterEach, describe, expect, it, vi } from "vitest";
import { CHART_PATH, KEY_VAULT_OPT_IN, keyVaultAllowed, loadSecrets } from "./secrets.ts";

const DEPLOYED = {
  POSTGRES_HOST: "dtsse-github-metrics.postgres.database.azure.com",
  POSTGRES_PORT: "5432",
  POSTGRES_USER: "hmcts",
  POSTGRES_PASSWORD: "a-vault-password",
  POSTGRES_DATABASE: "github_metrics"
};

function captureLog() {
  const lines: string[] = [];
  const record = (message: string) => {
    lines.push(message);
  };
  vi.spyOn(console, "info").mockImplementation(record);
  vi.spyOn(console, "warn").mockImplementation(record);
  return lines;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("keyVaultAllowed", () => {
  it("should read the vault in production, which is what the runtime image sets", () => {
    expect(keyVaultAllowed({ NODE_ENV: "production" })).toBe(true);
  });

  it("should not read the vault in development", () => {
    // The whole defect: `yarn dev` resolved `dtsse-aat` and attached to the production estate.
    expect(keyVaultAllowed({ NODE_ENV: "development" })).toBe(false);
  });

  it("should read the vault in development when asked exactly", () => {
    expect(keyVaultAllowed({ NODE_ENV: "development", [KEY_VAULT_OPT_IN]: "true" })).toBe(true);
  });

  it.each(["", "false", "TRUE", "1", "yes"])(`should not read the vault for ${KEY_VAULT_OPT_IN}=%s`, (value) => {
    // Anything but the exact string is a typo, and a typo must not attach a laptop to production.
    expect(keyVaultAllowed({ NODE_ENV: "development", [KEY_VAULT_OPT_IN]: value })).toBe(false);
  });

  it("should treat an unset NODE_ENV as local", () => {
    // The direction that refuses production rather than reaching for it.
    expect(keyVaultAllowed({})).toBe(false);
  });

  it("should not let the opt-in disarm the deployed path", () => {
    // The pods and both CronJobs depend on this: nothing set in a chart may stop them reading their secrets.
    expect(keyVaultAllowed({ NODE_ENV: "production", [KEY_VAULT_OPT_IN]: "false" })).toBe(true);
  });
});

describe("loadSecrets", () => {
  it("should read the chart's secret list in production", async () => {
    captureLog();
    const read = vi.fn().mockResolvedValue(undefined);

    await loadSecrets(read, { NODE_ENV: "production" });

    expect(read).toHaveBeenCalledWith(CHART_PATH);
  });

  it("should not read anything in development, and should say why", async () => {
    const lines = captureLog();
    const read = vi.fn().mockResolvedValue(undefined);

    await loadSecrets(read, { NODE_ENV: "development" });

    expect(read).not.toHaveBeenCalled();
    expect(lines.join("\n")).toContain(`${KEY_VAULT_OPT_IN}=true is not set`);
  });

  it("should name the database it resolved, whether or not the vault was read", async () => {
    const lines = captureLog();

    await loadSecrets(vi.fn(), { NODE_ENV: "development" });

    expect(lines).toContain("database: localhost:5432/github_metrics");
  });

  it("should name the mounted database, because the line is written after the secrets are read", async () => {
    // The ordering that makes the line worth having: it reports what the pool will use, not what was set before.
    const lines = captureLog();
    const env: Record<string, string | undefined> = { NODE_ENV: "production" };
    const read = vi.fn().mockImplementation(async () => {
      Object.assign(env, DEPLOYED);
    });

    await loadSecrets(read, env);

    expect(lines).toContain(`database: ${DEPLOYED.POSTGRES_HOST}:5432/github_metrics`);
  });

  it("should never write the credential to the log", async () => {
    const lines = captureLog();

    await loadSecrets(vi.fn(), { NODE_ENV: "production", ...DEPLOYED });

    expect(lines.join("\n")).not.toContain(DEPLOYED.POSTGRES_PASSWORD);
  });

  it("should say what an unset NODE_ENV was, rather than leave a gap in the line", async () => {
    const lines = captureLog();

    await loadSecrets(vi.fn(), {});

    expect(lines.join("\n")).toContain("NODE_ENV is unset");
  });

  it("should report a thrown non-error too, because a rejection is not always an Error", async () => {
    const lines = captureLog();

    await loadSecrets(vi.fn().mockRejectedValue("ENOENT"), { NODE_ENV: "production" });

    expect(lines.join("\n")).toContain("ENOENT");
  });

  it("should forgive a vault that will not answer, and still report the database", async () => {
    // A pod whose mount is missing must serve its health check and say what it has, not fail to start.
    const lines = captureLog();
    const read = vi.fn().mockRejectedValue(new Error("no such directory /mnt/secrets/dtsse"));

    await loadSecrets(read, { NODE_ENV: "production" });

    expect(lines.join("\n")).toContain("no such directory /mnt/secrets/dtsse");
    expect(lines).toContain("database: localhost:5432/github_metrics");
  });
});
