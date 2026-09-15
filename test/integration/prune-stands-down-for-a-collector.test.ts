import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXIT_COMPLETE } from "../../src/cli/exit-status.ts";
import { main } from "../../src/cli/index.ts";
import { resolveDatabaseUrl } from "../../src/evidence/store/database-url.ts";

/**
 * `prune` is the only command that deletes, and until 2026-09-15 it was the only one that ran unlocked.
 *
 * A hand-run prune alongside a collection is not a tidy-up: it deletes rows the run is midway through writing.
 * `collect` and `collect-org` have taken the collector advisory lock since AAT started running this application
 * on two clusters against one database; this asserts that `prune` now takes the same one, at the level where
 * the decision lives — the CLI dispatch.
 *
 * WRITTEN AGAINST A REAL LOCK AND A REAL DATABASE, with one process standing in for the collector, because a
 * stubbed lock would only prove that a fake returned what it was told to — and what has to hold is that the
 * seeded row this prune would otherwise have deleted is still there afterwards.
 *
 * `pg` rather than the Prisma singleton for the assertions: `main` disconnects the client in its `finally`, so
 * a query through it after the run is a query through a closed pool.
 */

const ORGANIZATION = "prune-stand-down-test";

/** Older than any cut-off the case below asks for, so an unlocked prune would take it. */
const ANCIENT = new Date(Date.UTC(2020, 0, 1));

const client = new pg.Client({ connectionString: resolveDatabaseUrl() });

async function seed(): Promise<void> {
  await client.query(
    `INSERT INTO source_coverage (organization, repository, source, query_hash, starts_at, ends_at, accessed_at)
     VALUES ($1, 'cath-service', 'pull_requests', 'stand-down', $2, $3, $2)`,
    [ORGANIZATION, ANCIENT, new Date(Date.UTC(2020, 1, 1))]
  );
  await client.query(
    `INSERT INTO pull_request_facts (organization, repository, query_hash, identifier, merged_at, payload)
     VALUES ($1, 'cath-service', 'stand-down', 101, $2, '{"number": 11}'::jsonb)`,
    [ORGANIZATION, new Date(Date.UTC(2020, 0, 15))]
  );
}

async function wipe(): Promise<void> {
  await client.query("DELETE FROM source_coverage WHERE organization = $1", [ORGANIZATION]);
  await client.query("DELETE FROM pull_request_facts WHERE organization = $1", [ORGANIZATION]);
}

beforeAll(async () => {
  await client.connect();
  await wipe();
  await seed();
});

afterAll(async () => {
  await wipe();
  await client.end();
});

describe("the prune command", () => {
  it("should stand down and delete nothing while a collector holds the lock", async () => {
    // ONE `main` CALL IN THIS FILE, deliberately: it disconnects Prisma when it returns, so a second run would
    // be reporting on a closed pool rather than on the lock. That `prune` DOES delete stale rows when it holds
    // the lock is asserted directly against `pruneCache` in prune-never-touches-durable.test.ts.
    const collector = await takeTheLockAsSomebodyElse();

    try {
      expect(await main(["prune", "--config", "metrics.yaml", "--days", "1"])).toBe(EXIT_COMPLETE);
    } finally {
      await collector.end();
    }

    const coverage = await client.query("SELECT 1 FROM source_coverage WHERE organization = $1", [ORGANIZATION]);
    const facts = await client.query("SELECT 1 FROM pull_request_facts WHERE organization = $1", [ORGANIZATION]);
    expect(coverage.rowCount).toBe(1);
    expect(facts.rowCount).toBe(1);
  });
});

/**
 * The second cluster's collector, as one connection holding the session-scoped lock.
 *
 * The key is `collector-lock.ts`'s, restated rather than exported: a test that reached for the module's own
 * constant would pass if the constant changed on both sides at once, and what this stands in for is a DIFFERENT
 * process — which shares only the number.
 */
async function takeTheLockAsSomebodyElse(): Promise<pg.Client> {
  const collector = new pg.Client({ connectionString: resolveDatabaseUrl() });
  await collector.connect();
  const { rows } = await collector.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1) AS locked", [0x636f_6c6c_6563_746fn.toString()]);
  expect(rows[0]?.locked).toBe(true);
  return collector;
}
