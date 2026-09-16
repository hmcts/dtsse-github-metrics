import { describe, expect, it } from "vitest";
import { applyDatabaseUrl, describeDatabase, LOCAL_DATABASE_URL, resolveDatabaseUrl } from "./database-url.ts";

const MOUNTED = {
  POSTGRES_HOST: "dtsse-github-metrics.postgres.database.azure.com",
  POSTGRES_PORT: "5432",
  POSTGRES_USER: "hmcts",
  POSTGRES_PASSWORD: "a-vault-password",
  POSTGRES_DATABASE: "github_metrics"
};

describe("resolveDatabaseUrl", () => {
  it("should assemble the mounted parts, requiring TLS as the flexible server does", () => {
    expect(resolveDatabaseUrl(MOUNTED)).toBe(`postgresql://hmcts:a-vault-password@${MOUNTED.POSTGRES_HOST}:5432/github_metrics?sslmode=require`);
  });

  it.each(Object.keys(MOUNTED))("should fall back where %s is missing, rather than assemble half a URL", (missing) => {
    expect(resolveDatabaseUrl({ ...MOUNTED, [missing]: undefined })).toBe(LOCAL_DATABASE_URL);
  });

  it("should prefer an explicit DATABASE_URL over the compose default, which is how a test points at a scratch database", () => {
    expect(resolveDatabaseUrl({ DATABASE_URL: "postgresql://hmcts@localhost:5432/scratch" })).toBe("postgresql://hmcts@localhost:5432/scratch");
  });

  it("should prefer the mounted parts over an explicit DATABASE_URL", () => {
    expect(resolveDatabaseUrl({ ...MOUNTED, DATABASE_URL: "postgresql://hmcts@localhost:5432/scratch" })).toContain(MOUNTED.POSTGRES_HOST);
  });
});

describe("applyDatabaseUrl", () => {
  it("should set the variable Prisma's own client reads", () => {
    const env: Record<string, string | undefined> = { ...MOUNTED };

    expect(applyDatabaseUrl(env)).toBe(env.DATABASE_URL);
    expect(env.DATABASE_URL).toContain(MOUNTED.POSTGRES_HOST);
  });
});

describe("describeDatabase", () => {
  it("should name the mounted host, port and database", () => {
    expect(describeDatabase(MOUNTED)).toBe(`${MOUNTED.POSTGRES_HOST}:5432/github_metrics`);
  });

  it("should never carry the credential, wherever the parts came from", () => {
    // This is written to stdout, which ships to App Insights from a pod.
    expect(describeDatabase(MOUNTED)).not.toContain(MOUNTED.POSTGRES_PASSWORD);
    expect(describeDatabase({ DATABASE_URL: "postgresql://hmcts:a-password@localhost:5432/github_metrics" })).toBe("localhost:5432/github_metrics");
  });

  it("should describe the compose default where nothing is set, which is what `yarn dev` gets", () => {
    expect(describeDatabase({})).toBe("localhost:5432/github_metrics");
  });

  it("should assume the standard port where a URL omits it", () => {
    expect(describeDatabase({ DATABASE_URL: "postgresql://hmcts@localhost/github_metrics" })).toBe("localhost:5432/github_metrics");
  });

  it("should report an unparseable URL as unrecognised rather than guess at it", () => {
    // A description is only worth printing if it is right.
    expect(describeDatabase({ DATABASE_URL: "the vault said so" })).toBe("an unrecognised database target");
  });

  it.each([
    ["an IPv6 literal", "postgresql://hmcts@[::1]:5432/github_metrics"],
    ["a URL with no host", "postgresql:///github_metrics"],
    ["a database name that is a path", "postgresql://localhost:5432/github/metrics"],
    ["a database name carrying anything escaped", "postgresql://localhost:5432/github metrics"]
  ])("should withhold %s, which does not read as a host, a port and a database", (_what, url) => {
    expect(describeDatabase({ DATABASE_URL: url })).toBe("an unrecognised database target");
  });

  it("should withhold a mounted host that is not one either, wherever it came from", () => {
    // The check is on the way out and not on one branch: `POSTGRES_HOST` is as much an environment value.
    expect(describeDatabase({ ...MOUNTED, POSTGRES_HOST: "host with spaces and a\nnewline" })).toBe("an unrecognised database target");
  });
});
