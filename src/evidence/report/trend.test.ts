import { describe, expect, it } from "vitest";
import { rate } from "../behaviour/analysis.ts";
import { independentReviewCoverage, mergeCycleTime, Percentile, pullRequestSize } from "../behaviour/metrics.ts";
import type { Interval } from "../domain/coverage.ts";
import { type DirectCommitFact, type Merges, ObservationStatus, type PullRequestFact, ReviewState } from "../domain/facts.ts";
import { parseConfiguration } from "../policy/load.ts";
import { findNulls } from "./absent.ts";
import {
  builtRepositoryTrend,
  DeltaBasis,
  delta,
  metricComparison,
  metricDelta,
  metricDeltas,
  noBaselineDelta,
  thinWindow,
  throughputDeltas,
  trendMetric,
  trendWithoutEnablement,
  trendWithoutWholePeriod
} from "./trend.ts";

// Ported from tests/test_trend.py; `builtRepositoryTrend` and the two period-less series are this port's own.

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
    const computed = throughputDeltas(
      { mergedPullRequests: 10, directCommits: 2, merges: 12, activeContributors: 3 },
      { mergedPullRequests: 20, directCommits: 1, merges: 21, activeContributors: 9 }
    );

    // THREE MEASURES AND NOT FOUR: the contributor count is reported beside them and never compared, because a
    // change in how many people worked in a repository is a change in the team rather than in its practice.
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

/**
 * One repository's whole series, which is what `getTrend` returned nothing for on every repository until VIBE-592.
 *
 * THE THREE STATES A WINDOW CAN BE IN are what most of these cases are about, because they are the absent-versus-
 * zero rule applied per window: unread (counts ABSENT), read but thin (counts reported, metric values suppressed),
 * and observed. A zero standing in for the first would say a repository merged nothing in a month nobody walked.
 */
const CONFIGURATION = parseConfiguration(`
version: 1
organization: hmcts
assessment:
  minimum_merges: 2
cohort:
  excluded_authors:
    - renovate
`);

const ENABLEMENT = new Date(Date.UTC(2026, 0, 1));
const PERIOD_MILLIS = 28 * 86_400_000;

/** The baseline and two whole periods, as `baselineWindow` and `periodWindows` resolve them for a 28-day period. */
const BASELINE = { startsAt: new Date(ENABLEMENT.getTime() - PERIOD_MILLIS), endsAt: ENABLEMENT };
const FIRST = { startsAt: ENABLEMENT, endsAt: new Date(ENABLEMENT.getTime() + PERIOD_MILLIS) };
const SECOND = { startsAt: FIRST.endsAt, endsAt: new Date(ENABLEMENT.getTime() + 2 * PERIOD_MILLIS) };

/** Coverage over the whole series, which is what makes every window below a MEASURED one. */
const COVERED: Interval[] = [{ startsAt: BASELINE.startsAt, endsAt: SECOND.endsAt }];

function pullRequest(mergedAt: Date, identifier: number, authorLogin = "ada", additions = 100): PullRequestFact {
  return {
    identifier,
    repository: "alpha",
    number: identifier,
    createdAt: new Date(mergedAt.getTime() - 4 * 3_600_000),
    readyForReviewAt: new Date(mergedAt.getTime() - 4 * 3_600_000),
    mergedAt,
    draft: false,
    authorLogin,
    authorType: "User",
    additions,
    deletions: 4,
    changedFiles: 3,
    reviews: [
      {
        identifier,
        submittedAt: new Date(mergedAt.getTime() - 2 * 3_600_000),
        state: ReviewState.Approved,
        authorLogin: "grace",
        authorType: "User",
        commentCount: 2
      }
    ],
    checks: [{ name: "build", conclusion: "SUCCESS", completedAt: new Date(mergedAt.getTime() - 3_600_000) }]
  };
}

function directCommit(committedAt: Date, sha: string): DirectCommitFact {
  return { sha, repository: "alpha", committedAt, authorLogin: "alan", authorType: "User", additions: 3, deletions: 1, changedFiles: 1 };
}

/** One merge an hour into a window, so every fact sits strictly inside the half-open interval it belongs to. */
function inside(window: { startsAt: Date }, hours: number): Date {
  return new Date(window.startsAt.getTime() + hours * 3_600_000);
}

/**
 * Facts spanning the baseline and both periods, in the ONE read `builtRepositoryTrend` slices per window.
 *
 * The sizes differ per window on purpose: an identical cohort in both would make every delta zero, and a zero
 * delta is indistinguishable from one the comparison declined to compute.
 */
function walked(): Merges {
  return {
    pullRequests: [
      pullRequest(inside(BASELINE, 1), 1, "ada", 100),
      pullRequest(inside(BASELINE, 2), 2, "ada", 100),
      pullRequest(inside(FIRST, 1), 3, "ada", 200),
      // Authored by someone other than the reviewer, so the review counts as independent: a pull request its own
      // author approved is not reviewed, which would make this window's coverage rate about the fixture.
      pullRequest(inside(FIRST, 2), 4, "alan", 200),
      pullRequest(inside(FIRST, 3), 5, "alan", 200),
      pullRequest(inside(SECOND, 1), 6, "ada", 400),
      pullRequest(inside(SECOND, 2), 7, "ada", 400)
    ],
    directCommits: [directCommit(inside(BASELINE, 3), "aaaaaaa"), directCommit(inside(SECOND, 3), "bbbbbbb")]
  };
}

function series(overrides: Partial<Parameters<typeof builtRepositoryTrend>[1]> = {}, configuration = CONFIGURATION) {
  return builtRepositoryTrend(configuration, {
    repository: "alpha",
    enablement: ENABLEMENT,
    baseline: BASELINE,
    periods: [FIRST, SECOND],
    walked: walked(),
    coverage: { pullRequests: COVERED, directCommits: COVERED },
    ...overrides
  });
}

describe("builtRepositoryTrend", () => {
  it("should build one window per whole period, each carrying its own half-open interval", () => {
    const built = series();

    expect(built.repository).toBe("alpha");
    expect(built.enablement_at).toBe(ENABLEMENT.toISOString());
    expect(built.baseline?.starts_at).toBe(BASELINE.startsAt.toISOString());
    expect(built.baseline?.ends_at).toBe(ENABLEMENT.toISOString());
    expect(built.periods.map((period) => [period.starts_at, period.ends_at])).toEqual([
      [FIRST.startsAt.toISOString(), FIRST.endsAt.toISOString()],
      [SECOND.startsAt.toISOString(), SECOND.endsAt.toISOString()]
    ]);
  });

  it("should number periods from the enablement instant rather than from their place in the list", () => {
    // A cut series names its periods the way an uncut one does, which is what `lib/trend.ts` labels `P1` onwards
    // from — so the index cannot come off the array.
    expect(series().periods.map((period) => period.index)).toEqual([1, 2]);
  });

  it("should slice one read of the facts into the window each merge belongs to, half-open at the end", () => {
    const built = series();

    expect(built.baseline?.throughput).toEqual({ merges: 3, merged_pull_requests: 2, direct_commits: 1, active_contributors: 2 });
    expect(built.periods[0]?.throughput).toEqual({ merges: 3, merged_pull_requests: 3, direct_commits: 0, active_contributors: 2 });
    expect(built.periods[1]?.throughput).toEqual({ merges: 3, merged_pull_requests: 2, direct_commits: 1, active_contributors: 2 });
  });

  it("should report the cohort split each window was measured over, beside its throughput", () => {
    const built = series({
      walked: {
        ...walked(),
        pullRequests: [...walked().pullRequests, pullRequest(inside(FIRST, 4), 8, "renovate")]
      }
    });

    // `merged` is what the cache held and `reported` is what the figures count, so the excluded author is
    // accounted for rather than showing up as a quiet drop in throughput.
    expect(built.periods[0]?.cohort).toEqual({ merged: 4, reported: 3, excluded_authors: { renovate: 1 }, direct_commits: 0 });
  });

  it("should compare every metric both windows observed, in percentage points for a rate", () => {
    const built = series();
    const coverage = built.periods[0]?.deltas.find((computed) => computed.measure === "independent-review-coverage");

    expect(coverage?.basis).toBe("percentage_points");
    expect(coverage?.unit).toBe("percent");
    // The baseline holds a direct commit and the first period holds none, so review coverage moves from 2/3 to 3/3.
    expect(coverage?.baseline).toBe(66.7);
    expect(coverage?.period).toBe(100);
  });

  it("should compare a distribution at the percentile the metric declares, carrying that percentile", () => {
    const size = series().periods[1]?.deltas.find((computed) => computed.measure === "pull-request-size");

    expect(size?.percentile).toBe(Percentile.Percentile75);
    expect(size?.basis).toBe("percentage_change");
    expect(size?.unit).toBe("lines");
  });

  it("should compare the counts onto the default branch, and never the contributor count", () => {
    const measures = series().periods[0]?.deltas.map((computed) => computed.measure) ?? [];

    expect(measures.slice(0, 3)).toEqual(["merged pull requests", "direct commits", "merges"]);
    expect(measures).not.toContain("active contributors");
  });

  it("should refuse a relative change against a zero baseline count, saying why on the delta itself", () => {
    // The baseline holds one direct commit and the first period holds none, so the reverse case needs a baseline
    // with none: a change of "minus one hundred per cent from nothing" is undefined rather than large.
    const built = series({ walked: { pullRequests: walked().pullRequests, directCommits: [directCommit(inside(FIRST, 3), "ccccccc")] } });
    const commits = built.periods[0]?.deltas.find((computed) => computed.measure === "direct commits");

    expect(commits?.change).toBeUndefined();
    expect(commits?.detail).toMatch(/baseline is zero/);
  });

  it("should report absent counts and no metric for a window no collection covered", () => {
    // A ZERO HERE WOULD BE A LIE. Collection fills 90 days and a cut of 13 periods reaches 364 back, so the early
    // periods of a long-enabled repository are normally in exactly this state.
    const built = series({ coverage: { pullRequests: [{ startsAt: BASELINE.startsAt, endsAt: FIRST.endsAt }], directCommits: COVERED } });
    const second = built.periods[1];

    expect(second?.throughput).toBeUndefined();
    expect(second?.metrics).toEqual([]);
    expect(second?.detail).toBe("cached pull_requests evidence does not cover this window");
    expect(second?.cohort).toEqual({ excluded_authors: {}, direct_commits: 1 });
  });

  it("should name both unread sources where neither reaches the window", () => {
    const built = series({ coverage: { pullRequests: [], directCommits: [] } });

    expect(built.periods[0]?.detail).toBe("cached pull_requests and direct_commits evidence does not cover this window");
  });

  it("should count a declared no-direct-pushes repository as read for its direct commits", () => {
    // The one exception `measuredSources` makes for the estate row, honoured here so a series and the row above it
    // do not disagree about whether a repository's direct commits were measured.
    const declared = parseConfiguration(`
version: 1
organization: hmcts
assessment:
  minimum_merges: 2
cohort:
  no_direct_pushes:
    - ALPHA
`);

    const built = series({ coverage: { pullRequests: COVERED, directCommits: [] } }, declared);

    expect(built.periods[0]?.throughput?.direct_commits).toBe(0);
    expect(built.periods[0]?.detail).toBeUndefined();
  });

  it("should report a thin window's counts and suppress its metric values, saying why", () => {
    const thin = series({ walked: { pullRequests: [pullRequest(inside(FIRST, 1), 1)], directCommits: [] } });

    expect(thin.periods[0]?.throughput?.merges).toBe(1);
    expect(thin.periods[0]?.metrics).toEqual([]);
    expect(thin.periods[0]?.detail).toMatch(/1 merges into the default branch, below the minimum of 2/);
  });

  it("should compare no period at all where the baseline was never read, quoting the baseline's own reason", () => {
    const built = series({ coverage: { pullRequests: [{ startsAt: ENABLEMENT, endsAt: SECOND.endsAt }], directCommits: COVERED } });

    expect(built.periods.every((period) => period.deltas.length === 0)).toBe(true);
    expect(built.delta_detail).toBe(
      "the baseline window is not comparable, so no delta was computed: cached pull_requests evidence does not cover this window"
    );
  });

  it("should still compare the counts where the baseline was read but is merely thin", () => {
    // A thin baseline suppresses its metric VALUES, not its counts, so `metricDeltas` drops the metrics on its own
    // and the throughput comparison survives. Blanking the whole comparison would lose a real movement.
    const built = series({ walked: { pullRequests: walked().pullRequests.filter((fact) => fact.identifier > 2), directCommits: [] } });

    expect(built.delta_detail).toBeUndefined();
    expect(built.periods[0]?.deltas.map((computed) => computed.measure)).toEqual(["merged pull requests", "direct commits", "merges"]);
  });

  it("should carry an empty alert history rather than omitting the key the contract requires", () => {
    // Nothing has ever written an `alert_observations` row, and `lib/trend.ts` reads the field without a guard.
    const built = series();

    expect(built.alert_observations).toEqual([]);
    expect(built.alert_observations).not.toBe(series().alert_observations);
  });

  it("should emit the contract's own spelling and no null anywhere in the series", () => {
    // `sampleSize` reaching a component printed "undefined samples" under three cards on every repository page,
    // and it type-checked because the domain and the contract call the interface the same thing.
    const built = series();
    const size = built.periods[1]?.metrics.find((metric) => metric.metric === "pull-request-size");

    expect(size?.summary).toMatchObject({ status: ObservationStatus.Observed, sample_size: 2, unit: "lines" });
    expect(size?.percentile).toBe(Percentile.Percentile75);
    expect(findNulls(built)).toEqual([]);
  });

  it("should carry no percentile on a rate, which has none to read", () => {
    const coverage = series().periods[0]?.metrics.find((metric) => metric.metric === "independent-review-coverage");

    expect(coverage).toBeDefined();
    expect(coverage === undefined ? true : "percentile" in coverage).toBe(false);
  });
});

describe("a series with no periods", () => {
  it("should say when no enablement date is configured, carrying no enablement instant at all", () => {
    const built = trendWithoutEnablement("alpha");

    expect(built.periods).toEqual([]);
    expect(built.enablement_at).toBeUndefined();
    expect(built.detail).toBe("no enablement date is configured for this repository");
    expect(built.alert_observations).toEqual([]);
  });

  it("should say when a repository has not been enabled for a whole period, carrying the date it was", () => {
    // TOLD APART BY MORE THAN THE PROSE: the enablement instant is present here and absent above, so a reader does
    // not have to parse a sentence to know which of the two states a repository is in.
    const built = trendWithoutWholePeriod("alpha", ENABLEMENT, 28);

    expect(built.periods).toEqual([]);
    expect(built.enablement_at).toBe(ENABLEMENT.toISOString());
    expect(built.detail).toMatch(/no whole period of 28 days has elapsed since 2026-01-01/);
  });
});
