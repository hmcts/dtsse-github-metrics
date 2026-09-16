import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { applyDatabaseUrl } from "./database-url.ts";
import { PrismaClient } from "./generated/client.js";

/**
 * The one Prisma client, and behind it the one connection pool, that a process is allowed to hold.
 *
 * RESOLVED AT MODULE LOAD AND DELIBERATELY NOT INSIDE `connect`. `cli/run.ts` and `instrumentation.ts` both
 * defer their import of this module until `platform/secrets.ts` has settled where the secrets come from, on the
 * strength of this line running when the module loads: neither chart injects `POSTGRES_*`, they mount the vault as
 * files, so the variables exist only once `getPropertiesVolumeSecrets` has set them. Moving the resolution into
 * the factory would make those two orderings look unnecessary while a pod that got them wrong failed silently,
 * which is the bug those comments were written for.
 *
 * Outside production that decision is to read nothing and leave the compose default standing, which is the same
 * ordering seen from the other side: what must not happen is this line running before the answer is known.
 */
const connectionString = applyDatabaseUrl();

/**
 * What one pod may hold open, stated here rather than inherited from `pg`.
 *
 * `max` IS THE ONLY ONE OF THE THREE THAT WAS ALREADY IN EFFECT, at `pg`'s default of 10 — and raising or
 * lowering it was NOT the fix for the pool count. A cap applies per pool, so two pools capped at ten held
 * twenty connections between them just as two uncapped ones did; the count only comes down because the pool
 * below is built once per process. The number is unchanged from the default on purpose, so this change moves
 * the number of pools and nothing else.
 *
 * `idleTimeoutMillis` returns a connection the estate is not using: the dashboard is read in bursts and warmed
 * on a poll, so a pool that grew to its cap during one collection would otherwise hold every slot until the pod
 * rolled. `connectionTimeoutMillis` is what makes an exhausted pool FAIL rather than hang — without it a
 * checkout waits for ever, and a page that never responds is indistinguishable from one that is merely slow.
 */
const POOL = {
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  /** So `pg_stat_activity` attributes a connection to this service rather than leaving the column blank. */
  application_name: "dtsse-github-metrics"
} as const;

/**
 * How long an interactive transaction may take, and how long it may wait to start.
 *
 * STATED HERE BECAUSE NOTHING STATED IT ANYWHERE, which meant Prisma's default five-second `timeout` and
 * two-second `maxWait` applied to all seven `$transaction` calls in this codebase. `org-graph.ts` records what
 * that default did in a real cluster: `collect-org` failed on every scheduled run from 2026-09-09 because one
 * touch pass took 8.7 s, as a throw that `--tolerate-partial` could not rescue, so the graph simply stopped
 * being collected. The fix there was a faster statement, and the same is true of the fact writes — but a
 * ceiling nothing declares is a ceiling the estate grows into silently, and the failure it produces is total
 * rather than slow.
 *
 * THE NUMBERS ARE CHOSEN AGAINST THE WRITE THIS IS THE SAFETY NET FOR, and are a net rather than a budget.
 * Every transaction here should finish in tens of milliseconds: `cachePullRequestFacts` is now one
 * `INSERT … ON CONFLICT` plus the four coverage statements, and the graph writers are one `unnest` per table.
 *
 *   `timeout: 30_000` is six times the default, and roughly three times the 8.7 s pass that broke `collect-org`
 *   at 3,399 repositories — so the next growth increment is a slow run rather than a lost one. It is not
 *   larger because a transaction still open after thirty seconds is holding row locks a concurrent reader waits
 *   behind, and `prune` deletes under this same client; a run that has stopped making progress should fail
 *   where somebody can read the error rather than block the estate.
 *
 *   `maxWait: 10_000` is the pool's own `connectionTimeoutMillis` above, and deliberately the same number: both
 *   are "how long may a caller wait for a connection", and two different answers to one question would make an
 *   exhausted pool fail with whichever timer happened to be shorter. Prisma's two-second default is under the
 *   pool's, which turns a momentary burst — the warmer's spans against a collection's writes — into a
 *   transaction that never opened.
 *
 * A `timeout` this raises is not a licence to loop: `facts.ts` says what belongs inside these transactions,
 * which is one statement rather than one per row.
 */
const TRANSACTION = {
  timeout: 30_000,
  maxWait: 10_000
} as const;

/**
 * The client, on `globalThis` rather than in this module's scope, and CACHED IN EVERY ENVIRONMENT.
 *
 * A `globalThis` singleton for the reason `report/cache.ts` is one, and the reason is production rather than
 * development. Next bundles this module graph twice — the pages get an `ssr/` copy and `instrumentation.ts`
 * gets its own, which `store/facts.ts` documents from a live data bug and `report/cache.ts` from a warming one.
 * Each copy runs this file, so a client built in module scope is a client per copy, and a `pg.Pool` per copy
 * with it: at least twenty server connections per pod against a `max` of ten, multiplied by the replicas across
 * both clusters. That was the 2026-09-15 readiness outage.
 *
 * The guard here used to be `NODE_ENV !== "production"`, which cached in the environment where a reload is the
 * problem and not in the one where a second pool is. The development reload it was written for still works:
 * caching unconditionally is a superset of caching outside production, so a fresh module after an edit finds
 * the client the previous one left rather than opening another pool per keystroke.
 *
 * The POOL IS BUILT INSIDE the resolution, which is the half that a cache alone would not have fixed — the
 * previous shape constructed one at module scope whatever the guard then decided about the client.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

globalForPrisma.prisma ??= new PrismaClient({
  adapter: new PrismaPg(new pg.Pool({ connectionString, ...POOL })),
  transactionOptions: TRANSACTION,
  log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"]
});

export const prisma: PrismaClient = globalForPrisma.prisma;

export type { PrismaClient } from "./generated/client.js";
