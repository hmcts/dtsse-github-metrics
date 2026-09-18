import { describe, expect, it } from "vitest";
import type { CveEvidence } from "../../domain/cves.ts";
import { cveReport, UNSCANNED_DETAIL } from "./cve.ts";

/**
 * One repository's CVE position on the wire.
 *
 * THE FIRST TWO TESTS ARE THE ACCEPTANCE CRITERIA. A repository nobody scanned and a repository whose scan found
 * nothing have to be distinguishable by a reader who has only the JSON, and four repositories in five are the
 * former — so a collapse here would report the estate as clean.
 */

const SCANNED: CveEvidence = {
  scannedAt: new Date(Date.UTC(2026, 8, 18, 10, 22, 45)),
  codebaseTypes: ["java"],
  all: { critical: 2, high: 4, medium: 40, unknown: 1 },
  live: { critical: 2, high: 3, unknown: 1 },
  suppressed: { medium: 40, high: 1 },
  occurrences: 262,
  documentedSuppressions: 30,
  undocumentedSuppressions: 11
};

describe("distinguishing a repository nobody scanned from one whose scan was clean", () => {
  it("should report only a detail when no CVE report has ever been published", () => {
    const report = cveReport(undefined);

    expect(report).toEqual({ detail: UNSCANNED_DETAIL });
    expect(report.cves).toBeUndefined();
  });

  it("should report zero totals and no detail when a scan ran and found nothing", () => {
    const report = cveReport({
      scannedAt: new Date(Date.UTC(2026, 8, 18)),
      codebaseTypes: ["node"],
      all: {},
      live: {},
      suppressed: {},
      occurrences: 0
    });

    expect(report.detail).toBeUndefined();
    expect(report.cves?.all).toEqual({ total: 0, by_severity: {} });
    expect(report.cves?.occurrences).toBe(0);
  });

  it("should never report both figures and a detail, so a component can branch on one key", () => {
    expect(cveReport(SCANNED).detail).toBeUndefined();
    expect(cveReport(undefined).cves).toBeUndefined();
  });
});

describe("what a scanned repository reports", () => {
  it("should report suppressed as a subset of all, so live plus suppressed is all", () => {
    // "X CVEs, Y of them suppressed" — never two totals a reader is invited to add together.
    const cves = cveReport(SCANNED).cves;

    expect(cves?.all.total).toBe(47);
    expect(cves?.live.total).toBe(6);
    expect(cves?.suppressed.total).toBe(41);
    expect((cves?.live.total ?? 0) + (cves?.suppressed.total ?? 0)).toBe(cves?.all.total);
  });

  it("should break each part down by severity", () => {
    expect(cveReport(SCANNED).cves?.live.by_severity).toEqual({ critical: 2, high: 3, unknown: 1 });
    expect(cveReport(SCANNED).cves?.suppressed.by_severity).toEqual({ medium: 40, high: 1 });
  });

  it("should carry the occurrence count so the finer grain is visible rather than surprising", () => {
    // 262 occurrences behind 47 distinct CVEs: a reader meeting the fine figure elsewhere can see why they differ.
    expect(cveReport(SCANNED).cves?.occurrences).toBe(262);
  });

  it("should report how many suppressions are documented and how many are not", () => {
    expect(cveReport(SCANNED).cves?.documented_suppressions).toBe(30);
    expect(cveReport(SCANNED).cves?.undocumented_suppressions).toBe(11);
  });

  it("should omit both documentation figures when no suppression could have carried a reason", () => {
    // A node-only repository. Zero documented would read as a team that explains nothing.
    const cves = cveReport({ ...SCANNED, codebaseTypes: ["node"], documentedSuppressions: undefined, undocumentedSuppressions: undefined }).cves;

    expect(cves).not.toHaveProperty("documented_suppressions");
    expect(cves).not.toHaveProperty("undocumented_suppressions");
  });

  it("should report zero undocumented when every suppression is explained, which is not the same as absent", () => {
    const cves = cveReport({ ...SCANNED, documentedSuppressions: 41, undocumentedSuppressions: 0 }).cves;

    expect(cves?.undocumented_suppressions).toBe(0);
  });

  it("should report the scan instant as an ISO string, like every other instant on the contract", () => {
    // A `Date` would fall through `SortValue` to a weekday-name comparison, which looks plausible and is wrong.
    expect(cveReport(SCANNED).scanned_at).toBe("2026-09-18T10:22:45.000Z");
  });

  it("should name which languages were scanned, so a reader knows what a figure covers", () => {
    expect(cveReport({ ...SCANNED, codebaseTypes: ["java", "node"] }).codebase_types).toEqual(["java", "node"]);
  });

  it("should carry the unknown band through rather than dropping or regrading it", () => {
    const report = cveReport({ ...SCANNED, all: { unknown: 4 }, live: { unknown: 4 }, suppressed: {} });

    expect(report.cves?.live).toEqual({ total: 4, by_severity: { unknown: 4 } });
  });
});
