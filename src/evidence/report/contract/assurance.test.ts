import { describe, expect, it } from "vitest";
import type { AssuranceEvidence } from "../../domain/assurance.ts";
import type { CohortEntry } from "../../org/cohort.ts";
import { OwnerKind } from "../../org/graph.ts";
import { reportedAssurance } from "./assurance.ts";

/**
 * The assurance criteria one row is judged against, in the shape the UI declares.
 *
 * TWO SOURCES, which is why this takes the cohort entry as well as the payload: ownership and maintenance are facts
 * the GRAPH holds, so they answer for a repository nothing has been collected for, and hygiene and patching come
 * from the collection. What must never happen is a criterion whose source is missing reading as UNMET.
 */

function entry(overrides: Partial<CohortEntry> = {}): CohortEntry {
  return {
    repository: "alpha",
    owners: ["dtsse"],
    ownerKind: OwnerKind.Team,
    archived: false,
    visibility: "public",
    behaviourCollectable: true,
    unmaintained: false,
    ...overrides
  };
}

const EVIDENCE: AssuranceEvidence = {
  hygiene: { secretScanning: true, pushProtection: false, vulnerabilityAlerts: true, dependabotSecurityUpdates: true, updateConfiguration: true },
  severeAlertsRead: true,
  secretsRead: true,
  securityPolicy: true,
  oldestSevereAlertDays: 41,
  secrets: { open: 0 }
};

describe("the assurance report on one row", () => {
  it("should judge a grade and a criterion list when a collection was read", () => {
    const report = reportedAssurance(entry(), { assurance: EVIDENCE });

    expect(report.grade).toBeDefined();
    expect(report.criteria.length).toBeGreaterThan(0);
    for (const criterion of report.criteria) {
      expect(Object.keys(criterion).sort()).toEqual(["criterion", "detail", "outcome"]);
    }
  });

  it("should still judge the criteria the graph answers when nothing has been collected", () => {
    // A repository nobody walked still has an owner and a maintenance state, so the row is not a blank column.
    const report = reportedAssurance(entry(), undefined);

    expect(report.criteria.length).toBeGreaterThan(0);
    expect(report.criteria.every((criterion) => criterion.outcome !== "unmet")).toBe(true);
  });

  it("should read a payload that is not an object as nothing collected", () => {
    expect(reportedAssurance(entry(), null).criteria.length).toBeGreaterThan(0);
    expect(reportedAssurance(entry(), { defaultBranch: "main" }).criteria.length).toBeGreaterThan(0);
  });

  it("should hand the graph's own facts to the judgement rather than only the collected payload", () => {
    // THE TWO SOURCES, proved by moving a fact that exists only on the cohort entry: a repository past the
    // unmaintained boundary has to grade differently from one inside it under identical collected evidence.
    const maintained = reportedAssurance(entry(), { assurance: EVIDENCE });
    const dead = reportedAssurance(entry({ unmaintained: true }), { assurance: EVIDENCE });

    expect(dead.criteria).not.toEqual(maintained.criteria);
  });

  it("should lift the oldest severe alert age out of the criteria beside it", () => {
    // So a column can print the number without finding the right judgement and parsing its sentence.
    expect(reportedAssurance(entry(), { assurance: EVIDENCE }).oldest_severe_alert_days).toBe(41);
  });

  it("should leave the alert age absent when the collection disclosed none", () => {
    const report = reportedAssurance(entry(), { assurance: { ...EVIDENCE, oldestSevereAlertDays: undefined } });

    expect(report.oldest_severe_alert_days).toBeUndefined();
  });

  it("should name the five hygiene signals on the contract's spelling when they were collected", () => {
    const hygiene = reportedAssurance(entry(), { assurance: EVIDENCE }).hygiene;

    expect(hygiene).toEqual({
      secret_scanning: true,
      push_protection: false,
      vulnerability_alerts: true,
      dependabot_security_updates: true,
      update_configuration: true
    });
  });

  it("should pass an undisclosed hygiene signal through as absent rather than as a control switched off", () => {
    // `false` would read as a control somebody turned off; `stripAbsent` drops the key so it reads as undisclosed.
    const hygiene = reportedAssurance(entry(), { assurance: { ...EVIDENCE, hygiene: { secretScanning: true } } }).hygiene as Record<string, unknown>;

    expect(hygiene.secret_scanning).toBe(true);
    expect(hygiene.push_protection).toBeUndefined();
  });

  it("should omit the whole hygiene block when nothing has been collected for the repository", () => {
    expect(reportedAssurance(entry(), undefined).hygiene).toBeUndefined();
  });
});
