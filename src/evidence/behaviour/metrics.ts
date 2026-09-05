import type { DirectCommitFact, DistributionObservation, Merges, PullRequestFact, RateObservation, ReviewFact } from "../domain/facts.ts";
import { ReviewState } from "../domain/facts.ts";
import type { TraceabilityConfiguration } from "../policy/schema.ts";
import { distribution, eligibleChecks, eligibleReviews, isHumanReview, isPassingCheck, rate, reviewStartedAt } from "./analysis.ts";

/**
 * The nine behaviour metrics. Ported from `metrics.behaviour_metrics`.
 *
 * Upstream expressed these as an abstract base class with template methods and two `ClassVar`s. Here they
 * are an interface plus plain object literals, which is what the repo's conventions ask for and loses
 * nothing: `governanceRate` and `defineMetric` supply the shared behaviour the base classes did.
 *
 * `percentile` is declared ONCE per metric and read by both the readiness assessment, which grades it, and
 * the trend, which compares it between windows. The two must read the same percentile or they describe the
 * same window differently, and a second copy of the choice is how they would drift apart.
 */

/** Which percentile of a distribution one number is taken from. */
export const Percentile = {
  Median: "median",
  Percentile75: "percentile_75",
  Percentile90: "percentile_90"
} as const;

export type Percentile = (typeof Percentile)[keyof typeof Percentile];

export interface BehaviourMetric {
  identifier: string;
  /**
   * A metric whose summary is a rate has no distribution to read and never consults this; the default keeps
   * every metric answerable rather than adding an optional nobody can act on.
   */
  percentile: Percentile;
  /** This metric's aggregate observation for one merge cohort. */
  summary(cohort: Merges): RateObservation | DistributionObservation;
  /** Classifies one merged pull request for this metric. */
  classification(pullRequest: PullRequestFact): string;
  /**
   * Classifies one direct commit, or `undefined` when this metric does not count commits.
   *
   * `undefined` is the flow metrics' answer: a commit pushed straight to the default branch has no cycle to
   * time and no review to wait for, so padding those samples would invent data.
   */
  commitClassification(directCommit: DirectCommitFact): string | undefined;
  /** This pull request's contribution to the aggregate, when it has one. */
  value(pullRequest: PullRequestFact): number | undefined;
  /** Whether review references belong in this metric's drill-down. */
  includesReviews: boolean;
}

/** Fills in the defaults every metric shares, so each literal states only what makes it different. */
function defineMetric(metric: Partial<BehaviourMetric> & Pick<BehaviourMetric, "identifier" | "summary" | "classification">): BehaviourMetric {
  return {
    percentile: Percentile.Median,
    commitClassification: () => undefined,
    value: () => undefined,
    includesReviews: true,
    ...metric
  };
}

/**
 * A metric measuring the share of merges that satisfy one governance test.
 *
 * The denominator is every change that reached the default branch, BY EITHER ROUTE. A direct commit
 * bypassed the process rather than followed it badly, so counting it anywhere else would let a repository
 * improve its governance rates by skipping pull requests altogether.
 */
function governanceRate(
  metric: Pick<BehaviourMetric, "identifier" | "classification"> & { counted: string; commitClassification?: BehaviourMetric["commitClassification"] }
): BehaviourMetric {
  const commitClassification = metric.commitClassification ?? (() => "direct-commit");
  return defineMetric({
    identifier: metric.identifier,
    classification: metric.classification,
    commitClassification,
    summary(cohort: Merges): RateObservation {
      const classifications = [
        ...cohort.pullRequests.map((pullRequest) => metric.classification(pullRequest)),
        ...cohort.directCommits.map((commit) => commitClassification(commit))
      ];
      return rate(classifications.filter((name) => name === metric.counted).length, classifications.length);
    }
  });
}

/**
 * Why a pull request has no eligible independent review before merge.
 *
 * Shared by the three review-based metrics so one pull request is explained the same way in each.
 */
export function independentReviewClassification(pullRequest: PullRequestFact): string {
  if (pullRequest.reviews.length === 0) {
    return "no-review-events";
  }
  const submitted = pullRequest.reviews.filter((review) => review.submittedAt.getTime() <= pullRequest.mergedAt.getTime());
  const completed = submitted.filter((review) => review.state !== ReviewState.Pending);
  const human = completed.filter((review) => isHumanReview(review));
  if (submitted.length === 0) {
    return "reviews-after-merge";
  }
  if (completed.length === 0) {
    return "pending-reviews-only";
  }
  if (human.length === 0) {
    return "bot-or-unattributed-reviews-only";
  }
  return "author-reviews-only";
}

const HOURS = 3_600_000;

/** Merges into the default branch carrying independent human review. */
export const independentReviewCoverage = governanceRate({
  identifier: "independent-review-coverage",
  counted: "included",
  classification: (pullRequest) => (eligibleReviews(pullRequest).length > 0 ? "included" : independentReviewClassification(pullRequest))
});

/**
 * Merges into the default branch carrying independent approval.
 *
 * Graded beside review coverage rather than folded into it: an approval is the reviewer's explicit
 * sign-off, and a team that reviews without ever approving leaves no record of who accepted the change.
 */
export const approvalCoverage = governanceRate({
  identifier: "approval-coverage",
  counted: "included",
  classification: (pullRequest) => {
    const reviews = eligibleReviews(pullRequest);
    if (reviews.some((review) => review.state === ReviewState.Approved)) {
      return "included";
    }
    if (reviews.length > 0) {
      return "independent-review-without-approval";
    }
    return independentReviewClassification(pullRequest);
  }
});

/** The eligible reviews that approved one pull request. */
function approvingReviews(pullRequest: PullRequestFact): ReviewFact[] {
  return eligibleReviews(pullRequest).filter((review) => review.state === ReviewState.Approved);
}

/**
 * Whether one review event said anything at all, inline or as its own summary.
 *
 * BOTH, because GitHub records them separately and a reviewer may use either: "this changes the retry
 * semantics, I checked X" with no inline comment is not a wordless click, and counting only `comments`
 * would score it as one. Presence, not length — `description-quality` grades how much was written about a
 * change, and no boundary for how much a review must say has an owner.
 */
function spoke(review: ReviewFact): boolean {
  return review.commentCount > 0 || (review.body ?? "").trim() !== "";
}

/**
 * Whether the reviewer behind one approval said anything on that pull request.
 *
 * Every eligible review by that reviewer counts, whenever it was submitted: remarks left before the
 * approval are the normal case, and a reviewer who answers a question after approving has still
 * scrutinised the change. `eligibleReviews` has already excluded the author's own reviews, bot reviews,
 * and anything submitted after the merge.
 */
function commented(pullRequest: PullRequestFact, approval: ReviewFact): boolean {
  return eligibleReviews(pullRequest).some((review) => review.authorLogin === approval.authorLogin && spoke(review));
}

/**
 * Whether an approval means anything: the share backed by something the reviewer said.
 *
 * Rated over eligible approving reviews, not over merges — a repository with 100% approval coverage where
 * every approval is a wordless click is exactly the gap this closes.
 *
 * An approval is judged against everything ITS OWN REVIEWER said on that pull request, not against the
 * approval event alone. Approving is a click, and GitHub records it as a review of its own: the common way
 * to review is to leave the remarks first, as `COMMENTED` reviews, and come back to approve once they are
 * answered. Reading only the approval scores that reviewer as a rubber stamp and is simply wrong about what
 * happened — on one repository it classified 70 pull requests carrying 224 comment-reviews from a
 * non-author as `uncommented-approval-only`.
 *
 * Attribution stays PER REVIEWER rather than per pull request. Where two approvals are required and one
 * reviewer argues the change through while the second clicks approve in silence, the second approval
 * carries no scrutiny and the metric must still say so; crediting it with the first reviewer's comments
 * would hide exactly the rubber stamp this exists to find.
 */
export const reviewDepth = defineMetric({
  identifier: "review-depth",
  summary(cohort: Merges): RateObservation {
    const approvals = cohort.pullRequests.flatMap((pullRequest) => approvingReviews(pullRequest).map((approval) => ({ pullRequest, approval })));
    return rate(approvals.filter(({ pullRequest, approval }) => commented(pullRequest, approval)).length, approvals.length);
  },
  classification(pullRequest: PullRequestFact): string {
    const approving = approvingReviews(pullRequest);
    if (approving.length === 0) {
      return "no-eligible-approval";
    }
    return approving.some((approval) => commented(pullRequest, approval)) ? "commented" : "uncommented-approval-only";
  }
});

/**
 * Elapsed time between a change entering review and being merged.
 *
 * Measured from `reviewStartedAt`, not from `createdAt`: a change opened as a draft and worked on for a
 * fortnight was not waiting on the merge gate during that fortnight, and anchoring on creation made this
 * metric report how long a branch existed. That is a different question, and grading it as cycle time held
 * well-reviewed repositories at a shortfall for their own working style.
 */
export const mergeCycleTime = defineMetric({
  identifier: "merge-cycle-time",
  // Read at the median: how long a typical change waits, undistorted by the one that stalled.
  percentile: Percentile.Median,
  includesReviews: false,
  summary(cohort: Merges): DistributionObservation {
    return distribution(
      cohort.pullRequests.map((fact) => (fact.mergedAt.getTime() - reviewStartedAt(fact).getTime()) / HOURS),
      "hours"
    );
  },
  classification: () => "included",
  value: (pullRequest) => (pullRequest.mergedAt.getTime() - reviewStartedAt(pullRequest).getTime()) / HOURS
});

/**
 * How long a merged pull request waited for its first independent review.
 *
 * Measured from `reviewStartedAt`, so time spent in draft is not counted as waiting: nobody was asked to
 * look at the change yet, and charging that delay to the reviewers described the wrong team.
 */
export const timeToFirstReview = defineMetric({
  identifier: "time-to-first-review",
  // Read at the median: a property of how a team works, not of its slowest single review.
  percentile: Percentile.Median,
  summary(cohort: Merges): DistributionObservation {
    const waits = cohort.pullRequests.map((fact) => timeToFirstReviewValue(fact)).filter((wait): wait is number => wait !== undefined);
    return distribution(waits, "hours");
  },
  classification: (pullRequest) => (eligibleReviews(pullRequest).length > 0 ? "included" : independentReviewClassification(pullRequest)),
  value: (pullRequest) => timeToFirstReviewValue(pullRequest)
});

function timeToFirstReviewValue(pullRequest: PullRequestFact): number | undefined {
  const reviews = eligibleReviews(pullRequest);
  if (reviews.length === 0) {
    return undefined;
  }
  const first = reviews.reduce(
    (soonest, review) => (review.submittedAt.getTime() < soonest.getTime() ? review.submittedAt : soonest),
    reviews[0]?.submittedAt as Date
  );
  return (first.getTime() - reviewStartedAt(pullRequest).getTime()) / HOURS;
}

/** How many lines each merged pull request changed. */
export const pullRequestSize = defineMetric({
  identifier: "pull-request-size",
  // Read at the 75th percentile: a long tail of large changes is the risk, not the typical size.
  percentile: Percentile.Percentile75,
  includesReviews: false,
  summary(cohort: Merges): DistributionObservation {
    // Pull-request size keeps meaning pull-request size: a direct commit is sized too, but folding it in
    // here would rename the metric without saying so. Its size is reported with the finding it supports.
    const sizes = cohort.pullRequests.map((fact) => pullRequestSizeValue(fact)).filter((size): size is number => size !== undefined);
    return distribution(sizes, "lines");
  },
  classification: (pullRequest) => (pullRequestSizeValue(pullRequest) !== undefined ? "included" : "size-unavailable"),
  value: (pullRequest) => pullRequestSizeValue(pullRequest)
});

function pullRequestSizeValue(pullRequest: PullRequestFact): number | undefined {
  if (pullRequest.additions === undefined || pullRequest.deletions === undefined) {
    return undefined;
  }
  return pullRequest.additions + pullRequest.deletions;
}

/** GitHub's rollup states, mapped onto the vocabulary a merged pull request already uses. */
const COMMIT_CHECK_STATES: Record<string, string> = {
  SUCCESS: "passing",
  FAILURE: "failing",
  ERROR: "failing",
  PENDING: "checks-unfinished",
  EXPECTED: "checks-unfinished"
};

/** Merges into the default branch whose status checks had passed. */
export const checksPassingAtMerge = governanceRate({
  identifier: "checks-passing-at-merge",
  counted: "passing",
  classification(pullRequest: PullRequestFact): string {
    if (pullRequest.checks.length === 0) {
      return "no-checks";
    }
    const completed = eligibleChecks(pullRequest);
    if (!completed.every((check) => isPassingCheck(check))) {
      return "failing";
    }
    if (completed.length < pullRequest.checks.length) {
      return "incomplete-at-merge";
    }
    return "passing";
  },
  /**
   * Judged by conclusion rather than as at an instant, unlike a pull request. Nothing gated the push, so
   * there is no merge point to measure against and no check could have finished before the commit existed;
   * requiring one would report every direct commit as unchecked and hide the difference between a
   * repository whose CI runs on the default branch and one whose does not.
   */
  commitClassification(directCommit: DirectCommitFact): string {
    if (directCommit.checkState === undefined) {
      return "no-checks";
    }
    return COMMIT_CHECK_STATES[directCommit.checkState] ?? "no-checks";
  }
});

/**
 * The share of merged pull requests whose description meets a minimum length.
 *
 * A neutral aggregate only: a documentation habit is not evidence a change was governed, and no threshold
 * here has an owner, so this never enters the readiness label. Direct commits are never counted — there was
 * no pull request, so there is no description to judge.
 */
export function descriptionQuality(traceability: TraceabilityConfiguration): BehaviourMetric {
  const described = (pullRequest: PullRequestFact) => (pullRequest.body ?? "").trim().length >= traceability.minimum_description;
  return defineMetric({
    identifier: "description-quality",
    includesReviews: false,
    summary: (cohort) => rate(cohort.pullRequests.filter((pullRequest) => described(pullRequest)).length, cohort.pullRequests.length),
    classification: (pullRequest) => (described(pullRequest) ? "described" : "description-too-short")
  });
}

/**
 * The share of merged pull requests that reference an issue or ticket.
 *
 * A neutral aggregate only, for the same reason as `description-quality`: it never enters the readiness
 * label. Title and body are both searched, because a ticket key in the title is traceability too, and
 * insisting on the body would fail a team whose convention is the title. Direct commits are never counted —
 * there was no pull request to carry a reference.
 */
export function traceabilityReference(traceability: TraceabilityConfiguration): BehaviourMetric {
  // Compiled once, rather than per pull request.
  const patterns = traceability.reference_patterns.map((pattern) => new RegExp(pattern));
  const references = (pullRequest: PullRequestFact) => {
    const text = `${pullRequest.title ?? ""}\n${pullRequest.body ?? ""}`;
    return patterns.some((pattern) => pattern.test(text));
  };
  return defineMetric({
    identifier: "traceability-reference",
    includesReviews: false,
    summary: (cohort) => rate(cohort.pullRequests.filter((pullRequest) => references(pullRequest)).length, cohort.pullRequests.length),
    classification: (pullRequest) => (references(pullRequest) ? "referenced" : "reference-missing")
  });
}

/** Every available behaviour metric, in the order a report presents them. */
export function behaviourMetrics(traceability: TraceabilityConfiguration): BehaviourMetric[] {
  return [
    independentReviewCoverage,
    approvalCoverage,
    reviewDepth,
    mergeCycleTime,
    timeToFirstReview,
    pullRequestSize,
    checksPassingAtMerge,
    descriptionQuality(traceability),
    traceabilityReference(traceability)
  ];
}

/** The behaviour metric registered for an identifier. */
export function behaviourMetric(identifier: string, traceability: TraceabilityConfiguration): BehaviourMetric {
  const found = behaviourMetrics(traceability).find((metric) => metric.identifier === identifier);
  if (found === undefined) {
    throw new RangeError(`unknown behaviour metric: ${identifier}`);
  }
  return found;
}

/** Every accepted behaviour metric identifier, for the CLI's `--metric` choices. */
export function behaviourMetricIdentifiers(): string[] {
  return behaviourMetrics({ minimum_description: 30, reference_patterns: [] }).map((metric) => metric.identifier);
}
