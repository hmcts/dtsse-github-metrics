import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { migrate, migrationsDirectory } from "../../src/evidence/store/migrate.ts";

/**
 * That the deployed image can bring an empty database up to the schema.
 *
 * This is the path a preview takes: Helm creates a Postgres with nothing in it, and the web pod's entry point
 * migrates before the server starts. It was worth a test because the failure it guards against is silent — every
 * probe reports UP while every page is an error, since readiness asks whether Postgres answers, not whether it
 * has any tables.
 *
 * Against its own scratch database rather than the shared one, so it can assert on a genuinely empty start
 * without destroying the fixtures the other integration tests build.
 */

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
    // `migrate` resolves its own connection from the environment, which is how the deployed image reaches it.
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
      "direct_commit_facts",
      "pull_request_facts",
      "repository_state",
      "sonar_project_map",
      "source_coverage"
    ]);
  });

  it("should apply nothing on a second run", async () => {
    // The web pod migrates on every start, so the restart case has to cost nothing and change nothing.
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
        // A sha256 in hex, which is what Prisma's own migration engine stores — a shorter or differently
        // encoded digest would make `prisma migrate status` report the migration as modified.
        expect(row.checksum).toMatch(/^[0-9a-f]{64}$/);
      }
    } finally {
      await client.end();
    }
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
    // Nothing listens on this port, so every attempt is refused. What is asserted is that it kept trying rather
    // than exiting on the first refusal — the behaviour that stops a fresh deploy restarting its web pod.
    process.env.DATABASE_URL = "postgresql://hmcts:hmcts@127.0.0.1:1/never_listening";
    let waits = 0;

    await expect(
      migrate(migrationsDirectory(), async () => {
        waits += 1;
        if (waits > 2) {
          // Stand in for the deadline, so the test does not spend two minutes proving the point.
          throw new Error("stop waiting");
        }
      })
    ).rejects.toThrow();

    expect(waits).toBeGreaterThan(1);
  });

  it("should fail immediately when the database answers with a refusal of its own", async () => {
    // A database that does not exist is not one that is starting up: Postgres is listening and has answered. That
    // has to fail at once, because retrying it for two minutes would turn a clear misconfiguration into a slow
    // one. Built from `original` rather than from whatever the previous test left in the environment.
    const url = new URL(original ?? "postgresql://hmcts@localhost:5432/github_metrics");
    url.pathname = "/no_such_database_here";
    process.env.DATABASE_URL = url.toString();
    const pause = vi.fn<(ms: number) => Promise<void>>();

    await expect(migrate(migrationsDirectory(), pause)).rejects.toThrow();

    expect(pause).not.toHaveBeenCalled();
  });
});
