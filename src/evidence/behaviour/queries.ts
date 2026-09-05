import { createHash } from "node:crypto";
import { EvidenceSource } from "../domain/coverage.ts";
import { githubTimestamp } from "../window/instant.ts";
import type { ReportingWindow } from "../window/window.ts";

/**
 * The GraphQL documents behaviour collection sends. Ported from `metrics.behaviour`.
 *
 * PAGE SIZES ARE DELIBERATELY BELOW GITHUB'S 100 MAXIMUM and are not to be raised casually. Status-check
 * rollups are expensive for GitHub to compute, and a full page of pull requests each carrying a full page
 * of reviews and rollup contexts times out on the server (502/504) rather than returning slowly.
 *
 * They are balanced, not minimised. Both nested connections page on overflow, so a page too small is not
 * wrong, merely slow: every pull request exceeding it costs an extra sequential round trip. Measured on
 * cath-service, a 90-day backfill of 182 pull requests took three minutes at `contexts(first: 20)` and
 * forty seconds at 50, because its pull requests carry between 21 and 50 checks each and every one was
 * paying for a follow-up query.
 */

/** The rollup context selection shared by the search and continuation queries. */
export function checkContextSelection(): string {
  return `
        __typename
        ... on CheckRun { name status conclusion completedAt }
        ... on StatusContext { context state createdAt }
    `;
}

/**
 * The shallow merged pull-request search query.
 *
 * `timelineItems` is filtered to `READY_FOR_REVIEW_EVENT` and to `first: 1`, so it returns the EARLIEST
 * instant the change left draft and asked to be reviewed — the anchor the two waiting-time metrics need.
 * `isDraft` alone could never answer this: it is the state at merge, which is false for every merged pull
 * request, so a change that sat in draft for a fortnight was indistinguishable from one opened ready. A
 * later conversion back to draft is deliberately not read: rework after review has begun is part of the
 * cycle being measured, whereas the wait before anyone was asked to look is not.
 */
export function pullRequestQuery(): string {
  return `
        query PullRequests($searchQuery: String!, $cursor: String) {
          search(query: $searchQuery, type: ISSUE, first: 25, after: $cursor) {
            issueCount
            pageInfo { hasNextPage endCursor }
            nodes {
              ... on PullRequest {
                databaseId number title body createdAt mergedAt isDraft
                additions deletions changedFiles
                timelineItems(itemTypes: [READY_FOR_REVIEW_EVENT], first: 1) {
                  nodes { ... on ReadyForReviewEvent { createdAt } }
                }
                author { login __typename }
                reviews(first: 50) {
                  pageInfo { hasNextPage endCursor }
                  nodes { databaseId submittedAt state author { login __typename } body comments(first: 0) { totalCount } }
                }
                commits(last: 1) {
                  nodes {
                    commit {
                      statusCheckRollup {
                        contexts(first: 50) {
                          pageInfo { hasNextPage endCursor }
                          nodes { ${checkContextSelection()} }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
          rateLimit { cost limit remaining resetAt }
        }
    `;
}

/** The focused query used only for an overflowing status-check rollup. */
export function checkQuery(): string {
  return `
        query Checks($organization: String!, $repository: String!, $number: Int!, $cursor: String) {
          repository(owner: $organization, name: $repository) {
            pullRequest(number: $number) {
              commits(last: 1) {
                nodes {
                  commit {
                    statusCheckRollup {
                      contexts(first: 50, after: $cursor) {
                        pageInfo { hasNextPage endCursor }
                        nodes { ${checkContextSelection()} }
                      }
                    }
                  }
                }
              }
            }
          }
          rateLimit { cost limit remaining resetAt }
        }
    `;
}

/** The focused query used only for an overflowing review connection. */
export function reviewQuery(): string {
  return `
        query Reviews($organization: String!, $repository: String!, $number: Int!, $cursor: String) {
          repository(owner: $organization, name: $repository) {
            pullRequest(number: $number) {
              reviews(first: 100, after: $cursor) {
                pageInfo { hasNextPage endCursor }
                nodes { databaseId submittedAt state author { login __typename } body comments(first: 0) { totalCount } }
              }
            }
          }
          rateLimit { cost limit remaining resetAt }
        }
    `;
}

/**
 * The default-branch history query used to find changes that skipped a pull request.
 *
 * `defaultBranchRef` resolves the branch server-side, so nothing here needs the branch name. History
 * follows every parent rather than first parents alone, which is what makes `associatedPullRequests` the
 * right discriminator: the commits a merge brought in carry their pull request, and only a commit no pull
 * request introduced is left without one. GitHub returns the MERGED pull request that introduced a
 * default-branch commit, never an open one, so an open pull request whose branch contains a commit cannot
 * hide a direct push.
 *
 * `statusCheckRollup { state }` is the BARE SCALAR, and it is the whole reason this query is cheap.
 * Fetching the `contexts` connection per direct commit cost one round trip each — measured at 159 of the
 * 173 calls a cath-service window took, 92% of the total — for check detail nothing reads.
 *
 * `history(first: 50)` is deliberately below GitHub's 100. Each node makes the server compute a rollup,
 * which is what returned 502/504 for the pull-request search, and a 90-day cath-service window is only 14
 * pages at this size. Do not raise it and the contexts connection together.
 */
export function commitHistoryQuery(): string {
  return `
        query DefaultBranchCommits(
          $organization: String!
          $repository: String!
          $since: GitTimestamp!
          $until: GitTimestamp!
          $cursor: String
        ) {
          repository(owner: $organization, name: $repository) {
            defaultBranchRef {
              target {
                ... on Commit {
                  history(first: 50, since: $since, until: $until, after: $cursor) {
                    pageInfo { hasNextPage endCursor }
                    nodes {
                      oid committedDate additions deletions changedFilesIfAvailable
                      author { user { login __typename } }
                      associatedPullRequests(first: 1) { nodes { number } }
                      statusCheckRollup { state }
                    }
                  }
                }
              }
            }
          }
          rateLimit { cost limit remaining resetAt }
        }
    `;
}

/**
 * The bundled open-pull-request state query.
 *
 * Four aliased searches share one round trip and read only `issueCount`, never a node: this state is NEVER
 * CACHED, so keeping the shape cheap and constant matters more than for a source fetched once and reused.
 * `first: 1` is the minimum GitHub's search connection accepts; nothing under it is read.
 */
export function openPullRequestQuery(): string {
  return `
        query OpenPullRequests(
          $openedQuery: String!
          $closedWithoutMergeQuery: String!
          $openQuery: String!
          $staleOpenQuery: String!
        ) {
          openedInWindow: search(query: $openedQuery, type: ISSUE, first: 1) { issueCount }
          closedWithoutMerge: search(query: $closedWithoutMergeQuery, type: ISSUE, first: 1) { issueCount }
          currentlyOpen: search(query: $openQuery, type: ISSUE, first: 1) { issueCount }
          staleOpen: search(query: $staleOpenQuery, type: ISSUE, first: 1) { issueCount }
          rateLimit { cost limit remaining resetAt }
        }
    `;
}

/**
 * The four search qualifiers the open-pull-request query bundles into one call.
 *
 * Each bounded qualifier uses GitHub's inclusive `start..end` range, NOT a pair of `>=` / `<` comparisons.
 * Two comparisons on one qualifier read as a half-open window but GITHUB DOES NOT INTERSECT THEM: measured
 * against hmcts/cath-service, `created:>=2026-05-09T00:00:00Z created:<2026-08-08T00:00:00Z` returned 614
 * pull requests for a window whose merged, closed and still-open counts together account for roughly 240 —
 * the count of every pull request the repository has ever opened, i.e. only the last qualifier applied.
 *
 * The window's exclusive upper bound is therefore expressed by ending the inclusive range ONE SECOND EARLY;
 * GitHub search resolves timestamps to the second.
 */
export function openPullRequestSearchQueries(organization: string, repository: string, window: ReportingWindow, staleCutoff: Date): Record<string, string> {
  const base = `repo:${organization}/${repository} is:pr`;
  const startsAt = githubTimestamp(window.startsAt);
  const lastInstant = githubTimestamp(new Date(window.endsAt.getTime() - 1000));
  return {
    openedQuery: `${base} created:${startsAt}..${lastInstant}`,
    closedWithoutMergeQuery: `${base} is:closed -is:merged closed:${startsAt}..${lastInstant}`,
    openQuery: `${base} is:open`,
    staleOpenQuery: `${base} is:open updated:<${githubTimestamp(staleCutoff)}`
  };
}

/** The merged-pull-request search qualifier for one shard of a window. */
export function mergedSearchQuery(organization: string, repository: string, startsAt: Date, endsAt: Date): string {
  return `repo:${organization}/${repository} is:pr is:merged merged:${githubTimestamp(startsAt)}..${githubTimestamp(endsAt)}`;
}

/**
 * Identifies the shape of the data these queries cache, so widening them invalidates the cache.
 *
 * The hash will NOT match the Python implementation's, because the document text is not byte-identical.
 * That is harmless: the signature is only ever compared with itself, so a differing value simply means this
 * build reads and writes its own coverage rows. It matters in exactly one place — importing a Python SQLite
 * cache — where the importer must rewrite the stored hash to this one or every imported row is unreadable.
 */
export function querySignature(): string {
  const documents = `${pullRequestQuery()}${reviewQuery()}${checkQuery()}`.split(/\s+/).join(" ");
  return createHash("sha256").update(documents).digest("hex").slice(0, 16);
}

/**
 * Identifies the shape of the cached commit data, separately from the pull-request queries.
 *
 * Its own signature so that widening one source does not discard the other's settled history: the two are
 * cached under different sources and are refetched independently.
 */
export function commitQuerySignature(): string {
  const documents = commitHistoryQuery().split(/\s+/).join(" ");
  return createHash("sha256").update(documents).digest("hex").slice(0, 16);
}

/**
 * The signature one independently cached source's rows are written under.
 *
 * Named once so that a reader of the cache and a writer of it cannot use different signatures: coverage is
 * requested through this and the report anchor is read through it, so the anchor is always the edge of
 * coverage this build can actually report from.
 */
export function sourceSignature(source: EvidenceSource): string {
  return source === EvidenceSource.PullRequests ? querySignature() : commitQuerySignature();
}

const SHARD_DAYS = 30;

/**
 * Splits a collection window into bounded search intervals.
 *
 * Thirty days, because GitHub's search caps any one query at 1000 results and a shard above that cap is
 * reported as incomplete history rather than silently truncated.
 *
 * NOTE the two conventions in play: shard boundaries are passed to GitHub as INCLUSIVE ranges, so
 * consecutive shards overlap by one second and a merge landing exactly on a boundary is returned twice. The
 * caller dedupes by identifier. The WINDOW itself stays half-open, and the caller filters on that too.
 */
export function* dateShards(startsAt: Date, endsAt: Date): Generator<{ startsAt: Date; endsAt: Date }> {
  let cursor = startsAt;
  while (cursor.getTime() < endsAt.getTime()) {
    const boundary = new Date(Math.min(cursor.getTime() + SHARD_DAYS * 86_400_000, endsAt.getTime()));
    yield { startsAt: cursor, endsAt: boundary };
    cursor = boundary;
  }
}
