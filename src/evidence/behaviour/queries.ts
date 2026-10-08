import { createHash } from "node:crypto";
import { EvidenceSource } from "../domain/coverage.ts";

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
 * Merged pull requests, walked off the REPOSITORY rather than found by search.
 *
 * Not search, because a GitHub App installation token is served an EMPTY search over repositories it reads
 * perfectly well: measured, the same query returns 1807 rows with a personal access token and 0 with the App's,
 * and GitHub reports that as success. A collection built on search therefore records zero merges and calls it a
 * complete run. `repository.pullRequests` returns all 1807. This also retires search's 1,000-result cap.
 *
 * UPDATED_AT descending is what makes the walk terminable — `pullRequests` cannot be ordered by merge time, but
 * `mergedAt <= updatedAt` always holds, so once `updatedAt` falls below the window start nothing later can be
 * inside it. CREATED_AT would not do: a change opened long ago and merged yesterday would sit past the cut.
 *
 * `timelineItems` is filtered to `READY_FOR_REVIEW_EVENT` and to `first: 1`, so it returns the EARLIEST
 * instant the change left draft and asked to be reviewed — the anchor the two waiting-time metrics need.
 * `isDraft` alone could never answer this: it is the state at merge, which is false for every merged pull
 * request, so a change that sat in draft for a fortnight was indistinguishable from one opened ready. A
 * later conversion back to draft is deliberately not read: rework after review has begun is part of the
 * cycle being measured, whereas the wait before anyone was asked to look is not.
 */
export function mergedPullRequestQuery(): string {
  return `
        query MergedPullRequests($organization: String!, $repository: String!, $cursor: String) {
          repository(owner: $organization, name: $repository) {
            pullRequests(states: MERGED, orderBy: { field: UPDATED_AT, direction: DESC }, first: 25, after: $cursor) {
              pageInfo { hasNextPage endCursor }
              nodes {
                databaseId number title body createdAt mergedAt updatedAt isDraft
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

/**
 * Whether the credential can see this repository's merged pull requests AT ALL, and nothing else.
 *
 * `doctor`'s question, and it is a different question from the collection's. The check exists because GitHub
 * answers a request it will not serve with an EMPTY RESULT rather than a refusal, so a credential that reads
 * every repository and sees none of their pull requests produces a report full of zeroes and a run that claims
 * to have succeeded. Answering that needs one number, not a walk.
 *
 * THE CHEAPEST SHAPE THAT ANSWERS IT. `mergedPullRequestQuery` is the heaviest document in this codebase — 25
 * pull requests, each with up to 50 reviews and 50 rollup contexts — and `doctor` was issuing one per cohort
 * repository for a boolean, which is why the command that calls itself "the cheap check somebody runs first"
 * cost more than a collection. `totalCount` beside `first: 1` is one node and one integer.
 *
 * ALL-TIME rather than windowed, deliberately, and it is the better answer here: nothing can be seen inside a
 * window that cannot be seen at all, and a repository whose last merge predates the window is not a credential
 * fault. The count is a capability check and is never reported as a figure.
 */
export function mergedPullRequestCountQuery(): string {
  return `
        query MergedPullRequestCount($organization: String!, $repository: String!) {
          repository(owner: $organization, name: $repository) {
            pullRequests(states: MERGED, first: 1) { totalCount }
          }
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
 * The default-branch history read for the newest human commit, and nothing else.
 *
 * Separate from `commitHistoryQuery` because it answers a different question at a fraction of the cost: no
 * rollup, no pull-request association and no sizes, so `first: 100` is safe here where it is not there. It is
 * bounded below by `since` alone — the walk stops at the first human commit, which is usually on the first page.
 *
 * Not part of either query signature: nothing it returns is cached as a fact.
 */
export function humanCommitHistoryQuery(): string {
  return `
        query DefaultBranchHumanCommits($organization: String!, $repository: String!, $since: GitTimestamp!, $cursor: String) {
          repository(owner: $organization, name: $repository) {
            defaultBranchRef {
              target {
                ... on Commit {
                  history(first: 100, since: $since, after: $cursor) {
                    pageInfo { hasNextPage endCursor }
                    nodes { committedDate author { name user { login __typename } } }
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
 * Identifies the shape of the data these queries cache, so widening them invalidates the cache.
 *
 * The hash will NOT match the Python implementation's, because the document text is not byte-identical.
 * That is harmless: the signature is only ever compared with itself, so a differing value simply means this
 * build reads and writes its own coverage rows. It matters in exactly one place — importing a Python SQLite
 * cache — where the importer must rewrite the stored hash to this one or every imported row is unreadable.
 */
export function querySignature(): string {
  const documents = `${mergedPullRequestQuery()}${reviewQuery()}${checkQuery()}`.replaceAll(/\s+/g, " ");
  return createHash("sha256").update(documents).digest("hex").slice(0, 16);
}

/**
 * Identifies the shape of the cached commit data, separately from the pull-request queries.
 *
 * Its own signature so that widening one source does not discard the other's settled history: the two are
 * cached under different sources and are refetched independently.
 */
export function commitQuerySignature(): string {
  const documents = commitHistoryQuery().replaceAll(/\s+/g, " ");
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
