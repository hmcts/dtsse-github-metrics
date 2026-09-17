import { describe, expect, it } from "vitest";
import type { SecurityAlertEvidence } from "../../domain/security-alerts.ts";
import { reportedAlerts, securityReport } from "./security.ts";

/**
 * The three alert families in the shape the UI declares, which is not the shape they are collected in.
 *
 * THE SECOND TRANSLATION THAT TOOK A PAGE DOWN. The stored evidence holds `codeScanning` and `bySeverity`; the
 * contract declares `code_scanning` and `by_severity`. Handing the stored object over type-checks — both files call
 * the interface `SecurityAlertEvidence` — and then `severityDetail` reads `by_severity.critical` off an object with
 * no such key.
 */

const FETCHED = "2026-09-15T15:00:00.000Z";

const ALERTS: SecurityAlertEvidence = {
  dependabot: { open: 3, bySeverity: { critical: 1, high: 2 } },
  codeScanning: { open: 0, bySeverity: {} },
  secretScanning: { bySeverity: {}, detail: "secret scanning could not be read for this repository" }
};

describe("the three alert families", () => {
  it("should rename each family to the contract's spelling when all three were collected", () => {
    const reported = reportedAlerts(ALERTS);

    expect(Object.keys(reported).sort()).toEqual(["code_scanning", "dependabot", "secret_scanning"]);
    expect(reported.dependabot).toEqual({ open: 3, by_severity: { critical: 1, high: 2 } });
  });

  it("should send all three families even when nothing was collected at all", () => {
    // The UI reads `alerts.code_scanning` unconditionally, so an absent family throws rather than rendering as
    // unmeasured. The object is always whole and it is each family's own `open` that goes absent.
    const reported = reportedAlerts(undefined);

    expect(Object.keys(reported).sort()).toEqual(["code_scanning", "dependabot", "secret_scanning"]);
    for (const family of [reported.dependabot, reported.code_scanning, reported.secret_scanning]) {
      expect(family).toEqual({ by_severity: {}, detail: "the alert families have not been collected" });
    }
  });

  it("should report an empty severity map rather than omit it when a family has nothing open", () => {
    // `by_severity` is REQUIRED: `tone.ts` reads `by_severity.critical` without a guard, so an absent map throws.
    expect(reportedAlerts(ALERTS).code_scanning).toEqual({ open: 0, by_severity: {} });
  });

  it("should distinguish a family with nothing open from one nobody could read", () => {
    // WHAT SEPARATES THE TWO IS `open`, not the severity map: both are empty, and only one of them was measured.
    const reported = reportedAlerts(ALERTS);

    expect(reported.code_scanning.open).toBe(0);
    expect("open" in reported.secret_scanning).toBe(false);
    expect(reported.secret_scanning.detail).toBe("secret scanning could not be read for this repository");
  });

  it("should supply an empty severity map when a collected family carries none", () => {
    const reported = reportedAlerts({ dependabot: { open: 1 } } as SecurityAlertEvidence);

    expect(reported.dependabot).toEqual({ open: 1, by_severity: {} });
  });
});

describe("the alert block on a repository's page", () => {
  it("should report the fetch instant and the translated families when a collection read them", () => {
    const report = securityReport(ALERTS, FETCHED);

    expect(report.fetched_at).toBe(FETCHED);
    expect(report.alerts?.dependabot.open).toBe(3);
  });

  it("should report the reason and no fetch instant when no family was collected", () => {
    expect(securityReport(undefined, FETCHED)).toEqual({ detail: "no security alert family was collected for this repository" });
  });
});
