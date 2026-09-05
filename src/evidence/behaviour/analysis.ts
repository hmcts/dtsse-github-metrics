import {
  CheckConclusion,
  type CheckFact,
  type DirectCommitFact,
  type DistributionObservation,
  type Merge,
  ObservationStatus,
  type PullRequestFact,
  type RateObservation,
  type ReviewFact,
  ReviewState
} from "../domain/facts.ts";
import { roundHalfEven } from "./rounding.ts";

/**
 * Neutral aggregate evidence calculated from cached facts. Ported from `metrics.analysis`.
 *
 * Nothing here grades anything: these are the counts and percentiles the assessment then judges against
 * configured thresholds. Keeping the two apart is what lets a report show the numbers behind a label.
 */

/** A linearly interpolated percentile from a non-empty sample. */
export function percentile(values: readonly number[], proportion: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  const position = (ordered.length - 1) * proportion;
  const lower = Math.floor(position);
  const upper = Math.min(lower + 1, ordered.length - 1);
  const low = ordered[lower] as number;
  const high = ordered[upper] as number;
  return roundHalfEven(low + (high - low) * (position - lower), 3);
}

/**
 * Whether an authored artefact came from a person rather than from a machine account.
 *
 * Two independent signals, because neither settles it alone: GitHub types an account as `Bot` only where it
 * is a GitHub App, so an ordinary user account driven by automation is typed `User` and gives itself away
 * instead by the `[bot]` suffix convention its login follows. An anonymous author — a commit GitHub could
 * match to no account at all — is nobody, so it is not a person either.
 *
 * One implementation, shared by the review predicate and the contributor count: two spellings of "is this
 * a bot" would eventually disagree about the same account, and a report would then say a review was human
 * and its author was not.
 */
export function isHumanAccount(login: string | undefined, accountType: string | undefined): boolean {
  return login !== undefined && accountType !== "Bot" && !login.toLowerCase().endsWith("[bot]");
}

/** Whether a review has an attributable non-bot author. */
export function isHumanReview(review: ReviewFact): boolean {
  return isHumanAccount(review.authorLogin, review.authorType);
}

/**
 * The distinct people who authored the given merges, leaving out every bot account.
 *
 * Case-folded, because a GitHub login is unique case-insensitively: `Alice` and `alice` are one person, and
 * two spellings of one login would count as two contributors.
 *
 * Bots are excluded here even though the cohort deliberately KEEPS agent-authored merges — see
 * `cohort.excluded_authors`, which drops dependency automation and nothing else. The two rules answer
 * different questions and are meant to differ: agent-authored work is work this report covers, and an agent
 * is still not a person who became active.
 */
export function contributorLogins(changes: Iterable<Merge>): Set<string> {
  const logins = new Set<string>();
  for (const change of changes) {
    const login = change.authorLogin;
    if (login !== undefined && isHumanAccount(login, change.authorType)) {
      logins.add(login.toLowerCase());
    }
  }
  return logins;
}

/** A login without GitHub's bot suffix, for configuration matching. */
export function comparableLogin(login: string | undefined): string {
  const folded = (login ?? "").toLowerCase();
  return folded.endsWith("[bot]") ? folded.slice(0, -"[bot]".length) : folded;
}

/**
 * Whether one commit was authored by a person maintaining the repository.
 *
 * LINKED ACCOUNT FIRST: when GitHub matched the commit's authorship to an account, that account settles the
 * answer. When GitHub links no account, the git author NAME is tested against the same two checks instead,
 * and otherwise counts as human. That fallback is a stated limitation: a name is whatever the committer's
 * tooling wrote, so automation signing an unrecognisable name reads as a person, and a person whose commit
 * email matches no account is judged by their name alone.
 *
 * Deliberately wider than `cohort.excluded_authors` on its own: ALL bot accounts fail, not just dependency
 * automation. An agent-authored commit is work the cohort keeps, but it is not a person maintaining the
 * repository — the same distinction `contributorLogins` draws.
 */
export function isHumanCommitAuthor(
  login: string | undefined,
  accountType: string | undefined,
  authorName: string | undefined,
  excluded: ReadonlySet<string>
): boolean {
  const identity = login ?? authorName;
  const linkedType = login !== undefined ? accountType : undefined;
  return isHumanAccount(identity, linkedType) && !excluded.has(comparableLogin(identity));
}

/** Whether a merge belongs to the reported cohort. */
export function inCohort(change: Merge, excludedAuthors: ReadonlySet<string>): boolean {
  return !excludedAuthors.has(comparableLogin(change.authorLogin));
}

/** The comparable set of authors excluded from the cohort. */
export function excludedAuthors(logins: Iterable<string>): Set<string> {
  return new Set([...logins].map((login) => comparableLogin(login)));
}

/** Submitted human reviews made by someone other than the pull-request author before merge. */
export function eligibleReviews(pullRequest: PullRequestFact): ReviewFact[] {
  const author = (pullRequest.authorLogin ?? "").toLowerCase();
  return pullRequest.reviews.filter(
    (review) =>
      review.submittedAt.getTime() <= pullRequest.mergedAt.getTime() &&
      review.state !== ReviewState.Pending &&
      isHumanReview(review) &&
      review.authorLogin !== undefined &&
      review.authorLogin.toLowerCase() !== author
  );
}

/**
 * The instant one pull request entered review, which is what a waiting time is measured from.
 *
 * NOT `createdAt`. A change opened as a draft and worked on for a fortnight has not been waiting for
 * anybody during that fortnight, and counting the draft period made the two waiting-time metrics measure
 * how long a branch existed rather than how long a finished change waited. The anchor is the earliest
 * ready-for-review event GitHub recorded.
 *
 * An eligible review submitted before that event overrides it. GitHub allows reviewing a draft, and where
 * someone did, review demonstrably began then — taking the earlier of the two keeps that honest and is also
 * what stops a wait from coming out negative.
 *
 * Falls back to `createdAt` when neither is available: a pull request opened ready has no event, and so does
 * a fact cached before the event was collected. Both mean "nothing better is known".
 */
export function reviewStartedAt(pullRequest: PullRequestFact): Date {
  const anchor = pullRequest.readyForReviewAt ?? pullRequest.createdAt;
  const reviews = eligibleReviews(pullRequest);
  if (reviews.length === 0) {
    return anchor;
  }
  const earliest = reviews.reduce(
    (soonest, review) => (review.submittedAt.getTime() < soonest.getTime() ? review.submittedAt : soonest),
    reviews[0]?.submittedAt as Date
  );
  return earliest.getTime() < anchor.getTime() ? earliest : anchor;
}

/**
 * One cohort's review events counted by the state they were submitted in.
 *
 * Every review event is counted, eligible or not: the breakdown exists to show what reviewing looked like,
 * and filtering it to eligible reviews would answer the coverage question twice.
 */
export function reviewStateCounts(pullRequests: Iterable<PullRequestFact>): Record<string, number> {
  const counts = new Map<string, number>();
  for (const pullRequest of pullRequests) {
    for (const review of pullRequest.reviews) {
      counts.set(review.state, (counts.get(review.state) ?? 0) + 1);
    }
  }
  return Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

/**
 * The checks that had finished by the merge instant.
 *
 * A check completing after a merge is not evidence the merge gate saw it, exactly as a review submitted
 * after a merge is ineligible. This is what keeps settled history immutable.
 */
export function eligibleChecks(pullRequest: PullRequestFact): CheckFact[] {
  return pullRequest.checks.filter((check) => check.completedAt !== undefined && check.completedAt.getTime() <= pullRequest.mergedAt.getTime());
}

/** Whether one completed check left the merge unblocked. Neutral and skipped do not block, as GitHub's own rollup treats them. */
export function isPassingCheck(check: CheckFact): boolean {
  return check.conclusion === CheckConclusion.Success || check.conclusion === CheckConclusion.Neutral || check.conclusion === CheckConclusion.Skipped;
}

/** One change's lines and files, or `undefined` when GitHub did not size it. */
export function changeSize(change: Merge): { lines: number; files: number } | undefined {
  if (change.additions === undefined || change.deletions === undefined || change.changedFiles === undefined) {
    return undefined;
  }
  return { lines: change.additions + change.deletions, files: change.changedFiles };
}

/**
 * Classifies a change as trivial, substantial, or unsized.
 *
 * An unsized change stays its own class rather than defaulting either way, so a missing size never silently
 * excuses an unreviewed merge nor inflates the substantial count.
 */
export function sizeClass(change: Merge, maximumLines: number, maximumFiles: number): "trivial" | "substantial" | "unsized" {
  const measured = changeSize(change);
  if (measured === undefined) {
    return "unsized";
  }
  return measured.lines <= maximumLines && measured.files <= maximumFiles ? "trivial" : "substantial";
}

/** An observed rate, or an explicit not-applicable result. */
export function rate(numerator: number, denominator: number): RateObservation {
  return {
    status: denominator > 0 ? ObservationStatus.Observed : ObservationStatus.NotApplicable,
    numerator,
    denominator
  };
}

/**
 * One rate as a percentage to the tenth, or `undefined` when there was no denominator.
 *
 * One implementation, shared by the readiness assessment that phrases it and the trend that compares it
 * between windows: two roundings of the same rate would eventually disagree in the last digit, and the two
 * reports would then describe the same window differently.
 */
export function ratePercentage(observation: RateObservation): number | undefined {
  if (observation.status !== ObservationStatus.Observed) {
    return undefined;
  }
  return roundHalfEven((observation.numerator / observation.denominator) * 100, 1);
}

/** Selected percentiles for one sample, or an explicit not-applicable result. */
export function distribution(values: readonly number[], unit: string): DistributionObservation {
  if (values.length === 0) {
    return { status: ObservationStatus.NotApplicable, sampleSize: 0, unit };
  }
  return {
    status: ObservationStatus.Observed,
    sampleSize: values.length,
    unit,
    median: percentile(values, 0.5),
    percentile75: percentile(values, 0.75),
    percentile90: percentile(values, 0.9)
  };
}

/** Every merge in one window, by either route, in a stable order. */
export function allMerges(pullRequests: readonly PullRequestFact[], directCommits: readonly DirectCommitFact[]): Merge[] {
  return [...pullRequests, ...directCommits];
}
