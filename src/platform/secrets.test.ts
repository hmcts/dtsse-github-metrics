import { readFileSync } from "node:fs";
import yaml from "js-yaml";
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

/**
 * THE FOUR BLOCKS A CronJob IS USELESS WITHOUT, asserted against the chart this repository deploys.
 *
 * Written because dropping one is a silent failure and not a build one. `sonarJob` lost its `keyVaults`,
 * `environment`, `activeDeadlineSeconds` and `ttlSecondsAfterFinished` in a conflict resolution and went on being
 * scheduled every Monday with no credentials: it failed, the CronJob history recorded it, and nothing said so until
 * somebody went looking. Helm raises nothing — a job chart given no `keyVaults` renders a perfectly valid Pod with
 * no vault mounted, which is why this is asserted here rather than left to the render.
 *
 * THE VALUES FILE IS PARSED AND NOT SEARCHED, because a key present somewhere in 380 lines of YAML is a different
 * claim from a key present on the right block. Every CronJob block is found by structure, so one added later is
 * covered from the moment it exists rather than when somebody remembers to add it here.
 */
describe("the deployed chart's CronJobs", () => {
  const values = yaml.load(readFileSync(CHART_PATH, "utf8")) as Record<string, Record<string, unknown>>;

  /** Every block that renders a CronJob: the `job` dependency and each alias of it. `nodejs` is the web pod. */
  const jobs = Object.entries(values).filter(([name, block]) => (name === "job" || name.endsWith("Job")) && typeof block === "object");

  it("should find every CronJob block the chart declares", () => {
    // Guards the filter above rather than the chart. A rename that stopped matching would leave every case below
    // iterating an empty list, which is how a test like this stops testing without ever failing.
    expect(jobs.map(([name]) => name).sort()).toEqual(["alertJob", "cveJob", "job", "orgJob", "sonarJob"]);
  });

  it.each(jobs)("should mount the dtsse vault for %s, so the run has credentials at all", (_name, block) => {
    const secrets = (block.keyVaults as { dtsse?: { secrets?: { alias?: string }[] } } | undefined)?.dtsse?.secrets;
    expect(secrets).toBeDefined();
    // Named rather than counted, because a block that had lost only the App credentials would still carry a
    // plausible-looking list of five Postgres parts.
    const aliases = (secrets ?? []).map((secret) => secret.alias);
    expect(aliases).toContain("POSTGRES_HOST");
    expect(aliases).toContain("POSTGRES_PASSWORD");
    expect(aliases).toContain("GH_APP_PRIVATE_KEY");
  });

  it.each(jobs)("should set the environment for %s, without which the config path and the heap ceiling are unset", (_name, block) => {
    const environment = block.environment as Record<string, string> | undefined;
    expect(environment?.NODE_CONFIG_ENV).toBeDefined();
    expect(environment?.METRICS_CONFIG).toBeDefined();
    expect(environment?.NODE_OPTIONS).toMatch(/--max-old-space-size=\d+/);
  });

  it.each(jobs)("should bound %s in time, so a wedged run cannot hold the collector lock indefinitely", (_name, block) => {
    expect(block.activeDeadlineSeconds).toBeTypeOf("number");
    expect(block.ttlSecondsAfterFinished).toBeTypeOf("number");
  });

  it.each(jobs)("should keep %s's heap ceiling inside its memory limit", (_name, block) => {
    const options = (block.environment as Record<string, string | undefined>).NODE_OPTIONS ?? "";
    const ceiling = Number(/--max-old-space-size=(\d+)/.exec(options)?.[1]);
    const limit = Number(/^(\d+)Gi$/.exec(String(block.memoryLimits))?.[1]) * 1024;
    // STRICTLY INSIDE, and this chart has been bitten twice by the alternative: a ceiling at or above the limit
    // leaves V8 still declining to collect at the point the kernel has already killed the container.
    expect(ceiling).toBeLessThan(limit);
  });

  it.each(
    jobs.filter(([, block]) => block.devmemoryLimits !== undefined)
  )("should keep %s's dev memory keys in step with the pair devMode ignores", (_name, block) => {
    // `library/templates/v2/_container.tpl` reads one pair or the other and never both, and the CNP pipeline
    // installs the `-staging` release with `global.devMode`. A dev pair left at the chart default is a pod that
    // OOMs in staging alone, which is where that was first found.
    expect(block.devmemoryLimits).toEqual(block.memoryLimits);
    expect(block.devmemoryRequests).toEqual(block.memoryRequests);
  });
});
