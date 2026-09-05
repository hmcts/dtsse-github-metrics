import type { CoverageKey, EvidenceSource, Interval, SourceCoverage } from "../domain/coverage.ts";
import { coalesceIntervals, findMissingIntervals, modalEdge } from "./intervals.ts";
import { prisma } from "./prisma.ts";
import { StorageError } from "./storage-error.ts";

/**
 * Reading and writing coverage intervals, ported from `metrics.storage`.
 *
 * The interval arithmetic lives in `./intervals.ts`; this module is the Postgres access around it.
 *
 * Where upstream relied on SQLite's single-writer lock and a single process, this port has a CronJob
 * writing while web pods read. `recordSourceCoverage` therefore takes a row lock on the coverage series
 * it is about to rewrite — see the comment there.
 */

/** Cached intervals for one repository source, in chronological order. */
export async function getSourceCoverage(key: CoverageKey): Promise<Interval[]> {
  try {
    const rows = await prisma.sourceCoverage.findMany({
      where: { organization: key.organization, repository: key.repository, source: key.source, queryHash: key.queryHash },
      orderBy: { startsAt: "asc" },
      select: { startsAt: true, endsAt: true }
    });
    return rows.map((row) => ({ startsAt: row.startsAt, endsAt: row.endsAt }));
  } catch (error) {
    throw new StorageError("could not read collection cache", error);
  }
}

/** The uncovered portions of one requested interval. */
export async function findMissingCoverage(requested: SourceCoverage): Promise<SourceCoverage[]> {
  const covered = await getSourceCoverage(requested);
  return findMissingIntervals(requested, covered).map((interval) => ({ ...requested, ...interval }));
}

/**
 * Stores successful coverage, coalescing overlapping or adjacent intervals.
 *
 * Read-all, coalesce, delete, insert — upstream's shape, and lost-update-shaped if two writers
 * interleave. It runs inside a transaction that first takes `FOR UPDATE` on the series' existing rows,
 * so a concurrent collection of the same repository and source waits rather than computing its merge
 * from a snapshot this one is about to replace. Two DIFFERENT series never contend: the lock is scoped
 * to the four key columns.
 *
 * A `SERIALIZABLE` transaction with a retry would also do, but this states the intent at the row level
 * and cannot fail on an unrelated conflict.
 */
export async function recordSourceCoverage(coverage: SourceCoverage, accessedAt: Date = new Date()): Promise<void> {
  const { organization, repository, source, queryHash } = coverage;
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT 1 FROM source_coverage
        WHERE organization = ${organization} AND repository = ${repository} AND source = ${source} AND query_hash = ${queryHash}
        FOR UPDATE
      `;
      const existing = await tx.sourceCoverage.findMany({
        where: { organization, repository, source, queryHash },
        orderBy: { startsAt: "asc" },
        select: { startsAt: true, endsAt: true }
      });
      const merged = coalesceIntervals(existing, { startsAt: coverage.startsAt, endsAt: coverage.endsAt });
      await tx.sourceCoverage.deleteMany({ where: { organization, repository, source, queryHash } });
      await tx.sourceCoverage.createMany({
        data: merged.map((interval) => ({
          organization,
          repository,
          source,
          queryHash,
          startsAt: interval.startsAt,
          endsAt: interval.endsAt,
          accessedAt
        }))
      });
    });
  } catch (error) {
    throw new StorageError("could not update collection cache", error);
  }
}

/** Stamps a series as used, so `prune` can tell a live cache row from an abandoned one. */
export async function touchSourceCoverage(key: CoverageKey, accessedAt: Date = new Date()): Promise<void> {
  try {
    await prisma.sourceCoverage.updateMany({
      where: { organization: key.organization, repository: key.repository, source: key.source, queryHash: key.queryHash },
      data: { accessedAt }
    });
  } catch (error) {
    throw new StorageError("could not update collection cache", error);
  }
}

/**
 * The instant most of one organisation's cached coverage reaches, or `undefined` for none.
 *
 * The anchor an offline report ends its windows at. Collection records coverage up to the stable edge of
 * the run that wrote it, so a repository's own edge is the edge of the last run that reached it, and
 * `undefined` here means nothing has been collected under this signature at all.
 *
 * See `modalEdge` for why this is the modal edge rather than the greatest or the shared one.
 *
 * `queryHash` IS PART OF THE FILTER because `source_coverage` accumulates superseded signatures — the
 * working cache holds several pull-request signatures from older builds. Their rows are not coverage
 * this build can report from, and one of them reaching further ahead would set an anchor nothing
 * current covers.
 *
 * `accessedAt` is left alone: reading the edge is not a use of any interval, and stamping it here would
 * keep dead signatures alive against `prune` for ever.
 */
export async function prevailingCachedCoverage(organization: string, source: EvidenceSource, queryHash: string): Promise<Date | undefined> {
  try {
    const rows = await prisma.sourceCoverage.groupBy({
      by: ["repository"],
      where: { organization, source, queryHash },
      _max: { endsAt: true }
    });
    const edges = rows.map((row) => row._max.endsAt).filter((edge): edge is Date => edge !== null);
    return modalEdge(edges);
  } catch (error) {
    throw new StorageError("could not read collection cache", error);
  }
}
