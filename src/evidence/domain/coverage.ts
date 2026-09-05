/**
 * What has been collected, and from where. Ported from `metrics.domain`'s coverage models.
 */

/**
 * The sources a window's evidence can come from.
 *
 * Coverage is recorded per source, not per repository, so widening one query cannot silently
 * invalidate another's cached intervals.
 */
export const EvidenceSource = {
  PullRequests: "pull_requests",
  DirectCommits: "direct_commits"
} as const;

export type EvidenceSource = (typeof EvidenceSource)[keyof typeof EvidenceSource];

/** One recorded half-open interval of collected evidence, keyed by the query that collected it. */
export interface SourceCoverage {
  organization: string;
  repository: string;
  source: EvidenceSource;
  queryHash: string;
  startsAt: Date;
  endsAt: Date;
}

/** The identity of a coverage series: everything but the interval. */
export type CoverageKey = Omit<SourceCoverage, "startsAt" | "endsAt">;

/** A half-open interval, without the key that identifies which series it belongs to. */
export interface Interval {
  startsAt: Date;
  endsAt: Date;
}
