import { AvailabilityReason, GitHubError } from "../domain/availability.ts";
import { CheckConclusion, type CheckFact, type DirectCommitFact, type PullRequestFact, type ReviewFact, type ReviewState } from "../domain/facts.ts";
import type { GitHubClient } from "../github/client.ts";
import { githubTimestamp } from "../window/instant.ts";
import type { ReportingWindow } from "../window/window.ts";
import { checkQuery, commitHistoryQuery, mergedPullRequestQuery, openPullRequestQuery, openPullRequestSearchQueries, reviewQuery } from "./queries.ts";
import {
  type CheckConnection,
  type CheckContext,
  type CommitConnection,
  type CommitNode,
  checkPageSchema,
  commitHistorySchema,
  mergedPullRequestSchema,
  openPullRequestSchema,
  type PullRequestNode,
  parseResponse,
  type ReviewConnection,
  type ReviewNode,
  reviewPageSchema
} from "./responses.ts";
/**
 * Collecting behaviour facts from GitHub. Ported from `metrics.behaviour`'s collection half.
 */
/** Open pull-request counts for one window, never cached. */
export interface OpenPullRequestSummary {
  openedInWindow: number;
  closedWithoutMerge: number;
  currentlyOpen: number;
  staleOpen: number;
}
/** Maps a legacy commit-status state onto a check conclusion. */
export function statusConclusion(state: string): CheckConclusion | undefined {
  const mapped: Record<string, CheckConclusion> = {
    SUCCESS: CheckConclusion.Success,
    FAILURE: CheckConclusion.Failure,
    ERROR: CheckConclusion.Failure
  };
  return mapped[state];
}
/**
 * Normalises a check run or a legacy status context into one compact fact.
 *
 * A check that has not settled carries no conclusion and no completion instant, so a check still running at
 * merge stays distinguishable from one that finished and failed.
 */
export function checkFact(context: CheckContext): CheckFact {
  if (context.__typename === "CheckRun") {
    const completed = context.status === "COMPLETED";
    const conclusion = completed && context.conclusion ? (context.conclusion as CheckConclusion) : undefined;
    return {
      name: context.name ?? "",
      ...(conclusion === undefined ? {} : { conclusion }),
      ...(completed && context.completedAt ? { completedAt: context.completedAt } : {})
    };
  }
  const conclusion = statusConclusion(context.state ?? "");
  return {
    name: context.context ?? "",
    ...(conclusion === undefined ? {} : { conclusion }),
    ...(conclusion !== undefined && context.createdAt ? { completedAt: context.createdAt } : {})
  };
}
/** Converts one GitHub review into a compact internal fact. */
export function reviewFact(review: ReviewNode): ReviewFact {
  return {
    identifier: review.databaseId,
    submittedAt: review.submittedAt,
    state: review.state as ReviewState,
    ...(review.author?.login === undefined ? {} : { authorLogin: review.author.login }),
    ...(review.author?.__typename === undefined ? {} : { authorType: review.author.__typename }),
    commentCount: review.comments.totalCount,
    ...((review.body ?? "").trim() === "" ? {} : { body: review.body as string })
  };
}
/** The rollup contexts of a pull request's head commit, if it has any. */
export function headCommitChecks(commits: CommitConnection): CheckConnection | undefined {
  const first = commits.nodes[0];
  return first?.commit.statusCheckRollup?.contexts ?? undefined;
}
/** Collects all review pages, issuing follow-ups only after a bounded connection overflows. */
async function collectReviews(
  client: GitHubClient,
  organization: string,
  repository: string,
  number: number,
  connection: ReviewConnection
): Promise<ReviewFact[]> {
  const reviews = connection.nodes.filter((node): node is ReviewNode => node != null).map((node) => reviewFact(node));
  let info = connection.pageInfo;
  while (info.hasNextPage) {
    const data = await client.graphql(reviewQuery(), { organization, repository, number, cursor: info.endCursor ?? null });
    const parsed = parseResponse(reviewPageSchema, data, "review behaviour data");
    const next = parsed.repository?.pullRequest?.reviews;
    if (next === undefined || next === null) {
      throw new GitHubError("GitHub omitted a pull request while collecting reviews", AvailabilityReason.CollectionFailed);
    }
    reviews.push(...next.nodes.filter((node): node is ReviewNode => node != null).map((node) => reviewFact(node)));
    info = next.pageInfo;
  }
  return reviews;
}
/** Collects all rollup pages, issuing follow-ups only after a bounded connection overflows. */
async function collectChecks(
  client: GitHubClient,
  organization: string,
  repository: string,
  number: number,
  connection: CheckConnection | undefined
): Promise<CheckFact[]> {
  if (connection === undefined) {
    return [];
  }
  const checks = connection.nodes.filter((node): node is CheckContext => node != null).map((node) => checkFact(node));
  let info = connection.pageInfo;
  while (info.hasNextPage) {
    const data = await client.graphql(checkQuery(), { organization, repository, number, cursor: info.endCursor ?? null });
    const parsed = parseResponse(checkPageSchema, data, "status-check data");
    const next = parsed.repository?.pullRequest?.commits === undefined ? undefined : headCommitChecks(parsed.repository.pullRequest.commits);
    if (next === undefined) {
      throw new GitHubError("GitHub omitted a pull request while collecting status checks", AvailabilityReason.CollectionFailed);
    }
    checks.push(...next.nodes.filter((node): node is CheckContext => node != null).map((node) => checkFact(node)));
    info = next.pageInfo;
  }
  return checks;
}
/** Converts one GitHub pull request and its complete reviews into a compact fact. */
async function pullRequestFact(client: GitHubClient, organization: string, repository: string, node: PullRequestNode): Promise<PullRequestFact> {
  const readyForReviewAt = node.timelineItems.nodes.find((event) => event?.createdAt != null)?.createdAt ?? undefined;
  return {
    identifier: node.databaseId,
    repository,
    number: node.number,
    createdAt: node.createdAt,
    mergedAt: node.mergedAt,
    draft: node.isDraft,
    ...(readyForReviewAt === undefined ? {} : { readyForReviewAt }),
    ...(node.author?.login === undefined ? {} : { authorLogin: node.author.login }),
    ...(node.author?.__typename === undefined ? {} : { authorType: node.author.__typename }),
    reviews: await collectReviews(client, organization, repository, node.number, node.reviews),
    ...(node.title == null ? {} : { title: node.title }),
    ...(node.body == null ? {} : { body: node.body }),
    ...(node.additions == null ? {} : { additions: node.additions }),
    ...(node.deletions == null ? {} : { deletions: node.deletions }),
    ...(node.changedFiles == null ? {} : { changedFiles: node.changedFiles }),
    checks: await collectChecks(client, organization, repository, node.number, headCommitChecks(node.commits))
  };
}
/**
 * Collects merged pull requests in date shards, deduplicating inclusive search boundaries.
 *
 * TWO CONVENTIONS MEET HERE. Shard boundaries are inclusive, so consecutive shards overlap by one second and
 * a merge landing on a boundary is returned twice — hence the map keyed by identifier. The WINDOW is
 * half-open, which is why membership is decided again per page against `startsAt <= mergedAt < endsAt`.
 *
 * Sorted by `(mergedAt, identifier)` at the end, so two merges at one instant cannot reorder between runs.
 */
export async function collectMergedPullRequests(
  client: GitHubClient,
  organization: string,
  repository: string,
  startsAt: Date,
  endsAt: Date
): Promise<PullRequestFact[]> {
  const facts = new Map<number, PullRequestFact>();
  let cursor: string | null = null;
  for (;;) {
    // Annotated `unknown` deliberately: without it the inferred type of `data` flows through
    // `parseResponse` and back into this loop's own initializer, which TypeScript reports as circular.
    const data: unknown = await client.graphql(mergedPullRequestQuery(), { organization, repository, cursor });
    const parsed = parseResponse(mergedPullRequestSchema, data, "pull-request behaviour data");
    const connection = parsed.repository?.pullRequests;
    if (connection === undefined || connection === null) {
      throw new GitHubError("GitHub omitted the repository while collecting merged pull requests", AvailabilityReason.CollectionFailed);
    }
    let reachedTheWindow = false;
    for (const node of connection.nodes) {
      if (node == null) {
        continue;
      }
      // `mergedAt <= updatedAt` always, and the walk is ordered by `updatedAt` descending, so a node updated
      // before the window opened cannot have been merged inside it and neither can anything after it.
      if (node.updatedAt.getTime() < startsAt.getTime()) {
        reachedTheWindow = true;
        break;
      }
      if (node.mergedAt.getTime() >= startsAt.getTime() && node.mergedAt.getTime() < endsAt.getTime()) {
        const fact = await pullRequestFact(client, organization, repository, node);
        facts.set(fact.identifier, fact);
      }
    }
    if (reachedTheWindow || !connection.pageInfo.hasNextPage) {
      break;
    }
    cursor = connection.pageInfo.endCursor ?? null;
  }
  return [...facts.values()].sort((left, right) => left.mergedAt.getTime() - right.mergedAt.getTime() || left.identifier - right.identifier);
}
/** Converts one default-branch commit into a compact fact. */
export function directCommitFact(node: CommitNode, repository: string): DirectCommitFact {
  return {
    sha: node.oid,
    repository,
    committedAt: node.committedDate,
    ...(node.author?.user?.login === undefined ? {} : { authorLogin: node.author.user.login }),
    ...(node.author?.user?.__typename === undefined ? {} : { authorType: node.author.user.__typename }),
    ...(node.author?.name == null ? {} : { authorName: node.author.name }),
    ...(node.additions == null ? {} : { additions: node.additions }),
    ...(node.deletions == null ? {} : { deletions: node.deletions }),
    ...(node.changedFilesIfAvailable == null ? {} : { changedFiles: node.changedFilesIfAvailable }),
    ...(node.statusCheckRollup?.state == null ? {} : { checkState: node.statusCheckRollup.state })
  };
}
/**
 * Collects the default-branch commits in a window that no pull request introduced.
 *
 * GitHub's `since` and `until` bound the walk but are INCLUSIVE, so membership is decided again here against
 * the half-open window every other cohort is built from.
 */
export async function collectDirectCommits(
  client: GitHubClient,
  organization: string,
  repository: string,
  startsAt: Date,
  endsAt: Date
): Promise<DirectCommitFact[]> {
  const facts = new Map<string, DirectCommitFact>();
  let cursor: string | null = null;
  for (;;) {
    // `unknown` for the same circularity reason as the pull-request loop above.
    const data: unknown = await client.graphql(commitHistoryQuery(), {
      organization,
      repository,
      since: githubTimestamp(startsAt),
      until: githubTimestamp(endsAt),
      cursor
    });
    const parsed = parseResponse(commitHistorySchema, data, "commit history data");
    const history = parsed.repository?.defaultBranchRef?.target?.history;
    if (history === undefined || history === null) {
      // An empty repository, or one whose default branch nobody has pushed to: no history is not a failure.
      break;
    }
    for (const node of history.nodes) {
      if (node == null) {
        continue;
      }
      const introducedByPullRequest = node.associatedPullRequests.nodes.some((entry) => entry != null);
      const inWindow = node.committedDate.getTime() >= startsAt.getTime() && node.committedDate.getTime() < endsAt.getTime();
      if (!introducedByPullRequest && inWindow) {
        facts.set(node.oid, directCommitFact(node, repository));
      }
    }
    if (!history.pageInfo.hasNextPage) {
      break;
    }
    cursor = history.pageInfo.endCursor ?? null;
  }
  return [...facts.values()].sort((left, right) => left.committedAt.getTime() - right.committedAt.getTime() || left.sha.localeCompare(right.sha));
}
/**
 * Fetches open pull-request counts in one call, fresh every time.
 *
 * What a collection stores is a snapshot of this state on the repository's row, which every other run
 * reports from; this is the observation itself, and its answer is never read back out of the windowed fact
 * cache.
 *
 * `staleOpen` is measured from each pull request's LAST UPDATE, not from when it was opened.
 */
export async function collectOpenPullRequestState(
  client: GitHubClient,
  organization: string,
  repository: string,
  window: ReportingWindow,
  staleOpenDays: number,
  reference: Date
): Promise<OpenPullRequestSummary> {
  const staleCutoff = new Date(reference.getTime() - staleOpenDays * 86_400_000);
  const queries = openPullRequestSearchQueries(organization, repository, window, staleCutoff);
  const data = await client.graphql(openPullRequestQuery(), queries);
  const parsed = parseResponse(openPullRequestSchema, data, "open pull-request data");
  return {
    openedInWindow: parsed.openedInWindow.issueCount,
    closedWithoutMerge: parsed.closedWithoutMerge.issueCount,
    currentlyOpen: parsed.currentlyOpen.issueCount,
    staleOpen: parsed.staleOpen.issueCount
  };
}
/**
 * The instant a window stops being settled history.
 *
 * A merge is anchored to the instant it reached the branch, so this only absorbs GitHub's eventually
 * consistent search index and checks still running on a very recent change.
 */
export function mutableEdge(window: ReportingWindow, mutableHours: number, reference: Date): Date {
  const edge = Math.min(window.endsAt.getTime(), reference.getTime() - mutableHours * 3_600_000);
  return new Date(Math.max(window.startsAt.getTime(), edge));
}
