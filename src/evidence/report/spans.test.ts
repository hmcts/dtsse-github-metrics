import { describe, expect, it } from "vitest";
import { DEFAULT_WEEKS, MAXIMUM_TREND_PERIODS, reportedWindowOptions, spanStartsAt, spanWindow, WEEK_OPTIONS, WIDEST_SPAN } from "./spans.ts";

/**
 * Which spans the selector offers, and where each of them starts.
 *
 * WHAT THE COLLECTED EDGE DOES TO A WINDOW is the whole subject here. The anchoring rule used to be reachable only
 * through a function that aggregated `source_coverage` first, so "a page served the day after a collection reports
 * the same figures" was asserted by nothing — it is two dates and a subtraction, and it is asserted here.
 */

const REFERENCE = new Date(Date.UTC(2026, 8, 17, 14, 30));
const STALE_AFTER_DAYS = 2;

describe("the spans on offer", () => {
  it("should offer the default span it also holds a cache entry for", () => {
    expect(WEEK_OPTIONS).toContain(DEFAULT_WEEKS);
  });

  it("should name the widest offered span as the one a shared read has to cover", () => {
    expect(WIDEST_SPAN).toBe(Math.max(...WEEK_OPTIONS));
  });
});

describe("where one span starts", () => {
  it("should start a span exactly seven days per week back from where the read ends", () => {
    const endsAt = new Date(Date.UTC(2026, 8, 17));

    expect(spanStartsAt(endsAt, 4)).toEqual(new Date(Date.UTC(2026, 7, 20)));
  });

  it("should place a wider span's start before a narrower one's when both end together", () => {
    const endsAt = new Date(Date.UTC(2026, 8, 17));

    expect(spanStartsAt(endsAt, 26).getTime()).toBeLessThan(spanStartsAt(endsAt, 1).getTime());
  });
});

describe("the window a selection resolves to", () => {
  it("should anchor at the collected edge when a collection landed before today", () => {
    // THE RULE THE WHOLE OFFLINE REPORT RESTS ON. A window ending at today's midnight the day after a run would
    // include hours nothing recorded as covered, and the figures would shrink for a reason no reader could see.
    const collectedThrough = new Date(Date.UTC(2026, 8, 15, 15, 0));

    const resolved = spanWindow(collectedThrough, 1, REFERENCE);

    expect(resolved.window.endsAt).toEqual(new Date(Date.UTC(2026, 8, 15)));
    expect(resolved.window.startsAt).toEqual(new Date(Date.UTC(2026, 8, 8)));
    expect(resolved.collectedThrough).toEqual(collectedThrough);
  });

  it("should resolve the same window on two successive days when the collection has not moved", () => {
    const collectedThrough = new Date(Date.UTC(2026, 8, 15, 15, 0));

    const today = spanWindow(collectedThrough, 4, REFERENCE);
    const tomorrow = spanWindow(collectedThrough, 4, new Date(Date.UTC(2026, 8, 18, 9, 0)));

    expect(tomorrow.window).toEqual(today.window);
  });

  it("should anchor at the reference's midnight when nothing has been collected", () => {
    const resolved = spanWindow(undefined, 1, REFERENCE);

    expect(resolved.window.endsAt).toEqual(new Date(Date.UTC(2026, 8, 17)));
  });

  it("should omit the collected edge rather than carry it as absent when nothing has been collected", () => {
    // Absent means unmeasured on this contract, so the key is missing rather than present and undefined.
    expect(Object.keys(spanWindow(undefined, 1, REFERENCE))).toEqual(["window"]);
  });

  it("should clamp an edge recorded ahead of today back to today's midnight", () => {
    // A `--to` in the future must not anchor a report ahead of the day it is read on.
    const resolved = spanWindow(new Date(Date.UTC(2026, 9, 1)), 1, REFERENCE);

    expect(resolved.window.endsAt).toEqual(new Date(Date.UTC(2026, 8, 17)));
  });

  it("should start a span where a read of that span would be asked to reach back to", () => {
    // ONE DEFINITION AND NOT TWO THAT AGREE: a span read for itself and a span filtered out of a shared read have
    // to resolve to the same instant, or a warmed report answers from facts that stop short of its own window.
    const resolved = spanWindow(new Date(Date.UTC(2026, 8, 15)), 8, REFERENCE);

    expect(resolved.window.startsAt).toEqual(spanStartsAt(resolved.window.endsAt, 8));
  });
});

describe("the window options the selector reads", () => {
  it("should offer a copy of the span list rather than the list the cache keys itself off", () => {
    const options = reportedWindowOptions(new Date(Date.UTC(2026, 8, 17)), STALE_AFTER_DAYS, REFERENCE);

    expect(options.options).toEqual([...WEEK_OPTIONS]);
    expect(options.options).not.toBe(WEEK_OPTIONS);
  });

  it("should state the default span and the trend cut so no reader has to assume one", () => {
    const options = reportedWindowOptions(new Date(Date.UTC(2026, 8, 17)), STALE_AFTER_DAYS, REFERENCE);

    expect(options.default).toBe(DEFAULT_WEEKS);
    expect(options.trend_periods).toBe(MAXIMUM_TREND_PERIODS);
  });

  it("should report the collection as fresh when it landed inside the configured cadence", () => {
    const options = reportedWindowOptions(new Date(Date.UTC(2026, 8, 17, 3, 0)), STALE_AFTER_DAYS, REFERENCE);

    expect(options.collection_stale).toBe(false);
    expect(options.collected_through).toBe("2026-09-17T03:00:00.000Z");
  });

  it("should report the collection as stale when the last run is further behind than the cadence allows", () => {
    const options = reportedWindowOptions(new Date(Date.UTC(2026, 8, 10)), STALE_AFTER_DAYS, REFERENCE);

    expect(options.collection_stale).toBe(true);
  });

  it("should drop the collected edge and report staleness when nothing has been collected", () => {
    // There is no run to be current, and the absent key says nobody measured rather than "collected at zero".
    const options = reportedWindowOptions(undefined, STALE_AFTER_DAYS, REFERENCE);

    expect(options.collection_stale).toBe(true);
    expect("collected_through" in options).toBe(false);
  });
});
