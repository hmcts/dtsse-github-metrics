import type { CoverageKey, SourceCoverage } from "../domain/coverage.ts";
import { recordSourceCoverage, touchOrganisationCoverage, touchSourceCoverage } from "./coverage.ts";
import { prisma } from "./prisma.ts";
import { StorageError } from "./storage-error.ts";

/**
 * Caching collected facts, ported from `metrics.storage`'s fact tables.
 *
 * Facts are stored as `jsonb` payloads beside the few queryable columns, exactly as upstream stored
 * `model_dump_json()` text. Adding a field to a fact therefore needs no migration — and a field REMOVED
 * from a fact must still parse when an old payload is read back, which is what the reader's schema
 * validation is for.
 *
 * `complete` is the whole reason writing facts and recording coverage are one operation: a partial
 * collection must leave its facts cached for reuse but must NOT claim the interval as covered, or the
 * next run would skip the gap it left.
 */

/** Stores merged pull requests, recording coverage only when the interval was collected in full. */
export async function cachePullRequestFacts(coverage: SourceCoverage, facts: readonly PullRequestFactRow[], complete: boolean): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      for (const fact of facts) {
        const identity = {
          organization: coverage.organization,
          repository: coverage.repository,
          queryHash: coverage.queryHash,
          identifier: fact.identifier
        };
        await tx.pullRequestFact.upsert({
          where: { organization_repository_queryHash_identifier: identity },
          create: { ...identity, mergedAt: fact.mergedAt, payload: fact.payload },
          update: { mergedAt: fact.mergedAt, payload: fact.payload }
        });
      }
    });
  } catch (error) {
    throw new StorageError("could not update collection cache", error);
  }
  if (complete) {
    await recordSourceCoverage(coverage);
  }
}

/** Stores direct commits, recording coverage only when the interval was collected in full. */
export async function cacheDirectCommitFacts(coverage: SourceCoverage, facts: readonly DirectCommitFactRow[], complete: boolean): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      for (const fact of facts) {
        const identity = {
          organization: coverage.organization,
          repository: coverage.repository,
          queryHash: coverage.queryHash,
          sha: fact.sha
        };
        await tx.directCommitFact.upsert({
          where: { organization_repository_queryHash_sha: identity },
          create: { ...identity, committedAt: fact.committedAt, payload: fact.payload },
          update: { committedAt: fact.committedAt, payload: fact.payload }
        });
      }
    });
  } catch (error) {
    throw new StorageError("could not update collection cache", error);
  }
  if (complete) {
    await recordSourceCoverage(coverage);
  }
}

/**
 * Cached merged pull requests for one window, in a stable order.
 *
 * Ordered by `(mergedAt, identifier)` rather than by `mergedAt` alone: shard boundaries can produce two
 * merges at the same instant, and an unstable order there would make two reports of the same window
 * differ. Reading stamps the coverage series as used, so a window a report still reads is not pruned.
 */
export async function loadCachedPullRequestFacts(key: CoverageKey, startsAt: Date, endsAt: Date): Promise<unknown[]> {
  try {
    const rows = await prisma.pullRequestFact.findMany({
      where: {
        organization: key.organization,
        repository: key.repository,
        queryHash: key.queryHash,
        // Half-open, matching every window in the system: a merge at `endsAt` belongs to the next one.
        mergedAt: { gte: startsAt, lt: endsAt }
      },
      orderBy: [{ mergedAt: "asc" }, { identifier: "asc" }],
      select: { payload: true }
    });
    await touchSourceCoverage(key);
    return rows.map((row) => row.payload);
  } catch (error) {
    throw new StorageError("could not read collection cache", error);
  }
}

/** Cached direct commits for one window, in a stable order. */
export async function loadCachedDirectCommitFacts(key: CoverageKey, startsAt: Date, endsAt: Date): Promise<unknown[]> {
  try {
    const rows = await prisma.directCommitFact.findMany({
      where: {
        organization: key.organization,
        repository: key.repository,
        queryHash: key.queryHash,
        committedAt: { gte: startsAt, lt: endsAt }
      },
      orderBy: [{ committedAt: "asc" }, { sha: "asc" }],
      select: { payload: true }
    });
    await touchSourceCoverage(key);
    return rows.map((row) => row.payload);
  } catch (error) {
    throw new StorageError("could not read collection cache", error);
  }
}

/**
 * What may be stored in a `jsonb` payload column.
 *
 * Declared here rather than importing Prisma's `InputJsonValue`, so the fact types this module exports
 * describe the domain rather than the driver — and so a caller holding a plain object needs no cast. A
 * fact is always a JSON object; the recursive value type is what its fields may hold.
 */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface PullRequestFactRow {
  /** A BigInt, because GitHub's databaseId exceeds a 32-bit integer — see prisma/schema.prisma. */
  identifier: bigint;
  mergedAt: Date;
  payload: { [key: string]: JsonValue };
}

export interface DirectCommitFactRow {
  sha: string;
  committedAt: Date;
  payload: { [key: string]: JsonValue };
}

/**
 * Every cohort repository's cached facts for one window, in FOUR queries rather than five per repository.
 *
 * This exists because the per-repository path made a page render unusable. `loadCachedMerges` costs five
 * database calls per repository — a state lookup, two fact queries, and two `touchSourceCoverage` WRITES — and
 * `repositoryRows` walked it sequentially while `overviewSummary` walked the whole thing again. Measured against
 * AAT at 1,235 repositories: 15.39 ms per repository, so about 38 seconds of database time per render, of which
 * the two writes are most. Rendering took 20 to 28 seconds.
 *
 * The two `accessedAt` stamps collapse into one `updateMany` per source across the whole organisation, which is
 * sound because the column feeds exactly one decision — `prune` deleting series unused since a cutoff. Stamping
 * a series once per render rather than once per read carries the same meaning: something read it today.
 *
 * Ordering is preserved per repository, because two reports of one window must not differ: rows arrive sorted by
 * `(mergedAt, identifier)` and are appended to their repository's list in that order.
 */
export async function loadCachedFactsForOrganisation(
  organization: string,
  queryHashes: { pullRequests: string; directCommits: string },
  startsAt: Date,
  endsAt: Date
): Promise<Map<string, { pullRequests: unknown[]; directCommits: unknown[] }>> {
  try {
    const [pullRequests, directCommits] = await Promise.all([
      prisma.pullRequestFact.findMany({
        where: { organization, queryHash: queryHashes.pullRequests, mergedAt: { gte: startsAt, lt: endsAt } },
        orderBy: [{ mergedAt: "asc" }, { identifier: "asc" }],
        select: { repository: true, payload: true }
      }),
      prisma.directCommitFact.findMany({
        where: { organization, queryHash: queryHashes.directCommits, committedAt: { gte: startsAt, lt: endsAt } },
        orderBy: [{ committedAt: "asc" }, { sha: "asc" }],
        select: { repository: true, payload: true }
      })
    ]);

    const byRepository = new Map<string, { pullRequests: unknown[]; directCommits: unknown[] }>();
    const forRepository = (repository: string) => {
      const existing = byRepository.get(repository);
      if (existing !== undefined) {
        return existing;
      }
      const created = { pullRequests: [] as unknown[], directCommits: [] as unknown[] };
      byRepository.set(repository, created);
      return created;
    };
    for (const row of pullRequests) {
      forRepository(row.repository).pullRequests.push(row.payload);
    }
    for (const row of directCommits) {
      forRepository(row.repository).directCommits.push(row.payload);
    }

    await touchOrganisationCoverage(organization, queryHashes);
    return byRepository;
  } catch (error) {
    throw new StorageError("could not read collection cache", error);
  }
}

/** Every cohort repository's collected state, in one query. */
export async function storedRepositoryStates(organization: string): Promise<Map<string, { fetchedAt: Date; payload: unknown }>> {
  try {
    const rows = await prisma.repositoryState.findMany({
      where: { organization },
      select: { repository: true, fetchedAt: true, payload: true }
    });
    return new Map(rows.map((row) => [row.repository, { fetchedAt: row.fetchedAt, payload: row.payload }]));
  } catch (error) {
    throw new StorageError("could not read collection cache", error);
  }
}
