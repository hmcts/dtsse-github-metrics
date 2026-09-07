import { describe, expect, it } from "vitest";
import { githubTimestamp, midnight, parseInstant } from "./instant.ts";
import { baselineWindow, collectedAnchor, collectionIsStale, days, hours, periodWindows, resolveWindow } from "./window.ts";

// Ported from tests/test_window.py. A fixed mid-afternoon instant anchors every relative window, so
// nothing here depends on when the suite runs.
const REFERENCE = new Date("2026-08-08T14:58:46Z");

// An enablement instant sitting a whole number of 28-day periods before the reference.
const ENABLEMENT = new Date("2026-05-03T00:00:00Z");

describe("parseInstant", () => {
  it.each([
    ["2026-08-01", "2026-08-01T00:00:00.000Z"],
    ["2026-08-01T14:30", "2026-08-01T14:30:00.000Z"],
    ["2026-08-01T14:30:00Z", "2026-08-01T14:30:00.000Z"],
    ["2026-08-01T14:30:00+01:00", "2026-08-01T13:30:00.000Z"],
    ["2026-08-01T14:30:00-05:00", "2026-08-01T19:30:00.000Z"]
  ])("should treat %s as %s when parsing a configured instant", (value, expected) => {
    expect(parseInstant(value).toISOString()).toBe(expected);
  });

  it("should read a naive datetime as UTC when no offset is given", () => {
    // The reason this module does not use `new Date`: it would read this as local time.
    expect(parseInstant("2026-08-01T14:30").toISOString()).toBe("2026-08-01T14:30:00.000Z");
  });

  it.each(["last tuesday", "", "2026-8-1", "2026-08-01T14"])("should name the accepted forms when %s cannot be parsed", (value) => {
    expect(() => parseInstant(value)).toThrow(/expected a date or datetime/);
  });

  it("should reject a date that does not exist rather than rolling it over", () => {
    // `Date.UTC` would turn month 13 into January of the next year. PyYAML raises for this value
    // before pydantic sees it, so a configuration naming an impossible date is reported, not fixed.
    expect(() => parseInstant("2026-13-05")).toThrow();
  });
});

describe("midnight", () => {
  it("should truncate to the most recent day boundary when anchoring a relative window", () => {
    expect(midnight(REFERENCE).toISOString()).toBe("2026-08-08T00:00:00.000Z");
  });
});

describe("githubTimestamp", () => {
  it("should emit second precision with no fraction when formatting a search qualifier", () => {
    // `toISOString()` would append `.000`, changing both the query text and the hash keyed on it.
    expect(githubTimestamp(new Date("2026-08-01T00:00:00.000Z"))).toBe("2026-08-01T00:00:00Z");
  });

  it("should truncate sub-second precision when an instant carries milliseconds", () => {
    expect(githubTimestamp(new Date("2026-08-01T12:34:56.789Z"))).toBe("2026-08-01T12:34:56Z");
  });
});

describe("resolveWindow", () => {
  it.each([
    [{}, "2026-05-10T00:00:00.000Z", "2026-08-08T00:00:00.000Z"],
    [{ days: 7 }, "2026-08-01T00:00:00.000Z", "2026-08-08T00:00:00.000Z"],
    [{ startsAt: new Date("2026-08-01Z"), endsAt: new Date("2026-08-05Z") }, "2026-08-01T00:00:00.000Z", "2026-08-05T00:00:00.000Z"],
    [{ startsAt: new Date("2026-08-01Z"), days: 2 }, "2026-08-01T00:00:00.000Z", "2026-08-03T00:00:00.000Z"],
    [{ startsAt: new Date("2026-08-01Z") }, "2026-08-01T00:00:00.000Z", "2026-08-08T00:00:00.000Z"],
    [{ endsAt: new Date("2026-08-05Z"), days: 2 }, "2026-08-03T00:00:00.000Z", "2026-08-05T00:00:00.000Z"],
    [{ endsAt: new Date("2026-08-05Z") }, "2026-05-07T00:00:00.000Z", "2026-08-05T00:00:00.000Z"]
  ])("should derive a half-open interval when given %o", (options, startsAt, endsAt) => {
    const window = resolveWindow({ ...options, defaultDays: 90, reference: REFERENCE });

    expect(window.startsAt.toISOString()).toBe(startsAt);
    expect(window.endsAt.toISOString()).toBe(endsAt);
  });

  it("should exclude its end instant when covering whole days", () => {
    const window = resolveWindow({
      startsAt: new Date("2026-08-01Z"),
      endsAt: new Date("2026-08-08Z"),
      defaultDays: 90,
      reference: REFERENCE
    });

    expect(window.endsAt.getTime() - window.startsAt.getTime()).toBe(days(7));
  });

  it.each([
    [{ days: 0 }, /at least one day/],
    [{ startsAt: new Date("2026-08-01Z"), endsAt: new Date("2026-08-05Z"), days: 2 }, /at most two of --from, --to, and --days/],
    [{ startsAt: new Date("2026-08-05Z"), endsAt: new Date("2026-08-01Z") }, /end must follow its start/]
  ])("should refuse %o as a contradictory, empty or reversed window", (options, message) => {
    expect(() => resolveWindow({ ...options, defaultDays: 90, reference: REFERENCE })).toThrow(message);
  });
});

describe("collectedAnchor", () => {
  it("should fall back to the reference when nothing has been collected", () => {
    expect(collectedAnchor(undefined, REFERENCE).toISOString()).toBe("2026-08-08T00:00:00.000Z");
  });

  it.each([
    ["2026-08-08T06:00:00Z", "2026-08-08T00:00:00.000Z"],
    ["2026-08-07T09:15:00Z", "2026-08-07T00:00:00.000Z"],
    ["2026-08-01T00:00:00Z", "2026-08-01T00:00:00.000Z"],
    // Clamped: a `--to` in the future must not anchor a report ahead of today.
    ["2026-08-12T00:00:00Z", "2026-08-08T00:00:00.000Z"]
  ])("should floor the collected edge to %s when anchoring an offline report", (collected, expected) => {
    expect(collectedAnchor(new Date(collected), REFERENCE).toISOString()).toBe(expected);
  });
});

describe("collectionIsStale", () => {
  it.each([
    [undefined, true],
    ["2026-07-31T14:58:46Z", false],
    ["2026-07-31T14:58:45Z", true],
    ["2026-08-07T00:00:00Z", false]
  ])("should measure the gap against the cadence when the last run was %s", (collected, expected) => {
    const collectedThrough = collected === undefined ? undefined : new Date(collected);

    expect(collectionIsStale(collectedThrough, REFERENCE, days(8))).toBe(expected);
  });
});

describe("baselineWindow", () => {
  it("should end at the enablement instant when measuring the before", () => {
    const window = baselineWindow(ENABLEMENT, days(28));

    expect(window.startsAt.toISOString()).toBe("2026-04-05T00:00:00.000Z");
    expect(window.endsAt).toEqual(ENABLEMENT);
  });
});

describe("periodWindows", () => {
  it("should cut the series into consecutive half-open periods that meet without overlapping", () => {
    const windows = periodWindows(ENABLEMENT, days(28), undefined, REFERENCE);

    expect(windows.map((window) => [window.startsAt.toISOString(), window.endsAt.toISOString()])).toEqual([
      ["2026-05-03T00:00:00.000Z", "2026-05-31T00:00:00.000Z"],
      ["2026-05-31T00:00:00.000Z", "2026-06-28T00:00:00.000Z"],
      ["2026-06-28T00:00:00.000Z", "2026-07-26T00:00:00.000Z"]
    ]);
  });

  it("should exclude the trailing partial period when it is not comparable with a full one", () => {
    // 97 days separate this enablement from the reference midnight: three whole 28-day periods, and
    // 13 days that are not a period at all.
    const windows = periodWindows(ENABLEMENT, days(28), undefined, REFERENCE);

    expect(windows).toHaveLength(3);
    const last = windows.at(-1);
    expect(last).toBeDefined();
    expect((last as { endsAt: Date }).endsAt.getTime() + days(28)).toBeGreaterThan(midnight(REFERENCE).getTime());
  });

  it("should keep the enablement time of day when anchoring each period", () => {
    const anchored = new Date("2026-05-03T09:30:00Z");

    const windows = periodWindows(anchored, days(28), undefined, REFERENCE);

    expect(windows[0]?.startsAt).toEqual(anchored);
    expect(windows[1]?.startsAt.toISOString()).toBe(new Date(anchored.getTime() + days(28)).toISOString());
    expect(windows.every((window) => window.endsAt.getUTCHours() === 9)).toBe(true);
  });

  it("should cap the series at the requested count, keeping the periods nearest enablement", () => {
    const windows = periodWindows(ENABLEMENT, days(28), 2, REFERENCE);

    expect(windows.map((window) => window.startsAt.toISOString())).toEqual(["2026-05-03T00:00:00.000Z", "2026-05-31T00:00:00.000Z"]);
  });

  it("should report every whole period when fewer exist than were requested", () => {
    expect(periodWindows(ENABLEMENT, days(28), 9, REFERENCE)).toHaveLength(3);
  });

  it.each(["2026-08-08T00:00:00Z", "2026-09-01T00:00:00Z"])("should report nothing when %s is too recent or in the future", (anchor) => {
    expect(periodWindows(new Date(anchor), days(28), undefined, REFERENCE)).toEqual([]);
  });
});

describe("days and hours", () => {
  it("should convert a count of days to milliseconds", () => {
    expect(days(1)).toBe(86_400_000);
  });

  it("should convert a count of hours to milliseconds", () => {
    // `hours` is the unit the flow metrics are expressed in — merge cycle time and time to first review are
    // both reported in hours — so it is read every time a threshold in the policy is compared against one.
    expect(hours(1)).toBe(3_600_000);
    expect(hours(24)).toBe(days(1));
  });
});
