import type { Interval } from "../domain/coverage.ts";

/**
 * The interval algebra behind coverage, ported from `metrics.storage`'s `find_missing_coverage` and the
 * coalescing half of `record_source_coverage`.
 *
 * Kept pure and separate from the database access that uses it, because this is where the correctness
 * of every cached report lives: get it wrong in one direction and a window reports figures it never
 * collected, and in the other a collection refetches the whole history on every run. It is also the
 * part worth testing without a Postgres to hand.
 *
 * Every interval here is half-open: `[startsAt, endsAt)`.
 */

/**
 * The uncovered portions of one requested interval, given what is already covered.
 *
 * `covered` must be sorted by `startsAt` — the caller reads it back from Postgres with an ORDER BY, and
 * the single forward pass below depends on it.
 *
 * The `continue`/`break`/cursor-advance ordering is upstream's, line for line, and each branch earns
 * its place: intervals ending at or before the cursor are already accounted for, one starting at or
 * after the request's end means nothing further can overlap, and `Math.max` on the cursor is what makes
 * a nested interval — one wholly inside another — leave the cursor where the wider one had already put
 * it rather than dragging it backwards.
 */
export function findMissingIntervals(requested: Interval, covered: readonly Interval[]): Interval[] {
  let cursor = requested.startsAt;
  const missing: Interval[] = [];

  for (const interval of covered) {
    if (interval.endsAt.getTime() <= cursor.getTime()) {
      continue;
    }
    if (interval.startsAt.getTime() >= requested.endsAt.getTime()) {
      break;
    }
    if (interval.startsAt.getTime() > cursor.getTime()) {
      missing.push({
        startsAt: cursor,
        endsAt: earlier(interval.startsAt, requested.endsAt)
      });
    }
    cursor = later(cursor, interval.endsAt);
    if (cursor.getTime() >= requested.endsAt.getTime()) {
      break;
    }
  }

  if (cursor.getTime() < requested.endsAt.getTime()) {
    missing.push({ startsAt: cursor, endsAt: requested.endsAt });
  }
  return missing;
}

/**
 * One interval added to a set, with overlapping or adjacent intervals coalesced.
 *
 * Adjacency counts, not just overlap: `interval.startsAt > previous.endsAt` is a strict comparison, so
 * `[a, b)` and `[b, c)` merge into `[a, c)`. That is what stops a repository collected in daily
 * increments accumulating ninety rows that together cover one span, and it is why a report can find a
 * ninety-day window covered by runs that each collected a day.
 */
export function coalesceIntervals(existing: readonly Interval[], addition: Interval): Interval[] {
  const sorted = [...existing, addition].sort((left, right) => left.startsAt.getTime() - right.startsAt.getTime());
  const merged: Interval[] = [];

  for (const interval of sorted) {
    const previous = merged.at(-1);
    if (previous === undefined || interval.startsAt.getTime() > previous.endsAt.getTime()) {
      merged.push({ startsAt: interval.startsAt, endsAt: interval.endsAt });
      continue;
    }
    previous.endsAt = later(previous.endsAt, interval.endsAt);
  }
  return merged;
}

/**
 * The instant most of a set of per-repository edges reaches, or `undefined` for none.
 *
 * THE EDGE MOST REPOSITORIES ARE AT, NOT THE GREATEST ONE ANY OF THEM REACHED, and not the edge every
 * one of them shares. Both extremes blank the whole estate from a single repository:
 *
 *   - The edge every repository shares hands the window to the worst straggler — one repository missed
 *     for a month would drag a thousand others' window back a month to hide one gap.
 *   - The greatest edge hands it to whichever repository ran last on its own. A single-repository
 *     refresh, or a `collect` that died part-way, records coverage to today's midnight for the
 *     repositories it touched; an anchor there leaves every repository the run did not reach short of
 *     coverage by that day alone, which is the whole-estate `unavailable` this anchor exists to stop.
 *
 * The modal edge is the one the last WHOLE run left behind, so neither a straggler nor a minority
 * collected ahead of the rest moves it. A `collect` that dies past HALFWAY does move it, and the
 * repositories it never reached then report as unavailable — the residual case, accepted knowingly,
 * because a row count cannot tell a finished run from a majority of one.
 *
 * TIES GO TO THE LATER EDGE: with no edge in the majority there is nothing to tell a cohort moving
 * forward from one lagging behind, so the answer stays what it was before the mode was counted.
 */
export function modalEdge(edges: readonly Date[]): Date | undefined {
  if (edges.length === 0) {
    return undefined;
  }
  const counts = new Map<number, number>();
  for (const edge of edges) {
    const time = edge.getTime();
    counts.set(time, (counts.get(time) ?? 0) + 1);
  }
  let bestTime: number | undefined;
  let bestCount = 0;
  for (const [time, count] of counts) {
    if (count > bestCount || (count === bestCount && bestTime !== undefined && time > bestTime)) {
      bestTime = time;
      bestCount = count;
    }
  }
  return bestTime === undefined ? undefined : new Date(bestTime);
}

function earlier(left: Date, right: Date): Date {
  return left.getTime() <= right.getTime() ? left : right;
}

function later(left: Date, right: Date): Date {
  return left.getTime() >= right.getTime() ? left : right;
}
