import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { applyDatabaseUrl } from "./database-url.ts";
import { PrismaClient } from "./generated/client.js";

/**
 * The one Prisma client, and behind it the one connection pool, that a process is allowed to hold.
 *
 * RESOLVED AT MODULE LOAD AND DELIBERATELY NOT INSIDE `connect`. `cli/run.ts` and `instrumentation.ts` both
 * defer their import of this module until after the properties volume has been read, on the strength of this
 * line running when the module loads: neither chart injects `POSTGRES_*`, they mount the vault as files, so the
 * variables exist only once `getPropertiesVolumeSecrets` has set them. Moving the resolution into the factory
 * would make those two orderings look unnecessary while a pod that got them wrong failed silently, which is the
 * bug those comments were written for.
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
  log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"]
});

export const prisma: PrismaClient = globalForPrisma.prisma;

export type { PrismaClient } from "./generated/client.js";
