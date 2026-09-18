import { describe, expect, it } from "vitest";
import { type CveOccurrence, countedCves, cveSeverity, distinctCves, recordsSuppressionNotes, severityBucket, totalCount, UNKNOWN_SEVERITY } from "./cves.ts";

/**
 * The severity vocabulary three scanners have to be read into, and the rollup from occurrences to distinct CVEs.
 *
 * EVERY CASE BELOW IS ONE REAL DATA CARRIES. The upper-case words are dependency-check's, the lower-case ones yarn
 * audit's, `moderate` is yarn audit's most common band, the absent severity is uv audit's only answer, and the
 * many-packages-one-CVE shape is `pcs-api`'s 262 occurrences of 26 CVEs.
 */

function occurrence(overrides: Partial<CveOccurrence> = {}): CveOccurrence {
  return { identifier: "CVE-1", codebaseType: "java", suppressed: false, documented: false, ...overrides };
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

  it("should fold moderate to medium, which is 261,445 of the node estate's live entries", () => {
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

  it("should report nothing when the field is null or is not a string", () => {
    expect(cveSeverity(null)).toBeUndefined();
    expect(cveSeverity(undefined)).toBeUndefined();
    expect(cveSeverity(7.5)).toBeUndefined();
  });
});

describe("which formats can record a suppression justification", () => {
  it("should name java, whose dependency-check suppressions carry a notes field", () => {
    expect(recordsSuppressionNotes("java")).toBe(true);
  });

  it("should not name node or python, whose suppression lists have nowhere to put a reason", () => {
    // Verified against every node document in both databases: no notes, justification, reason or comment field.
    // Counting these as undocumented would blame every node team for a limitation of their builder.
    expect(recordsSuppressionNotes("node")).toBe(false);
    expect(recordsSuppressionNotes("python")).toBe(false);
  });
});

describe("which bucket a CVE is counted in", () => {
  it("should count a graded CVE in its own band", () => {
    expect(severityBucket({ severity: "high" })).toBe("high");
  });

  it("should count an ungraded CVE as unknown rather than as low", () => {
    expect(severityBucket({})).toBe(UNKNOWN_SEVERITY);
    expect(UNKNOWN_SEVERITY).toBe("unknown");
  });
});

describe("rolling occurrences up to distinct CVEs", () => {
  it("should report one CVE when it was found against many packages", () => {
    // pcs-api's CVE-2026-47884 reaches 13 packages. It is one thing wrong, not thirteen.
    const rolled = distinctCves([
      occurrence({ identifier: "CVE-2026-47884", suppressed: true, documented: true }),
      occurrence({ identifier: "CVE-2026-47884", suppressed: true, documented: true }),
      occurrence({ identifier: "CVE-2026-47884", suppressed: true, documented: true })
    ]);

    expect(rolled).toHaveLength(1);
    expect(rolled[0]).toMatchObject({ identifier: "CVE-2026-47884", suppressed: true, documented: true });
  });

  it("should report a CVE as live when it is suppressed in one package and open in another", () => {
    // THE MIXED CASE, and the rule is stated rather than emergent: something unsuppressed is still exposed, and a
    // rule letting one suppression speak for every package would let a team retire a live CVE from the figures.
    const rolled = distinctCves([
      occurrence({ identifier: "CVE-1", suppressed: true, documented: true }),
      occurrence({ identifier: "CVE-1", suppressed: false })
    ]);

    expect(rolled[0]?.suppressed).toBe(false);
  });

  it("should report a CVE as suppressed only when every occurrence of it is", () => {
    const rolled = distinctCves([
      occurrence({ identifier: "CVE-1", suppressed: true, documented: true }),
      occurrence({ identifier: "CVE-1", suppressed: true, documented: true })
    ]);

    expect(rolled[0]?.suppressed).toBe(true);
  });

  it("should keep the worst grading when two occurrences of one CVE disagree", () => {
    const rolled = distinctCves([
      occurrence({ identifier: "CVE-1", severity: "low" }),
      occurrence({ identifier: "CVE-1", severity: "critical" }),
      occurrence({ identifier: "CVE-1", severity: "medium" })
    ]);

    expect(rolled[0]?.severity).toBe("critical");
  });

  it("should prefer any grading over none when one occurrence states no severity", () => {
    const rolled = distinctCves([occurrence({ identifier: "CVE-1" }), occurrence({ identifier: "CVE-1", severity: "low" })]);

    expect(rolled[0]?.severity).toBe("low");
  });

  it("should read a CVE as documented when any one of its suppressions explains it", () => {
    // A suppression file names a CVE once and it lands against thirteen packages. Requiring a note on all
    // thirteen would report a properly documented acceptance as undocumented.
    const rolled = distinctCves([
      occurrence({ identifier: "CVE-1", suppressed: true }),
      occurrence({ identifier: "CVE-1", suppressed: true, documented: true })
    ]);

    expect(rolled[0]?.documented).toBe(true);
  });

  it("should read a suppression with a blank note as undocumented", () => {
    const rolled = distinctCves([occurrence({ identifier: "CVE-1", suppressed: true, documented: false })]);

    expect(rolled[0]?.documented).toBe(false);
  });

  it("should leave documentation absent when the only suppression came from a format with no notes field", () => {
    // THE THIRD STATE. `false` here would be a finding about a node team; absent says the question cannot be put.
    const rolled = distinctCves([occurrence({ identifier: "CVE-1", codebaseType: "node", suppressed: true })]);

    expect(rolled[0]).not.toHaveProperty("documented");
  });

  it("should assess a CVE suppressed in both java and node on the java suppression alone", () => {
    const rolled = distinctCves([
      occurrence({ identifier: "CVE-1", codebaseType: "node", suppressed: true }),
      occurrence({ identifier: "CVE-1", codebaseType: "java", suppressed: true, documented: true })
    ]);

    expect(rolled[0]?.documented).toBe(true);
  });

  it("should leave documentation absent for a CVE that is not suppressed at all", () => {
    // A live finding has nothing to justify, and dependency-check emits `notes: ""` on every one of them.
    const rolled = distinctCves([occurrence({ identifier: "CVE-1", suppressed: false })]);

    expect(rolled[0]).not.toHaveProperty("documented");
  });

  it("should report nothing when there are no occurrences", () => {
    expect(distinctCves([])).toEqual([]);
  });
});

describe("counting a repository's distinct CVEs", () => {
  it("should partition the distinct CVEs so live and suppressed sum to all", () => {
    // THE SUBSET INVARIANT: "X CVEs, Y of them suppressed" and never two unrelated totals to add up.
    const counted = countedCves([
      occurrence({ identifier: "CVE-1", severity: "critical" }),
      occurrence({ identifier: "CVE-2", severity: "high", suppressed: true, documented: true }),
      occurrence({ identifier: "CVE-3", severity: "high", suppressed: true, documented: true })
    ]);

    expect(totalCount(counted.all)).toBe(3);
    expect(totalCount(counted.live)).toBe(1);
    expect(totalCount(counted.suppressed)).toBe(2);
    expect(totalCount(counted.live) + totalCount(counted.suppressed)).toBe(totalCount(counted.all));
  });

  it("should count one CVE once however many packages it affects", () => {
    const counted = countedCves([
      occurrence({ identifier: "CVE-1", severity: "critical", suppressed: true, documented: true }),
      occurrence({ identifier: "CVE-1", severity: "critical", suppressed: true, documented: true }),
      occurrence({ identifier: "CVE-1", severity: "critical", suppressed: true, documented: true })
    ]);

    expect(counted.suppressed).toEqual({ critical: 1 });
  });

  it("should leave a band with nothing in it absent rather than reporting it as zero", () => {
    const counted = countedCves([occurrence({ severity: "high" })]);

    expect(counted.live).toEqual({ high: 1 });
    expect(counted.live).not.toHaveProperty("low");
  });

  it("should count ungraded CVEs in the unknown band", () => {
    const counted = countedCves([occurrence({ identifier: "CVE-1" }), occurrence({ identifier: "CVE-2", severity: "low" })]);

    expect(counted.live).toEqual({ unknown: 1, low: 1 });
  });

  it("should report three empty maps when a scan found nothing, which is the measured zero", () => {
    expect(countedCves([])).toEqual({ all: {}, live: {}, suppressed: {} });
  });

  it("should split the suppressed CVEs into documented and undocumented", () => {
    const counted = countedCves([
      occurrence({ identifier: "CVE-1", severity: "critical", suppressed: true, documented: true }),
      occurrence({ identifier: "CVE-2", severity: "high", suppressed: true }),
      occurrence({ identifier: "CVE-3", severity: "low", suppressed: true, documented: false })
    ]);

    expect(counted.documentedSuppressions).toBe(1);
    expect(counted.undocumentedSuppressions).toBe(2);
  });

  it("should leave both documentation figures absent for a node-only repository", () => {
    // Zero documented would read as a team that explains nothing; absent says their builder cannot record it.
    const counted = countedCves([occurrence({ identifier: "CVE-1", codebaseType: "node", severity: "high", suppressed: true })]);

    expect(counted).not.toHaveProperty("documentedSuppressions");
    expect(counted).not.toHaveProperty("undocumentedSuppressions");
  });

  it("should exclude a CVE reported live from both documentation figures", () => {
    // It was suppressed against one package and explained there, but the row reports it open — so counting it as
    // a documented suppression would show a justification beside a vulnerability still exposed.
    const counted = countedCves([
      occurrence({ identifier: "CVE-1", severity: "high", suppressed: true, documented: true }),
      occurrence({ identifier: "CVE-1", severity: "high", suppressed: false })
    ]);

    expect(totalCount(counted.live)).toBe(1);
    expect(counted).not.toHaveProperty("documentedSuppressions");
  });

  it("should count only the java suppressions when a repository publishes both kinds", () => {
    const counted = countedCves([
      occurrence({ identifier: "CVE-1", severity: "high", suppressed: true, documented: true }),
      occurrence({ identifier: "CVE-2", codebaseType: "node", severity: "high", suppressed: true })
    ]);

    expect(totalCount(counted.suppressed)).toBe(2);
    // The node suppression is in neither figure, which is why the two need not sum to the suppressed total.
    expect(counted.documentedSuppressions).toBe(1);
    expect(counted.undocumentedSuppressions).toBe(0);
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
