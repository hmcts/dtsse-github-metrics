import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { migrate, migrationsDirectory } from "../../src/evidence/store/migrate.ts";

const SCRATCH = "github_metrics_migrate_test";

function administrativeUrl(): string {
  const url = new URL(process.env.DATABASE_URL ?? "postgresql://hmcts@localhost:5432/github_metrics");
  url.pathname = "/postgres";
  return url.toString();
}

function scratchUrl(): string {
  const url = new URL(process.env.DATABASE_URL ?? "postgresql://hmcts@localhost:5432/github_metrics");
  url.pathname = `/${SCRATCH}`;
  return url.toString();
}

async function administer(statement: string): Promise<void> {
  const client = new pg.Client({ connectionString: administrativeUrl() });
  await client.connect();
  try {
    await client.query(statement);
  } finally {
    await client.end();
  }
}

async function tableNames(): Promise<string[]> {
  const client = new pg.Client({ connectionString: scratchUrl() });
  await client.connect();
  try {
    const { rows } = await client.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name"
    );
    return rows.map((row) => row.table_name);
  } finally {
    await client.end();
  }
}

describe("migrate", () => {
  const original = process.env.DATABASE_URL;

  beforeAll(async () => {
    await administer(`DROP DATABASE IF EXISTS "${SCRATCH}"`);
    await administer(`CREATE DATABASE "${SCRATCH}"`);
    process.env.DATABASE_URL = scratchUrl();
  });

  afterAll(async () => {
    if (original === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = original;
    }
    await administer(`DROP DATABASE IF EXISTS "${SCRATCH}"`);
  });

  it("should create every table when the database is empty", async () => {
    const applied = await migrate();

    expect(applied.length).toBeGreaterThan(0);
    expect(await tableNames()).toEqual([
      "_prisma_migrations",
      "alert_observations",
      "collection_state",
      "cve_findings",
      "cve_scans",
      "direct_commit_facts",
      "org_people",
      "org_repositories",
      "org_team_memberships",
      "org_team_repositories",
      "org_teams",
      "pull_request_facts",
      "repository_notes",
      "repository_ownership",
      "repository_production",
      "repository_state",
      "security_alert_scans",
      "security_alerts",
      "sonar_project_map",
      "source_coverage"
    ]);
  });

  it("should apply nothing on a second run", async () => {
    expect(await migrate()).toEqual([]);
  });

  it("should record each migration in the ledger Prisma reads", async () => {
    const client = new pg.Client({ connectionString: scratchUrl() });
    await client.connect();
    try {
      const { rows } = await client.query<{ migration_name: string; checksum: string; finished: boolean }>(
        `SELECT migration_name, checksum, finished_at IS NOT NULL AS finished FROM "_prisma_migrations" ORDER BY migration_name`
      );

      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.finished).toBe(true);
        expect(row.checksum).toMatch(/^[0-9a-f]{64}$/);
      }
    } finally {
      await client.end();
    }
  });
});

describe("migrate on a database already up to date", () => {
  const original = process.env.DATABASE_URL;
  let directory: string;

  beforeAll(async () => {
    await administer(`DROP DATABASE IF EXISTS "${SCRATCH}"`);
    await administer(`CREATE DATABASE "${SCRATCH}"`);
    process.env.DATABASE_URL = scratchUrl();
    await migrate();
    directory = await mkdtemp(path.join(tmpdir(), "migrations-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    if (original === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = original;
    }
    await rm(directory, { recursive: true, force: true });
    await administer(`DROP DATABASE IF EXISTS "${SCRATCH}"`);
  });

  it("should roll back a migration that fails, name it, and leave it out of the ledger", async () => {
    await mkdir(path.join(directory, "29991231000000_broken"));
    await writeFile(path.join(directory, "29991231000000_broken", "migration.sql"), "CREATE TABLE half_made (id int); SELECT no_such_function();");

    await expect(migrate(directory)).rejects.toThrow(/^migration 29991231000000_broken failed: /);

    const client = new pg.Client({ connectionString: scratchUrl() });
    await client.connect();
    try {
      const { rows } = await client.query(`SELECT 1 FROM "_prisma_migrations" WHERE migration_name = '29991231000000_broken'`);
      expect(rows).toEqual([]);
      expect(await tableNames()).not.toContain("half_made");
    } finally {
      await client.end();
    }
  });

  it("should still finish when the unlock fails, since closing the session releases the lock", async () => {
    const query = pg.Client.prototype.query;
    vi.spyOn(pg.Client.prototype, "query").mockImplementation(function (this: pg.Client, ...args: unknown[]) {
      if (typeof args[0] === "string" && args[0].startsWith("SELECT pg_advisory_unlock")) {
        return Promise.reject(new Error("the server went away"));
      }
      return (query as (...rest: unknown[]) => unknown).apply(this, args);
    } as never);

    await expect(migrate(migrationsDirectory())).resolves.toEqual([]);
  });
});

describe("migrate waiting for the database", () => {
  const original = process.env.DATABASE_URL;

  afterAll(() => {
    if (original === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = original;
    }
  });

  it("should retry a refused connection while the database is still starting", async () => {
    process.env.DATABASE_URL = "postgresql://hmcts:hmcts@127.0.0.1:1/never_listening";
    let waits = 0;

    await expect(
      migrate(migrationsDirectory(), async () => {
        waits += 1;
        if (waits > 2) {
          throw new Error("stop waiting");
        }
      })
    ).rejects.toThrow();

    expect(waits).toBeGreaterThan(1);
  });

  it("should wait its own retry interval and try again when the default pause applies", async () => {
    // The default pause is a real two seconds, so this is the one case that spends it. The first refusal is
    // stated rather than produced by a closed port, so the second attempt meets the real database.
    process.env.DATABASE_URL = original ?? "postgresql://hmcts@localhost:5432/github_metrics";
    vi.spyOn(pg.Client.prototype, "connect").mockRejectedValueOnce(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }));
    vi.spyOn(pg.Client.prototype, "end").mockRejectedValueOnce(new Error("never connected"));
    vi.spyOn(console, "info").mockImplementation(() => undefined);

    try {
      await expect(migrate(migrationsDirectory())).resolves.toEqual([]);
      expect(console.info).toHaveBeenCalledWith("waiting for the database: connect ECONNREFUSED");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("should fail immediately when the database answers with a refusal of its own", async () => {
    const url = new URL(original ?? "postgresql://hmcts@localhost:5432/github_metrics");
    url.pathname = "/no_such_database_here";
    process.env.DATABASE_URL = url.toString();
    const pause = vi.fn<(ms: number) => Promise<void>>();

    await expect(migrate(migrationsDirectory(), pause)).rejects.toThrow();

    expect(pause).not.toHaveBeenCalled();
  });
});
