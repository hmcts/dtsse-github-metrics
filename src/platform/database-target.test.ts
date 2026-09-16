import { describe, expect, it } from "vitest";
import { describeDatabase } from "./database-target.ts";

const MOUNTED = {
  POSTGRES_HOST: "dtsse-github-metrics.postgres.database.azure.com",
  POSTGRES_PORT: "5432",
  POSTGRES_USER: "hmcts",
  POSTGRES_PASSWORD: "a-vault-password",
  POSTGRES_DATABASE: "github_metrics"
};

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
