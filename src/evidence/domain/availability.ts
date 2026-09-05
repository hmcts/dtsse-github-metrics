/**
 * Why configured evidence could not be observed, ported from `metrics.domain`.
 *
 * Every one of these is reported as AVAILABILITY rather than as a number. That distinction is the
 * whole design: a repository whose alerts nobody may read is not a repository with no alerts, and a
 * report that showed a zero would be stating a fact nobody observed.
 */
export const AvailabilityReason = {
  AuthenticationFailed: "authentication_failed",
  NotApplicable: "not_applicable",
  FeatureDisabled: "feature_disabled",
  PermissionDenied: "permission_denied",
  NotFoundOrInaccessible: "not_found_or_inaccessible",
  InsufficientSample: "insufficient_sample",
  IncompleteHistory: "incomplete_history",
  RateLimited: "rate_limited",
  CollectionFailed: "collection_failed"
} as const;

export type AvailabilityReason = (typeof AvailabilityReason)[keyof typeof AvailabilityReason];

/** The completeness of one collection run. */
export const CollectionStatus = {
  Complete: "complete",
  Partial: "partial",
  Failed: "failed"
} as const;

export type CollectionStatus = (typeof CollectionStatus)[keyof typeof CollectionStatus];

/** The evidence affected by a collection failure. */
export const EvidenceKind = {
  Repository: "repository",
  MergeGate: "merge_gate",
  Behaviour: "behaviour",
  OpenPullRequests: "open_pull_requests",
  SecurityAlerts: "security_alerts",
  Codeowners: "codeowners",
  Maintenance: "maintenance",
  Sonar: "sonar"
} as const;

export type EvidenceKind = (typeof EvidenceKind)[keyof typeof EvidenceKind];

/**
 * One repository's evidence that could not be observed, and why.
 *
 * Carries a `status` alongside the reason because one endpoint's meaning is not another's: a 422 from
 * `/commits/{sha}` refutes a candidate Sonar mapping, and only the caller that issued it knows that.
 * The client classifies what it can for every endpoint and hands the status on for the rest.
 */
export class GitHubError extends Error {
  readonly reason: AvailabilityReason;
  readonly status: number | undefined;

  constructor(message: string, reason: AvailabilityReason, status?: number, options?: ErrorOptions) {
    super(message, options);
    this.name = "GitHubError";
    this.reason = reason;
    this.status = status;
  }
}
