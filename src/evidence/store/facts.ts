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
 * zero is the one outcome this module exists to prevent (see the note on what is no longer stored, below).
 * Either both land or neither does; a rolled-back fact write cannot leave a claim behind it.
 *
 * It costs four more statements inside the transaction, which is affordable BECAUSE the fact write itself is
 * now ONE statement per source rather than one upsert per fact — see `cachePullRequestFacts`. Anything added
 * here should be one statement rather than another loop.
 */

/**
 * Stores merged pull requests, recording coverage only when the interval was collected in full.
 *
 * ONE `INSERT … ON CONFLICT` FOR THE WHOLE BATCH, from 2026-09-16, and it was one `upsert` per fact in a
 * sequential loop. At the 1.3 ms per round trip `org-graph.ts` measures in-cluster, the estate's 23,853 facts
 * were 31 seconds of pure latency per collection — and a first 26-week backfill of a busy repository put
 * several thousand of those round trips inside ONE transaction, which is what Prisma's five-second interactive
 * ceiling is measured against. `org-graph.ts` documents what that ceiling did to `collect-org` when a single
 * pass crossed it: every scheduled run failing outright, with `--tolerate-partial` unable to rescue a throw.
 *
 * THE FACTS TRAVEL AS PARALLEL ARRAYS THROUGH `unnest`, not as a `VALUES` list. `org-graph.ts` sets out the
 * reasoning at `stampByKey`: a `VALUES` list puts one bind parameter per column per row into the statement
 * text and eventually meets PostgreSQL's 65,535 int16 parameter ceiling, which is what `MaximumRowsPerStatement`
 * exists there to keep the insert path under. The parameter count here is FIXED at seven however many facts a
 * repository merged, so there is no chunk size to keep in step with the column list and no batch big enough to
 * need one.
 *
 * WRITTEN AS LITERAL SQL IN ONE PIECE, never assembled from nested `Prisma.Sql` fragments — see the note below
 * on what an interpolated fragment silently became in the `ssr/` bundle. The arrays are ordinary bind
 * parameters, which is the same distinction `stampByKey` draws.
 *
 * `NULLIF` on the login because the array carries `''` for a merge GitHub matched to no account: a `text[]`
 * with NULL elements is one more thing for a driver to disagree about, and the column's single spelling of
 * "nobody" is NULL. No login is ever the empty string, and the reader this replaced already read `''` as
 * nobody.
 *
 * The coverage row still commits inside THIS transaction, which is the whole point of the module — batching
 * changed how many statements write the facts, not how many transactions they and their claim commit in.
 */
export async function cachePullRequestFacts(coverage: SourceCoverage, facts: readonly PullRequestFactRow[], complete: boolean): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      if (facts.length > 0) {
        await tx.$executeRaw`
          INSERT INTO pull_request_facts (organization, repository, query_hash, identifier, merged_at, author_login, payload)
          SELECT ${coverage.organization}, ${coverage.repository}, ${coverage.queryHash},
                 fact.identifier::bigint, fact.merged_at::timestamptz, NULLIF(fact.author_login, ''), fact.payload::jsonb
          FROM unnest(
            ${facts.map((fact) => fact.identifier.toString())}::text[],
            ${facts.map((fact) => fact.mergedAt.toISOString())}::text[],
            ${facts.map((fact) => fact.authorLogin ?? "")}::text[],
            ${facts.map((fact) => JSON.stringify(fact.payload))}::text[]
          ) AS fact(identifier, merged_at, author_login, payload)
          ON CONFLICT (organization, repository, query_hash, identifier)
          DO UPDATE SET merged_at = EXCLUDED.merged_at, author_login = EXCLUDED.author_login, payload = EXCLUDED.payload
        `;
      }
      if (complete) {
        await recordSourceCoverageWithin(tx, coverage);
      }
    });
  } catch (error) {
    throw new StorageError("could not update collection cache", error);
  }
}

/** Stores direct commits, recording coverage only when the interval was collected in full — one statement, as above. */
export async function cacheDirectCommitFacts(coverage: SourceCoverage, facts: readonly DirectCommitFactRow[], complete: boolean): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      if (facts.length > 0) {
        await tx.$executeRaw`
          INSERT INTO direct_commit_facts (organization, repository, query_hash, sha, committed_at, payload)
          SELECT ${coverage.organization}, ${coverage.repository}, ${coverage.queryHash},
                 fact.sha, fact.committed_at::timestamptz, fact.payload::jsonb
          FROM unnest(
            ${facts.map((fact) => fact.sha)}::text[],
            ${facts.map((fact) => fact.committedAt.toISOString())}::text[],
            ${facts.map((fact) => JSON.stringify(fact.payload))}::text[]
          ) AS fact(sha, committed_at, payload)
          ON CONFLICT (organization, repository, query_hash, sha)
          DO UPDATE SET committed_at = EXCLUDED.committed_at, payload = EXCLUDED.payload
        `;
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
  /**
   * Who merged it, promoted OUT of the payload into its own column — see prisma/schema.prisma.
   *
   * Absent where GitHub matched the merge to no account. It stays in the payload as well, because the fact's
   * own shape is what `deserialiseMerges` revives and every metric that attributes a merge reads it there; this
   * is the copy the estate-wide predicate runs against.
   */
  authorLogin?: string;
  payload: { [key: string]: JsonValue };
}

export interface DirectCommitFactRow {
  sha: string;
  committedAt: Date;
  payload: { [key: string]: JsonValue };
}

/**
 * NOTHING IS PROJECTED AWAY ON READ ANY MORE, because nothing writes what was being dropped.
 *
 * The reads below used to select `payload - 'body' - 'title'`. Dropping a pull request's description in
 * PostgreSQL rather than in JavaScript did save the wire transfer and the client JSON parse — that is where the
 * 2.91 s → 1.50 s came from — but building the reduced document still DETOASTS the whole of the original, so
 * every byte was read off disk on every render to be discarded a moment later. Measured with
 * `EXPLAIN (ANALYZE, BUFFERS)` on a table seeded to the live row count and body distribution, the 26-week
 * organisation-wide read cost 35,815 buffers and 253 ms that way, and 1,900 buffers and 19 ms once the
 * descriptions were never stored; the table went from 102 MB to 14 MB. `authorshipForOrganisation` was worse
 * per row, 51,139 buffers, because `payload->>'authorLogin'` appeared three times and each evaluation
 * detoasted the document again — which is why that field is a column now.
 *
 * What replaced the two fields is two ANSWERS, `bodyLength` and `hasTicketReference`, derived where the fact is
 * built. `descriptionQuality` and `traceabilityReference` are the only readers either field ever had, and both
 * wanted a predicate over a description rather than the description — so they are still implementable, which a
 * plain drop would not have left them. See `behaviour/collect.ts` for what each answer decides and
 * `domain/facts.ts` for why one is a number and the other a boolean.
 *
 * NEW ROWS CARRY NO BODY; EXISTING ROWS KEEP THEIRS. The reads are indifferent — a payload with a `body` in it
 * deserialises exactly as it did — and no collection will rewrite one: `querySignature` hashes the query
 * document text, which dropping these fields did not change, so every settled coverage interval stays valid and
 * a run refetches only the mutable edge (`mutable_hours`, six by default). Shedding the stored bodies is a
 * deliberate bulk update, not something collection converges on. An old row has no `bodyLength` and no
 * `hasTicketReference`, and both metrics read that absence as UNMEASURED rather than as zero or false.
 *
 * IF ANYTHING IS EVER PROJECTED AWAY HERE AGAIN, WRITE IT INTO THE QUERY LITERALLY. The projection that lived
 * here was, from 2026-09-15, and the reason it had to be is worth keeping: it was first built as a `Prisma.Sql`
 * fragment interpolated into the template, and that did not survive being bundled twice. Next gives
 * `instrumentation.ts` its own copy of this module graph and the pages an `ssr/` copy, and in the `ssr/` one the
 * nested `Prisma.Sql` was bound as a PARAMETER rather than spliced in as SQL — so every row came back with
 * `{"strings":["payload - "," - ",""],"values":["body","title"]}` as its payload, a valid JSON object that no
 * `jsonb_typeof` check would flag. The warmer's copy read real facts, so the estate looked healthy while every
 * request-side read of the fact cache got a constant. Bind values, never fragments.
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
 * Every cohort repository's cached facts for one window, in TWO queries rather than five per repository.
 *
 * This exists because the per-repository path made a page render unusable. `loadCachedMerges` costs five
 * database calls per repository — a state lookup, two fact queries, and two `touchSourceCoverage` WRITES — and
 * `repositoryRows` walked it sequentially while `overviewSummary` walked the whole thing again. Measured inside
 * the AAT pod at 1,233 repositories, a four-week `/repositories` render cost 7.89 s of CPU that way; batching the
 * reads took it to 1.15 s, and narrowing the projection to what the report reads took it to 0.71 s. At 26 weeks
 * the same three figures are 10.49 s, 2.91 s and 1.50 s. Not storing the descriptions at all, rather than
 * projecting them away here, is what took the read itself from 35,815 buffers to 1,900 — see the note above.
 *
 * `$queryRaw` rather than `findMany` for what it carries OUT: the query selects `merged_at` under an alias, and
 * Prisma's typed API has no way to project a column into a differently-named field. The `where` and the
 * `orderBy` are the same predicates the typed query used, against the same
 * `(organization, repository, query_hash, merged_at)` index.
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
        SELECT repository, merged_at AS at, payload
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
 *
 * OFF THE `author_login` COLUMN, from 2026-09-16, and it was `payload->>'authorLogin'`. This is the statement
 * that made the case for promoting it: the login appeared in the select list, the filter and the grouping, and
 * each of those three evaluations detoasted the whole jsonb document — 51,139 buffers and 273 ms over a 90-day
 * window on a table seeded to the live row count, against 1,835 buffers and 19 ms as a column. Reading a field
 * as a predicate across the whole estate is the criterion `prisma/schema.prisma` gives for `permission` being a
 * column too.
 *
 * The column is populated for every existing row by the migration that added it, so this is not waiting on a
 * collection. `<> ''` is kept beside `IS NOT NULL` because the column is written through `NULLIF` and neither
 * spelling of "nobody" should reach the ladder as a login.
 */
export async function authorshipForOrganisation(organization: string, since: Date): Promise<Map<string, Map<string, number>>> {
  try {
    const rows = await prisma.$queryRaw<{ repository: string; login: string; merges: bigint }[]>`
      SELECT repository, lower(author_login) AS login, count(*) AS merges
      FROM pull_request_facts
      WHERE organization = ${organization} AND merged_at >= ${since}
        AND author_login IS NOT NULL AND author_login <> ''
      GROUP BY repository, lower(author_login)
      ORDER BY repository ASC, lower(author_login) ASC
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
