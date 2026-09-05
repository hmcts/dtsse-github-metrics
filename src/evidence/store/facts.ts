import type { CoverageKey, SourceCoverage } from "../domain/coverage.ts";
import { recordSourceCoverage, touchSourceCoverage } from "./coverage.ts";
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
