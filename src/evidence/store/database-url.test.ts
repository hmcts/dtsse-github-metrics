import { describe, expect, it } from "vitest";
import { applyDatabaseUrl, LOCAL_DATABASE_URL, mountedDatabaseParts, resolveDatabaseUrl } from "./database-url.ts";

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

describe("mountedDatabaseParts", () => {
  it("should read the five parts the chart mounts", () => {
    expect(mountedDatabaseParts(MOUNTED)).toEqual({
      host: MOUNTED.POSTGRES_HOST,
      port: "5432",
      user: "hmcts",
      password: MOUNTED.POSTGRES_PASSWORD,
      database: "github_metrics"
    });
  });

  it.each(Object.keys(MOUNTED))("should answer nothing where %s is missing, so both callers agree on when a mount counts", (missing) => {
    expect(mountedDatabaseParts({ ...MOUNTED, [missing]: undefined })).toBeUndefined();
  });
});
