import { midnight } from "./instant.ts";

/**
 * Resolving half-open reporting windows from user options. `metrics.window` verbatim, minus
 * `parse_instant`/`midnight`, which live in `./instant.ts`.
 *
 * Every window here is half-open: `[startsAt, endsAt)`. A merge at exactly `endsAt` belongs to the
 * next window, never to both.
 */

const MILLIS_PER_DAY = 86_400_000;
const MILLIS_PER_HOUR = 3_600_000;

export function days(count: number): number {
  return count * MILLIS_PER_DAY;
}

export function hours(count: number): number {
  return count * MILLIS_PER_HOUR;
}

/**
 * The midnight offline reporting should anchor at.
 *
 * A window ending where the caches end is reportable; one ending at today's midnight the day after a
 * collection is not, because the last few hours of the collection's own day were never recorded as
 * covered. Anchoring at the collection's edge means a span served the day after a run reports the
 * same figures it did the day the run landed.
 *
 * Nothing collected falls back to the reference's midnight, so a cold cache still resolves a window
 * and reports it as unavailable. The clamp is deliberate: a window recorded by a `--to` in the future
 * must not anchor a report ahead of today.
 */
export function collectedAnchor(collectedThrough: Date | undefined, reference: Date): Date {
  const floor = midnight(reference);
  if (collectedThrough === undefined) {
    return floor;
  }
  const collected = midnight(collectedThrough);
  return collected.getTime() < floor.getTime() ? collected : floor;
}

/**
 * Whether the collection the report is anchored at is older than the cadence allows.
 *
 * Figures anchored at an old collection are honest but easy to misread as current, so reporting says
 * when the last run is further behind than `staleAfter`. Nothing collected is stale too: there is no
 * run to be current.
 */
export function collectionIsStale(collectedThrough: Date | undefined, reference: Date, staleAfterMillis: number): boolean {
  if (collectedThrough === undefined) {
    return true;
  }
  return reference.getTime() - collectedThrough.getTime() > staleAfterMillis;
}

/**
 * Builds a window, refusing an interval that ends at or before it starts.
 *
 * `domain.ReportingWindow.validate_interval` was a pydantic model validator, so upstream got this
 * check on every construction however the window arrived. Nothing in TypeScript's structural typing
 * gives that for free, so every window is built through here — an empty or reversed interval would
 * otherwise report "no evidence" for a request that was simply the wrong way round.
 */
export function reportingWindow(startsAt: Date, endsAt: Date): ReportingWindow {
  if (endsAt.getTime() <= startsAt.getTime()) {
    throw new RangeError("reporting window end must follow its start");
  }
  return { startsAt, endsAt };
}

/**
 * The window of one period length ending at the enablement instant.
 *
 * One period, not several, so the before and the after are the same shape and comparing them needs no
 * averaging.
 */
export function baselineWindow(enablement: Date, spanMillis: number): ReportingWindow {
  return reportingWindow(new Date(enablement.getTime() - spanMillis), enablement);
}

/**
 * Each WHOLE period since enablement, the trailing partial period excluded.
 *
 * Whole periods are counted to the most recent UTC midnight, the anchor `resolveWindow` already uses,
 * so two runs on the same day resolve the same series. A short trailing period is excluded rather than
 * reported: it is not comparable with a full one, and including it would show every series dipping at
 * its right-hand edge for arithmetic reasons alone.
 *
 * `periods` caps the count from the ENABLEMENT end of the series, keeping the EARLIEST periods and
 * dropping the recent ones: the question is what happened after enablement, and the baseline
 * comparison reads from there. An enablement instant in the future yields no period rather than a
 * negative count.
 */
export function periodWindows(enablement: Date, spanMillis: number, periods: number | undefined, reference: Date): ReportingWindow[] {
  // Python's `//` floors toward negative infinity; `Math.floor` matches it, and the `max(…, 0)` clamp
  // upstream applies is what stops a future enablement yielding a negative count either way.
  const elapsed = midnight(reference).getTime() - enablement.getTime();
  const whole = Math.max(Math.floor(elapsed / spanMillis), 0);
  const count = periods === undefined ? whole : Math.min(periods, whole);
  const windows: ReportingWindow[] = [];
  for (let index = 0; index < count; index += 1) {
    windows.push(reportingWindow(new Date(enablement.getTime() + index * spanMillis), new Date(enablement.getTime() + (index + 1) * spanMillis)));
  }
  return windows;
}

/** Resolves a reporting window from at most two of its start, end, and span. */
export function resolveWindow(options: WindowOptions): ReportingWindow {
  const { startsAt, endsAt, days: spanDays, defaultDays, reference } = options;

  if (spanDays !== undefined && spanDays < 1) {
    throw new RangeError("a reporting window must span at least one day");
  }
  if (startsAt !== undefined && endsAt !== undefined && spanDays !== undefined) {
    throw new RangeError("give at most two of --from, --to, and --days");
  }

  const span = days(spanDays === undefined ? defaultDays : spanDays);
  const anchor = midnight(reference);

  if (startsAt !== undefined && endsAt !== undefined) {
    return reportingWindow(startsAt, endsAt);
  }
  if (startsAt !== undefined) {
    return reportingWindow(startsAt, spanDays !== undefined ? new Date(startsAt.getTime() + span) : anchor);
  }
  if (endsAt !== undefined) {
    return reportingWindow(new Date(endsAt.getTime() - span), endsAt);
  }
  return reportingWindow(new Date(anchor.getTime() - span), anchor);
}

/** A half-open interval `[startsAt, endsAt)`. */
export interface ReportingWindow {
  startsAt: Date;
  endsAt: Date;
}

export interface WindowOptions {
  startsAt?: Date;
  endsAt?: Date;
  days?: number;
  defaultDays: number;
  reference: Date;
}
