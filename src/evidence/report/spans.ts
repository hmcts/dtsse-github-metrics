import type * as contract from "../../lib/types.ts";
import { collectedAnchor, collectionIsStale, days, type ReportingWindow, reportingWindow } from "../window/window.ts";
import { stripAbsent } from "./absent.ts";

/**
 * Which spans the dashboard offers and what window each of them resolves to.
 *
 * PURE OVER THE COLLECTED EDGE, which is the whole reason this is not part of `./estate.ts`. Both answers below
 * depend on one fact from the database — how far the last collection reached — and on nothing else, so the read
 * happens once in `./estate.ts` and the arithmetic is a function of its result. That is what lets the anchoring
 * rule be asserted by the unit suite rather than by a case that has to arrange a `source_coverage` table.
 *
 * THE LEAF THE SPAN LIST IS DECLARED IN, and it imports neither the cache nor the store for that reason: a module
 * that reached either would pull the Prisma client into every reader of the week selector.
 */

/**
 * The spans the week selector offers, which are also the only spans `./cache.ts` will hold.
 *
 * ONE LIST AND NOT TWO THAT AGREE. A span on offer the cache does not hold is a page every reader pays a cold
 * build for, and a span held but not offered is an entry nothing reads — so the selector and the cache read the
 * same declaration and cannot disagree about which spans exist.
 */
export const WEEK_OPTIONS: readonly number[] = [1, 4, 8, 12, 26];
export const DEFAULT_WEEKS = 4;

/** The most periods one trend request may ask for. The UI reads the cut from here rather than assuming one. */
export const MAXIMUM_TREND_PERIODS = 13;

/**
 * How long one trend period runs.
 *
 * FOUR WHOLE WEEKS AND NOT A CALENDAR MONTH, so every period holds the same number of each weekday. Throughput
 * onto a default branch is not flat across a week — almost nothing merges at a weekend — so periods of 30 and 31
 * days would carry four or five Mondays depending on where they happened to fall, and a series would move for
 * that reason alone. It is not configurable because it is the unit the periods are counted in rather than a
 * threshold anybody argues with: changing it renumbers every period a reader has already seen.
 */
export const TREND_PERIOD_DAYS = 28;

/**
 * The cut one trend request named, or `undefined` for every whole period since enablement.
 *
 * REFUSED ABOVE THE MAXIMUM RATHER THAN TRUNCATED TO IT, which is the upstream service's rule and matters
 * because of which end a cut keeps. `periodWindows` drops the RECENT periods, so a request silently reduced from
 * 40 to 13 would be answered with the first 13 periods after enablement while the caller believed it had asked
 * for everything — a series that is not what was requested, presented as though it were. Refusing says so.
 *
 * AN OMITTED CUT IS NOT A DEFAULT, and there is deliberately none: it means every whole period since enablement,
 * however many that is. The UI never omits it — it asks for `WindowOptions.trend_periods`, which is
 * `MAXIMUM_TREND_PERIODS` — so the unbounded series is reachable only by a caller that has chosen it.
 */
export function requestedTrendPeriods(periods: number | undefined): number | undefined {
  if (periods === undefined) {
    return undefined;
  }
  if (!Number.isInteger(periods) || periods < 1) {
    throw new RangeError(`a trend must ask for a whole number of periods, at least one, not ${periods}`);
  }
  if (periods > MAXIMUM_TREND_PERIODS) {
    throw new RangeError(`a trend may ask for at most ${MAXIMUM_TREND_PERIODS} periods, not ${periods}`);
  }
  return periods;
}

/** The widest span on offer, and so the one window a read has to cover to answer for all of them. */
export const WIDEST_SPAN = Math.max(...WEEK_OPTIONS);

/** One window and, where a collection has reached the estate, the edge it was anchored at. */
export interface ReportWindow {
  window: ReportingWindow;
  collectedThrough?: Date;
}

/**
 * The window one `?weeks=` selection resolves to, anchored where the caches end.
 *
 * Anchored at the collected edge rather than at today's midnight, so a page served the day after a collection
 * reports the same figures it did the day the run landed.
 */
export function spanWindow(collectedThrough: Date | undefined, weeks: number, reference: Date): ReportWindow {
  const anchor = collectedAnchor(collectedThrough, reference);
  return {
    window: reportingWindow(spanStartsAt(anchor, weeks), anchor),
    ...(collectedThrough === undefined ? {} : { collectedThrough })
  };
}

/**
 * Where one span starts, given where the read it is derived from ends.
 *
 * ONE DEFINITION AND NOT TWO THAT AGREE. `spanWindow` above resolves a span read for itself and `covers` in
 * `./estate.ts` asks whether a shared read reaches one, and both are `anchor - weeks * 7 days` against the anchor
 * `collectedAnchor` snapped to. Both go through this, so a span derived from a shared read and the same span read
 * for itself resolve to the identical window rather than to two windows that happen to match.
 */
export function spanStartsAt(endsAt: Date, weeks: number): Date {
  return new Date(endsAt.getTime() - days(weeks * 7));
}

/** The spans on offer, and what the collection behind them looks like. */
export function reportedWindowOptions(collectedThrough: Date | undefined, staleCollectionDays: number, reference: Date): contract.WindowOptions {
  // `stripAbsent` IS GIVEN THE TYPE EXPLICITLY, here and at every other call in the report layer that wraps a
  // literal. Its signature is `<T>(value: T): T`, so left to infer it takes the literal's own shape and hands it
  // back — the declared return type is then satisfied by a WIDER object, and a key the contract does not name
  // passes silently. Naming the type argument makes the literal fresh against the contract, which is what runs the
  // excess property check. This is how `display_name` and the four row figures were found.
  return stripAbsent<contract.WindowOptions>({
    // COPIED RATHER THAN HANDED OVER. `WEEK_OPTIONS` is the one declaration the cache keys itself off and every
    // caller of this shares one module scope, so passing the array itself would let a reader sort or splice the
    // cache's key set. The contract declares a plain `number[]` because that is what a JSON array is, and this is
    // the copy.
    options: [...WEEK_OPTIONS],
    default: DEFAULT_WEEKS,
    trend_periods: MAXIMUM_TREND_PERIODS,
    collected_through: collectedThrough?.toISOString(),
    collection_stale: collectionIsStale(collectedThrough, reference, days(staleCollectionDays))
  });
}
