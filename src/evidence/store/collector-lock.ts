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
 *   - The GitHub budget is per INSTALLATION, against 15,000 core and 12,500 GraphQL an hour. This used to be
 *     the decisive reason: a full `collect` was about 15,500 calls, so one run fitted and two did not. It is
 *     the WEAKEST reason now — the estate-wide reads brought a run well inside one hour's budget, so two would
 *     no longer exhaust it. The two below are unaffected by that and are on their own sufficient.
 *   - Each run stamps `observedAt` at its own start instant. If the later-starting run commits first, the other
 *     tries to close a row at an instant BEFORE it was observed, which `<table>_interval_ordered` rejects.
 *   - The live-row partial unique indexes catch two writers inserting one key — as a unique violation, which
 *     rolls back the whole `$transaction`. A colliding run therefore writes no graph at all.
 *   - `collection_state` is a single row. Both stamp it, last write wins, and `collected_at` can end up
 *     reporting the earlier run's completion so the staleness notice reads wrong.
 *
 * WHICH OF THE TWO CLUSTERS COLLECTS IS ALREADY DECIDED IN GIT, and this lock is not what decides it. The `job`
 * chart emits `suspend: {{ not $activeCronCluster }}` on every CronJob it renders, and cnp-flux-config injects
 * `global.activeCronCluster` into every HelmRelease from a value defined on `aat/00` alone. `kubectl get cronjob
 * -n dtsse` shows the result: `SUSPEND=false` for both collectors on `cft-aat-00-aks`, `true` for both on
 * `cft-aat-01-aks`. Helm does manage `suspend`, the platform sets it, and a new collector added to this chart
 * inherits the same guarantee without declaring anything.
 *
 * WHAT THAT MECHANISM DOES NOT COVER, and what this lock is for: TWO RELEASES IN ONE CLUSTER. Every master build
 * installs a throwaway `-staging` release into the same `dtsse` namespace as the persistent one, on the same
 * `activeCronCluster`, so both sets of CronJobs unsuspend together — which is how duplicate collectors were
 * actually observed. `values.aat.template.yaml` disables them there, but that is a value anybody can flip in a
 * release that lives for minutes, and these are the real credentials and the real database.
 *
 * So the constraint is also enforced where it can be checked, by the writer itself rather than by a value being
 * right. `pg_try_advisory_lock` is the same mechanism `migrate.ts` already uses for the same reason — several
 * pods booting at once must not apply migrations together — and it needs no per-cluster configuration.
 */

/**
 * Distinct from `migrate.ts`'s key, so a collection and a migration do not exclude each other.
 *
 * A pod boots `migrate` and then serves; a CronJob collects. Sharing one key would make a long collection block
 * a deployment's migration step, which is a different problem than the one this solves.
 */
const COLLECTOR_LOCK_KEY = 0x636f_6c6c_6563_746fn;

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
