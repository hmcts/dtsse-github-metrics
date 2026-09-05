import { describe, expect, it } from "vitest";
import type { Interval } from "../domain/coverage.ts";
import { coalesceIntervals, findMissingIntervals, modalEdge } from "./intervals.ts";

// Ported from the coverage cases in tests/test_storage.py. Upstream exercised these through SQLite;
// the algebra is pure here, so the same cases run without a database. Days in August 2026 stand in for
// instants, exactly as upstream's parametrisation did.

function august(day: number, hour = 0): Date {
  return new Date(Date.UTC(2026, 7, day, hour));
}

function interval(startDay: number, endDay: number): Interval {
  return { startsAt: august(startDay), endsAt: august(endDay) };
}

function asDays(intervals: readonly Interval[]): [number, number][] {
  return intervals.map((entry) => [entry.startsAt.getUTCDate(), entry.endsAt.getUTCDate()]);
}

describe("findMissingIntervals", () => {
  it("should report the gaps left by partial collection while reusing complete history", () => {
    const covered = coalesceIntervals(coalesceIntervals(coalesceIntervals([], interval(1, 3)), interval(5, 7)), interval(7, 8));

    expect(asDays(findMissingIntervals(interval(1, 10), covered))).toEqual([
      [3, 5],
      [8, 10]
    ]);
  });

  it("should report the whole request when nothing is covered", () => {
    expect(asDays(findMissingIntervals(interval(1, 10), []))).toEqual([[1, 10]]);
  });

  it.each([
    [[interval(1, 2), interval(7, 8)], [[3, 6]]],
    // Enclosing coverage recognised: a request wholly inside a covered interval needs no collection.
    [[interval(1, 8)], []]
  ])("should ignore coverage outside the request and recognise enclosing coverage for %o", (covered, expected) => {
    expect(asDays(findMissingIntervals(interval(3, 6), covered))).toEqual(expected);
  });

  it("should clip a gap to the request rather than reporting beyond its end", () => {
    // The covered interval starts inside the request and ends past it, so the gap before it must stop
    // at the covered edge and nothing may be reported after the request's own end.
    expect(asDays(findMissingIntervals(interval(1, 5), [interval(3, 9)]))).toEqual([[1, 3]]);
  });

  it("should leave the cursor where the wider interval put it when one interval nests inside another", () => {
    // `Math.max` on the cursor is what makes this work: without it the nested interval would drag the
    // cursor backwards and invent a gap that is already covered.
    const covered = [interval(1, 9), interval(3, 4)];

    expect(findMissingIntervals(interval(1, 9), covered)).toEqual([]);
  });

  it("should treat an interval ending exactly at the request start as covering nothing of it", () => {
    // Half-open: `[…, 3)` and `[3, …)` do not overlap.
    expect(asDays(findMissingIntervals(interval(3, 6), [interval(1, 3)]))).toEqual([[3, 6]]);
  });

  it("should treat an interval starting exactly at the request end as covering nothing of it", () => {
    expect(asDays(findMissingIntervals(interval(1, 3), [interval(3, 6)]))).toEqual([[1, 3]]);
  });

  it("should report sub-day gaps when a window is collected to a mutable edge", () => {
    // The mutable edge is measured in hours, not days, so the algebra must not be day-granular.
    const covered: Interval[] = [{ startsAt: august(1), endsAt: august(1, 18) }];

    const missing = findMissingIntervals({ startsAt: august(1), endsAt: august(2) }, covered);

    expect(missing).toHaveLength(1);
    expect(missing[0]?.startsAt.toISOString()).toBe("2026-08-01T18:00:00.000Z");
    expect(missing[0]?.endsAt.toISOString()).toBe("2026-08-02T00:00:00.000Z");
  });
});

describe("coalesceIntervals", () => {
  it("should merge adjacent intervals, so daily collection does not accumulate a row per day", () => {
    // Adjacency counts, not just overlap: `[5, 7)` and `[7, 8)` become `[5, 8)`. This is what lets a
    // ninety-day window be satisfied by runs that each collected a day.
    const merged = coalesceIntervals(coalesceIntervals(coalesceIntervals([], interval(1, 3)), interval(5, 7)), interval(7, 8));

    expect(asDays(merged)).toEqual([
      [1, 3],
      [5, 8]
    ]);
  });

  it("should merge overlapping intervals into their union", () => {
    expect(asDays(coalesceIntervals([interval(1, 5)], interval(3, 9)))).toEqual([[1, 9]]);
  });

  it("should keep the wider end when the addition is enclosed by an existing interval", () => {
    expect(asDays(coalesceIntervals([interval(1, 9)], interval(3, 4)))).toEqual([[1, 9]]);
  });

  it("should keep a disjoint interval separate", () => {
    expect(asDays(coalesceIntervals([interval(1, 3)], interval(5, 8)))).toEqual([
      [1, 3],
      [5, 8]
    ]);
  });

  it("should order the result chronologically whatever order intervals arrived in", () => {
    expect(asDays(coalesceIntervals([interval(7, 9), interval(1, 2)], interval(4, 5)))).toEqual([
      [1, 2],
      [4, 5],
      [7, 9]
    ]);
  });

  it("should not mutate the intervals it was given", () => {
    const existing = [interval(1, 5)];

    coalesceIntervals(existing, interval(3, 9));

    expect(existing[0]?.endsAt.getUTCDate()).toBe(5);
  });
});

describe("modalEdge", () => {
  it("should report nothing when no edge has been collected", () => {
    expect(modalEdge([])).toBeUndefined();
  });

  it("should report the edge most repositories are at, not the greatest one any reached", () => {
    // The single repository at the 9th is a refresh or a part-way collection; anchoring there would
    // leave every other repository short of coverage and report the whole estate unavailable.
    expect(modalEdge([august(8), august(8), august(8), august(9)])?.toISOString()).toBe(august(8).toISOString());
  });

  it("should not let a straggler drag the anchor back", () => {
    // The edge every repository SHARES would be the 1st, hiding a thousand repositories' figures to
    // accommodate one that was missed.
    expect(modalEdge([august(1), august(8), august(8)])?.toISOString()).toBe(august(8).toISOString());
  });

  it("should break a tie towards the later edge", () => {
    // With no edge in the majority there is nothing to tell a cohort moving forward from one lagging
    // behind, so the answer stays what it was before the mode was counted.
    expect(modalEdge([august(7), august(8)])?.toISOString()).toBe(august(8).toISOString());
  });

  it("should report the only edge when one repository has been collected", () => {
    expect(modalEdge([august(8)])?.toISOString()).toBe(august(8).toISOString());
  });
});
