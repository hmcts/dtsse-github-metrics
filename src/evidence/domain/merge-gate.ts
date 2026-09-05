/**
 * The declared merge gate on a repository's default branch. Ported from `metrics.domain`.
 */

/** One pull-request rule active on a branch. */
export interface PullRequestRule {
  requiredApprovingReviewCount: number;
  dismissStaleReviewsOnPush: boolean;
  requireCodeOwnerReview: boolean;
  requireLastPushApproval: boolean;
}

/** One status-checks rule active on a branch. */
export interface StatusChecksRule {
  contexts: string[];
  strictRequiredStatusChecksPolicy: boolean;
}

/**
 * The active rules applied to a repository branch.
 *
 * `appliesToAdministrators` is absent when it was not observable, never false: a gate whose enforcement is
 * unknown must not be reported as one that admins can bypass.
 *
 * `rulesObserved` says whether GitHub disclosed the detailed rules. It is false when a non-administrator
 * was refused branch-protection detail, and false by default so that state stored before the field existed
 * cannot be read as a gate with no rules — `protected: true` with empty rule arrays is otherwise
 * indistinguishable from a gate nobody was allowed to see.
 *
 * `restrictsDeletions`, `blocksForcePushes`, `requiresLinearHistory` and `restrictsBranchNames` describe THE
 * REPOSITORY's configuration, and each is two-valued on purpose: false means the rule is not configured, and
 * `rulesObserved` — not a third state on the boolean — is what separates that from nobody having been
 * allowed to look.
 *
 * `unmodelledRules` describes THIS TOOL's limits, not the repository's configuration. It names every active
 * rule type the collector does not interpret, sorted and deduplicated, so a rule GitHub adds after this
 * release is reported rather than silently dropped. An empty array means every observed rule type was
 * attributed, not that the repository configured nothing.
 */
export interface MergeGateEvidence {
  branch: string;
  protected: boolean;
  pullRequests: PullRequestRule[];
  statusChecks: StatusChecksRule[];
  restrictsDeletions: boolean;
  blocksForcePushes: boolean;
  appliesToAdministrators?: boolean;
  rulesObserved: boolean;
  requiresLinearHistory: boolean;
  restrictsBranchNames: boolean;
  unmodelledRules: string[];
}

/**
 * The strictest approval count any rule demands, and 0 where no rule demands one.
 *
 * Several rules can apply to one branch and the strictest of them is what a merge actually has to satisfy,
 * so the maximum is the figure to report. 0 means no rule required a review, which `rulesObserved` — not
 * this figure — separates from nobody having been allowed to look.
 */
export function requiredApprovals(gate: MergeGateEvidence): number {
  return gate.pullRequests.reduce((strictest, rule) => Math.max(strictest, rule.requiredApprovingReviewCount), 0);
}

/** Every distinct status check context any rule on the branch requires. */
export function requiredContexts(gate: MergeGateEvidence): string[] {
  return [...new Set(gate.statusChecks.flatMap((rule) => rule.contexts))];
}

/**
 * One repository's stored merge gate, or why there is none to show.
 *
 * A gate is current state read at `fetchedAt`, while the findings beside it cover a historical window, so a
 * reader has to be able to see that the two describe different instants. A gate that was never collected,
 * or that was not observable when it was, carries the reason instead: an absent block would read as an
 * absent gate.
 *
 * Exactly one of `gate` and `detail` is always set — `mergeGateReport` enforces it, since upstream had a
 * model validator doing so on every construction.
 */
export interface MergeGateReport {
  fetchedAt?: Date;
  gate?: MergeGateEvidence;
  detail?: string;
}

/** Builds a report, requiring either an observed gate or the reason there is none. */
export function mergeGateReport(report: MergeGateReport): MergeGateReport {
  if ((report.gate === undefined) === (report.detail === undefined)) {
    throw new RangeError("a merge gate report must carry either a gate or the reason it is unavailable");
  }
  return report;
}
