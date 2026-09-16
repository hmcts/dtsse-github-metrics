import { describe, expect, it } from "vitest";
import {
  CheckConclusion,
  type CheckFact,
  type DirectCommitFact,
  ObservationStatus,
  type PullRequestFact,
  type ReviewFact,
  ReviewState
} from "../domain/facts.ts";
import {
  botAccounts,
  changeSize,
  comparableLogin,
  contributorLogins,
  distribution,
  eligibleChecks,
  eligibleReviews,
  excludedAuthors,
  inCohort,
  isHumanAccount,
  isHumanCommitAuthor,
  isPassingCheck,
  percentile,
  rate,
  ratePercentage,
  reportedCohort,
  reportedDirectCommit,
  reviewStartedAt,
  reviewStateCounts,
  sizeClass
} from "./analysis.ts";

// Ported from tests/test_analysis.py.

function review(overrides: Partial<ReviewFact> = {}): ReviewFact {
  return {
    identifier: 1,
    submittedAt: new Date("2026-08-02T00:00:00Z"),
    state: ReviewState.Approved,
    authorLogin: "reviewer",
    authorType: "User",
    commentCount: 0,
    ...overrides
  };
}

function pullRequest(overrides: Partial<PullRequestFact> = {}): PullRequestFact {
  return {
    identifier: 101,
    repository: "cath-service",
    number: 11,
    createdAt: new Date("2026-08-01T00:00:00Z"),
    mergedAt: new Date("2026-08-03T00:00:00Z"),
    draft: false,
    authorLogin: "author",
    authorType: "User",
    reviews: [],
    checks: [],
    ...overrides
  };
}

function commit(overrides: Partial<DirectCommitFact> = {}): DirectCommitFact {
  return { sha: "abc123", repository: "cath-service", committedAt: new Date("2026-08-02T00:00:00Z"), authorLogin: "author", authorType: "User", ...overrides };
}

function check(overrides: Partial<CheckFact> = {}): CheckFact {
  return { name: "build", conclusion: CheckConclusion.Success, completedAt: new Date("2026-08-02T00:00:00Z"), ...overrides };
}

describe("percentile", () => {
  it("should interpolate linearly between the two nearest samples", () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
  });

  it("should return the only value of a single-sample distribution", () => {
    expect(percentile([7], 0.9)).toBe(7);
  });

  it("should sort before reading, so the sample order cannot change the answer", () => {
    expect(percentile([4, 1, 3, 2], 0.5)).toBe(2.5);
  });

  it("should round to three decimals with the same rule Python uses", () => {
    expect(percentile([0, 1], 0.1234)).toBe(0.123);
  });
});

describe("isHumanAccount", () => {
  it.each([
    ["alice", "User", true],
    // GitHub types an account as Bot only where it is a GitHub App.
    ["dependabot", "Bot", false],
    // An ordinary user account driven by automation gives itself away by the login convention.
    ["renovate[bot]", "User", false],
    ["RENOVATE[BOT]", "User", false],
    // A commit GitHub could match to no account is nobody, so not a person either.
    [undefined, "User", false]
  ])("should judge login %s of type %s as human=%s", (login, type, expected) => {
    expect(isHumanAccount(login, type)).toBe(expected);
  });

  it("should judge a named account as a bot when GitHub itself reports a user", () => {
    // THE THIRD SIGNAL, and on the commit path the only one that fires: no stored direct commit carries
    // `authorType: "Bot"`, and `fluxcdbot` — 32.9% of them — has neither that type nor a `[bot]` suffix.
    const bots = botAccounts(["fluxcdbot", "hmcts-platform-operations"]);

    expect(isHumanAccount("fluxcdbot", "User", bots)).toBe(false);
    expect(isHumanAccount("FluxCDBot", "User", bots)).toBe(false);
    expect(isHumanAccount("hmcts-platform-operations", "User", bots)).toBe(false);
  });

  it("should judge a person whose login contains bot as human, since the list is not a substring rule", () => {
    // `gemmatalbot` is Gemma Talbot, who has 53 pull requests on this estate. Any `login.includes("bot")`
    // test calls her automation, and misattributing somebody's work is worse than the miscount.
    expect(isHumanAccount("gemmatalbot", "User", botAccounts(["fluxcdbot", "claude"]))).toBe(true);
  });

  it("should tolerate a suffix on either side of the configured name", () => {
    expect(isHumanAccount("renovate[bot]", "User", botAccounts(["renovate"]))).toBe(false);
    expect(isHumanAccount("flux", "User", botAccounts(["flux[bot]"]))).toBe(false);
  });
});

describe("contributorLogins", () => {
  it("should count one person once whatever case their login was written in", () => {
    // A GitHub login is unique case-insensitively, so two spellings are one person.
    expect([...contributorLogins([commit({ authorLogin: "Alice" }), commit({ authorLogin: "alice" })], new Set())]).toEqual(["alice"]);
  });

  it("should leave out every bot account", () => {
    // Bots are excluded here even though the pull-request cohort keeps agent-authored merges: an agent is
    // still not a person who became active.
    const logins = contributorLogins([commit({ authorLogin: "alice" }), commit({ authorLogin: "dependabot", authorType: "Bot" })], new Set());

    expect([...logins]).toEqual(["alice"]);
  });

  it("should leave out a named account when nothing in GitHub's answer marks it as one", () => {
    const logins = contributorLogins([commit({ authorLogin: "alice" }), commit({ authorLogin: "fluxcdbot" })], botAccounts(["fluxcdbot"]));

    expect([...logins]).toEqual(["alice"]);
  });
});

describe("comparableLogin", () => {
  it.each([
    ["renovate[bot]", "renovate"],
    ["Dependabot", "dependabot"],
    [undefined, ""]
  ])("should normalise %s to %s for configuration matching", (login, expected) => {
    expect(comparableLogin(login)).toBe(expected);
  });
});

describe("inCohort", () => {
  it("should exclude a configured author whatever bot suffix their login carries", () => {
    const excluded = excludedAuthors(["renovate", "dependabot"]);

    expect(inCohort(commit({ authorLogin: "renovate[bot]" }), excluded)).toBe(false);
    expect(inCohort(commit({ authorLogin: "alice" }), excluded)).toBe(true);
  });
});

describe("isHumanCommitAuthor", () => {
  it("should let the linked account settle it when GitHub matched one", () => {
    expect(isHumanCommitAuthor("alice", "User", "Some Bot", new Set(), new Set())).toBe(true);
    expect(isHumanCommitAuthor("dependabot", "Bot", "Alice", new Set(), new Set())).toBe(false);
  });

  it("should fall back to the git author name when GitHub linked no account", () => {
    // A stated limitation: a name is whatever the committer's tooling wrote.
    expect(isHumanCommitAuthor(undefined, undefined, "renovate[bot]", new Set(), new Set())).toBe(false);
    expect(isHumanCommitAuthor(undefined, undefined, "Alice", new Set(), new Set())).toBe(true);
  });

  it("should exclude a configured author by the same normalisation the cohort uses", () => {
    expect(isHumanCommitAuthor("renovate[bot]", "User", undefined, new Set(["renovate"]), new Set())).toBe(false);
  });

  it("should exclude a named bot account when the git author name is the only identity", () => {
    // The name fallback carries the named list too, which is what catches a service account committing
    // through tooling GitHub linked to nobody.
    expect(isHumanCommitAuthor(undefined, undefined, "fluxcdbot", new Set(), botAccounts(["fluxcdbot"]))).toBe(false);
  });
});

describe("reportedDirectCommit", () => {
  it("should keep a person's commit when neither list names them", () => {
    expect(reportedDirectCommit(commit({ authorLogin: "gemmatalbot" }), excludedAuthors(["renovate"]), botAccounts(["fluxcdbot"]))).toBe(true);
  });

  it("should drop a bot-suffixed author, which GitHub's own convention already declares", () => {
    expect(reportedDirectCommit(commit({ authorLogin: "renovate[bot]" }), new Set(), new Set())).toBe(false);
  });

  it("should drop a named account when GitHub reports it as a user", () => {
    // The whole reason the list exists: 44% of stored direct commits come from three accounts GitHub types
    // `User`, `fluxcdbot` alone 32.9%, and a deploy bot reconciling an image tag is not a person bypassing
    // review.
    expect(reportedDirectCommit(commit({ authorLogin: "fluxcdbot" }), new Set(), botAccounts(["fluxcdbot"]))).toBe(false);
  });

  it("should drop a dependency bot the cohort excludes, by either list", () => {
    expect(reportedDirectCommit(commit({ authorLogin: "renovate" }), excludedAuthors(["renovate"]), new Set())).toBe(false);
  });
});

describe("reportedCohort", () => {
  /** One walked window: two people, one dependency bot and one named service account, by both routes. */
  function walked() {
    return {
      pullRequests: [
        pullRequest({ identifier: 1, authorLogin: "alice" }),
        pullRequest({ identifier: 2, authorLogin: "renovate[bot]" }),
        // An agent's PULL REQUEST stays: it was opened, reviewed and merged through the gate, which is the
        // practice being measured. Only the direct-commit rule is wider.
        pullRequest({ identifier: 3, authorLogin: "claude" })
      ],
      directCommits: [commit({ sha: "aaa", authorLogin: "bob" }), commit({ sha: "bbb", authorLogin: "fluxcdbot" })]
    };
  }

  const EXCLUDED = excludedAuthors(["renovate", "dependabot"]);
  const BOTS = botAccounts(["fluxcdbot", "claude"]);

  it("should count the merges neither list names and no others", () => {
    const reported = reportedCohort(walked(), EXCLUDED, BOTS);

    expect(reported.merges.pullRequests.map((fact) => fact.identifier)).toEqual([1, 3]);
    expect(reported.merges.directCommits.map((fact) => fact.sha)).toEqual(["aaa"]);
  });

  it("should name every author it left out, keyed as the configuration names them", () => {
    // `renovate[bot]` reads back as `renovate`, so the map compares against the policy that produced it
    // rather than against GitHub's suffix convention.
    expect(reportedCohort(walked(), EXCLUDED, BOTS).excluded).toEqual({ renovate: 1, fluxcdbot: 1 });
  });

  it("should count nothing excluded when neither list names an author in the window", () => {
    const reported = reportedCohort(walked(), new Set(), new Set());

    expect(reported.excluded).toEqual({});
    expect(reported.merges.pullRequests).toHaveLength(3);
    expect(reported.merges.directCommits).toHaveLength(2);
  });

  it("should leave the cohort empty rather than absent when every merge was a bot's", () => {
    // The distinction the whole contract rests on: this is a measured nothing, and the report layer turns it
    // into `0` because the coverage table says the walk happened.
    const reported = reportedCohort({ pullRequests: [pullRequest({ authorLogin: "renovate[bot]" })], directCommits: [] }, EXCLUDED, BOTS);

    expect(reported.merges).toEqual({ pullRequests: [], directCommits: [] });
  });

  it("should tally each excluded author once per change they landed", () => {
    const cohort = {
      pullRequests: [pullRequest({ identifier: 1, authorLogin: "renovate[bot]" }), pullRequest({ identifier: 2, authorLogin: "renovate" })],
      directCommits: [commit({ sha: "aaa", authorLogin: "fluxcdbot" }), commit({ sha: "bbb", authorLogin: undefined, authorName: "fluxcdbot" })]
    };

    expect(reportedCohort(cohort, EXCLUDED, BOTS).excluded).toEqual({ renovate: 2, fluxcdbot: 2 });
  });
});

describe("eligibleReviews", () => {
  it("should exclude a review submitted after the merge, keeping settled history immutable", () => {
    const fact = pullRequest({ reviews: [review({ submittedAt: new Date("2026-08-04T00:00:00Z") })] });

    expect(eligibleReviews(fact)).toEqual([]);
  });

  it("should exclude a pending review, a bot review and the author's own", () => {
    const fact = pullRequest({
      reviews: [
        review({ identifier: 1, state: ReviewState.Pending }),
        review({ identifier: 2, authorLogin: "ci", authorType: "Bot" }),
        review({ identifier: 3, authorLogin: "AUTHOR" }),
        review({ identifier: 4, authorLogin: "reviewer" })
      ]
    });

    expect(eligibleReviews(fact).map((r) => r.identifier)).toEqual([4]);
  });
});

describe("reviewStartedAt", () => {
  it("should anchor on the ready-for-review event rather than on creation", () => {
    // A change worked on as a draft for a fortnight was not waiting for anybody during it.
    const fact = pullRequest({ readyForReviewAt: new Date("2026-08-02T12:00:00Z") });

    expect(reviewStartedAt(fact).toISOString()).toBe("2026-08-02T12:00:00.000Z");
  });

  it("should prefer an earlier eligible review, since review demonstrably began then", () => {
    // GitHub allows reviewing a draft, and taking the earlier of the two also stops a negative wait.
    const fact = pullRequest({
      readyForReviewAt: new Date("2026-08-02T12:00:00Z"),
      reviews: [review({ submittedAt: new Date("2026-08-01T06:00:00Z") })]
    });

    expect(reviewStartedAt(fact).toISOString()).toBe("2026-08-01T06:00:00.000Z");
  });

  it("should fall back to creation when nothing better is known", () => {
    expect(reviewStartedAt(pullRequest()).toISOString()).toBe("2026-08-01T00:00:00.000Z");
  });
});

describe("reviewStateCounts", () => {
  it("should count every review event, eligible or not, sorted by state", () => {
    // The breakdown exists to show what reviewing looked like; filtering it would answer coverage twice.
    const fact = pullRequest({
      reviews: [review({ state: ReviewState.Approved }), review({ state: ReviewState.Commented }), review({ state: ReviewState.Approved })]
    });

    expect(reviewStateCounts([fact])).toEqual({ APPROVED: 2, COMMENTED: 1 });
  });
});

describe("eligibleChecks", () => {
  it("should exclude a check that finished after the merge", () => {
    const fact = pullRequest({ checks: [check({ completedAt: new Date("2026-08-04T00:00:00Z") })] });

    expect(eligibleChecks(fact)).toEqual([]);
  });

  it("should exclude a check that never finished", () => {
    const fact = pullRequest({ checks: [check({ completedAt: undefined })] });

    expect(eligibleChecks(fact)).toEqual([]);
  });
});

describe("isPassingCheck", () => {
  it.each([
    [CheckConclusion.Success, true],
    // Neutral and skipped do not block a merge, so GitHub's own rollup treats them as passing.
    [CheckConclusion.Neutral, true],
    [CheckConclusion.Skipped, true],
    [CheckConclusion.Failure, false],
    [CheckConclusion.Cancelled, false]
  ])("should treat %s as passing=%s", (conclusion, expected) => {
    expect(isPassingCheck(check({ conclusion }))).toBe(expected);
  });
});

describe("sizeClass", () => {
  it.each([
    [{ additions: 3, deletions: 2, changedFiles: 1 }, "trivial"],
    [{ additions: 30, deletions: 20, changedFiles: 4 }, "substantial"],
    [{ additions: 3, deletions: 2, changedFiles: 3 }, "substantial"],
    // An unsized change stays its own class, so a missing size never silently excuses an unreviewed merge
    // nor inflates the substantial count.
    [{ additions: undefined, deletions: 2, changedFiles: 1 }, "unsized"]
  ])("should classify %o as %s", (size, expected) => {
    expect(sizeClass(commit(size), 10, 1)).toBe(expected);
  });
});

describe("changeSize", () => {
  it("should sum additions and deletions when GitHub sized the change", () => {
    expect(changeSize(commit({ additions: 7, deletions: 3, changedFiles: 2 }))).toEqual({ lines: 10, files: 2 });
  });

  it("should report nothing when any part of the size is missing", () => {
    expect(changeSize(commit({ additions: 7, deletions: 3 }))).toBeUndefined();
  });
});

describe("rate", () => {
  it("should report an observed rate when there was a denominator", () => {
    expect(rate(3, 4)).toEqual({ status: ObservationStatus.Observed, numerator: 3, denominator: 4 });
  });

  it("should report not-applicable rather than a zero when there was nothing to count", () => {
    expect(rate(0, 0).status).toBe(ObservationStatus.NotApplicable);
  });
});

describe("ratePercentage", () => {
  it("should report a percentage to the tenth", () => {
    expect(ratePercentage(rate(1, 3))).toBe(33.3);
  });

  it("should report nothing when there was no denominator", () => {
    expect(ratePercentage(rate(0, 0))).toBeUndefined();
  });

  it("should round a tie to even, as Python does", () => {
    // 33 of 40 is 82.5 exactly, so the tie rule decides the last digit.
    expect(ratePercentage(rate(33, 40))).toBe(82.5);
  });
});

describe("distribution", () => {
  it("should report the three percentiles of a sample", () => {
    const observed = distribution([1, 2, 3, 4], "hours");

    expect(observed.status).toBe(ObservationStatus.Observed);
    expect(observed.sampleSize).toBe(4);
    expect(observed.median).toBe(2.5);
    expect(observed.percentile75).toBe(3.25);
    expect(observed.percentile90).toBe(3.7);
  });

  it("should report not-applicable with no percentiles at all for an empty sample", () => {
    // Absent rather than zero: nobody measured it, as distinct from having measured nothing.
    const observed = distribution([], "hours");

    expect(observed.status).toBe(ObservationStatus.NotApplicable);
    expect(observed.median).toBeUndefined();
    expect(observed.percentile75).toBeUndefined();
    expect(observed.percentile90).toBeUndefined();
  });
});
