import type { CoverageKey, EvidenceSource, Interval, SourceCoverage } from "../domain/coverage.ts";
import { midnight } from "../window/instant.ts";
import type { Prisma } from "./generated/client.js";
import { coalesceIntervals, findMissingIntervals, modalEdge } from "./intervals.ts";
import { prisma } from "./prisma.ts";
import { StorageError } from "./storage-error.ts";

/**
 * Reading and writing coverage intervals, ported from `metrics.storage`.
 *
 * The interval arithmetic lives in `./intervals.ts`; this module is the Postgres access around it.
 *
 * Where upstream relied on SQLite's single-writer lock and a single process, this port has a CronJob
 * writing while web pods read. `recordSourceCoverage` therefore takes an advisory lock on the coverage
 * series it is about to rewrite — see the comment there for why a row lock was not enough.
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
 * interleave. It runs inside a transaction that first locks the SERIES, so a concurrent collection of the
 * same repository and source waits rather than computing its merge from a snapshot this one is about to
 * replace. Two DIFFERENT series never contend: the lock is derived from the four key columns.
 *
 * A `SERIALIZABLE` transaction with a retry would also do, but this states the intent at the series level
 * and cannot fail on an unrelated conflict.
 *
 * COVERAGE ON ITS OWN, which is what the transaction here means. A caller that has just written FACTS must not
 * use this: the two writes have to commit together, so it joins the coverage write to its own transaction
 * through `recordSourceCoverageWithin` below.
 */
export async function recordSourceCoverage(coverage: SourceCoverage, accessedAt: Date = new Date()): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      await recordSourceCoverageWithin(tx, coverage, accessedAt);
    });
  } catch (error) {
    throw new StorageError("could not update collection cache", error);
  }
}

/**
 * The same write, joined to a transaction a caller has already opened.
 *
 * Exists so facts and the coverage row claiming them can commit TOGETHER — see the note at the top of
 * `facts.ts`. Two transactions leave a window in which the facts are visible and the coverage is not, which
 * under READ COMMITTED is enough for a `prune` running alongside to delete the facts and then have the
 * coverage insert commit a row saying the interval is covered. A covered interval with no facts reports as
 * zero merges rather than as a failure.
 *
 * It does NOT wrap its own errors: the caller's transaction owns the failure, and `cachePullRequestFacts`
 * already reports the whole write as "could not update collection cache".
 *
 * AN ADVISORY LOCK ON THE SERIES AND NOT `FOR UPDATE` ON ITS ROWS, from 2026-09-16. A row lock only exists for
 * rows that exist, so on the FIRST write of a series `FOR UPDATE` locked nothing: both writers proceeded, both
 * deleted nothing, both `createMany`, and because `starts_at` is in the primary key two non-identical intervals
 * both inserted — leaving the coalescing invariant broken with no error anywhere. Not a live bug today, because
 * `collect` holds the collector lock and walks repositories sequentially, but the guard above presents itself as
 * sound in general and it was not.
 *
 * `pg_advisory_xact_lock` locks the series whether or not a row for it exists, is released when the caller's
 * transaction ends — never left held by a crashed writer — and still never contends across different series:
 * `hashtextextended` over the four key columns, joined by a separator that cannot occur in any of them.
 *
 * U+0001 AND NOT THE NUL `org-graph.ts` JOINS ITS COMPOSITE KEYS WITH, because that key never leaves the
 * process and this one is a `text` parameter: PostgreSQL cannot hold a NUL in a text value at all and rejects
 * the statement with `invalid byte sequence for encoding "UTF8": 0x00`. U+0001 answers the same requirement —
 * a GitHub organisation or repository name, an `EvidenceSource` member and a hex digest can none of them
 * contain it — so `a\u0001b`/`c` and `a`/`b\u0001c` cannot be one key where a hyphen would make them one.
 * Written as the escape, for the reason that comment gives: a literal control byte makes the file binary to
 * git and grep. A hash collision between two unrelated series costs one of them a wait, and nothing else.
 */
export async function recordSourceCoverageWithin(tx: Prisma.TransactionClient, coverage: SourceCoverage, accessedAt: Date = new Date()): Promise<void> {
  const { organization, repository, source, queryHash } = coverage;
  const series = [organization, repository, source, queryHash].join("\u0001");
  // `$executeRaw` and not `$queryRaw`: `pg_advisory_xact_lock` returns `void`, and the driver adapter refuses to
  // deserialise a void column at all — `UnsupportedNativeDataType`. Nothing here wants the result anyway.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${series}, 0))`;
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
}

/**
 * Stamps a series as used, so `prune` can tell a live cache row from an abandoned one.
 *
 * AT MOST ONE WRITE PER SERIES PER DAY, and the guard is what makes reading cheap rather than an optimisation
 * bolted onto it. `accessed_at` feeds exactly one decision — `prune` deleting series unused since a cut-off
 * measured in DAYS — so a row already stamped today needs no second stamp to answer it, and skipping that write
 * carries identical meaning.
 *
 * What it costs to write unconditionally is not the update: it is that `accessed_at` is INDEXED, so no update to
 * it can be HOT — every stamp is a dead tuple and a new index tuple. Measured with `EXPLAIN (ANALYZE, BUFFERS)`
 * over the estate's own row count of 3,782 (1,891 repositories × 2 sources), the unguarded organisation-wide
 * stamp costs 30,983 buffers and 21 ms; guarded, a second read the same day is an index probe that matches
 * nothing — 2 buffers and 0.03 ms. That is paid on every uncached request and every span the warmer builds, and
 * `/repositories/[repository]` is documented as deliberately uncached and issued two of these per view.
 *
 * `midnight` in UTC, matching every other window edge in this system — `prune`'s cut-off is a subtraction from
 * `Date.now()` and has no local-time reading either.
 */
export async function touchSourceCoverage(key: CoverageKey, accessedAt: Date = new Date()): Promise<void> {
  try {
    await prisma.sourceCoverage.updateMany({
      where: {
        organization: key.organization,
        repository: key.repository,
        source: key.source,
        queryHash: key.queryHash,
        accessedAt: { lt: midnight(accessedAt) }
      },
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

/**
 * How far each repository's own cached coverage reaches, per source.
 *
 * THE PER-REPOSITORY EDGES `prevailingCachedCoverage` TAKES THE MODE OF, kept apart instead of folded, and the
 * same aggregate over the same rows. That one answers "where does the estate's coverage end", which is where a
 * report anchors; this answers "was THIS repository read up to there", which is what separates a repository
 * measured as having merged nothing from one whose merge history nobody fetched. A repository absent from the
 * map has no coverage under the current signature at all — a source never read for it.
 *
 * BOTH SOURCES IN ONE QUERY, because the report needs both and neither is worth a round trip of its own. The
 * filter is the query hashes rather than the sources, which `touchOrganisationCoverage` reads the same way: a
 * signature is derived from one source's query, so naming it selects that source and no other, and coverage
 * left behind by a superseded signature is not coverage this build can report from.
 */
export async function cachedCoverageEdges(
  organization: string,
  queryHashes: { pullRequests: string; directCommits: string }
): Promise<Map<string, Map<string, Date>>> {
  try {
    const rows = await prisma.sourceCoverage.groupBy({
      by: ["repository", "source"],
      where: { organization, queryHash: { in: [queryHashes.pullRequests, queryHashes.directCommits] } },
      _max: { endsAt: true }
    });
    const edges = new Map<string, Map<string, Date>>();
    for (const row of rows.filter((row): row is typeof row & { _max: { endsAt: Date } } => row._max.endsAt !== null)) {
      const bySource = edges.get(row.repository) ?? new Map<string, Date>();
      bySource.set(row.source, row._max.endsAt);
      edges.set(row.repository, bySource);
    }
    return edges;
  } catch (error) {
    throw new StorageError("could not read collection cache", error);
  }
}

/**
 * Stamps every series of one organisation as used, in one write per source.
 *
 * The batched counterpart to `touchSourceCoverage`, and the reason a page render is not dominated by writes:
 * per repository it was two `UPDATE`s, which measured at more than half of the 15.39 ms each repository cost.
 *
 * Coarser than the per-series stamp, and that is safe rather than sloppy. `accessedAt` feeds one decision —
 * `prune` deleting series unused since a cutoff — so the question it answers is "did anything read this
 * recently", and a render that reads the whole organisation has read every series in it. What it must not do is
 * stamp a series NOTHING read, which is why it is scoped to the query hashes the render actually used: a series
 * under a retired signature keeps ageing and stays prunable.
 *
 * ONCE A DAY, on the same guard and for the same reason as `touchSourceCoverage` — see the note there, which
 * measures this statement in particular. It is the one that reaches the whole estate: 3,782 indexed rows
 * rewritten per organisation-wide render, which the warmer's spans plus every uncached request pay over and over
 * for an answer that does not change until tomorrow.
 */
export async function touchOrganisationCoverage(
  organization: string,
  queryHashes: { pullRequests: string; directCommits: string },
  accessedAt: Date = new Date()
): Promise<void> {
  try {
    await prisma.sourceCoverage.updateMany({
      where: {
        organization,
        queryHash: { in: [queryHashes.pullRequests, queryHashes.directCommits] },
        accessedAt: { lt: midnight(accessedAt) }
      },
      data: { accessedAt }
    });
  } catch (error) {
    throw new StorageError("could not update collection cache", error);
  }
}
