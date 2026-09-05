import { describe, expect, it } from "vitest";
import { CheckConclusion, type DirectCommitFact, type Merges, type PullRequestFact, type ReviewFact, ReviewState } from "../domain/facts.ts";
import type { MergeGateEvidence, MergeGateReport } from "../domain/merge-gate.ts";
import { ReadinessLabel, UnreviewedSubstantialOutcome } from "../domain/readiness.ts";
import { parseConfiguration } from "../policy/load.ts";
import { createPolicy, readinessPolicy } from "./assessment.ts";

// Ported from tests/test_assessment.py.

const CONFIGURATION = parseConfiguration("version: 1\norganization: hmcts\n");

function policy() {
  return readinessPolicy(CONFIGURATION);
}

function gate(overrides: Partial<MergeGateEvidence> = {}): MergeGateEvidence {
  return {
    branch: "main",
    protected: true,
    rulesObserved: true,
    pullRequests: [{ requiredApprovingReviewCount: 1, dismissStaleReviewsOnPush: true, requireCodeOwnerReview: false, requireLastPushApproval: false }],
    statusChecks: [{ contexts: ["build"], strictRequiredStatusChecksPolicy: false }],
    restrictsDeletions: true,
    blocksForcePushes: true,
    appliesToAdministrators: true,
    requiresLinearHistory: false,
    restrictsBranchNames: false,
    unmodelledRules: [],
    ...overrides
  };
}

function report(overrides: Partial<MergeGateReport> = {}): MergeGateReport {
  return { fetchedAt: new Date("2026-08-08T00:00:00Z"), gate: gate(), ...overrides };
}

function review(overrides: Partial<ReviewFact> = {}): ReviewFact {
  return {
    identifier: 1,
    submittedAt: new Date("2026-08-02T00:00:00Z"),
    state: ReviewState.Approved,
    authorLogin: "reviewer",
    authorType: "User",
    commentCount: 2,
    ...overrides
  };
}

/** A well-governed merge: reviewed, approved, commented on, checks passing, trivially sized. */
function goodPullRequest(index: number): PullRequestFact {
  return {
    identifier: index,
    repository: "cath-service",
    number: index,
    createdAt: new Date("2026-08-01T00:00:00Z"),
    mergedAt: new Date("2026-08-01T04:00:00Z"),
    draft: false,
    authorLogin: "author",
    authorType: "User",
    additions: 3,
    deletions: 2,
    changedFiles: 1,
    reviews: [review({ identifier: index, submittedAt: new Date("2026-08-01T01:00:00Z") })],
    checks: [{ name: "build", conclusion: CheckConclusion.Success, completedAt: new Date("2026-08-01T02:00:00Z") }],
    ...{}
  };
}

function unreviewedPullRequest(index: number, overrides: Partial<PullRequestFact> = {}): PullRequestFact {
  return { ...goodPullRequest(index), reviews: [], ...overrides };
}

function commit(index: number, overrides: Partial<DirectCommitFact> = {}): DirectCommitFact {
  return {
    sha: `sha${index}`,
    repository: "cath-service",
    committedAt: new Date("2026-08-02T00:00:00Z"),
    authorLogin: "author",
    authorType: "User",
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    ...overrides
  };
}

function cohort(pullRequests: PullRequestFact[], directCommits: DirectCommitFact[] = []): Merges {
  return { pullRequests, directCommits };
}

/** Ten well-governed merges: enough to grade, and everything at target. */
function healthy(): Merges {
  return cohort(Array.from({ length: 10 }, (_, index) => goodPullRequest(index + 1)));
}

function conditions(assessment: { blocking: { condition: string }[]; caution: { condition: string }[]; clear: { condition: string }[] }): string[] {
  return [...assessment.blocking, ...assessment.caution, ...assessment.clear].map((condition) => condition.condition);
}

describe("assess", () => {
  it("should report green when the gate holds and every graded condition is at target", () => {
    const assessment = policy().assess(healthy(), report());

    expect(assessment.label).toBe(ReadinessLabel.Green);
    expect(assessment.blocking).toEqual([]);
  });

  it("should report every section, so a green label is as auditable as a red one", () => {
    const assessment = policy().assess(healthy(), report());

    expect(conditions(assessment)).toContain("branch-protected");
    expect(conditions(assessment)).toContain("pull-request-review-required");
    expect(conditions(assessment)).toContain("sufficient-merges");
  });
});

describe("the two vetoes", () => {
  it("should veto an unprotected default branch in red", () => {
    const assessment = policy().assess(healthy(), report({ gate: gate({ protected: false }) }));

    expect(assessment.label).toBe(ReadinessLabel.Red);
    expect(assessment.blocking.map((condition) => condition.condition)).toEqual(["branch-not-protected"]);
  });

  it("should veto a gate requiring no approving review in red", () => {
    const assessment = policy().assess(healthy(), report({ gate: gate({ pullRequests: [] }) }));

    expect(assessment.label).toBe(ReadinessLabel.Red);
    expect(assessment.blocking.map((condition) => condition.condition)).toContain("pull-request-review-not-required");
  });

  it("should report nothing further about an unprotected branch, since its rules are evidence of nothing", () => {
    // The order is the argument: an unprotected branch vetoes on an observed fact, and no rule detail came
    // with it.
    const assessment = policy().assess(healthy(), report({ gate: gate({ protected: false }) }));

    expect(conditions(assessment)).not.toContain("status-checks-required");
  });
});

describe("an unreadable gate", () => {
  it("should report cannot-assess when the gate was never collected", () => {
    const assessment = policy().assess(healthy(), { detail: "the merge gate has not been collected" });

    expect(assessment.label).toBe(ReadinessLabel.CannotAssess);
    expect(assessment.blocking.map((condition) => condition.condition)).toEqual(["merge-gate-not-collected"]);
  });

  it("should report cannot-assess when GitHub withheld the rules of a protected branch", () => {
    // A protected branch whose rules GitHub withheld must not be read as a gate that requires no review.
    const assessment = policy().assess(healthy(), report({ gate: gate({ rulesObserved: false }) }));

    expect(assessment.label).toBe(ReadinessLabel.CannotAssess);
    expect(assessment.blocking[0]?.detail).toMatch(/Administration access/);
  });

  it("should let red outrank cannot-assess, so an unreadable gate cannot hide a disqualifier", () => {
    // An insufficient cohort imposes cannot_assess; an unprotected branch imposes red.
    const assessment = policy().assess(cohort([goodPullRequest(1)]), report({ gate: gate({ protected: false }) }));

    expect(assessment.label).toBe(ReadinessLabel.Red);
  });
});

describe("the sample", () => {
  it("should suppress every graded condition on a cohort too thin to read a pattern from", () => {
    // A rate over four merges is arithmetic; reporting it as a shortfall would dress a thin window as a
    // finding.
    const assessment = policy().assess(cohort([unreviewedPullRequest(1)]), report());

    expect(assessment.label).toBe(ReadinessLabel.CannotAssess);
    expect(assessment.blocking.map((condition) => condition.condition)).toEqual(["insufficient-merges"]);
    expect(conditions(assessment)).not.toContain("independent-review-coverage-below-target");
  });

  it("should count direct commits towards the minimum, so a repository bypassing pull requests is still graded", () => {
    // Counting merged pull requests alone would report it as unassessable precisely where the bypass is
    // worst.
    const graded = policy().assess(
      cohort(
        [goodPullRequest(1)],
        Array.from({ length: 9 }, (_, index) => commit(index))
      ),
      report()
    );

    expect(graded.blocking.map((condition) => condition.condition)).not.toContain("insufficient-merges");
  });

  it("should mark a sufficient cohort informational, since grading more is not being governed better", () => {
    const assessment = policy().assess(healthy(), report());
    const sufficient = assessment.clear.find((condition) => condition.condition === "sufficient-merges");

    expect(sufficient?.informational).toBe(true);
  });
});

describe("graded rates", () => {
  it("should block in amber when a rate sits between the amber and green boundaries", () => {
    // Eight of ten reviewed is 80%: below the 90% green target, at or above the 70% amber one.
    const merges = cohort([...Array.from({ length: 8 }, (_, index) => goodPullRequest(index + 1)), unreviewedPullRequest(9), unreviewedPullRequest(10)]);

    const assessment = policy().assess(merges, report());

    expect(assessment.label).toBe(ReadinessLabel.Amber);
    const blocked = assessment.blocking.find((condition) => condition.condition === "independent-review-coverage-below-target");
    expect(blocked?.label).toBe(ReadinessLabel.Amber);
    expect(blocked?.detail).toMatch(/is 80% \(8 of 10\)/);
  });

  it("should block in red when a rate falls below the amber boundary", () => {
    const merges = cohort([
      ...Array.from({ length: 5 }, (_, index) => goodPullRequest(index + 1)),
      ...Array.from({ length: 5 }, (_, index) => unreviewedPullRequest(index + 6))
    ]);

    const assessment = policy().assess(merges, report());

    expect(assessment.label).toBe(ReadinessLabel.Red);
    expect(assessment.blocking.find((condition) => condition.condition === "independent-review-coverage-below-target")?.label).toBe(ReadinessLabel.Red);
  });

  it("should grade approval coverage beside review coverage, catching the team that never approves", () => {
    const commented = Array.from({ length: 10 }, (_, index) => ({
      ...goodPullRequest(index + 1),
      reviews: [review({ identifier: index, state: ReviewState.Commented, submittedAt: new Date("2026-08-01T01:00:00Z") })]
    }));

    const assessment = policy().assess(cohort(commented), report());

    expect(conditions(assessment)).toContain("independent-review-coverage-at-target");
    expect(assessment.blocking.map((condition) => condition.condition)).toContain("approval-coverage-below-target");
  });
});

describe("flow signals", () => {
  it("should report a slow cycle time as a caution and never hold the label back", () => {
    // On the HMCTS estate the fastest medians belonged to repositories merging almost nothing through
    // review, while a repository reviewing 99.3% of 294 merges was held below ready for taking four days.
    const slow = Array.from({ length: 10 }, (_, index) => ({
      ...goodPullRequest(index + 1),
      mergedAt: new Date("2026-08-08T00:00:00Z")
    }));

    const assessment = policy().assess(cohort(slow), report());

    expect(assessment.label).toBe(ReadinessLabel.Green);
    expect(assessment.caution.map((condition) => condition.condition)).toContain("merge-cycle-time-above-target");
  });

  it("should grade pull-request size at the 75th percentile the metric declares", () => {
    const large = Array.from({ length: 10 }, (_, index) => ({ ...goodPullRequest(index + 1), additions: 500, deletions: 100, changedFiles: 20 }));

    const assessment = policy().assess(cohort(large), report());

    const above = assessment.caution.find((condition) => condition.condition === "pull-request-size-above-target");
    expect(above?.detail).toMatch(/75th percentile is 600 lines, above the 400 lines target/);
  });

  it("should report a distribution with no observations as not graded rather than as a pass", () => {
    const unsized = Array.from({ length: 10 }, (_, index) => ({ ...goodPullRequest(index + 1), additions: undefined, deletions: undefined }));

    const assessment = policy().assess(cohort(unsized), report());

    expect(assessment.caution.map((condition) => condition.condition)).toContain("pull-request-size-not-observed");
  });
});

describe("review depth", () => {
  it("should caution a wordless approval without imposing a ceiling", () => {
    const wordless = Array.from({ length: 10 }, (_, index) => ({
      ...goodPullRequest(index + 1),
      reviews: [review({ identifier: index, commentCount: 0, submittedAt: new Date("2026-08-01T01:00:00Z") })]
    }));

    const assessment = policy().assess(cohort(wordless), report());

    expect(assessment.label).toBe(ReadinessLabel.Green);
    expect(assessment.caution.map((condition) => condition.condition)).toContain("review-depth-below-target");
  });
});

describe("unreviewed substantial merges", () => {
  it("should forgive a breach within either allowance", () => {
    const merges = healthy();

    const assessment = policy().assess(merges, report());

    expect(assessment.clear.map((condition) => condition.condition)).toContain("substantial-changes-reviewed");
  });

  it("should block in amber when neither allowance forgives", () => {
    // Substantial and unreviewed: 100% against a 1% allowance and a 0-merge floor.
    const substantial = Array.from({ length: 10 }, (_, index) => unreviewedPullRequest(index + 1, { additions: 400, deletions: 100, changedFiles: 12 }));

    const assessment = policy().assess(cohort(substantial), report());

    const blocked = assessment.blocking.find((condition) => condition.condition === "substantial-changes-merged-unreviewed");
    expect(blocked?.label).toBe(ReadinessLabel.Amber);
  });

  it("should count every substantial direct commit as unreviewed by definition", () => {
    const merges = cohort(
      Array.from({ length: 5 }, (_, index) => goodPullRequest(index + 1)),
      Array.from({ length: 5 }, (_, index) => commit(index, { additions: 500, deletions: 0, changedFiles: 9 }))
    );

    const counts = policy().unreviewedSubstantialCounts(merges);

    expect(counts).toEqual({ unreviewed: 5, merges: 5, percentage: 100 });
  });

  it("should report nothing when the window held no substantial merge at all", () => {
    // `healthy()` merges are all trivial, so there is no denominator to judge — which is a different fact
    // from nothing having merged unreviewed, and must not be reported as a pass.
    expect(policy().unreviewedSubstantialOutcome(healthy())).toBeUndefined();
  });

  it("should report nothing on a cohort below the minimum, whose conditions are suppressed entirely", () => {
    // Unmeasured, and an unmeasured thing must never be reported as a pass: the reader of a projection
    // cannot see the detail that would say so.
    expect(policy().unreviewedSubstantialOutcome(cohort([goodPullRequest(1)]))).toBeUndefined();
  });

  it("should report none when substantial merges were all reviewed", () => {
    const substantial = Array.from({ length: 10 }, (_, index) => ({ ...goodPullRequest(index + 1), additions: 400, deletions: 100, changedFiles: 12 }));

    expect(policy().unreviewedSubstantialOutcome(cohort(substantial))).toBe(UnreviewedSubstantialOutcome.None);
  });

  it("should report above when neither allowance forgives", () => {
    const substantial = Array.from({ length: 10 }, (_, index) => unreviewedPullRequest(index + 1, { additions: 400, deletions: 100, changedFiles: 12 }));

    expect(policy().unreviewedSubstantialOutcome(cohort(substantial))).toBe(UnreviewedSubstantialOutcome.Above);
  });

  it("should keep within apart from none, because they are different facts", () => {
    // One unreviewed of 100 substantial merges is 1%, exactly at the allowance.
    const merges = cohort([
      ...Array.from({ length: 99 }, (_, index) => ({ ...goodPullRequest(index + 1), additions: 400, deletions: 100, changedFiles: 12 })),
      unreviewedPullRequest(100, { additions: 400, deletions: 100, changedFiles: 12 })
    ]);

    expect(policy().unreviewedSubstantialOutcome(merges)).toBe(UnreviewedSubstantialOutcome.Within);
  });
});

describe("merge gate cautions", () => {
  it.each([
    [{ statusChecks: [] }, "status-checks-not-required"],
    [{ appliesToAdministrators: undefined }, "gate-enforcement-on-administrators-unknown"],
    [{ appliesToAdministrators: false }, "administrators-can-bypass-the-gate"],
    [
      { pullRequests: [{ requiredApprovingReviewCount: 1, dismissStaleReviewsOnPush: false, requireCodeOwnerReview: false, requireLastPushApproval: false }] },
      "stale-reviews-not-dismissed"
    ],
    [{ blocksForcePushes: false }, "force-pushes-not-blocked"]
  ])("should caution %o as %s without holding the label back", (overrides, expected) => {
    const assessment = policy().assess(healthy(), report({ gate: gate(overrides) }));

    expect(assessment.caution.map((condition) => condition.condition)).toContain(expected);
    expect(assessment.label).toBe(ReadinessLabel.Green);
  });
});

describe("the neutral merge-gate rules", () => {
  it.each([
    ["branch-deletion-not-restricted", { restrictsDeletions: false }],
    ["linear-history-not-required", {}],
    ["branch-names-not-restricted", {}]
  ])("should report %s as clear and informational even when absent", (condition, overrides) => {
    // Each bears on none of the decision questions, so an absent one is not a shortfall — but a check that
    // is never reported cannot be argued with, so it is reported.
    const assessment = policy().assess(healthy(), report({ gate: gate(overrides) }));

    const found = assessment.clear.find((entry) => entry.condition === condition);
    expect(found?.informational).toBe(true);
    expect(found?.detail).toMatch(/does not bear on the readiness label/);
  });

  it("should report the neutral rules last, so they cannot crowd out the graded conditions", () => {
    const assessment = policy().assess(healthy(), report());
    const names = assessment.clear.map((condition) => condition.condition);

    expect(names.indexOf("pull-request-review-required")).toBeLessThan(names.indexOf("branch-deletion-restricted"));
  });
});

describe("createPolicy", () => {
  it("should report whether readiness should be assessed at all", () => {
    const disabled = parseConfiguration("version: 1\norganization: hmcts\nassessment:\n  enabled: false\n");

    expect(readinessPolicy(disabled).enabled).toBe(false);
    expect(policy().enabled).toBe(true);
  });

  it("should honour a configured minimum cohort", () => {
    const strict = createPolicy({ ...CONFIGURATION.assessment, minimum_merges: 50 }, CONFIGURATION.triviality);

    expect(strict.sufficient(healthy())).toBe(false);
  });
});
