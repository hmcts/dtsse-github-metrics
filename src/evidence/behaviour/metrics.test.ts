import { describe, expect, it } from "vitest";
import {
  CheckConclusion,
  type DirectCommitFact,
  type DistributionObservation,
  type Merges,
  ObservationStatus,
  type PullRequestFact,
  type RateObservation,
  type ReviewFact,
  ReviewState
} from "../domain/facts.ts";
import type { TraceabilityConfiguration } from "../policy/schema.ts";
import { ratePercentage } from "./analysis.ts";
import {
  approvalCoverage,
  behaviourMetric,
  behaviourMetricIdentifiers,
  behaviourMetrics,
  checksPassingAtMerge,
  descriptionQuality,
  independentReviewClassification,
  independentReviewCoverage,
  mergeCycleTime,
  Percentile,
  pullRequestSize,
  reviewDepth,
  timeToFirstReview,
  traceabilityReference
} from "./metrics.ts";

const TRACEABILITY: TraceabilityConfiguration = { minimum_description: 30, reference_patterns: ["#\\d+", "[A-Z][A-Z0-9]+-\\d+"] };

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
  return { sha: "abc", repository: "cath-service", committedAt: new Date("2026-08-02T00:00:00Z"), authorLogin: "author", authorType: "User", ...overrides };
}

function cohort(pullRequests: PullRequestFact[] = [], directCommits: DirectCommitFact[] = []): Merges {
  return { pullRequests, directCommits };
}

describe("independentReviewCoverage", () => {
  it("should count a merge carrying an independent human review", () => {
    const summary = independentReviewCoverage.summary(cohort([pullRequest({ reviews: [review()] })])) as RateObservation;

    expect(ratePercentage(summary)).toBe(100);
  });

  it("should count a direct commit in the denominator, so bypassing review cannot improve the rate", () => {
    const summary = independentReviewCoverage.summary(cohort([pullRequest({ reviews: [review()] })], [commit()])) as RateObservation;

    expect(summary).toMatchObject({ numerator: 1, denominator: 2 });
  });

  it("should classify a direct commit as such", () => {
    expect(independentReviewCoverage.commitClassification(commit())).toBe("direct-commit");
  });

  it("should report not-applicable for an empty cohort rather than a zero rate", () => {
    expect(independentReviewCoverage.summary(cohort()).status).toBe(ObservationStatus.NotApplicable);
  });
});

describe("approvalCoverage", () => {
  it("should count a merge carrying an independent approval", () => {
    expect(approvalCoverage.classification(pullRequest({ reviews: [review({ state: ReviewState.Approved })] }))).toBe("included");
  });

  it("should distinguish a review that never approved, which review coverage alone would pass", () => {
    const reviewed = pullRequest({ reviews: [review({ state: ReviewState.Commented })] });

    expect(independentReviewCoverage.classification(reviewed)).toBe("included");
    expect(approvalCoverage.classification(reviewed)).toBe("independent-review-without-approval");
  });
});

describe("independentReviewClassification", () => {
  it.each([
    [[], "no-review-events"],
    [[review({ submittedAt: new Date("2026-08-04T00:00:00Z") })], "reviews-after-merge"],
    [[review({ state: ReviewState.Pending })], "pending-reviews-only"],
    [[review({ authorLogin: "ci", authorType: "Bot" })], "bot-or-unattributed-reviews-only"],
    [[review({ authorLogin: "author" })], "author-reviews-only"]
  ])("should explain %o as %s", (reviews, expected) => {
    expect(independentReviewClassification(pullRequest({ reviews }))).toBe(expected);
  });
});

describe("reviewDepth", () => {
  it("should credit an approval whose reviewer commented elsewhere on the pull request", () => {
    const fact = pullRequest({
      reviews: [
        review({ identifier: 1, state: ReviewState.Commented, commentCount: 3, submittedAt: new Date("2026-08-01T12:00:00Z") }),
        review({ identifier: 2, state: ReviewState.Approved, commentCount: 0 })
      ]
    });

    expect(reviewDepth.classification(fact)).toBe("commented");
  });

  it("should count a body with no inline comments as having said something", () => {
    const fact = pullRequest({ reviews: [review({ state: ReviewState.Approved, body: "this changes the retry semantics, I checked X" })] });

    expect(reviewDepth.classification(fact)).toBe("commented");
  });

  it("should report a wordless approval as a rubber stamp", () => {
    expect(reviewDepth.classification(pullRequest({ reviews: [review({ state: ReviewState.Approved })] }))).toBe("uncommented-approval-only");
  });

  it("should attribute per reviewer, so a silent second approval is still reported", () => {
    const fact = pullRequest({
      reviews: [
        review({ identifier: 1, authorLogin: "first", state: ReviewState.Approved, commentCount: 4 }),
        review({ identifier: 2, authorLogin: "second", state: ReviewState.Approved, commentCount: 0 })
      ]
    });

    const summary = reviewDepth.summary(cohort([fact])) as RateObservation;
    expect(summary).toMatchObject({ numerator: 1, denominator: 2 });
  });

  it("should report no eligible approval when nothing approved", () => {
    expect(reviewDepth.classification(pullRequest({ reviews: [review({ state: ReviewState.Commented })] }))).toBe("no-eligible-approval");
  });
});

describe("mergeCycleTime", () => {
  it("should measure from entering review rather than from creation", () => {
    const fact = pullRequest({ readyForReviewAt: new Date("2026-08-02T00:00:00Z") });

    expect(mergeCycleTime.value(fact)).toBe(24);
  });

  it("should read at the median, undistorted by the one change that stalled", () => {
    expect(mergeCycleTime.percentile).toBe(Percentile.Median);
  });

  it("should count no direct commit, since a push has no cycle to time", () => {
    expect(mergeCycleTime.commitClassification(commit())).toBeUndefined();
  });
});

describe("timeToFirstReview", () => {
  it("should measure the wait to the first independent review", () => {
    const fact = pullRequest({ readyForReviewAt: new Date("2026-08-01T00:00:00Z"), reviews: [review({ submittedAt: new Date("2026-08-01T08:00:00Z") })] });

    expect(timeToFirstReview.value(fact)).toBe(8);
  });

  it("should contribute nothing when the change was never reviewed", () => {
    expect(timeToFirstReview.value(pullRequest())).toBeUndefined();
    expect(timeToFirstReview.summary(cohort([pullRequest()])).status).toBe(ObservationStatus.NotApplicable);
  });
});

describe("pullRequestSize", () => {
  it("should read at the 75th percentile, since a long tail of large changes is the risk", () => {
    expect(pullRequestSize.percentile).toBe(Percentile.Percentile75);
  });

  it("should sum additions and deletions", () => {
    expect(pullRequestSize.value(pullRequest({ additions: 40, deletions: 60 }))).toBe(100);
  });

  it("should separate a pull request GitHub did not size", () => {
    expect(pullRequestSize.classification(pullRequest())).toBe("size-unavailable");
  });

  it("should keep meaning pull-request size, excluding direct commits from the sample", () => {
    const summary = pullRequestSize.summary(
      cohort([pullRequest({ additions: 10, deletions: 0 })], [commit({ additions: 900, deletions: 0, changedFiles: 9 })])
    ) as DistributionObservation;

    expect(summary.sampleSize).toBe(1);
  });
});

describe("checksPassingAtMerge", () => {
  it.each([
    [[], "no-checks"],
    [[{ name: "build", conclusion: CheckConclusion.Success, completedAt: new Date("2026-08-02T00:00:00Z") }], "passing"],
    [[{ name: "build", conclusion: CheckConclusion.Failure, completedAt: new Date("2026-08-02T00:00:00Z") }], "failing"],
    [[{ name: "build", conclusion: undefined, completedAt: undefined }], "incomplete-at-merge"]
  ])("should classify checks %o as %s", (checks, expected) => {
    expect(checksPassingAtMerge.classification(pullRequest({ checks }))).toBe(expected);
  });

  it.each([
    [undefined, "no-checks"],
    ["SUCCESS", "passing"],
    ["FAILURE", "failing"],
    ["ERROR", "failing"],
    ["PENDING", "checks-unfinished"]
  ])("should judge a direct commit whose rollup is %s as %s", (checkState, expected) => {
    expect(checksPassingAtMerge.commitClassification(commit({ checkState }))).toBe(expected);
  });
});

describe("descriptionQuality", () => {
  const metric = descriptionQuality(TRACEABILITY);

  it("should count a description meeting the configured minimum length", () => {
    expect(metric.classification(pullRequest({ body: "x".repeat(30) }))).toBe("described");
  });

  it("should not count whitespace towards the minimum", () => {
    expect(metric.classification(pullRequest({ body: `${"x".repeat(10)}${" ".repeat(40)}` }))).toBe("description-too-short");
  });

  it("should count no direct commit, since there was no pull request to describe", () => {
    expect(metric.commitClassification(commit())).toBeUndefined();
  });
});

describe("traceabilityReference", () => {
  const metric = traceabilityReference(TRACEABILITY);

  it.each([
    [{ body: "fixes #123" }, "referenced"],
    [{ title: "DTSSE-42 add the thing" }, "referenced"],
    [{ body: "no reference at all" }, "reference-missing"]
  ])("should classify %o as %s", (fields, expected) => {
    expect(metric.classification(pullRequest(fields))).toBe(expected);
  });

  it("should search the title as well as the body, for a team whose convention is the title", () => {
    expect(metric.classification(pullRequest({ title: "fixes #7", body: "" }))).toBe("referenced");
  });
});

describe("behaviourMetrics", () => {
  it("should register all nine metrics in the order a report presents them", () => {
    expect(behaviourMetrics(TRACEABILITY).map((metric) => metric.identifier)).toEqual([
      "independent-review-coverage",
      "approval-coverage",
      "review-depth",
      "merge-cycle-time",
      "time-to-first-review",
      "pull-request-size",
      "checks-passing-at-merge",
      "description-quality",
      "traceability-reference"
    ]);
  });

  it("should find a metric by its identifier", () => {
    expect(behaviourMetric("review-depth", TRACEABILITY).identifier).toBe("review-depth");
  });

  it("should refuse an unknown identifier", () => {
    expect(() => behaviourMetric("not-a-metric", TRACEABILITY)).toThrow(/unknown behaviour metric/);
  });

  it("should list every accepted identifier for the CLI to choose from", () => {
    expect(behaviourMetricIdentifiers()).toHaveLength(9);
  });
});

describe("every behaviour metric's per-merge accessors", () => {
  const metrics = behaviourMetrics(TRACEABILITY);

  for (const metric of metrics) {
    describe(metric.identifier, () => {
      it("should classify a merge as a non-empty label", () => {
        expect(metric.classification(pullRequest({ reviews: [review()] }))).toMatch(/\S/);
      });

      it("should classify a bare merge as a non-empty label", () => {
        expect(metric.classification(pullRequest())).toMatch(/\S/);
      });

      it("should return a finite value or nothing at all", () => {
        const value = metric.value(pullRequest({ reviews: [review()] }));
        if (value !== undefined) {
          expect(Number.isFinite(value)).toBe(true);
        }
      });

      it("should answer for a direct commit with a label or nothing", () => {
        const label = metric.commitClassification(commit());
        expect(label === undefined || label.length > 0).toBe(true);
      });
    });
  }

  it("should give every metric a percentile to read its distribution at", () => {
    for (const metric of metrics) {
      expect(Object.values(Percentile)).toContain(metric.percentile);
    }
  });
});
