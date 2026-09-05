import { describe, expect, it } from "vitest";
import { rate } from "../behaviour/analysis.ts";
import { independentReviewCoverage, mergeCycleTime, Percentile, pullRequestSize } from "../behaviour/metrics.ts";
import { ObservationStatus } from "../domain/facts.ts";
import { DeltaBasis, delta, metricComparison, metricDelta, metricDeltas, noBaselineDelta, thinWindow, throughputDeltas, trendMetric } from "./trend.ts";

// Ported from tests/test_trend.py.

describe("trendMetric", () => {
  it("should compare a rate as a percentage", () => {
    const item = trendMetric(independentReviewCoverage, rate(9, 10));

    expect(item.value).toBe(90);
    expect(item.percentile).toBeUndefined();
  });

  it("should compare a distribution at the percentile the metric declares", () => {
    // Read through the metric so the trend and the assessment cannot diverge on which number they mean.
    const summary = { status: ObservationStatus.Observed, sampleSize: 4, unit: "lines", median: 100, percentile75: 400, percentile90: 900 };

    const item = trendMetric(pullRequestSize, summary);

    expect(item.value).toBe(400);
    expect(item.percentile).toBe(Percentile.Percentile75);
  });

  it("should read the median where that is the declared percentile", () => {
    const summary = { status: ObservationStatus.Observed, sampleSize: 4, unit: "hours", median: 12, percentile75: 30, percentile90: 48 };

    expect(trendMetric(mergeCycleTime, summary).value).toBe(12);
  });

  it("should carry no value where the window observed no eligible sample", () => {
    // A metric with no value in one of the two windows has no delta rather than a delta against nothing.
    expect(trendMetric(pullRequestSize, { status: ObservationStatus.NotApplicable, sampleSize: 0, unit: "lines" }).value).toBeUndefined();
    expect(trendMetric(independentReviewCoverage, rate(0, 0)).value).toBeUndefined();
  });
});

describe("delta", () => {
  it("should subtract a rate in percentage points, never as a percentage of a percentage", () => {
    const computed = delta("independent-review-coverage", { basis: DeltaBasis.PercentagePoints, unit: "percent" }, 70, 90);

    expect(computed.change).toBe(20);
    expect(computed.basis).toBe(DeltaBasis.PercentagePoints);
  });

  it("should report a relative change for a count", () => {
    expect(delta("merges", { basis: DeltaBasis.PercentageChange }, 20, 25).change).toBe(25);
  });

  it("should refuse a relative change against a zero baseline, saying why", () => {
    // A relative change against nothing is not a large movement, it is an undefined one.
    const computed = delta("merges", { basis: DeltaBasis.PercentageChange }, 0, 5);

    expect(computed.change).toBeUndefined();
    expect(computed.detail).toMatch(/baseline is zero/);
  });

  it("should always report both absolute figures, whatever the change came out as", () => {
    const computed = delta("merges", { basis: DeltaBasis.PercentageChange }, 0, 5);

    expect(computed.baseline).toBe(0);
    expect(computed.period).toBe(5);
  });

  it("should subtract rates after rounding, so the page's own figures subtract to the stated movement", () => {
    // A reader who subtracts the two figures on the page must get the figure the page states.
    const computed = delta("rate", { basis: DeltaBasis.PercentagePoints, unit: "percent" }, 33.3, 66.7);

    expect(computed.change).toBe(33.4);
  });

  it("should round a relative change to the tenth", () => {
    expect(delta("merges", { basis: DeltaBasis.PercentageChange }, 3, 10).change).toBe(233.3);
  });
});

describe("metricComparison", () => {
  it("should compare a rate in percentage points", () => {
    expect(metricComparison(trendMetric(independentReviewCoverage, rate(9, 10)))).toEqual({ basis: DeltaBasis.PercentagePoints, unit: "percent" });
  });

  it("should compare a distribution relatively, carrying its unit and percentile", () => {
    const summary = { status: ObservationStatus.Observed, sampleSize: 4, unit: "lines", median: 100, percentile75: 400, percentile90: 900 };

    expect(metricComparison(trendMetric(pullRequestSize, summary))).toEqual({
      basis: DeltaBasis.PercentageChange,
      unit: "lines",
      percentile: Percentile.Percentile75
    });
  });
});

describe("metricDelta", () => {
  it("should report nothing where the baseline observed no value", () => {
    const period = trendMetric(independentReviewCoverage, rate(9, 10));

    expect(metricDelta(trendMetric(independentReviewCoverage, rate(0, 0)), period)).toBeUndefined();
    expect(metricDelta(undefined, period)).toBeUndefined();
  });

  it("should report nothing where the period observed no value", () => {
    expect(metricDelta(trendMetric(independentReviewCoverage, rate(9, 10)), trendMetric(independentReviewCoverage, rate(0, 0)))).toBeUndefined();
  });
});

describe("metricDeltas", () => {
  it("should compare every metric both windows observed, and no others", () => {
    const baseline = [trendMetric(independentReviewCoverage, rate(7, 10))];
    const period = [
      trendMetric(independentReviewCoverage, rate(9, 10)),
      trendMetric(mergeCycleTime, { status: ObservationStatus.NotApplicable, sampleSize: 0, unit: "hours" })
    ];

    const computed = metricDeltas(baseline, period);

    expect(computed.map((entry) => entry.measure)).toEqual(["independent-review-coverage"]);
    expect(computed[0]?.change).toBe(20);
  });
});

describe("throughputDeltas", () => {
  it("should compare both routes onto the default branch and the total", () => {
    const computed = throughputDeltas({ mergedPullRequests: 10, directCommits: 2, merges: 12 }, { mergedPullRequests: 20, directCommits: 1, merges: 21 });

    expect(computed.map((entry) => [entry.measure, entry.change])).toEqual([
      ["merged pull requests", 100],
      ["direct commits", -50],
      ["merges", 75]
    ]);
  });
});

describe("thinWindow", () => {
  it("should suppress metric values below the configured minimum, saying why", () => {
    // Applied per period: a rate over four merges is arithmetic, and reporting it would dress a thin window up
    // as a movement.
    expect(thinWindow(4, 10)).toMatch(/4 merges into the default branch, below the minimum of 10/);
  });

  it("should suppress nothing once the cohort is big enough", () => {
    expect(thinWindow(10, 10)).toBeUndefined();
  });
});

describe("noBaselineDelta", () => {
  it("should quote what the baseline itself reported", () => {
    expect(noBaselineDelta("3 merges into the default branch")).toMatch(/not comparable, so no delta was computed: 3 merges/);
  });
});
