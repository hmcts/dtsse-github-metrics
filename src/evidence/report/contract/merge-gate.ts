import type * as contract from "../../../lib/types.ts";
import type { MergeGateEvidence, MergeGateReport } from "../../domain/merge-gate.ts";

/**
 * What a collection stored about a repository's merge gate, and that gate in the shape the UI declares.
 *
 * IN `report/contract/` for `./observation.ts`'s reason: a pure function of its argument, so the suite that runs on
 * every build holds it rather than the integration run.
 */

/** The merge gate one collection stored, or the reason there is none to grade. */
export function storedGate(payload: unknown): MergeGateReport {
  if (typeof payload !== "object" || payload === null) {
    return { detail: "nothing has been collected for this repository" };
  }
  const stored = (payload as { mergeGate?: unknown }).mergeGate;
  if (typeof stored !== "object" || stored === null) {
    return { detail: "the merge gate has not been collected" };
  }
  const report = stored as { gate?: MergeGateEvidence; detail?: string };
  return report.gate === undefined ? { detail: report.detail ?? "the merge gate has not been collected" } : { gate: report.gate };
}

/**
 * The stored merge gate in the shape the UI declares, which is NOT the shape it is stored in.
 *
 * Two translations, not one. The obvious one is case: the domain holds `pullRequests` and the contract declares
 * `pull_requests`, and every field differs the same way. The one that would survive a careless rename is
 * STRUCTURAL — the domain holds a status-checks rule's contexts as `string[]`, and the contract declares
 * `required_status_checks` as a list of objects with a `context` each, because it carries an optional
 * `integration_id` the collector does not read.
 *
 * This never surfaced before because `repositoryRow` reads the stored gate only through `requiredApprovals` and
 * `requiredContexts`, which are domain functions over the domain shape. The moment the gate itself went on the
 * contract, `mergeGateRows` called `.map` on an undefined `pull_requests` and took the page down.
 *
 * `required_review_thread_resolution` is OMITTED rather than sent as `false`. The collector does not model it, so
 * `false` would be a claim that a repository does not require thread resolution when nobody asked GitHub. Nothing
 * renders it — `mergeGateRows` prints ten rows and that is not one of them.
 */
export function contractGate(report: MergeGateReport, fetched: string): contract.MergeGateReport {
  if (report.gate === undefined) {
    return { detail: report.detail ?? "the merge gate has not been collected" };
  }
  const gate = report.gate;
  return {
    fetched_at: fetched,
    gate: {
      branch: gate.branch,
      protected: gate.protected,
      pull_requests: gate.pullRequests.map((rule) => ({
        required_approving_review_count: rule.requiredApprovingReviewCount,
        dismiss_stale_reviews_on_push: rule.dismissStaleReviewsOnPush,
        require_code_owner_review: rule.requireCodeOwnerReview,
        require_last_push_approval: rule.requireLastPushApproval
      })),
      status_checks: gate.statusChecks.map((rule) => ({
        strict_required_status_checks_policy: rule.strictRequiredStatusChecksPolicy,
        required_status_checks: rule.contexts.map((context) => ({ context }))
      })),
      restricts_deletions: gate.restrictsDeletions,
      blocks_force_pushes: gate.blocksForcePushes,
      applies_to_administrators: gate.appliesToAdministrators,
      rules_observed: gate.rulesObserved,
      requires_linear_history: gate.requiresLinearHistory,
      restricts_branch_names: gate.restrictsBranchNames,
      unmodelled_rules: gate.unmodelledRules
    }
  };
}
