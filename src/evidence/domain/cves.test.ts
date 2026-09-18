import { describe, expect, it } from "vitest";
import { type CveFinding, countedFindings, cveSeverity, severityBucket, totalCount, UNKNOWN_SEVERITY } from "./cves.ts";

/**
 * The severity vocabulary three different scanners have to be read into, and the counting that follows it.
 *
 * EVERY CASE BELOW IS ONE REAL DATA CARRIES. The upper-case words are dependency-check's, the lower-case ones
 * yarn audit's, `moderate` is yarn audit's most common band, and the absent severity is uv audit's only answer.
 */

function finding(overrides: Partial<CveFinding> = {}): CveFinding {
  return { identifier: "CVE-1", package: "a.jar", suppressed: false, ...overrides };
}

describe("folding a severity word", () => {
  it("should read dependency-check's upper-case words when they arrive as published", () => {
    expect(cveSeverity("CRITICAL")).toBe("critical");
    expect(cveSeverity("HIGH")).toBe("high");
    expect(cveSeverity("MEDIUM")).toBe("medium");
    expect(cveSeverity("LOW")).toBe("low");
  });

  it("should read yarn audit's lower-case words unchanged", () => {
    expect(cveSeverity("critical")).toBe("critical");
    expect(cveSeverity("low")).toBe("low");
  });

  it("should fold moderate to medium, which is 261,445 of the node estate's live findings", () => {
    expect(cveSeverity("moderate")).toBe("medium");
  });

  it("should ignore surrounding whitespace when a report carries any", () => {
    expect(cveSeverity(" HIGH ")).toBe("high");
  });

  it("should report nothing when a scanner emits a word this does not name", () => {
    // Unmeasured rather than admitted to a union no reader's own type holds.
    expect(cveSeverity("severe")).toBeUndefined();
    expect(cveSeverity("informational")).toBeUndefined();
  });

  it("should report nothing when the field is null, which yarn audit leaves it on one live finding in nine", () => {
    expect(cveSeverity(null)).toBeUndefined();
    expect(cveSeverity(undefined)).toBeUndefined();
    expect(cveSeverity(7.5)).toBeUndefined();
  });
});

describe("which bucket a finding is counted in", () => {
  it("should count a graded finding in its own band", () => {
    expect(severityBucket(finding({ severity: "high" }))).toBe("high");
  });

  it("should count an ungraded finding as unknown rather than as low", () => {
    // The single most consequential line in this module: `low` would be a claim nobody made.
    expect(severityBucket(finding())).toBe(UNKNOWN_SEVERITY);
    expect(UNKNOWN_SEVERITY).toBe("unknown");
  });
});

describe("counting a scan's findings", () => {
  it("should keep suppressed findings out of the live counts entirely", () => {
    const counted = countedFindings([
      finding({ identifier: "CVE-1", severity: "critical" }),
      finding({ identifier: "CVE-2", severity: "critical", suppressed: true }),
      finding({ identifier: "CVE-3", severity: "critical", suppressed: true })
    ]);

    expect(counted.live).toEqual({ critical: 1 });
    expect(counted.suppressed).toEqual({ critical: 2 });
  });

  it("should leave a band with nothing in it absent rather than reporting it as zero", () => {
    const counted = countedFindings([finding({ severity: "high" })]);

    expect(counted.live).toEqual({ high: 1 });
    expect(counted.live).not.toHaveProperty("low");
  });

  it("should count ungraded findings in the unknown band", () => {
    const counted = countedFindings([finding({ identifier: "CVE-1" }), finding({ identifier: "CVE-2", severity: "low" })]);

    expect(counted.live).toEqual({ unknown: 1, low: 1 });
  });

  it("should report two empty maps when a scan found nothing, which is the measured zero", () => {
    expect(countedFindings([])).toEqual({ live: {}, suppressed: {} });
  });
});

describe("totalling a count map", () => {
  it("should add every band when several are populated", () => {
    expect(totalCount({ critical: 2, high: 3, unknown: 1 })).toBe(6);
  });

  it("should report zero for an empty map, which is a scan that found nothing", () => {
    expect(totalCount({})).toBe(0);
  });
});
