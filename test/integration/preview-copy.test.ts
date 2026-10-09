import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { applied, migrate, migrationNames, migrationsDirectory } from "../../src/evidence/store/migrate.ts";
import { connectPreview, resetSchema, scrubSecretScanning } from "../../src/preview/database.ts";
import { dumpSource, PREVIEW_SERVER_HOST, previewTarget } from "../../src/preview/target.ts";

/**
 * The preview server exists only in Azure, so a client addressed to it is sent to the local server instead, and
 * every PR's database to the one PR database made here. What the redirect cannot change is the name the server
 * reports back, which is the check `connectPreview` makes — a PR number other than 1 therefore lands somewhere
 * other than where it asked to, exactly as a misrouted connection would.
 */
vi.mock("pg", async (importOriginal) => {
  const actual = (await importOriginal<{ default: typeof import("pg") }>()).default;
  class Client extends actual.Client {
    constructor(config: pg.ClientConfig) {
      const requested = new URL(config.connectionString ?? "postgresql://localhost");
      if (requested.hostname !== "dtsse-preview.postgres.database.azure.com") {
        super(config);
        return;
      }
      const local = new URL(process.env.DATABASE_URL ?? "postgresql://hmcts@localhost:5432/github_metrics");
      local.pathname = "/dtsse-github-metrics-pr-1";
      super({ ...config, connectionString: local.toString() });
    }
  }
  return { default: { ...actual, Client } };
});

const SCRATCH = "github_metrics_preview_copy_test";
const PREVIEW_DATABASE = "dtsse-github-metrics-pr-1";

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

const SOURCE = dumpSource({
  AAT_POSTGRES_HOST: "dtsse-aat.postgres.database.azure.com",
  AAT_POSTGRES_PORT: "5432",
  AAT_POSTGRES_USER: "reader",
  AAT_POSTGRES_PASSWORD: "secret",
  AAT_POSTGRES_DATABASE: "github_metrics"
});

function target(changeId: string) {
  return previewTarget({ HOST: PREVIEW_SERVER_HOST, PORT: "5432", USER: "writer", PASSWORD: "secret" }, changeId, SOURCE);
}

/** The client, with `answer` deciding a statement's result; a statement it returns `undefined` for reaches the server. */
function answering(client: pg.Client, answer: (text: string) => Promise<unknown> | undefined): void {
  const original = client.query.bind(client) as (text: string) => Promise<unknown>;
  vi.spyOn(client, "query").mockImplementation(((text: string) => answer(text) ?? original(text)) as never);
}

describe("connectPreview", () => {
  beforeAll(async () => {
    await administer(`DROP DATABASE IF EXISTS "${PREVIEW_DATABASE}" WITH (FORCE)`);
    await administer(`CREATE DATABASE "${PREVIEW_DATABASE}"`);
  });

  afterAll(async () => {
    await administer(`DROP DATABASE IF EXISTS "${PREVIEW_DATABASE}" WITH (FORCE)`);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should hand back a client connected to the PR's own database", async () => {
    const client = await connectPreview(target("1"));

    try {
      const { rows } = await client.query<{ database: string }>("SELECT current_database() AS database");
      expect(rows).toEqual([{ database: PREVIEW_DATABASE }]);
    } finally {
      await client.end();
    }
  });

  it("should refuse a connection that landed in another database, and close it", async () => {
    const end = vi.spyOn(pg.Client.prototype, "end");

    await expect(connectPreview(target("2"))).rejects.toThrow(`connected to ${PREVIEW_DATABASE}, expected dtsse-github-metrics-pr-2`);
    expect(end).toHaveBeenCalledOnce();
  });

  it("should refuse a server that names no database, even where closing the client then fails", async () => {
    const close = pg.Client.prototype.end as (this: pg.Client) => Promise<void>;
    vi.spyOn(pg.Client.prototype, "query").mockResolvedValueOnce({ rows: [] } as never);
    vi.spyOn(pg.Client.prototype, "end").mockImplementationOnce(async function (this: pg.Client) {
      await close.call(this);
      throw new Error("already closed");
    });

    await expect(connectPreview(target("1"))).rejects.toThrow("connected to no database, expected dtsse-github-metrics-pr-1");
  });
});

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

  it("should roll the drop back when the schema cannot be recreated", async () => {
    answering(client, (text) => (text === "CREATE SCHEMA public" ? Promise.reject(new Error("permission denied")) : undefined));

    try {
      await expect(resetSchema(client)).rejects.toThrow("permission denied");
    } finally {
      vi.restoreAllMocks();
    }

    const { rows } = await client.query("SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'security_alerts'");
    expect(rows).toHaveLength(1);
  });

  it("should roll the scrub back when a location survives it", async () => {
    await client.query(
      `INSERT INTO security_alert_scans (organization, repository, family, state, observed_at) VALUES ('hmcts', 'a', 'secret-scanning', 'read', now())`
    );
    await client.query(
      `INSERT INTO security_alerts (organization, repository, family, alert_number, alert_type, state, created_at, path)
       VALUES ('hmcts', 'a', 'secret-scanning', 1, 'github_pat', 'open', '2026-01-01', 'src/key.ts')`
    );
    answering(client, (text) => (text.includes("count(*)") ? Promise.resolve({ rows: [{ total: "1", located: "1" }] }) : undefined));

    try {
      await expect(scrubSecretScanning(client)).rejects.toThrow("1 secret-scanning alerts still carry a location after the scrub");
    } finally {
      vi.restoreAllMocks();
    }

    const { rows } = await client.query("SELECT path FROM security_alerts");
    expect(rows).toEqual([{ path: "src/key.ts" }]);
  });

  it("should refuse to call a scrub done when the count comes back empty", async () => {
    answering(client, (text) => (text.includes("count(*)") ? Promise.resolve({ rows: [] }) : undefined));

    try {
      await expect(scrubSecretScanning(client)).rejects.toThrow("an unknown number of secret-scanning alerts still carry a location after the scrub");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("should report zero for counts the server did not state", async () => {
    answering(client, (text) => {
      if (text.includes("count(*)")) {
        return Promise.resolve({ rows: [{ located: "0" }] });
      }
      return text.includes("UPDATE security_alerts") ? Promise.resolve({ rowCount: null, rows: [] }) : undefined;
    });

    try {
      await expect(scrubSecretScanning(client)).resolves.toEqual({ scrubbed: 0, secretScanningRows: 0 });
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("should fail rather than report a scrub when there is no table to scrub", async () => {
    await resetSchema(client);

    await expect(scrubSecretScanning(client)).rejects.toThrow(/security_alerts/);
  });
});
