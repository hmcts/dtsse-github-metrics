import { describe, expect, it } from "vitest";
import type { MergeGateEvidence } from "../../domain/merge-gate.ts";
import { contractGate, storedGate } from "./merge-gate.ts";

/**
 * The merge gate as it was stored, and the merge gate as the UI declares it.
 *
 * THE TRANSLATION THAT TOOK `/repositories/[repository]` DOWN. The domain and the contract both call the interface
 * `MergeGateEvidence`, so handing the stored object over type-checked and then `mergeGateRows` called `.map` on an
 * undefined `pull_requests`. Two shapes, one name, in two files — and the case difference is only half of it: a
 * status-check rule's contexts are `string[]` in one and a list of objects in the other.
 */

const FETCHED = "2026-09-15T15:00:00.000Z";

const GATE: MergeGateEvidence = {
  branch: "main",
  protected: true,
  pullRequests: [{ requiredApprovingReviewCount: 2, dismissStaleReviewsOnPush: true, requireCodeOwnerReview: false, requireLastPushApproval: true }],
  statusChecks: [{ contexts: ["build", "lint"], strictRequiredStatusChecksPolicy: true }],
  restrictsDeletions: true,
  blocksForcePushes: true,
  appliesToAdministrators: true,
  rulesObserved: true,
  requiresLinearHistory: false,
  restrictsBranchNames: false,
  unmodelledRules: ["some_future_rule"]
};

describe("the merge gate a collection stored", () => {
  it("should say nothing was collected when the payload is not an object", () => {
    expect(storedGate(undefined)).toEqual({ detail: "nothing has been collected for this repository" });
    expect(storedGate(null)).toEqual({ detail: "nothing has been collected for this repository" });
    expect(storedGate("main")).toEqual({ detail: "nothing has been collected for this repository" });
  });

  it("should say the gate was not collected when the payload carries no merge gate", () => {
    // A DIFFERENT SENTENCE from the one above, because they are different failures: a repository nobody walked and
    // a walk whose gate read was refused.
    expect(storedGate({ defaultBranch: "main" })).toEqual({ detail: "the merge gate has not been collected" });
    expect(storedGate({ mergeGate: null })).toEqual({ detail: "the merge gate has not been collected" });
  });

  it("should carry the collector's own reason when the stored gate names one", () => {
    expect(storedGate({ mergeGate: { detail: "FORBIDDEN: Resource not accessible by integration" } })).toEqual({
      detail: "FORBIDDEN: Resource not accessible by integration"
    });
  });

  it("should fall back to a stated reason when the stored gate carries neither a gate nor a detail", () => {
    expect(storedGate({ mergeGate: {} })).toEqual({ detail: "the merge gate has not been collected" });
  });

  it("should return the stored gate itself when one was collected", () => {
    expect(storedGate({ mergeGate: { gate: GATE } })).toEqual({ gate: GATE });
  });
});

describe("the merge gate in the shape the UI declares", () => {
  it("should rename every field to the contract's spelling when a gate was collected", () => {
    const report = contractGate({ gate: GATE }, FETCHED);

    expect(report.fetched_at).toBe(FETCHED);
    expect(report.gate).toMatchObject({
      branch: "main",
      protected: true,
      restricts_deletions: true,
      blocks_force_pushes: true,
      applies_to_administrators: true,
      rules_observed: true,
      requires_linear_history: false,
      restricts_branch_names: false,
      unmodelled_rules: ["some_future_rule"]
    });
  });

  it("should rename a pull-request rule's four fields when one was collected", () => {
    const rule = contractGate({ gate: GATE }, FETCHED).gate?.pull_requests[0];

    expect(rule).toEqual({
      required_approving_review_count: 2,
      dismiss_stale_reviews_on_push: true,
      require_code_owner_review: false,
      require_last_push_approval: true
    });
  });

  it("should omit the thread-resolution rule rather than claim a repository does not require it", () => {
    // OMITTED AND NOT `false`. The collector does not model it, so a `false` would be a claim nobody asked GitHub
    // for — the same absent-means-unmeasured rule the rest of the contract keeps.
    const rule = contractGate({ gate: GATE }, FETCHED).gate?.pull_requests[0];

    expect(rule === undefined ? [] : Object.keys(rule)).not.toContain("required_review_thread_resolution");
  });

  it("should turn a status-check rule's contexts into the objects the contract declares", () => {
    // THE STRUCTURAL HALF of the translation, which a careless rename would not have caught: the domain holds
    // `string[]` and the contract declares a list of objects carrying an optional `integration_id`.
    const rule = contractGate({ gate: GATE }, FETCHED).gate?.status_checks[0];

    expect(rule).toEqual({ strict_required_status_checks_policy: true, required_status_checks: [{ context: "build" }, { context: "lint" }] });
  });

  it("should report the reason and no fetch instant when there is no gate to translate", () => {
    // No `fetched_at`, because nothing was read: a fetch instant beside an absence would read as a gate that was
    // looked at and found to require nothing.
    expect(contractGate({ detail: "the merge gate has not been collected" }, FETCHED)).toEqual({ detail: "the merge gate has not been collected" });
  });

  it("should state a reason when a gateless report carries none", () => {
    expect(contractGate({}, FETCHED)).toEqual({ detail: "the merge gate has not been collected" });
  });
});
