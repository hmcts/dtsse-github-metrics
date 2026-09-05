import { EvidenceSource, type SourceCoverage } from "../domain/coverage.ts";
import type { DirectCommitFact, Merges, PullRequestFact } from "../domain/facts.ts";
import { findMissingCoverage, touchSourceCoverage } from "../store/coverage.ts";
import { cacheDirectCommitFacts, cachePullRequestFacts, type JsonValue, loadCachedDirectCommitFacts, loadCachedPullRequestFacts } from "../store/facts.ts";
import type { ReportingWindow } from "../window/window.ts";
import { sourceSignature } from "./queries.ts";

/**
 * Filling the cache for one window and reading it back. Ported from `metrics.behaviour`'s cache half.
 *
 * The one rule that makes offline reporting honest: ONLY THE STABLE SIDE RECORDS COVERAGE. The mutable edge
 * is fetched and cached but never claimed as covered, so a report reading from the cache refuses a window
 * reaching into that edge rather than serving a remembered answer for it.
 */

/** The coverage row one source's facts for a window are written under. */
export function requestedCoverage(organization: string, repository: string, source: EvidenceSource, window: ReportingWindow): SourceCoverage {
  return {
    organization,
    repository,
    source,
    queryHash: sourceSignature(source),
    startsAt: window.startsAt,
    endsAt: window.endsAt
  };
}

/**
 * Fills one source's missing stable history and refreshes its mutable edge.
 *
 * The stable side is filled only where coverage is missing, so a second run over the same window costs
 * nothing. The mutable side is always refetched and cached with `complete: false`, which stores the facts for
 * reuse without recording the interval — the next run therefore collects it again, as it must, because
 * checks may still have been running and GitHub's search index may not have caught up.
 */
export async function fillCachedSource<FactT>(
  requested: SourceCoverage,
  mutableStartsAt: Date,
  collect: (startsAt: Date, endsAt: Date) => Promise<FactT[]>,
  cache: (coverage: SourceCoverage, facts: FactT[], complete: boolean) => Promise<void>
): Promise<SourceCoverage[]> {
  let fetched: SourceCoverage[] = [];

  if (requested.startsAt.getTime() < mutableStartsAt.getTime()) {
    const stable: SourceCoverage = { ...requested, endsAt: mutableStartsAt };
    fetched = await findMissingCoverage(stable);
    // This is the collecting run, and the intervals it reads here are the ones the current queries still
    // ask for, so they must not age out of the cache under `prune`.
    await touchSourceCoverage(stable);
    for (const missing of fetched) {
      await cache(missing, await collect(missing.startsAt, missing.endsAt), true);
    }
  }

  if (mutableStartsAt.getTime() < requested.endsAt.getTime()) {
    const mutable: SourceCoverage = { ...requested, startsAt: mutableStartsAt };
    await cache(mutable, await collect(mutable.startsAt, mutable.endsAt), false);
  }

  return fetched;
}

/** Writes merged pull requests into the cache under one coverage row. */
export function pullRequestCacheWriter(): (coverage: SourceCoverage, facts: PullRequestFact[], complete: boolean) => Promise<void> {
  return (coverage, facts, complete) =>
    cachePullRequestFacts(
      coverage,
      // BigInt at the boundary: the column is a BIGINT because GitHub's databaseId exceeds a 32-bit integer,
      // while the in-memory fact keeps a number, which holds it exactly.
      facts.map((fact) => ({ identifier: BigInt(fact.identifier), mergedAt: fact.mergedAt, payload: serialise(fact) })),
      complete
    );
}

/** Writes direct commits into the cache under one coverage row. */
export function directCommitCacheWriter(): (coverage: SourceCoverage, facts: DirectCommitFact[], complete: boolean) => Promise<void> {
  return (coverage, facts, complete) =>
    cacheDirectCommitFacts(
      coverage,
      facts.map((fact) => ({ sha: fact.sha, committedAt: fact.committedAt, payload: serialise(fact) })),
      complete
    );
}

/** Reads both sources' cached facts for one window. */
export async function loadCachedMerges(organization: string, repository: string, window: ReportingWindow): Promise<Merges> {
  const pullRequestKey = requestedCoverage(organization, repository, EvidenceSource.PullRequests, window);
  const commitKey = requestedCoverage(organization, repository, EvidenceSource.DirectCommits, window);
  const [pullRequests, directCommits] = await Promise.all([
    loadCachedPullRequestFacts(pullRequestKey, window.startsAt, window.endsAt),
    loadCachedDirectCommitFacts(commitKey, window.startsAt, window.endsAt)
  ]);
  return {
    pullRequests: pullRequests.map((payload) => deserialise<PullRequestFact>(payload)),
    directCommits: directCommits.map((payload) => deserialise<DirectCommitFact>(payload))
  };
}

/**
 * Converts a fact to its stored form, with `Date`s as ISO strings.
 *
 * `jsonb` cannot hold a `Date`, and stringifying through `JSON.stringify` would do this implicitly — doing
 * it explicitly is what makes `deserialise` the exact inverse, and what stops an undefined field becoming a
 * `null` in the payload. Absent means unmeasured throughout this codebase; a null in a payload would read
 * back as a measured nothing.
 */
function serialise(fact: object): { [key: string]: JsonValue } {
  const entries = Object.entries(fact).flatMap(([key, value]) => {
    if (value === undefined || value === null) {
      return [];
    }
    return [[key, toJson(value)] as [string, JsonValue]];
  });
  return Object.fromEntries(entries);
}

function toJson(value: unknown): JsonValue {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map((entry) => toJson(entry));
  }
  if (typeof value === "object" && value !== null) {
    return serialise(value);
  }
  return value as JsonValue;
}

/** The instant-bearing fields of a stored fact, which must come back as `Date`s. */
const INSTANT_FIELDS = new Set(["createdAt", "mergedAt", "readyForReviewAt", "submittedAt", "completedAt", "committedAt"]);

/** Reads a stored payload back into a fact, restoring its instants. */
export function deserialise<T>(payload: unknown): T {
  return revive(payload) as T;
}

function revive(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => revive(entry));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        INSTANT_FIELDS.has(key) && typeof entry === "string" ? new Date(entry) : revive(entry)
      ])
    );
  }
  return value;
}
