import pg from "pg";
import { resolveDatabaseUrl } from "./database-url.ts";

/**
 * Making sure only ONE collector writes the database at a time, wherever it is running from.
 *
 * AAT runs this application on two clusters — `cft-aat-00` and `cft-aat-01` — and both mount the same
 * `dtsse-aat` Key Vault, so both resolve the same `POSTGRES_*` and the same GitHub App installation. Two
 * clusters, one database, one rate-limit budget. `concurrencyPolicy: Forbid` does not help: it prevents a
 * CronJob overlapping ITSELF in ONE cluster, and says nothing about its twin next door.
 *
 * What two concurrent collectors actually do, which is worse than duplicated work:
 *
 *   - The GitHub budget is per INSTALLATION. A full `collect` is about 15,500 calls against 15,000 core and
 *     12,500 GraphQL an hour, so one run fits and two do not. Both degrade to partial and the estate ends up
 *     less well collected than if one had run alone.
 *   - Each run stamps `observedAt` at its own start instant. If the later-starting run commits first, the other
 *     tries to close a row at an instant BEFORE it was observed, which `<table>_interval_ordered` rejects.
 *   - The live-row partial unique indexes catch two writers inserting one key — as a unique violation, which
 *     rolls back the whole `$transaction`. A colliding run therefore writes no graph at all.
 *   - `collection_state` is a single row. Both stamp it, last write wins, and `collected_at` can end up
 *     reporting the earlier run's completion so the staleness notice reads wrong.
 *
 * This was previously prevented by SUSPENDING the CronJob on one cluster by hand. That worked, but the chart
 * never sets `suspend`, so Helm does not manage the field and the decision lived only in the cluster — invisible
 * to git, unexplained, and undone by anyone who re-enabled it. Worse, it does not generalise: a new collector
 * (the organisation walk) arrives enabled on both clusters and nobody remembers why the old one was not.
 *
 * So the constraint is enforced where it can be checked instead. `pg_try_advisory_lock` is the same mechanism
 * `migrate.ts` already uses for the same reason — several pods booting at once must not apply migrations
 * together — and it needs no per-cluster configuration to be correct.
 */

/**
 * Distinct from `migrate.ts`'s key, so a collection and a migration do not exclude each other.
 *
 * A pod boots `migrate` and then serves; a CronJob collects. Sharing one key would make a long collection block
 * a deployment's migration step, which is a different problem than the one this solves.
 */
const COLLECTOR_LOCK_KEY = 0x636f6c6c_6563746fn;

/** What a run learns when it asks to be the collector. */
export interface CollectorLock {
  /** Whether this run holds the lock. `false` means another collector is mid-run. */
  held: boolean;
  /** Releases the lock and closes the connection. Safe to call when the lock was not held. */
  release: () => Promise<void>;
}

/**
 * Takes the collector lock, or reports that somebody else has it.
 *
 * A DEDICATED CONNECTION, not the Prisma pool, and that is the whole reason this file exists rather than a
 * one-line query. A session-scoped advisory lock lives on the connection that took it, and Prisma hands
 * connections back to the pool between queries — so the lock could be released the moment an unrelated query
 * reused that connection, or held indefinitely by a pooled connection nobody is using. `migrate.ts` opens its
 * own `pg.Client` for exactly this reason.
 *
 * `pg_try_advisory_lock` rather than `pg_advisory_lock`: the point is to find out and get on with it, not to
 * queue. Two collectors waiting on each other would both then run against a spent rate limit.
 */
export async function takeCollectorLock(): Promise<CollectorLock> {
  const client = new pg.Client({ connectionString: resolveDatabaseUrl() });
  await client.connect();

  try {
    const result = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1) AS locked", [COLLECTOR_LOCK_KEY.toString()]);
    const held = result.rows[0]?.locked === true;
    return {
      held,
      release: async () => {
        if (held) {
          await client.query("SELECT pg_advisory_unlock($1)", [COLLECTOR_LOCK_KEY.toString()]).catch(() => undefined);
        }
        await client.end().catch(() => undefined);
      }
    };
  } catch (error) {
    await client.end().catch(() => undefined);
    throw error;
  }
}

/**
 * Runs `collect` only if this process is the one collector, and says so plainly when it is not.
 *
 * `undefined` means somebody else is collecting. The caller reports that as SUCCESS rather than failure, and
 * that is deliberate: on an estate where both clusters run the same schedule, one of them loses every single
 * day. Exiting non-zero would raise an alert every day for a system working exactly as designed, and an alert
 * that always fires is one nobody reads.
 */
export async function asSoleCollector<T>(run: () => Promise<T>): Promise<T | undefined> {
  const lock = await takeCollectorLock();
  try {
    if (!lock.held) {
      return undefined;
    }
    return await run();
  } finally {
    await lock.release();
  }
}
