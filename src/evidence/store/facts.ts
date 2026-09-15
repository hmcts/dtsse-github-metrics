import type { CoverageKey, SourceCoverage } from "../domain/coverage.ts";
import { recordSourceCoverageWithin, touchOrganisationCoverage, touchSourceCoverage } from "./coverage.ts";
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
 *
 * ONE OPERATION MEANS ONE TRANSACTION, from 2026-09-15, and it was two. The facts committed and the coverage
 * row committed after them, which under READ COMMITTED leaves a window where the facts are visible and the
 * claim over them is not. A `prune` landing in that window deletes the facts — nothing yet says the interval
 * is in use — and the coverage insert then commits a row asserting the interval IS covered. The report serves
 * that window as covered with zero merges, which is a plausible number rather than a failure, and a plausible
 * zero is the one outcome this module exists to prevent (see the note on the dropped payload fields below).
 * Either both land or neither does; a rolled-back fact write cannot leave a claim behind it.
 *
 * It costs four more statements inside a transaction that already runs one upsert per fact, against Prisma's
 * DEFAULT five-second interactive-transaction timeout, which nothing here raises — see `org-graph.ts` for what
 * that timeout did in a real cluster. Four statements is not what will exhaust it; the per-fact loop is, and
 * batching it is tracked separately. Anything added here should be one statement rather than another loop.
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
      if (complete) {
        await recordSourceCoverageWithin(tx, coverage);
      }
    });
  } catch (error) {
    throw new StorageError("could not update collection cache", error);
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
      if (complete) {
        await recordSourceCoverageWithin(tx, coverage);
      }
    });
  } catch (error) {
    throw new StorageError("could not update collection cache", error);
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
 * The payload fields no figure the dashboard currently shows is derived from.
 *
 * A pull request's `body` and `title` are collected because two neutral metrics grade them —
 * `description-quality` and `traceability-reference` — and neither enters the readiness label. They are also,
 * measured on AAT, TWO THIRDS OF THE ESTATE'S PAYLOAD: at 26 weeks the pull-request facts serialise to 93 MB, of
 * which `body` alone is 61 MB and `title` 1.2 MB. The report was transferring, parsing and materialising 62 MB
 * per window to reach nothing.
 *
 * BE PRECISE ABOUT WHY THAT IS SAFE, because it is NOT that nothing renders them. `MetricsGrid` is rendered by
 * `/repositories/[repository]` and `/contributors/[login]`, and it reads both metrics through
 * `src/lib/metrics.ts`. What makes the drop safe is one level up: `getRepository` in `src/lib/api.ts` returns the
 * row unchanged and never populates `metrics`, so those two summaries are absent today whatever this projection
 * does.
 *
 * SO WIRING THE METRIC SUMMARIES UP MEANS TAKING `body` OUT OF THIS LIST IN THE SAME CHANGE. Leaving it here
 * would report a description-quality rate over descriptions that were never fetched — a plausible-looking zero
 * rather than a failure, which is the one outcome this comment exists to prevent.
 *
 * Dropped in POSTGRES rather than after the rows arrive, which is the whole point: a projection applied in
 * JavaScript would already have paid the transfer and the JSON parse this exists to avoid. `deserialiseMerges`
 * revives whatever does arrive, so a narrowed projection is a smaller `jsonb` document and not a different shape.
 *
 * WRITTEN INTO THE QUERY LITERALLY, from 2026-09-15, and not built up as a `Prisma.Sql` fragment interpolated
 * into the template below. It was the second, and the interpolation did not survive being bundled twice: Next
 * gives `instrumentation.ts` its own copy of this module graph and the pages an `ssr/` copy, and in the `ssr/` one
 * the nested `Prisma.Sql` was bound as a PARAMETER rather than spliced in as SQL — so every row came back with
 * `{"strings":["payload - "," - ",""],"values":["body","title"]}` as its payload, a valid JSON object that no
 * `jsonb_typeof` check would flag. The warmer's copy read real facts, so the estate looked healthy while every
 * request-side read of the fact cache got a constant.
 *
 * Two fields are a literal in one place. If a third is ever dropped, it goes in the SQL below and in this comment.
 */

/**
 * One cached fact and the instant the window that selected it was compared against.
 *
 * THE COLUMN, NOT THE PAYLOAD'S OWN COPY OF IT. `merged_at` and `committed_at` are what the query filters and
 * orders on, and carrying them out is what lets a caller narrow ONE read into several nested windows and get
 * exactly what a query per window would have returned. The payload is written from the same fact and its
 * `mergedAt` should agree — but "should agree" is precisely how a warmed span and a cold-built one could come to
 * differ without anything failing, and eight bytes a row is a cheap way not to find out.
 */
export interface DatedFact {
  at: Date;
  payload: unknown;
}

/** One repository's cached facts, as the reader groups them. */
interface RepositoryFacts {
  pullRequests: DatedFact[];
  directCommits: DatedFact[];
}

/**
 * Every cohort repository's cached facts for one window, in TWO queries rather than five per repository, and
 * WITHOUT the two thirds of each payload nothing reads.
 *
 * This exists because the per-repository path made a page render unusable. `loadCachedMerges` costs five
 * database calls per repository — a state lookup, two fact queries, and two `touchSourceCoverage` WRITES — and
 * `repositoryRows` walked it sequentially while `overviewSummary` walked the whole thing again. Measured inside
 * the AAT pod at 1,233 repositories, a four-week `/repositories` render cost 7.89 s of CPU that way; batching the
 * reads took it to 1.15 s, and narrowing the projection to what the report reads took it to 0.71 s. At 26 weeks
 * the same three figures are 10.49 s, 2.91 s and 1.50 s.
 *
 * `$queryRaw` rather than `findMany`, and that is the projection's doing rather than a preference: Prisma has no
 * way to select PART of a `jsonb` column, so `select: { payload: true }` is all-or-nothing and the 62 MB of
 * `body` would come with it. The `where` and the `orderBy` are the same predicates the typed query used, against
 * the same `(organization, repository, query_hash, merged_at)` index.
 *
 * The two `accessedAt` stamps collapse into one `updateMany` per source across the whole organisation, which is
 * sound because the column feeds exactly one decision — `prune` deleting series unused since a cutoff. Stamping
 * a series once per render rather than once per read carries the same meaning: something read it today.
 *
 * Ordering is preserved per repository, because two reports of one window must not differ: rows arrive sorted by
 * `(mergedAt, identifier)` and are appended to their repository's list in that order.
 *
 * Each fact carries the instant it was SELECTED ON as well as its payload — see `DatedFact`. That is what makes
 * one read of a wide window answerable for every narrower window ending at the same instant, which is how the
 * report layer builds five spans from one read rather than reading the same rows five times over.
 */
export async function loadCachedFactsForOrganisation(
  organization: string,
  queryHashes: { pullRequests: string; directCommits: string },
  startsAt: Date,
  endsAt: Date
): Promise<Map<string, RepositoryFacts>> {
  try {
    const [pullRequests, directCommits] = await Promise.all([
      prisma.$queryRaw<{ repository: string; at: Date; payload: unknown }[]>`
        SELECT repository, merged_at AS at, payload - 'body' - 'title' AS payload
        FROM pull_request_facts
        WHERE organization = ${organization} AND query_hash = ${queryHashes.pullRequests}
          AND merged_at >= ${startsAt} AND merged_at < ${endsAt}
        ORDER BY merged_at ASC, identifier ASC
      `,
      prisma.$queryRaw<{ repository: string; at: Date; payload: unknown }[]>`
        SELECT repository, committed_at AS at, payload
        FROM direct_commit_facts
        WHERE organization = ${organization} AND query_hash = ${queryHashes.directCommits}
          AND committed_at >= ${startsAt} AND committed_at < ${endsAt}
        ORDER BY committed_at ASC, sha ASC
      `
    ]);

    const byRepository = new Map<string, RepositoryFacts>();
    const forRepository = (repository: string) => {
      const existing = byRepository.get(repository);
      if (existing !== undefined) {
        return existing;
      }
      const created = { pullRequests: [] as DatedFact[], directCommits: [] as DatedFact[] };
      byRepository.set(repository, created);
      return created;
    };
    for (const row of pullRequests) {
      forRepository(row.repository).pullRequests.push({ at: row.at, payload: row.payload });
    }
    for (const row of directCommits) {
      forRepository(row.repository).directCommits.push({ at: row.at, payload: row.payload });
    }

    await touchOrganisationCoverage(organization, queryHashes);
    return byRepository;
  } catch (error) {
    throw new StorageError("could not read collection cache", error);
  }
}

/**
 * Who authored the merges in each repository over a window, for the `authoring-team` ownership rung.
 *
 * ONE QUERY FOR THE WHOLE ORGANISATION, aggregated in Postgres. The rung needs a count per
 * (repository, author) across the estate, and the alternative — reading every payload and folding in
 * JavaScript — would transfer the fact cache to count a field of it. On AAT this reads 703 repositories'
 * authorship as a few thousand rows.
 *
 * `query_hash` is deliberately NOT constrained. Every other reader here scopes to the signature that collected
 * it, because a widened query invalidates the intervals a narrower one covered — but this asks "who has been
 * merging here", and a merge authored under a previous query shape was still authored. Excluding those rows
 * would empty this the day somebody adds a field to the pull-request document, and silently move the whole
 * estate's ownership back onto `teams-api-admin`.
 *
 * FOLDED IN SQL, matching `canonical`: the memberships this is joined against are folded, and `Alice` must
 * match their membership as `alice`.
 */
export async function authorshipForOrganisation(organization: string, since: Date): Promise<Map<string, Map<string, number>>> {
  try {
    const rows = await prisma.$queryRaw<{ repository: string; login: string; merges: bigint }[]>`
      SELECT repository, lower(payload->>'authorLogin') AS login, count(*) AS merges
      FROM pull_request_facts
      WHERE organization = ${organization} AND merged_at >= ${since}
        AND payload->>'authorLogin' IS NOT NULL AND payload->>'authorLogin' <> ''
      GROUP BY repository, lower(payload->>'authorLogin')
      ORDER BY repository ASC, lower(payload->>'authorLogin') ASC
    `;
    const authorship = new Map<string, Map<string, number>>();
    for (const row of rows) {
      const merges = authorship.get(row.repository) ?? new Map<string, number>();
      // `count(*)` arrives as a BIGINT through the raw client, which is a `bigint` in JavaScript and would
      // compare against a threshold as `2n >= 2` — true, but every arithmetic use of it beside a number
      // throws. Narrowed here, where the row is read, rather than at each of the comparisons downstream.
      merges.set(row.login, Number(row.merges));
      authorship.set(row.repository, merges);
    }
    return authorship;
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
