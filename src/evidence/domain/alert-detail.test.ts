import { describe, expect, it } from "vitest";
import { ALERT_FAMILIES, AlertScanState, alertScanState } from "./alert-detail.ts";
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
