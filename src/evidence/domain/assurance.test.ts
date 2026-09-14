import { describe, expect, it } from "vitest";
import {
  AssuranceCriteria,
  AssuranceCriterion,
  type AssuranceEvidence,
  AssuranceGrade,
  AssuranceOutcome,
  type AssuranceSubject,
  ageInDays,
  assuranceGrade,
  GradedAssuranceCriteria,
  type HygieneSignals,
  judgeAssurance
} from "./assurance.ts";

/**
 * The assurance criteria, which are a DIFFERENT QUESTION from readiness.
 *
 * Everything here is a pure function of the evidence, so each case states the whole repository it needs. What the
 * cases are mostly about is the third value: a signal nobody could read must never be graded as a signal that is
 * off, because that would blame a missing permission on the team that owns the code.
 */

/** Every hygiene signal on, which is the case the interesting ones are variations of. */
function hygiene(overrides: Partial<HygieneSignals> = {}): HygieneSignals {
  return {
    secretScanning: true,
    pushProtection: true,
    dependabotSecurityUpdates: true,
    vulnerabilityAlerts: true,
    updateConfiguration: true,
    ...overrides
  };
}

function evidenceOf(overrides: Partial<AssuranceEvidence> = {}): AssuranceEvidence {
  return { hygiene: hygiene(), severeAlertsRead: true, ...overrides };
}

/** A team-owned, maintained repository with every signal on: the all-met baseline. */
function subjectOf(overrides: Partial<AssuranceSubject> = {}): AssuranceSubject {
  return { ownerKind: "team", archived: false, unmaintained: false, evidence: evidenceOf(), ...overrides };
}

function outcomeOf(subject: AssuranceSubject, criterion: AssuranceCriterion): AssuranceOutcome {
  const found = judgeAssurance(subject).find((judgement) => judgement.criterion === criterion);
  if (found === undefined) {
    throw new Error(`${criterion} was not judged at all`);
  }
  return found.outcome;
}

function detailOf(subject: AssuranceSubject, criterion: AssuranceCriterion): string {
  const found = judgeAssurance(subject).find((judgement) => judgement.criterion === criterion);
  if (found === undefined) {
    throw new Error(`${criterion} was not judged at all`);
  }
  return found.detail;
}

describe("the criteria this build reports", () => {
  it("should report four of the seven, and name them in the order the criteria themselves read", () => {
    // The count is the claim the page footnote makes, so it is asserted rather than left to a comment: three are
    // omitted deliberately and a fifth appearing here without that decision being revisited would be a proxy
    // signal, which is the one thing this set was built to avoid.
    expect(AssuranceCriteria).toEqual([
      AssuranceCriterion.NamedOwner,
      AssuranceCriterion.AutomatedHygiene,
      AssuranceCriterion.Patching,
      AssuranceCriterion.Maintained
    ]);
  });

  it("should judge every criterion it reports, so no column can be structurally empty", () => {
    // The failure this guards is the one the CODEOWNERS column shipped with for months: a column whose field
    // nothing ever populated, rendering a dash for the entire estate.
    expect(judgeAssurance(subjectOf()).map((judgement) => judgement.criterion)).toEqual([...AssuranceCriteria]);
  });

  it("should leave the patching criterion out of the grade, having no threshold to pass", () => {
    expect(GradedAssuranceCriteria).not.toContain(AssuranceCriterion.Patching);
    expect(GradedAssuranceCriteria).toEqual([AssuranceCriterion.NamedOwner, AssuranceCriterion.AutomatedHygiene, AssuranceCriterion.Maintained]);
  });
});

describe("the named-owner criterion", () => {
  it("should be met by a team and unmet by one individual", () => {
    // 206 repositories on this estate are one person's. That is the finding the criterion exists to state, so it
    // is `unmet` rather than `unknown` — the ladder answered, and the answer is a person.
    expect(outcomeOf(subjectOf({ ownerKind: "team" }), AssuranceCriterion.NamedOwner)).toBe(AssuranceOutcome.Met);
    expect(outcomeOf(subjectOf({ ownerKind: "person" }), AssuranceCriterion.NamedOwner)).toBe(AssuranceOutcome.Unmet);
  });

  it("should be unmet by the unowned bucket, which is an answer rather than a gap", () => {
    expect(outcomeOf(subjectOf({ ownerKind: "none" }), AssuranceCriterion.NamedOwner)).toBe(AssuranceOutcome.Unmet);
  });

  it("should be unknown where no ownership was attributed at all", () => {
    // A repository collected since the last attribution ran. Nobody looked, which is not the same as nobody owning
    // it — `none` is the ladder's remembered negative and this is the absence of even that.
    expect(outcomeOf(subjectOf({ ownerKind: undefined }), AssuranceCriterion.NamedOwner)).toBe(AssuranceOutcome.Unknown);
  });
});

describe("the automated-hygiene criterion", () => {
  it("should be met when every signal is on", () => {
    expect(outcomeOf(subjectOf(), AssuranceCriterion.AutomatedHygiene)).toBe(AssuranceOutcome.Met);
  });

  it("should name the control that is missing rather than only counting them", () => {
    // THE ANSWER TO THE OBJECTION TO A COMPOSITE, which is that it hides which control is missing. The name of
    // the control is the actionable part, so it is in the detail.
    const subject = subjectOf({ evidence: evidenceOf({ hygiene: hygiene({ dependabotSecurityUpdates: false, updateConfiguration: false }) }) });

    expect(outcomeOf(subject, AssuranceCriterion.AutomatedHygiene)).toBe(AssuranceOutcome.Unmet);
    expect(detailOf(subject, AssuranceCriterion.AutomatedHygiene)).toBe("not configured: Dependabot security updates, a dependency update configuration");
  });

  it("should judge on the signals it could read rather than holding the answer back for one it could not", () => {
    // A repository whose Dependabot state GitHub withheld but whose secret scanning is plainly off HAS failed the
    // criterion. Holding the whole answer back for the missing field would hide a real gap behind a permission.
    const subject = subjectOf({ evidence: evidenceOf({ hygiene: { secretScanning: false } }) });

    expect(outcomeOf(subject, AssuranceCriterion.AutomatedHygiene)).toBe(AssuranceOutcome.Unmet);
    expect(detailOf(subject, AssuranceCriterion.AutomatedHygiene)).toBe("not configured: secret scanning");
  });

  it("should say how many signals it read when some were withheld and the rest are on", () => {
    const subject = subjectOf({ evidence: evidenceOf({ hygiene: { secretScanning: true, pushProtection: true } }) });

    expect(outcomeOf(subject, AssuranceCriterion.AutomatedHygiene)).toBe(AssuranceOutcome.Met);
    expect(detailOf(subject, AssuranceCriterion.AutomatedHygiene)).toBe("every one of the 2 readable hygiene signals is on");
  });

  it("should be unknown only when no signal at all could be read", () => {
    expect(outcomeOf(subjectOf({ evidence: evidenceOf({ hygiene: {} }) }), AssuranceCriterion.AutomatedHygiene)).toBe(AssuranceOutcome.Unknown);
  });

  it("should be unknown where nothing has been collected for the repository", () => {
    expect(outcomeOf(subjectOf({ evidence: undefined }), AssuranceCriterion.AutomatedHygiene)).toBe(AssuranceOutcome.Unknown);
  });
});

describe("the patching criterion", () => {
  it("should report the age and never fail, no threshold having been agreed", () => {
    // MEASUREMENT FIRST. A 900-day-old critical alert is a finding a reader judges; grading it here would publish
    // an SLA nobody chose. `oldestSevereAlertDays` is where a threshold reads from when one is agreed.
    const subject = subjectOf({ evidence: evidenceOf({ oldestSevereAlertDays: 900 }) });

    expect(outcomeOf(subject, AssuranceCriterion.Patching)).toBe(AssuranceOutcome.Met);
    expect(detailOf(subject, AssuranceCriterion.Patching)).toBe("the oldest open critical or high alert is 900 days old");
  });

  it("should say nothing severe is open where no age was recorded", () => {
    expect(detailOf(subjectOf(), AssuranceCriterion.Patching)).toBe("no critical or high alert is open");
  });

  it("should be unknown where the alert list could not be read, which is not zero alerts", () => {
    // The distinction the whole codebase keeps: a family nobody could read and a family with nothing open look
    // identical as a zero and mean opposite things.
    expect(outcomeOf(subjectOf({ evidence: evidenceOf({ severeAlertsRead: false }) }), AssuranceCriterion.Patching)).toBe(AssuranceOutcome.Unknown);
  });
});

describe("the maintained criterion", () => {
  it("should be met by an archived repository, which is clearly marked", () => {
    expect(outcomeOf(subjectOf({ archived: true, unmaintained: true }), AssuranceCriterion.Maintained)).toBe(AssuranceOutcome.Met);
  });

  it("should be unmet by an unarchived repository past the boundary, which should be archived", () => {
    // The criterion's whole point, and why stale repositories had to be admitted to the estate: 148 unarchived
    // HMCTS repositories are two or more years stale, and the cohort's activity window used to remove every one.
    const subject = subjectOf({ archived: false, unmaintained: true });

    expect(outcomeOf(subject, AssuranceCriterion.Maintained)).toBe(AssuranceOutcome.Unmet);
    expect(detailOf(subject, AssuranceCriterion.Maintained)).toBe("not archived and not pushed to for years, so it should be archived");
  });

  it("should be met by a repository being pushed to", () => {
    expect(outcomeOf(subjectOf(), AssuranceCriterion.Maintained)).toBe(AssuranceOutcome.Met);
  });

  it("should answer even where nothing has been collected, activity not being a fact about a window", () => {
    // Read from the graph rather than from `repository_state`, so a repository the span cannot report is still
    // answerable on this criterion and on ownership — the same reason `owner_kind` is on both row branches.
    expect(outcomeOf(subjectOf({ evidence: undefined, unmaintained: true }), AssuranceCriterion.Maintained)).toBe(AssuranceOutcome.Unmet);
  });
});

describe("assuranceGrade", () => {
  it("should read met when every graded criterion is met", () => {
    expect(assuranceGrade(judgeAssurance(subjectOf()))).toBe(AssuranceGrade.Met);
  });

  it("should read partial on any shortfall", () => {
    expect(assuranceGrade(judgeAssurance(subjectOf({ ownerKind: "person" })))).toBe(AssuranceGrade.Partial);
  });

  it("should let a shortfall outrank an unreadable signal rather than the other way round", () => {
    // THE PRECEDENCE THAT MATTERS, and the same argument `assessment.ts` makes for putting red above
    // cannot-assess: read the other way, one withheld signal would hide a criterion the repository plainly fails.
    const subject = subjectOf({ ownerKind: "person", evidence: evidenceOf({ hygiene: {} }) });

    expect(assuranceGrade(judgeAssurance(subject))).toBe(AssuranceGrade.Partial);
  });

  it("should read unknown only when nothing at all could be graded", () => {
    // Every graded criterion unreadable: no ownership attributed, no hygiene signal read. Maintenance is not
    // among them because the graph always answers it, so this needs the one subject where it cannot.
    const nothing = judgeAssurance(subjectOf({ ownerKind: undefined, evidence: evidenceOf({ hygiene: {} }) })).filter(
      (judgement) => judgement.criterion !== AssuranceCriterion.Maintained
    );

    expect(assuranceGrade(nothing)).toBe(AssuranceGrade.Unknown);
  });

  it("should ignore the patching criterion, whatever it says", () => {
    // A 900-day alert must not drag a fully-compliant repository off `met`, because the criterion grades nothing.
    // Were it graded, this would be the case that caught it.
    expect(assuranceGrade(judgeAssurance(subjectOf({ evidence: evidenceOf({ oldestSevereAlertDays: 900 }) })))).toBe(AssuranceGrade.Met);
  });
});

describe("ageInDays", () => {
  const NOW = new Date("2026-09-14T12:00:00Z");

  it("should floor the age, so an alert raised this morning reads as zero days rather than as one", () => {
    expect(ageInDays(new Date("2026-09-14T00:00:00Z"), NOW)).toBe(0);
    expect(ageInDays(new Date("2026-09-13T00:00:00Z"), NOW)).toBe(1);
    expect(ageInDays(new Date("2024-09-14T12:00:00Z"), NOW)).toBe(730);
  });

  it("should hold an instant in the future at zero rather than reporting a negative age", () => {
    // A clock skew between GitHub and the collector, which is small and not impossible. A negative age would
    // sort above every real one and read as the newest alert in the estate.
    expect(ageInDays(new Date("2026-09-15T12:00:00Z"), NOW)).toBe(0);
  });

  it("should have no age for an absent instant", () => {
    expect(ageInDays(undefined, NOW)).toBeUndefined();
  });
});
