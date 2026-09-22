import { describe, expect, it } from "vitest";
import { AlertFamily, AlertScanState, type SecurityAlertDetail, type StoredAlertScan } from "../../domain/alert-detail.ts";
import type { SecurityAlertEvidence } from "../../domain/security-alerts.ts";
import { reportedAlertScans, reportedAlerts, securityReport } from "./security.ts";

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

const OBSERVED = new Date(Date.UTC(2026, 8, 22, 6));

/** One stored alert, with the two fields the three families spell differently between them. */
function alert(overrides: Partial<SecurityAlertDetail> = {}): SecurityAlertDetail {
  return {
    repository: "alpha",
    family: AlertFamily.SecretScanning,
    number: 7,
    alertType: "azure_storage_account_key",
    path: "src/config.ts",
    line: 12,
    state: "open",
    createdAt: new Date(Date.UTC(2024, 2, 9)),
    htmlUrl: "https://github.com/hmcts/alpha/security/secret-scanning/7",
    ...overrides
  };
}

function scan(overrides: Partial<StoredAlertScan> = {}): StoredAlertScan {
  return { family: AlertFamily.SecretScanning, state: AlertScanState.Read, observedAt: OBSERVED, alerts: [alert()], ...overrides };
}

describe("the alert block on a repository's page", () => {
  it("should report the fetch instant and the translated families when a collection read them", () => {
    const report = securityReport(ALERTS, FETCHED, []);

    expect(report.fetched_at).toBe(FETCHED);
    expect(report.alerts?.dependabot.open).toBe(3);
  });

  it("should report the reason and no fetch instant when no family was collected", () => {
    const report = securityReport(undefined, FETCHED, []);

    expect(report.detail).toBe("no security alert family was collected for this repository");
    expect(report.fetched_at).toBeUndefined();
  });

  it("should send the scans even when the count block was never collected", () => {
    // The two come from different tables, so a repository can hold the scans and not the counts — and a page drawing
    // the alerts only beside a count block would show nothing for exactly those repositories.
    expect(securityReport(undefined, FETCHED, [scan()]).scans).toHaveLength(3);
  });
});

describe("each family's scan and the alerts under it", () => {
  it("should send all three families in reporting order when only one has a stored scan", () => {
    // A FAMILY OMITTED RENDERS AS NOTHING, and nothing is indistinguishable from a family read and found clean. So
    // the universe is the family list and never the stored rows.
    const scans = reportedAlertScans([scan()]);

    expect(scans.map((entry) => entry.family)).toEqual(["secret-scanning", "dependabot", "code-scanning"]);
  });

  it("should report a family with no stored scan as unmeasured rather than as clean", () => {
    const [, dependabot] = reportedAlertScans([scan()]);

    expect(dependabot).toEqual({
      family: "dependabot",
      state: "unmeasured",
      detail: "no scan of this family has been recorded for this repository",
      alerts: []
    });
  });

  it("should distinguish a family that is switched off from one nobody could read", () => {
    // Both have an empty alert list and neither is a finding about the code. Only the state and the sentence separate
    // them, which is why both are carried through rather than folded into one absence.
    const scans = reportedAlertScans([
      scan({ family: AlertFamily.CodeScanning, state: AlertScanState.NotEnabled, detail: "code scanning is not enabled for this repository", alerts: [] }),
      scan({ family: AlertFamily.Dependabot, state: AlertScanState.Unmeasured, detail: "the walk was refused", alerts: [] })
    ]);

    expect(scans[2]).toMatchObject({ state: "not-enabled", detail: "code scanning is not enabled for this repository" });
    expect(scans[1]).toMatchObject({ state: "unmeasured", detail: "the walk was refused" });
  });

  it("should report a read family with no alerts as read rather than as unmeasured", () => {
    // THE MEASURED ZERO this pair of tables exists to be able to state: somebody looked and found nothing.
    const [secrets] = reportedAlertScans([scan({ alerts: [] })]);

    expect(secrets).toMatchObject({ state: "read", alerts: [] });
    expect(secrets?.observed_at).toBe(OBSERVED.toISOString());
  });

  it("should drop the stored reason on a family that was read", () => {
    // The sentence explains an ABSENCE of alerts; beside a family that was read it reads as a caveat on a measurement
    // that has none. The writer blanks it for the same reason.
    const [secrets] = reportedAlertScans([scan({ detail: "yesterday's refusal" })]);

    expect("detail" in (secrets ?? {})).toBe(false);
  });

  it("should rename every alert field to the contract's spelling and send its instants as strings", () => {
    const [secrets] = reportedAlertScans([scan()]);

    expect(secrets?.alerts[0]).toEqual({
      family: "secret-scanning",
      number: 7,
      alert_type: "azure_storage_account_key",
      path: "src/config.ts",
      line: 12,
      state: "open",
      created_at: "2024-03-09T00:00:00.000Z",
      html_url: "https://github.com/hmcts/alpha/security/secret-scanning/7"
    });
  });

  it("should omit every field an alert did not carry rather than send it holding null", () => {
    // An alert whose `path` could not be read is still an alert. What must not happen is a key present and empty,
    // which a renderer reads as the repository root.
    const [secrets] = reportedAlertScans([scan({ alerts: [{ repository: "alpha", family: AlertFamily.SecretScanning, number: 9 }] })]);

    expect(secrets?.alerts[0]).toEqual({ family: "secret-scanning", number: 9 });
  });

  it("should carry every field a Dependabot alert adds over a secret-scanning one", () => {
    // The two families populate different fields — a package and a severity against a line — so a translation
    // asserted against one family only would let the other's fields go missing.
    const [, dependabot] = reportedAlertScans([
      scan({
        family: AlertFamily.Dependabot,
        alerts: [
          alert({
            family: AlertFamily.Dependabot,
            number: 4,
            alertType: "GHSA-1234-5678-90ab",
            subject: "lodash",
            severity: "high",
            path: "package.json",
            line: undefined,
            resolution: "tolerable_risk",
            resolvedAt: new Date(Date.UTC(2026, 8, 20)),
            htmlUrl: undefined
          })
        ]
      })
    ]);

    expect(dependabot?.alerts[0]).toEqual({
      family: "dependabot",
      number: 4,
      alert_type: "GHSA-1234-5678-90ab",
      subject: "lodash",
      severity: "high",
      path: "package.json",
      state: "open",
      resolution: "tolerable_risk",
      created_at: "2024-03-09T00:00:00.000Z",
      resolved_at: "2026-09-20T00:00:00.000Z"
    });
  });
});
