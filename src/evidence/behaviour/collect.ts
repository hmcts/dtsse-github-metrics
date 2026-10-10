import { AvailabilityReason, GitHubError } from "../domain/availability.ts";
import { CheckConclusion, type CheckFact, type DirectCommitFact, type PullRequestFact, type ReviewFact, type ReviewState } from "../domain/facts.ts";
import { type MaintenanceEvidence, maintenanceEvidence } from "../domain/standards.ts";
import type { GitHubClient } from "../github/client.ts";
import type { TraceabilityConfiguration } from "../policy/schema.ts";
import { githubTimestamp } from "../window/instant.ts";
import type { ReportingWindow } from "../window/window.ts";
import { isHumanCommitAuthor } from "./analysis.ts";
import { checkQuery, commitHistoryQuery, humanCommitHistoryQuery, mergedPullRequestQuery, reviewQuery } from "./queries.ts";
import {
  type CheckConnection,
  type CheckContext,
  type CommitConnection,
  type CommitNode,
  checkPageSchema,
  commitHistorySchema,
  type HumanCommitNode,
  humanCommitHistorySchema,
  type MergedPullRequestNode,
  mergedPullRequestSchema,
  type PullRequestNode,
  parseResponse,
  type ReviewConnection,
  type ReviewNode,
  reviewPageSchema
} from "./responses.ts";

/**
 * Collecting behaviour facts from GitHub. Ported from `metrics.behaviour`'s collection half.
 */

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

/** The two answers a description is reduced to, which is all any report reads of it. */
export interface DescriptionAnswers {
  bodyLength: number;
  hasTicketReference: boolean;
}

/**
 * The configured patterns, compiled once.
 *
 * Beside `describedBy` because `reference_patterns` is read in exactly the places the patterns are applied, and
 * there are two of those now — a collection and the backfill over rows a collection will never rewrite. The
 * schema has already rejected a pattern that does not compile, at load time.
 */
export function referencePatterns(traceability: TraceabilityConfiguration): RegExp[] {
  return traceability.reference_patterns.map((pattern) => new RegExp(pattern));
}

/**
 * The two things a pull request's title and description are ever asked, decided HERE and stored as answers.
 *
 * Everything a report wants of a description is a predicate over it, and the descriptions themselves were two
 * thirds of the stored fact payload — 61 MB of `body` at 26 weeks against a 93 MB total, read off disk on
 * every render to reach a length and a regex match. Reducing them once, where the fact is built, is a few
 * bytes a row instead.
 *
 * THIS IS THE ONLY PLACE `reference_patterns` IS APPLIED. `traceabilityReference` reads the boolean and holds
 * no regexes of its own, so there is no second implementation for the two to disagree about — but it does mean
 * an edited pattern list regrades nothing already cached. Stated on the field and at the metric.
 *
 * The reference is searched in the TITLE AND THE BODY TOGETHER, joined the way the metric joined them, because
 * a ticket key in the title is traceability too and insisting on the body would fail a team whose convention
 * is the title.
 *
 * EXPORTED, and taking a title and a body rather than a GitHub node, for the one other caller that has to reach
 * the same answers: `store/descriptions.ts` reduces the descriptions of rows cached before these fields existed.
 * That is a backfill of this function's output over stored text, so it calls this — the alternative was a second
 * implementation, in SQL, which is precisely what the paragraph above says the design avoids.
 */
export function describedBy(source: { title?: string | null; body?: string | null }, patterns: readonly RegExp[]): DescriptionAnswers {
  const title = source.title ?? "";
  const body = source.body ?? "";
  return {
    // Trimmed here, so the stored length is the one the threshold is compared against: whitespace is not a
    // description, and `description-quality` measured it as one for as long as it trimmed at read time.
    bodyLength: body.trim().length,
    hasTicketReference: patterns.some((pattern) => pattern.test(`${title}\n${body}`))
  };
}

/** Converts one GitHub pull request and its complete reviews into a compact fact. */
async function pullRequestFact(
  client: GitHubClient,
  organization: string,
  repository: string,
  node: PullRequestNode,
  patterns: readonly RegExp[]
): Promise<PullRequestFact> {
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
    // ALWAYS PRESENT, including for a pull request opened with no description at all: GitHub answered, and the
    // answer is a length of zero. Absent is reserved for a row cached before these fields existed.
    ...describedBy(node, patterns),
    ...(node.additions == null ? {} : { additions: node.additions }),
    ...(node.deletions == null ? {} : { deletions: node.deletions }),
    ...(node.changedFiles == null ? {} : { changedFiles: node.changedFiles }),
    checks: await collectChecks(client, organization, repository, node.number, headCommitChecks(node.commits))
  };
}

/**
 * The pull requests on one page merged inside the window, and whether the page reached a node updated before it.
 *
 * `mergedAt <= updatedAt` always, and the walk is ordered by `updatedAt` descending, so a node updated before the
 * window opened cannot have been merged inside it and neither can anything after it.
 */
function mergedOnPage(
  nodes: readonly (MergedPullRequestNode | null | undefined)[],
  startsAt: Date,
  endsAt: Date
): { merged: MergedPullRequestNode[]; reachedTheWindow: boolean } {
  const merged: MergedPullRequestNode[] = [];
  for (const node of nodes) {
    if (node == null) {
      continue;
    }
    if (node.updatedAt.getTime() < startsAt.getTime()) {
      return { merged, reachedTheWindow: true };
    }
    if (node.mergedAt.getTime() >= startsAt.getTime() && node.mergedAt.getTime() < endsAt.getTime()) {
      merged.push(node);
    }
  }
  return { merged, reachedTheWindow: false };
}

/**
 * Collects the merged pull requests inside one window.
 *
 * The WINDOW is half-open, so membership is `startsAt <= mergedAt < endsAt` and is decided per node rather than
 * left to the query — the walk is ordered by last touch, which says nothing about when a change merged.
 *
 * Keyed by identifier while collecting, so a node returned twice cannot be counted twice, and sorted by
 * `(mergedAt, identifier)` at the end so two merges at one instant cannot reorder between runs.
 */
export async function collectMergedPullRequests(
  client: GitHubClient,
  organization: string,
  repository: string,
  startsAt: Date,
  endsAt: Date,
  traceability: TraceabilityConfiguration
): Promise<PullRequestFact[]> {
  const facts = new Map<number, PullRequestFact>();
  // Compiled once per repository rather than per pull request, matching what `traceabilityReference` did with
  // them when it held them.
  const patterns = referencePatterns(traceability);
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
    const { merged, reachedTheWindow } = mergedOnPage(connection.nodes, startsAt, endsAt);
    for (const node of merged) {
      const fact = await pullRequestFact(client, organization, repository, node, patterns);
      facts.set(fact.identifier, fact);
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

/** How many history pages the human-commit search reads before it gives up and says how far it got. */
export const HUMAN_COMMIT_PAGE_CAP = 10;

/**
 * The first human commit on one page of history, or else the oldest commit read so far, carrying `oldest` in from
 * the pages before it.
 */
function scanForHumanCommit(
  nodes: readonly (HumanCommitNode | null | undefined)[],
  oldest: Date | undefined,
  excluded: ReadonlySet<string>,
  bots: ReadonlySet<string>
): { lastHumanCommitAt: Date } | { oldest: Date | undefined } {
  let oldestSoFar = oldest;
  for (const node of nodes) {
    if (node == null) {
      continue;
    }
    if (isHumanCommitAuthor(node.author?.user?.login, node.author?.user?.__typename, node.author?.name ?? undefined, excluded, bots)) {
      return { lastHumanCommitAt: node.committedDate };
    }
    if (oldestSoFar === undefined || node.committedDate.getTime() < oldestSoFar.getTime()) {
      oldestSoFar = node.committedDate;
    }
  }
  return { oldest: oldestSoFar };
}

/**
 * The newest human commit on the default branch since `since`, or how far back the search looked for one.
 *
 * Stops at the FIRST commit passing `isHumanCommitAuthor`: history is walked newest first, so that is the answer.
 * Where none is found the two endings are told apart. A walk that ran out of history reached `since`, so that
 * is how far back it looked; a walk that hit `HUMAN_COMMIT_PAGE_CAP` looked only as far as the oldest commit it
 * read, and the report must not read beyond it as "nobody". A branch with no commits returns neither instant. A
 * repository GitHub omitted, or a capped walk that read no commit at all, throws: neither is an answer.
 */
export async function findLastHumanCommit(
  client: GitHubClient,
  organization: string,
  repository: string,
  since: Date,
  excluded: ReadonlySet<string>,
  bots: ReadonlySet<string>
): Promise<MaintenanceEvidence> {
  let cursor: string | null = null;
  let oldest: Date | undefined;
  for (let page = 0; page < HUMAN_COMMIT_PAGE_CAP; page += 1) {
    // `unknown` for the same circularity reason as the pull-request loop above.
    const data: unknown = await client.graphql(humanCommitHistoryQuery(), { organization, repository, since: githubTimestamp(since), cursor });
    const parsed = parseResponse(humanCommitHistorySchema, data, "commit history data");
    if (parsed.repository == null) {
      // Not an empty branch: a repository GitHub left out is unknown, and reading it as "nobody committed" would
      // answer every window "no".
      throw new GitHubError("GitHub omitted the repository while searching for the last human commit", AvailabilityReason.CollectionFailed);
    }
    const history = parsed.repository.defaultBranchRef?.target?.history;
    if (history === undefined || history === null) {
      // An empty repository, or one whose default branch nobody has pushed to.
      return maintenanceEvidence({});
    }
    const scanned = scanForHumanCommit(history.nodes, oldest, excluded, bots);
    if ("lastHumanCommitAt" in scanned) {
      return maintenanceEvidence(scanned);
    }
    oldest = scanned.oldest;
    if (!history.pageInfo.hasNextPage) {
      return maintenanceEvidence({ searchedBackTo: since });
    }
    cursor = history.pageInfo.endCursor ?? null;
  }
  if (oldest === undefined) {
    // Every capped page came back without a commit, so nothing was searched; `since` would claim all of it was.
    throw new GitHubError("GitHub returned no commits on any page while searching for the last human commit", AvailabilityReason.CollectionFailed);
  }
  return maintenanceEvidence({ searchedBackTo: oldest });
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
