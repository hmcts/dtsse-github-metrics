import type { CallOutcome, RateLimitWait } from "./client.ts";

/**
 * The run summary: where a run's calls went, and where its hours went.
 *
 * Formatting only, and deliberately in its own module rather than in the two commands that print it. Both
 * `collect` and `collect-org` spend a quota and both were reporting a single total, so the breakdown belongs
 * somewhere both can reach — and a summary whose whole job is to be READ is worth having under test rather
 * than assembled inline at a call site nothing exercises.
 */

/** What a summary is built from: the counters, and nothing else of a client. */
export interface RunSummarySource {
  callOutcomes(): { outcome: CallOutcome; count: number }[];
  rateLimitWaits(): RateLimitWait[];
}

/**
 * ORDERED BY COST, largest first.
 *
 * The question this summary exists to answer is "where did the eleven thousand calls go", and insertion
 * order answers it only by accident — whichever endpoint the collection happened to reach first leads. Ties
 * break on the line itself so two runs over the same estate read identically, the same reason
 * `countBySeverity` orders its output.
 */
function byCostThenName(left: { line: string; count: number }, right: { line: string; count: number }): number {
  return right.count - left.count || left.line.localeCompare(right.line);
}

/** One counted attempt kind as a line. */
function outcomeLine(outcome: CallOutcome, count: number): string {
  return `  ${outcome.status} ${outcome.outcome} ${outcome.method} ${outcome.endpoint} (x${count})`;
}

/**
 * One resource's standing still as a line.
 *
 * Reported in whole seconds beside the number of pauses, because those are the two different facts: one
 * fifty-minute wait and fifty one-minute waits cost a run the same hour and mean entirely different things
 * about the budget.
 */
function waitLine(wait: RateLimitWait): string {
  return `  waited ${wait.seconds.toFixed(0)}s for the ${wait.resource} quota across ${wait.count} ${wait.count === 1 ? "pause" : "pauses"}`;
}

/**
 * Every line of the run summary, indented for printing under a run's total.
 *
 * The waits come LAST rather than interleaved with the outcomes: a pause is not a call, and putting the two
 * in one list would invite a reader to add them up.
 */
export function runSummaryLines(source: RunSummarySource): string[] {
  const outcomes = source
    .callOutcomes()
    .map(({ outcome, count }) => ({ line: outcomeLine(outcome, count), count }))
    .sort(byCostThenName)
    .map((counted) => counted.line);
  const waits = source
    .rateLimitWaits()
    .slice()
    .sort((left, right) => right.seconds - left.seconds || left.resource.localeCompare(right.resource))
    .map(waitLine);
  return [...outcomes, ...waits];
}
