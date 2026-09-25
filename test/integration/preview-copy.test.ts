import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applied, migrate, migrationNames, migrationsDirectory } from "../../src/evidence/store/migrate.ts";
import { resetSchema, scrubSecretScanning } from "../../src/preview/database.ts";

const SCRATCH = "github_metrics_preview_copy_test";

function urlFor(database: string): string {
  const url = new URL(process.env.DATABASE_URL ?? "postgresql://hmcts@localhost:5432/github_metrics");
  url.pathname = `/${database}`;
  return url.toString();
}

async function administer(statement: string): Promise<void> {
  const client = new pg.Client({ connectionString: urlFor("postgres") });
  await client.connect();
  try {
    await client.query(statement);
  } finally {
    await client.end();
  }
}

const noPause = async () => undefined;

describe("the preview copy's statements", () => {
  let client: pg.Client;

  beforeAll(async () => {
    await administer(`DROP DATABASE IF EXISTS "${SCRATCH}"`);
    await administer(`CREATE DATABASE "${SCRATCH}"`);
    client = new pg.Client({ connectionString: urlFor(SCRATCH) });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
    await administer(`DROP DATABASE IF EXISTS "${SCRATCH}"`);
  });

  beforeEach(async () => {
    await resetSchema(client);
    await migrate(migrationsDirectory(), noPause, urlFor(SCRATCH));
  });

  it("should leave an empty public schema when the schema is reset", async () => {
    await resetSchema(client);

    const { rows } = await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'");
    expect(rows).toEqual([]);
  });

  it("should apply every migration to the connection it is given, whatever POSTGRES_* says", async () => {
    await resetSchema(client);
    const mounted = { POSTGRES_HOST: "must-not-be-used.invalid", POSTGRES_PORT: "5432", POSTGRES_USER: "x", POSTGRES_PASSWORD: "x", POSTGRES_DATABASE: "x" };
    Object.assign(process.env, mounted);

    try {
      const names = await migrate(migrationsDirectory(), noPause, urlFor(SCRATCH));

      expect(names).toEqual(await migrationNames(migrationsDirectory()));
      expect([...(await applied(client))].sort()).toEqual(names);
    } finally {
      for (const name of Object.keys(mounted)) {
        delete process.env[name];
      }
    }
  });

  it("should blank only secret-scanning locations, and keep what the pages grade on", async () => {
    await client.query(
      `INSERT INTO security_alert_scans (organization, repository, family, state, observed_at)
       VALUES ('hmcts', 'a', 'secret-scanning', 'read', now()), ('hmcts', 'a', 'code-scanning', 'read', now()),
              ('hmcts', 'a', 'dependabot', 'read', now())`
    );
    await client.query(
      `INSERT INTO security_alerts (organization, repository, family, alert_number, alert_type, state, resolution, created_at, resolved_at, path, line, html_url)
       VALUES ('hmcts', 'a', 'secret-scanning', 1, 'azure_storage_key', 'resolved', 'revoked', '2026-01-01', '2026-01-02', 'src/key.ts', 3, 'https://github.com/hmcts/a/security/secret-scanning/1'),
              ('hmcts', 'a', 'secret-scanning', 2, 'github_pat', 'open', NULL, '2026-01-03', NULL, NULL, NULL, 'https://github.com/hmcts/a/security/secret-scanning/2'),
              ('hmcts', 'a', 'code-scanning', 1, 'js/xss', 'open', NULL, '2026-01-01', NULL, 'src/page.ts', 9, 'https://github.com/hmcts/a/security/code-scanning/1'),
              ('hmcts', 'a', 'dependabot', 1, 'GHSA-x', 'open', NULL, '2026-01-01', NULL, 'package.json', NULL, 'https://github.com/hmcts/a/security/dependabot/1')`
    );

    const result = await scrubSecretScanning(client);

    expect(result).toEqual({ scrubbed: 2, secretScanningRows: 2 });
    const { rows } = await client.query(
      `SELECT family, alert_type, state, resolution, created_at IS NOT NULL AS dated, path, line, html_url
         FROM security_alerts ORDER BY family, alert_number`
    );
    expect(rows).toEqual([
      {
        family: "code-scanning",
        alert_type: "js/xss",
        state: "open",
        resolution: null,
        dated: true,
        path: "src/page.ts",
        line: 9,
        html_url: expect.any(String)
      },
      {
        family: "dependabot",
        alert_type: "GHSA-x",
        state: "open",
        resolution: null,
        dated: true,
        path: "package.json",
        line: null,
        html_url: expect.any(String)
      },
      {
        family: "secret-scanning",
        alert_type: "azure_storage_key",
        state: "resolved",
        resolution: "revoked",
        dated: true,
        path: null,
        line: null,
        html_url: null
      },
      { family: "secret-scanning", alert_type: "github_pat", state: "open", resolution: null, dated: true, path: null, line: null, html_url: null }
    ]);
  });

  it("should fail rather than report a scrub when there is no table to scrub", async () => {
    await resetSchema(client);

    await expect(scrubSecretScanning(client)).rejects.toThrow(/security_alerts/);
  });
});
