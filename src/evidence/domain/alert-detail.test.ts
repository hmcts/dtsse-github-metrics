import { describe, expect, it } from "vitest";
import { ALERT_FAMILIES, AlertFamily, AlertScanState, alertScanState, byExposure, type SecurityAlertDetail } from "./alert-detail.ts";
import { FEATURE_NOT_ENABLED } from "./security-alerts.ts";

/**
 * The three states, from the stored count block.
 *
 * THIS IS THE CRUX OF THE FEATURE. Everything else about collecting the individual alerts is a projection and a
 * write; this is the function that decides whether a repository nobody could read is reported as unmeasured or as
 * clean, and the second is the one wrong answer that reads like good news.
 */

describe("alertScanState", () => {
  it("should report read when the count block holds a number, however small", () => {
    expect(alertScanState({ open: 0, bySeverity: {} })).toBe(AlertScanState.Read);
    expect(alertScanState({ open: 7 })).toBe(AlertScanState.Read);
  });

  it("should report read when a number arrives beside a detail, because the number is the stronger signal", () => {
    // Not a state the collectors produce, but the precedence has to be stated: something counted alerts, so
    // something read the family, whatever prose came with it.
    expect(alertScanState({ open: 3, detail: "secret-scanning/alerts could not be read for the organisation" })).toBe(AlertScanState.Read);
  });

  it("should report not enabled when the block says the feature is off", () => {
    expect(alertScanState({ detail: `code-scanning/alerts ${FEATURE_NOT_ENABLED}` })).toBe(AlertScanState.NotEnabled);
  });

  it.each(ALERT_FAMILIES)("should report not enabled for %s whichever family names the sentence", (family) => {
    // The sentence is built as `${family} ${FEATURE_NOT_ENABLED}` in three places and matched in one, so every
    // family's spelling of it has to reach the same answer.
    expect(alertScanState({ detail: `${family} ${FEATURE_NOT_ENABLED}` })).toBe(AlertScanState.NotEnabled);
  });

  it("should report unmeasured when the block gives a reason that is not the feature being off", () => {
    expect(alertScanState({ detail: "dependabot/alerts could not be read for the organisation" })).toBe(AlertScanState.Unmeasured);
  });

  it("should report unmeasured when the estate-wide read named nothing and nothing says whether it is enabled", () => {
    // `organisationAbsence`'s third sentence, which is the one VIBE-590's refusals land on.
    expect(alertScanState({ detail: "secret-scanning/alerts named no alerts for this repository and nothing says whether it is enabled" })).toBe(
      AlertScanState.Unmeasured
    );
  });

  it("should report unmeasured when there is no count block at all", () => {
    // A repository `collect` has never reached. Absent is unmeasured, and never zero.
    expect(alertScanState(undefined)).toBe(AlertScanState.Unmeasured);
  });

  it("should report unmeasured for an empty block, which is what the shallow path writes for code scanning", () => {
    expect(alertScanState({})).toBe(AlertScanState.Unmeasured);
  });
});

/**
 * The order one family's alerts are reported in.
 *
 * A COMPARATOR AND NOT A BARE `sort()`, per CONTRIBUTING.md: three keys over a state word, an instant and a number,
 * and any of them sorted as a default string is the failure that rule is named for.
 */
describe("byExposure", () => {
  function alert(overrides: Partial<SecurityAlertDetail> = {}): SecurityAlertDetail {
    return { repository: "alpha", family: AlertFamily.SecretScanning, number: 1, state: "open", ...overrides };
  }

  it("should put every open alert above every alert that has been dealt with", () => {
    const sorted = [alert({ number: 2, state: "resolved" }), alert({ number: 1 })].sort(byExposure);

    expect(sorted.map((entry) => entry.number)).toEqual([1, 2]);
  });

  it("should put the longest-exposed open alert first, which is not GitHub's own order", () => {
    // GitHub answers newest-first by alert number, which puts the credential leaked this morning above the one that
    // has been public for 900 days. The oldest is what the `patching` criterion's sentence is about.
    const sorted = [alert({ number: 9, createdAt: new Date(Date.UTC(2026, 8, 1)) }), alert({ number: 3, createdAt: new Date(Date.UTC(2024, 0, 2)) })].sort(
      byExposure
    );

    expect(sorted.map((entry) => entry.number)).toEqual([3, 9]);
  });

  it("should sort an alert with no readable instant after every dated one", () => {
    // An unknown age is not evidence of a long exposure, so it does not win the top of the list.
    const sorted = [alert({ number: 4 }), alert({ number: 5, createdAt: new Date(Date.UTC(2026, 0, 1)) })].sort(byExposure);

    expect(sorted.map((entry) => entry.number)).toEqual([5, 4]);
  });

  it("should break a tie on the alert number so two runs over unchanged alerts produce one order", () => {
    const raised = new Date(Date.UTC(2026, 0, 1));
    const sorted = [alert({ number: 8, createdAt: raised }), alert({ number: 2, createdAt: raised })].sort(byExposure);

    expect(sorted.map((entry) => entry.number)).toEqual([2, 8]);
  });

  it("should order two undated alerts by number rather than by whatever the engine does with NaN", () => {
    // `Infinity - Infinity` is `NaN`, and a comparator returning `NaN` leaves `sort` free to produce any order at all.
    const sorted = [alert({ number: 6 }), alert({ number: 3 })].sort(byExposure);

    expect(sorted.map((entry) => entry.number)).toEqual([3, 6]);
  });
});
