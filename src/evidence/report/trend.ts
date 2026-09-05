import { ratePercentage } from "../behaviour/analysis.ts";
import { type BehaviourMetric, Percentile } from "../behaviour/metrics.ts";
import { roundHalfEven } from "../behaviour/rounding.ts";
import { type DistributionObservation, ObservationStatus, type RateObservation } from "../domain/facts.ts";

/**
 * Comparing one repository's windows since enablement. Ported from `metrics.trend`.
 *
 * DERIVED ARITHMETIC ONLY: nothing here consults a threshold, and no result is graded or coloured. A trend says
 * what moved, and by how much; whether that is good is a question the readiness assessment answers separately.
 */

/** How a movement is expressed. */
export const DeltaBasis = {
  /** A relative change, for a count or a distribution. */
  PercentageChange: "percentage_change",
  /** An absolute difference, for a rate: never a relative percentage of a percentage. */
  PercentagePoints: "percentage_points"
} as const;

export type DeltaBasis = (typeof DeltaBasis)[keyof typeof DeltaBasis];

const BASELINE_ZERO = "the baseline is zero, so a relative change cannot be computed";

/** Says why a series compares none of its periods, quoting what the baseline itself reported. */
export function noBaselineDelta(detail: string): string {
  return `the baseline window is not comparable, so no delta was computed: ${detail}`;
}

/** Says why a window's metric values are suppressed, or `undefined` when its cohort is big enough. */
export function thinWindow(counted: number, minimum: number): string | undefined {
  if (counted >= minimum) {
    return undefined;
  }
  return `${counted} merges into the default branch, below the minimum of ${minimum}, so metric values are suppressed`;
}

/** One metric's observation beside the single number a series compares windows on. */
export interface TrendMetric {
  metric: string;
  summary: RateObservation | DistributionObservation;
  value?: number;
  percentile?: Percentile;
}

export interface TrendDelta {
  measure: string;
  basis: DeltaBasis;
  baseline: number;
  period: number;
  change?: number;
  unit?: string;
  percentile?: Percentile;
  detail?: string;
}

interface Comparison {
  basis: DeltaBasis;
  unit?: string;
  percentile?: Percentile;
}

/** How a cohort count is compared: relative change, with both absolute counts always reported. */
const COUNT: Comparison = { basis: DeltaBasis.PercentageChange };

/** How a rate is compared: in percentage points, never as a relative percentage of a percentage. */
const RATE: Comparison = { basis: DeltaBasis.PercentagePoints, unit: "percent" };

/** Whether one observation is a distribution, which is what tells the two observation shapes apart. */
function isDistribution(summary: RateObservation | DistributionObservation): summary is DistributionObservation {
  return "unit" in summary;
}

/** The value a distribution is compared at, read from the percentile the metric declares. */
function percentileValue(metric: BehaviourMetric, observation: DistributionObservation): number | undefined {
  if (metric.percentile === Percentile.Percentile75) {
    return observation.percentile75;
  }
  if (metric.percentile === Percentile.Percentile90) {
    return observation.percentile90;
  }
  return observation.median;
}

/**
 * One metric's observation beside the number a series compares windows on.
 *
 * A rate is compared as a percentage; a distribution at the FIXED PERCENTILE THE METRIC DECLARES and the
 * readiness assessment grades, read through the metric so the two cannot diverge. Either is absent where the
 * window observed no eligible sample, and a metric with no value in one of the two windows has no delta rather
 * than a delta against nothing.
 */
export function trendMetric(metric: BehaviourMetric, summary: RateObservation | DistributionObservation): TrendMetric {
  if (isDistribution(summary)) {
    const value = summary.status === ObservationStatus.Observed ? percentileValue(metric, summary) : undefined;
    return { metric: metric.identifier, summary, ...(value === undefined ? {} : { value }), percentile: metric.percentile };
  }
  const value = ratePercentage(summary);
  return { metric: metric.identifier, summary, ...(value === undefined ? {} : { value }) };
}

/** How one behaviour metric moves, from the shape of the observation itself. */
export function metricComparison(item: TrendMetric): Comparison {
  if (!isDistribution(item.summary)) {
    return RATE;
  }
  return {
    basis: DeltaBasis.PercentageChange,
    unit: item.summary.unit,
    ...(item.percentile === undefined ? {} : { percentile: item.percentile })
  };
}

/**
 * How one measure moved between the baseline and one period.
 *
 * RATES ARE SUBTRACTED AFTER BOTH ARE ROUNDED TO THE TENTH, so the reported movement is exactly the difference
 * between the two reported values rather than a third number rounded separately. A reader who subtracts the two
 * figures on the page must get the figure the page states.
 */
export function delta(measure: string, comparison: Comparison, baseline: number, period: number): TrendDelta {
  let change: number | undefined;
  let detail: string | undefined;

  if (comparison.basis === DeltaBasis.PercentagePoints) {
    change = roundHalfEven(period - baseline, 1);
  } else if (baseline === 0) {
    // A relative change against nothing is not a large movement, it is an undefined one.
    detail = BASELINE_ZERO;
  } else {
    change = roundHalfEven(((period - baseline) / baseline) * 100, 1);
  }

  return {
    measure,
    basis: comparison.basis,
    baseline,
    period,
    ...(change === undefined ? {} : { change }),
    ...(comparison.unit === undefined ? {} : { unit: comparison.unit }),
    ...(comparison.percentile === undefined ? {} : { percentile: comparison.percentile }),
    ...(detail === undefined ? {} : { detail })
  };
}

/** Compares one metric between the two windows, or reports nothing where either observed no value. */
export function metricDelta(baseline: TrendMetric | undefined, period: TrendMetric): TrendDelta | undefined {
  if (baseline === undefined || baseline.value === undefined || period.value === undefined) {
    return undefined;
  }
  return delta(period.metric, metricComparison(period), baseline.value, period.value);
}

/** Compares every metric BOTH windows observed, and no others. */
export function metricDeltas(baseline: readonly TrendMetric[], period: readonly TrendMetric[]): TrendDelta[] {
  const observed = new Map(baseline.map((item) => [item.metric, item]));
  return period.map((item) => metricDelta(observed.get(item.metric), item)).filter((computed): computed is TrendDelta => computed !== undefined);
}

/** What one window put onto the default branch, by both routes and in total. */
export interface TrendThroughput {
  mergedPullRequests: number;
  directCommits: number;
  merges: number;
}

/** The measures a throughput comparison names, spelled once so deltas and rendered rows cannot disagree. */
export function throughputMeasures(throughput: TrendThroughput): [string, number][] {
  return [
    ["merged pull requests", throughput.mergedPullRequests],
    ["direct commits", throughput.directCommits],
    ["merges", throughput.merges]
  ];
}

/** Compares what the two windows put onto the default branch. */
export function throughputDeltas(baseline: TrendThroughput, period: TrendThroughput): TrendDelta[] {
  const counts = new Map(throughputMeasures(baseline));
  return throughputMeasures(period).map(([measure, value]) => delta(measure, COUNT, counts.get(measure) ?? 0, value));
}
