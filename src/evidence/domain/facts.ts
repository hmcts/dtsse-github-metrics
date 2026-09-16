/**
 * The facts a collection caches, and the observations derived from them. Ported from `metrics.domain`.
 *
 * A merged pull request and a direct commit are different evidence and stay different types, but
 * attribution and size are asked of both — hence `Merge`, which is what the predicates that answer those
 * two questions accept.
 */

/** Whether an observation was made, or did not apply. */
export const ObservationStatus = {
  Observed: "observed",
  NotApplicable: "not_applicable"
} as const;

export type ObservationStatus = (typeof ObservationStatus)[keyof typeof ObservationStatus];

export const ReviewState = {
  Approved: "APPROVED",
  ChangesRequested: "CHANGES_REQUESTED",
  Commented: "COMMENTED",
  Dismissed: "DISMISSED",
  Pending: "PENDING"
} as const;

export type ReviewState = (typeof ReviewState)[keyof typeof ReviewState];

export const CheckConclusion = {
  Success: "SUCCESS",
  Failure: "FAILURE",
  Neutral: "NEUTRAL",
  Skipped: "SKIPPED",
  Cancelled: "CANCELLED",
  TimedOut: "TIMED_OUT",
  ActionRequired: "ACTION_REQUIRED",
  StartupFailure: "STARTUP_FAILURE",
  Stale: "STALE"
} as const;

export type CheckConclusion = (typeof CheckConclusion)[keyof typeof CheckConclusion];

/**
 * What any merge into the default branch can be asked, by either route.
 *
 * Attribution is BOTH fields: a login says who, and the account type says whether that who is a person. A
 * caller counting people needs the pair, and a shape carrying only the login would push each caller into
 * reading the type off the concrete fact it was handed.
 */
export interface Merge {
  authorLogin?: string;
  authorType?: string;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
}

/** One review event, reduced to the fields that classify it. */
export interface ReviewFact {
  /**
   * GitHub's own id. A plain `number` is safe here where the stored pull-request column is a BIGINT: this one is
   * only ever compared and sorted in memory, and a double holds an integer exactly to 2^53 - 1, far past the
   * 32-bit limit that forced the column's type.
   */
  identifier: number;
  submittedAt: Date;
  state: ReviewState;
  authorLogin?: string;
  authorType?: string;
  body?: string;
  commentCount: number;
}

/** One check run or status context, reduced to the fields that classify it. */
export interface CheckFact {
  name: string;
  conclusion?: CheckConclusion;
  completedAt?: Date;
}

/**
 * One merged pull request.
 *
 * NEITHER `title` NOR `body` IS A FIELD HERE, and that is the shape rather than an omission. Both were
 * collected, stored and then projected away on every read, which is two thirds of the estate's fact payload
 * for two metrics that need PREDICATES over a description and not the description itself. `bodyLength` and
 * `hasTicketReference` are those predicates, derived once where the fact is built — see
 * `behaviour/collect.ts` for what each one decides and `store/facts.ts` for what it saved.
 */
export interface PullRequestFact extends Merge {
  identifier: number;
  repository: string;
  number: number;
  /**
   * How long the description is, with surrounding whitespace already trimmed off.
   *
   * A NUMBER AND NOT A BOOLEAN, so `traceability.minimum_description` stays a policy the REPORT applies:
   * raising the threshold regrades every cached merge on the next render with nothing refetched, which is how
   * every other configured boundary in this system behaves. Storing "described" instead would bake one
   * deployment's threshold into the cache.
   *
   * ZERO WHERE THE DESCRIPTION IS EMPTY, absent only where nothing measured it — a row cached before this
   * field existed. A pull request opened with no description was MEASURED as having none, and the two must
   * not fold together: see `descriptionQuality`.
   */
  bodyLength?: number;
  /**
   * Whether the title or the description carries an issue or ticket reference.
   *
   * A BOOLEAN AND NOT THE TEXT, which is the whole of what the metric asks — and unlike `bodyLength` this one
   * bakes its policy in, because `traceability.reference_patterns` cannot be applied to a length. Changing
   * those patterns therefore regrades nothing already collected; it takes effect as the cache is rewritten.
   * That is the price of not storing 61 MB of bodies to re-run a regex over, and it is stated at the metric
   * too.
   *
   * Absent means nothing measured it, never that no reference was found.
   */
  hasTicketReference?: boolean;
  createdAt: Date;
  mergedAt: Date;
  readyForReviewAt?: Date;
  draft: boolean;
  reviews: ReviewFact[];
  checks: CheckFact[];
}

/**
 * One commit that reached the default branch with no pull request.
 *
 * Counted in the merge cohort's denominator, because a direct commit is a change that arrived without
 * review — a repository whose work bypasses pull requests must not escape grading by having few of them.
 */
export interface DirectCommitFact extends Merge {
  sha: string;
  repository: string;
  committedAt: Date;
  authorName?: string;
  checkState?: string;
}

/** Both routes into the default branch for one window. */
export interface Merges {
  pullRequests: PullRequestFact[];
  directCommits: DirectCommitFact[];
}

/** A count over a denominator, or an explicit statement that there was nothing to count. */
export interface RateObservation {
  status: ObservationStatus;
  numerator: number;
  denominator: number;
}

/**
 * Selected percentiles of a sample.
 *
 * Optional rather than nullable throughout, because an absent percentile means the sample was empty and a
 * zero would mean the sample measured zero. That distinction is carried all the way to the UI.
 */
export interface DistributionObservation {
  status: ObservationStatus;
  sampleSize: number;
  unit: string;
  median?: number;
  percentile75?: number;
  percentile90?: number;
}

/** A rate carries no `unit`, which is what tells the two observation shapes apart at runtime. */
export type Observation = RateObservation | DistributionObservation;
