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
  live: { critical: 2, high: 3, unknown: 1 },
  suppressed: { medium: 40, high: 5 }
};

describe("distinguishing a repository nobody scanned from one whose scan was clean", () => {
  it("should report only a detail when no CVE report has ever been published", () => {
    const report = cveReport(undefined);

    expect(report).toEqual({ detail: UNSCANNED_DETAIL });
    expect(report.cves).toBeUndefined();
  });

  it("should report zero totals and no detail when a scan ran and found nothing", () => {
    const report = cveReport({ scannedAt: new Date(Date.UTC(2026, 8, 18)), codebaseTypes: ["node"], live: {}, suppressed: {} });

    expect(report.detail).toBeUndefined();
    expect(report.cves).toEqual({ live: { total: 0, by_severity: {} }, suppressed: { total: 0, by_severity: {} } });
  });

  it("should never report both figures and a detail, so a component can branch on one key", () => {
    expect(cveReport(SCANNED).detail).toBeUndefined();
    expect(cveReport(undefined).cves).toBeUndefined();
  });
});

describe("what a scanned repository reports", () => {
  it("should total the live bands without adding the suppressed ones", () => {
    // The acceptance criterion in one assertion: 6 live, and the 45 suppressed nowhere near it.
    expect(cveReport(SCANNED).cves?.live).toEqual({ total: 6, by_severity: { critical: 2, high: 3, unknown: 1 } });
  });

  it("should report the suppressed figure separately so an accepted finding is visible rather than absent", () => {
    expect(cveReport(SCANNED).cves?.suppressed).toEqual({ total: 45, by_severity: { medium: 40, high: 5 } });
  });

  it("should report the scan instant as an ISO string, like every other instant on the contract", () => {
    // A `Date` would fall through `SortValue` to a weekday-name comparison, which looks plausible and is wrong.
    expect(cveReport(SCANNED).scanned_at).toBe("2026-09-18T10:22:45.000Z");
  });

  it("should name which languages were scanned, so a reader knows what a figure covers", () => {
    expect(cveReport({ ...SCANNED, codebaseTypes: ["java", "node"] }).codebase_types).toEqual(["java", "node"]);
  });

  it("should carry the unknown band through rather than dropping or regrading it", () => {
    const report = cveReport({ ...SCANNED, live: { unknown: 4 }, suppressed: {} });

    expect(report.cves?.live).toEqual({ total: 4, by_severity: { unknown: 4 } });
  });
});
