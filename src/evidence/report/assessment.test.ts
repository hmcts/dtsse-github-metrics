import { describe, expect, it } from "vitest";
import { conditionGroups } from "../../lib/repository.ts";
import type { ReadinessAssessment as ContractAssessment, ReadinessCondition as ContractCondition } from "../../lib/types.ts";
import { readinessPolicy } from "../assessment/assessment.ts";
import { type Merges, type PullRequestFact, ReviewState } from "../domain/facts.ts";
import type { MergeGateReport } from "../domain/merge-gate.ts";
import { parseConfiguration } from "../policy/load.ts";
import { contractAssessment } from "./assessment.ts";

/**
 * The seam between the readiness policy's verdict and what the UI declares.
 *
 * THE ONE CROSSING THAT WAS ALREADY CORRECT, which is why it needs a test more than the three that were not. Every
 * field on `ReadinessAssessment` and `ReadinessCondition` is a single word in BOTH `domain/readiness.ts` and
 * `src/lib/types.ts`, so `repositoryEvidence` handed the policy's own object to the contract and it happened to be
 * right. A camelCase field added to either side turns that into `sample_size` all over again — a key on the wire
 * nothing reads, rendering as nothing at all — and the three cases below are what would fail instead.
 *
 * So the assessment here comes from the REAL policy over real merges, and the assertions are the contract's own
 * types and `lib/repository.conditionGroups`, the function the repository page draws the three groups with. A fixture
 * spelling `informational` by hand would pass whatever the translation emitted, which is exactly how the seam went
 * three bugs without a failing test.
 */

const CONFIGURATION = parseConfiguration(`
version: 1
organization: hmcts
assessment:
  minimum_merges: 1
`);

/**
 * Every field the contract declares on a condition, exhaustively.
 *
 * `Record<keyof ContractCondition, true>` rather than a string array, so the COMPILER checks the list: a field added,
 * renamed or removed in `src/lib/types.ts` fails to build here rather than going unasserted.
 */
const CONTRACT_CONDITION_FIELDS: Record<keyof ContractCondition, true> = {
  condition: true,
  label: true,
  detail: true,
  informational: true
};

const CONTRACT_ASSESSMENT_FIELDS: Record<keyof ContractAssessment, true> = { label: true, blocking: true, caution: true, clear: true };

function pullRequest(identifier: number, reviewed: boolean): PullRequestFact {
  return {
    identifier,
    repository: "cath-service",
    number: identifier,
    createdAt: new Date(Date.UTC(2026, 7, 1)),
    readyForReviewAt: new Date(Date.UTC(2026, 7, 1)),
    mergedAt: new Date(Date.UTC(2026, 7, 2)),
    draft: false,
    authorLogin: "author",
    authorType: "User",
    additions: 20,
    deletions: 2,
    changedFiles: 3,
    reviews: reviewed
      ? [
          {
            identifier,
            submittedAt: new Date(Date.UTC(2026, 7, 1, 12)),
            state: ReviewState.Approved,
            authorLogin: "reviewer",
            authorType: "User",
            commentCount: 1
          }
        ]
      : [],
    checks: []
  };
}

/** A cohort the policy will grade: `count` merges, each reviewed or not, which is what moves the verdict. */
function cohort(count: number, reviewed: boolean): Merges {
  return { pullRequests: Array.from({ length: count }, (_, index) => pullRequest(index + 1, reviewed)), directCommits: [] };
}

/** A readable gate requiring one approving review, so the governance conditions have something to judge. */
const GATE: MergeGateReport = {
  gate: {
    branch: "main",
    protected: true,
    rulesObserved: true,
    pullRequests: [{ requiredApprovingReviewCount: 1, dismissStaleReviewsOnPush: true, requireCodeOwnerReview: false, requireLastPushApproval: false }],
    statusChecks: [{ contexts: ["build"], strictRequiredStatusChecksPolicy: true }],
    restrictsDeletions: true,
    blocksForcePushes: true,
    requiresLinearHistory: false,
    restrictsBranchNames: false,
    unmodelledRules: []
  }
};

function assess(merges: Merges): ContractAssessment {
  return contractAssessment(readinessPolicy(CONFIGURATION).assess(merges, GATE));
}

describe("contractAssessment", () => {
  it("should emit the four assessment fields the contract declares and nothing else", () => {
    const emitted = assess(cohort(4, true));

    expect(Object.keys(emitted).sort()).toEqual(["blocking", "caution", "clear", "label"]);
    for (const field of Object.keys(emitted)) {
      expect(CONTRACT_ASSESSMENT_FIELDS).toHaveProperty(field);
    }
  });

  it("should emit only fields the contract names on every condition of every group", () => {
    // ACROSS ALL THREE GROUPS AND BOTH VERDICTS, because a field is added to `ReadinessCondition` once and reaches
    // whichever group the policy happens to put that condition in. One group's worth of assertions would leave the
    // other two able to carry a key nothing reads.
    const conditions = [cohort(4, true), cohort(4, false)].flatMap((merges) => {
      const emitted = assess(merges);
      return [...emitted.blocking, ...emitted.caution, ...emitted.clear];
    });

    expect(conditions.length).toBeGreaterThan(0);
    for (const condition of conditions) {
      for (const field of Object.keys(condition)) {
        expect(CONTRACT_CONDITION_FIELDS).toHaveProperty(field);
      }
      // Both required fields are present and are strings, which is what the page prints. A condition arriving with
      // `detail: undefined` renders as a blank row rather than as the sentence a reader is owed.
      expect(typeof condition.condition).toBe("string");
      expect(typeof condition.detail).toBe("string");
    }
  });

  it("should omit label and informational rather than sending them as undefined", () => {
    // The rule `contractDistribution` states: an absent answer is a MISSING KEY where it is built, so the emitted
    // key set is right without `stripAbsent`'s help and `lib/repository.gradedFirst` — which reads `informational`
    // with `?? false` — is reading a key that is either there or is not.
    const emitted = assess(cohort(4, true));
    const clear = emitted.clear;

    expect(clear.length).toBeGreaterThan(0);
    for (const condition of clear) {
      if (condition.label === undefined) {
        expect(condition).not.toHaveProperty("label");
      }
      if (condition.informational === undefined) {
        expect(condition).not.toHaveProperty("informational");
      }
    }
  });

  it("should carry the verdict the policy decided, in the policy's own order and words", () => {
    // THE TRANSLATION RENAMES AND DECIDES NOTHING, asserted against the policy's own object rather than against a
    // label this case would then be pinning: which conditions block is `assessment/assessment.ts`'s business, and a
    // test asserting "green" here would fail the day a threshold moved for reasons that have nothing to do with the
    // seam. What has to hold is that every condition survives the rebuild, in its group, in order, word for word.
    const merges = cohort(4, false);
    const decided = readinessPolicy(CONFIGURATION).assess(merges, GATE);

    const emitted = contractAssessment(decided);

    expect(emitted.label).toBe(decided.label);
    for (const group of ["blocking", "caution", "clear"] as const) {
      expect(emitted[group].map((condition) => condition.condition)).toEqual(decided[group].map((condition) => condition.condition));
      expect(emitted[group].map((condition) => condition.detail)).toEqual(decided[group].map((condition) => condition.detail));
      expect(emitted[group].map((condition) => condition.label)).toEqual(decided[group].map((condition) => condition.label));
    }
    // A cohort merged with no independent review has something to block on, which is what makes the comparison
    // above able to fail rather than comparing two empty lists.
    expect(emitted.blocking.length).toBeGreaterThan(0);
  });

  it("should render every group through the page's own reader without an empty row", () => {
    // THE CONSUMER, run over the producer's output. `conditionGroups` is what `AssessmentSection` draws from, and it
    // reads `blocking`, `caution` and `clear` off the contract's type — so a group the translation failed to carry
    // arrives here as an empty list under a heading rather than as a compile error.
    const groups = conditionGroups(assess(cohort(4, false)));

    expect(groups.map((group) => group.key)).toEqual(["blocking", "caution", "clear"]);
    for (const group of groups) {
      for (const condition of group.conditions) {
        expect(condition.detail).not.toBe("");
        expect(condition.detail).not.toContain("undefined");
      }
    }
  });
});
