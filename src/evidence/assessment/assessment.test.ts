import { describe, expect, it } from "vitest";
import { CheckConclusion, type DirectCommitFact, type Merges, type PullRequestFact, type ReviewFact, ReviewState } from "../domain/facts.ts";
import type { MergeGateEvidence, MergeGateReport } from "../domain/merge-gate.ts";
import { ReadinessLabel, UnreviewedSubstantialOutcome } from "../domain/readiness.ts";
import type { RepositorySettings } from "../domain/repository-settings.ts";
import { parseConfiguration } from "../policy/load.ts";
import type { SecureDesignSeverity } from "../policy/schema.ts";
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

  it("should say the gate was not collected when the report carries no detail of its own", () => {
    const assessment = policy().assess(healthy(), {});

    expect(assessment.blocking).toEqual([
      { condition: "merge-gate-not-collected", label: ReadinessLabel.CannotAssess, detail: "the merge gate has not been collected" }
    ]);
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
    ["branch-names-not-restricted", {}],
    ["branch-deletion-restricted", {}],
    ["linear-history-required", { requiresLinearHistory: true }],
    ["branch-names-restricted", { restrictsBranchNames: true }]
  ])("should report %s as clear and informational whether configured or absent", (condition, overrides) => {
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

function secureDesignPolicy(actions: SecureDesignSeverity, issues: SecureDesignSeverity, pinning: SecureDesignSeverity = "caution") {
  return createPolicy(
    {
      ...CONFIGURATION.assessment,
      "secure-by-design": { "actions-allow-all": actions, "actions-sha-pinning-not-required": pinning, "public-issue-creation": issues }
    },
    CONFIGURATION.triviality
  );
}

function find(assessment: ReturnType<ReturnType<typeof policy>["assess"]>, condition: string) {
  for (const outcome of ["blocking", "caution", "clear"] as const) {
    const found = assessment[outcome].find((entry) => entry.condition === condition);
    if (found !== undefined) {
      return { outcome, ...found };
    }
  }
  return undefined;
}

const RESTRICTED: RepositorySettings = {
  actions: { enabled: true, allowedActions: "local_only", shaPinningRequired: true },
  issues: { enabled: true, creationPolicy: "COLLABORATORS_ONLY" }
};

describe("the Actions policy", () => {
  it.each([
    [{ enabled: true, allowedActions: "all" }, "actions-allow-all", "caution"],
    [{ enabled: true, allowedActions: "local_only" }, "actions-restricted", "clear"],
    [{ enabled: true, allowedActions: "selected" }, "actions-restricted", "clear"],
    [{ enabled: false }, "actions-restricted", "clear"],
    [{ enabled: false, allowedActions: "all" }, "actions-restricted", "clear"],
    [{ enabled: true }, "actions-policy-not-read", "clear"]
  ])("should judge %o as %s in %s", (actions, condition, outcome) => {
    const assessment = policy().assess(healthy(), report(), { ...RESTRICTED, actions });

    expect(find(assessment, condition)?.outcome).toBe(outcome);
    expect(assessment.label).toBe(ReadinessLabel.Green);
  });

  it("should say exactly what allowing every Action means", () => {
    const assessment = policy().assess(healthy(), report(), { actions: { enabled: true, allowedActions: "all" } });

    expect(find(assessment, "actions-allow-all")?.detail).toBe("any GitHub Action from any source can run in this repository's workflows");
  });

  it("should name the allowed set when Actions is restricted", () => {
    const assessment = policy().assess(healthy(), report(), { actions: { enabled: true, allowedActions: "selected" } });

    expect(find(assessment, "actions-restricted")?.detail).toBe(
      "this repository's workflows can run only the GitHub Actions it allows (selected), not any Action from any source"
    );
  });

  it("should report Actions enabled with no allowed set as not read, never as restricted", () => {
    const assessment = policy().assess(healthy(), report(), { actions: { enabled: true } });

    expect(find(assessment, "actions-policy-not-read")?.informational).toBe(true);
    expect(find(assessment, "actions-restricted")).toBeUndefined();
  });

  it("should report an unread Actions policy as informational clear, never as a finding", () => {
    const assessment = policy().assess(healthy(), report(), { issues: RESTRICTED.issues });

    const found = find(assessment, "actions-policy-not-read");
    expect(found?.outcome).toBe("clear");
    expect(found?.informational).toBe(true);
    expect(find(assessment, "actions-allow-all")).toBeUndefined();
  });
});

describe("the SHA pinning policy", () => {
  it.each([
    [{ enabled: true, allowedActions: "all", shaPinningRequired: false }, "actions-sha-pinning-not-required", "caution"],
    [{ enabled: true, allowedActions: "local_only", shaPinningRequired: false }, "actions-sha-pinning-not-required", "caution"],
    [{ enabled: true, allowedActions: "all", shaPinningRequired: true }, "actions-sha-pinning-required", "clear"],
    [{ enabled: false }, "actions-sha-pinning-required", "clear"],
    [{ enabled: false, shaPinningRequired: false }, "actions-sha-pinning-required", "clear"],
    [{ enabled: true, allowedActions: "all" }, "actions-sha-pinning-not-read", "clear"]
  ])("should judge %o as %s in %s", (actions, condition, outcome) => {
    const assessment = policy().assess(healthy(), report(), { ...RESTRICTED, actions });

    expect(find(assessment, condition)?.outcome).toBe(outcome);
    expect(assessment.label).toBe(ReadinessLabel.Green);
  });

  it("should say exactly what not requiring SHA pinning means", () => {
    const assessment = policy().assess(healthy(), report(), { actions: { enabled: true, allowedActions: "selected", shaPinningRequired: false } });

    expect(find(assessment, "actions-sha-pinning-not-required")?.detail).toBe(
      "this repository's workflows can use an Action by tag or branch, which can be moved to different code after review"
    );
  });

  it("should say what is required when SHA pinning is on", () => {
    const assessment = policy().assess(healthy(), report(), { actions: { enabled: true, allowedActions: "selected", shaPinningRequired: true } });

    expect(find(assessment, "actions-sha-pinning-required")?.detail).toBe(
      "every Action this repository's workflows use must be pinned to a full-length commit SHA"
    );
  });

  it("should say why nothing needs pinning when Actions is disabled", () => {
    const assessment = policy().assess(healthy(), report(), { actions: { enabled: false } });

    expect(find(assessment, "actions-sha-pinning-required")?.detail).toBe(
      "GitHub Actions is disabled in this repository, so no Action runs that could need pinning"
    );
  });

  it("should report an unread SHA pinning setting as informational clear, never as a finding", () => {
    const assessment = policy().assess(healthy(), report(), { issues: RESTRICTED.issues });

    const found = find(assessment, "actions-sha-pinning-not-read");
    expect(found?.outcome).toBe("clear");
    expect(found?.informational).toBe(true);
    expect(find(assessment, "actions-sha-pinning-not-required")).toBeUndefined();
  });
});

describe("the issue creation policy", () => {
  it.each([
    [{ enabled: true, creationPolicy: "ALL" }, "issues-open-to-public", "caution"],
    [{ enabled: true, creationPolicy: "COLLABORATORS_ONLY" }, "issues-restricted", "clear"],
    [{ enabled: false, creationPolicy: "ALL" }, "issues-restricted", "clear"],
    [{ enabled: false }, "issues-restricted", "clear"],
    [{ enabled: true }, "issue-policy-not-read", "clear"]
  ])("should judge %o as %s in %s", (issues, condition, outcome) => {
    const assessment = policy().assess(healthy(), report(), { ...RESTRICTED, issues });

    expect(find(assessment, condition)?.outcome).toBe(outcome);
    expect(assessment.label).toBe(ReadinessLabel.Green);
  });

  it("should say exactly what an open issue policy means", () => {
    const assessment = policy().assess(healthy(), report(), { issues: { enabled: true, creationPolicy: "ALL" } });

    expect(find(assessment, "issues-open-to-public")?.detail).toBe("anyone with a GitHub account can open an issue on this repository");
  });

  it("should say who may open an issue when only collaborators can", () => {
    const assessment = policy().assess(healthy(), report(), { issues: { enabled: true, creationPolicy: "COLLABORATORS_ONLY" } });

    expect(find(assessment, "issues-restricted")?.detail).toBe("only collaborators can open an issue on this repository");
  });

  it("should name a creation policy it does not recognise, and not treat it as open to everyone", () => {
    const assessment = policy().assess(healthy(), report(), { issues: { enabled: true, creationPolicy: "MAINTAINERS_ONLY" } });

    expect(find(assessment, "issues-restricted")?.detail).toBe(
      "issues are enabled and GitHub reported the creation policy as MAINTAINERS_ONLY, which does not open them to everyone"
    );
    expect(find(assessment, "issues-open-to-public")).toBeUndefined();
  });

  it("should report issues enabled with no creation policy as not read, never as restricted", () => {
    const assessment = policy().assess(healthy(), report(), { issues: { enabled: true } });

    expect(find(assessment, "issue-policy-not-read")?.informational).toBe(true);
    expect(find(assessment, "issues-restricted")).toBeUndefined();
  });

  it("should report an unread issue policy as informational clear, never as a finding", () => {
    const assessment = policy().assess(healthy(), report(), { actions: RESTRICTED.actions });

    const found = find(assessment, "issue-policy-not-read");
    expect(found?.outcome).toBe("clear");
    expect(found?.informational).toBe(true);
  });
});

describe("secure-by-design severity", () => {
  const OPEN: RepositorySettings = {
    actions: { enabled: true, allowedActions: "all" },
    issues: { enabled: true, creationPolicy: "ALL" }
  };

  it("should leave a green label green when both findings are cautions", () => {
    const assessment = secureDesignPolicy("caution", "caution").assess(healthy(), report(), OPEN);

    expect(assessment.label).toBe(ReadinessLabel.Green);
    expect(assessment.caution.map((entry) => entry.condition)).toEqual(expect.arrayContaining(["actions-allow-all", "issues-open-to-public"]));
    expect(assessment.blocking).toEqual([]);
  });

  it.each([
    ["amber", ReadinessLabel.Amber],
    ["red", ReadinessLabel.Red]
  ] as const)("should block the Actions finding in %s when configured so", (severity, expected) => {
    const assessment = secureDesignPolicy(severity, "caution").assess(healthy(), report(), OPEN);

    expect(assessment.label).toBe(expected);
    expect(assessment.blocking).toEqual([expect.objectContaining({ condition: "actions-allow-all", label: expected })]);
    expect(find(assessment, "issues-open-to-public")?.outcome).toBe("caution");
  });

  it.each([
    ["amber", ReadinessLabel.Amber],
    ["red", ReadinessLabel.Red]
  ] as const)("should block the issue finding in %s when configured so", (severity, expected) => {
    const assessment = secureDesignPolicy("caution", severity).assess(healthy(), report(), OPEN);

    expect(assessment.label).toBe(expected);
    expect(assessment.blocking).toEqual([expect.objectContaining({ condition: "issues-open-to-public", label: expected })]);
    expect(find(assessment, "actions-allow-all")?.outcome).toBe("caution");
  });

  it.each([
    ["amber", ReadinessLabel.Amber],
    ["red", ReadinessLabel.Red]
  ] as const)("should block the SHA pinning finding in %s when configured so", (severity, expected) => {
    const unpinned: RepositorySettings = { ...OPEN, actions: { enabled: true, allowedActions: "selected", shaPinningRequired: false } };
    const assessment = secureDesignPolicy("caution", "caution", severity).assess(healthy(), report(), unpinned);

    expect(assessment.label).toBe(expected);
    expect(assessment.blocking).toEqual([expect.objectContaining({ condition: "actions-sha-pinning-not-required", label: expected })]);
    expect(find(assessment, "issues-open-to-public")?.outcome).toBe("caution");
  });

  it("should never block on an unread setting, however severe the configuration", () => {
    const assessment = secureDesignPolicy("red", "red", "red").assess(healthy(), report());

    expect(assessment.label).toBe(ReadinessLabel.Green);
    expect(find(assessment, "actions-policy-not-read")?.outcome).toBe("clear");
    expect(find(assessment, "actions-sha-pinning-not-read")?.outcome).toBe("clear");
    expect(find(assessment, "issue-policy-not-read")?.outcome).toBe("clear");
  });

  it("should leave a restricted repository clear, however severe the configuration", () => {
    const assessment = secureDesignPolicy("red", "red", "red").assess(healthy(), report(), RESTRICTED);

    expect(assessment.label).toBe(ReadinessLabel.Green);
    expect(find(assessment, "actions-restricted")?.outcome).toBe("clear");
    expect(find(assessment, "actions-sha-pinning-required")?.outcome).toBe("clear");
    expect(find(assessment, "issues-restricted")?.outcome).toBe("clear");
  });
});

describe("createPolicy", () => {
  it("should report whether readiness should be assessed at all", () => {
    const disabled = parseConfiguration("version: 1\norganization: hmcts\nassessment:\n  enabled: false\n");

    expect(readinessPolicy(disabled).enabled).toBe(false);
    expect(policy().enabled).toBe(true);
  });

  it("should report a rate with no denominator as not graded rather than as a pass", () => {
    // Only reachable through a hand-built configuration: the schema requires at least one merge, so an
    // empty cohort is never sufficient when the minimum is loaded from YAML.
    const lenient = createPolicy({ ...CONFIGURATION.assessment, minimum_merges: 0 }, CONFIGURATION.triviality);

    const assessment = lenient.assess(cohort([]), report());

    expect(assessment.caution.map((condition) => condition.condition)).toEqual(
      expect.arrayContaining(["independent-review-coverage-not-observed", "approval-coverage-not-observed", "checks-passing-at-merge-not-observed"])
    );
    expect(assessment.blocking).toEqual([]);
  });

  it("should honour a configured minimum cohort", () => {
    const strict = createPolicy({ ...CONFIGURATION.assessment, minimum_merges: 50 }, CONFIGURATION.triviality);

    expect(strict.sufficient(healthy())).toBe(false);
  });
});
