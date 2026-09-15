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
  // Clean and readable by default on every axis, so a case that is about one criterion states only that one.
  return { hygiene: hygiene(), severeAlertsRead: true, securityPolicy: true, secrets: { open: 0 }, secretsRead: true, ...overrides };
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
  it("should report the six it can evidence, in the order the criteria themselves read", () => {
    // The count is the claim the page footnote makes, so it is asserted rather than left to a comment: one
    // criterion is omitted deliberately and one is partial, and a seventh appearing here without that decision
    // being revisited would be a proxy signal, which is the one thing this set was built to avoid.
    expect(AssuranceCriteria).toEqual([
      AssuranceCriterion.NamedOwner,
      AssuranceCriterion.AutomatedHygiene,
      AssuranceCriterion.NoCommittedSecrets,
      AssuranceCriterion.SecurityContact,
      AssuranceCriterion.Patching,
      AssuranceCriterion.Maintained
    ]);
  });

  it("should judge every criterion it reports, so no column can be structurally empty", () => {
    // The failure this guards is the one the CODEOWNERS column shipped with for months: a column whose field
    // nothing ever populated, rendering a dash for the entire estate.
    expect(judgeAssurance(subjectOf()).map((judgement) => judgement.criterion)).toEqual([...AssuranceCriteria]);
  });

  it("should leave two criteria out of the grade, for opposite reasons", () => {
    // `Patching` has no threshold to pass, so it has no verdict to contribute. `SecurityContact` is met for
    // essentially the whole estate, so it can only ever add a free pass — counted, it would make a repository
    // meeting two of three graded criteria look like one meeting three of four on identical evidence.
    expect(GradedAssuranceCriteria).not.toContain(AssuranceCriterion.Patching);
    expect(GradedAssuranceCriteria).not.toContain(AssuranceCriterion.SecurityContact);
    expect(GradedAssuranceCriteria).toEqual([
      AssuranceCriterion.NamedOwner,
      AssuranceCriterion.AutomatedHygiene,
      AssuranceCriterion.NoCommittedSecrets,
      AssuranceCriterion.Maintained
    ]);
  });

  it("should grade the secrets criterion, which unlike those two actually discriminates", () => {
    // The distinction between the two exclusions above and this: an open secret-scanning alert is a real, varying,
    // actionable finding — 12 repositories on this estate have one — so it separates repositories rather than
    // flattering them.
    expect(GradedAssuranceCriteria).toContain(AssuranceCriterion.NoCommittedSecrets);
  });
});

/**
 * The committed-secrets criterion, which is the half of "no secrets or sensitive detail" that IS collectable.
 *
 * Measured on AAT: 18 alerts open across 12 repositories, oldest raised 2022-05-26. The criterion was written off
 * as needing human judgement until the org-wide endpoint was checked.
 */
describe("the committed-secrets criterion", () => {
  it("should still be met when no alert is open and secret scanning is enabled", () => {
    // THE ONE SHAPE IN WHICH AN EMPTY ALERT LIST IS AN ANSWER: something scanned and found nothing. The org-wide
    // read makes the absence unambiguous as a READ — a refusal cannot be mistaken for a quiet repository — and the
    // hygiene flag is what says anything looked.
    const subject = subjectOf({ evidence: evidenceOf({ hygiene: hygiene({ secretScanning: true }), secrets: { open: 0 } }) });

    expect(outcomeOf(subject, AssuranceCriterion.NoCommittedSecrets)).toBe(AssuranceOutcome.Met);
    expect(detailOf(subject, AssuranceCriterion.NoCommittedSecrets)).toBe("no secret-scanning alert is open");
  });

  it("should grade unknown when no alert is open and secret scanning is disabled", () => {
    // 890 OF THIS ESTATE'S 1,890 GRADED REPOSITORIES, every one of them reading "no secret-scanning alert is open"
    // off a list it could not have contributed to: scanning off raises no alerts, so the repository goes unnamed in
    // the org-wide response for the same reason a scanned and clean one does.
    const subject = subjectOf({ evidence: evidenceOf({ hygiene: hygiene({ secretScanning: false }), secrets: { open: 0 } }) });

    expect(outcomeOf(subject, AssuranceCriterion.NoCommittedSecrets)).toBe(AssuranceOutcome.Unknown);
    expect(detailOf(subject, AssuranceCriterion.NoCommittedSecrets)).toBe("secret scanning is not enabled, so nothing has been scanned");
  });

  it("should grade unknown rather than unmet when nothing scanned, no credential having been shown", () => {
    // THE DIRECTION MATTERS AS MUCH AS THE MOVE OFF `Met`. A repository nobody scanned has not been shown to hold a
    // secret, and marking it down would assert something unmeasured the other way — `AssuranceOutcome.Unknown`'s
    // own rule. Nothing is lost by it: scanning being off is already one of `AutomatedHygiene`'s signals.
    const subject = subjectOf({ evidence: evidenceOf({ hygiene: hygiene({ secretScanning: false }), secrets: { open: 0 } }) });

    expect(outcomeOf(subject, AssuranceCriterion.NoCommittedSecrets)).not.toBe(AssuranceOutcome.Unmet);
    expect(outcomeOf(subject, AssuranceCriterion.AutomatedHygiene)).toBe(AssuranceOutcome.Unmet);
    expect(detailOf(subject, AssuranceCriterion.AutomatedHygiene)).toBe("not configured: secret scanning");
  });

  it("should grade unknown when no alert is open and the scanning flag is absent", () => {
    // NOT DEFAULTED TO OFF, on the rule `hygieneFromMetadata` already states: a metadata body this build cannot
    // read is not evidence that scanning is disabled. It is not evidence that anything scanned either, so the zero
    // still has nothing to be measured against.
    const subject = subjectOf({ evidence: evidenceOf({ hygiene: hygiene({ secretScanning: undefined }), secrets: { open: 0 } }) });

    expect(outcomeOf(subject, AssuranceCriterion.NoCommittedSecrets)).toBe(AssuranceOutcome.Unknown);
    expect(detailOf(subject, AssuranceCriterion.NoCommittedSecrets)).toBe(
      "whether secret scanning is enabled could not be read, so nothing evidences that it ran"
    );
  });

  it("should be unmet with an open alert, and carry how long it has been open", () => {
    // The age goes in the DETAIL rather than a column of its own: the answer is binary — there is an outstanding
    // leaked credential or there is not — and how long is what a reader needs next. On this estate the oldest is
    // 1,572 days, which is the finding this criterion exists to surface.
    const subject = subjectOf({ evidence: evidenceOf({ secrets: { open: 3, oldestOpenDays: 1572 } }) });

    expect(outcomeOf(subject, AssuranceCriterion.NoCommittedSecrets)).toBe(AssuranceOutcome.Unmet);
    expect(detailOf(subject, AssuranceCriterion.NoCommittedSecrets)).toBe("3 secret-scanning alerts open, the oldest for 1572 days");
  });

  it("should pluralise one alert against its own noun", () => {
    expect(detailOf(subjectOf({ evidence: evidenceOf({ secrets: { open: 1, oldestOpenDays: 4 } }) }), AssuranceCriterion.NoCommittedSecrets)).toBe(
      "1 secret-scanning alert open, the oldest for 4 days"
    );
  });

  it("should still report an open alert whose age could not be read", () => {
    // An alert with an unreadable `created_at` is still an alert. It just cannot contribute an age, and the
    // criterion must not read as clean because one instant would not parse.
    const subject = subjectOf({ evidence: evidenceOf({ secrets: { open: 2 } }) });

    expect(outcomeOf(subject, AssuranceCriterion.NoCommittedSecrets)).toBe(AssuranceOutcome.Unmet);
    expect(detailOf(subject, AssuranceCriterion.NoCommittedSecrets)).toBe("2 secret-scanning alerts open");
  });

  it("should still grade unmet when an alert is open, whatever the scanning flag says", () => {
    // The flag is only needed to interpret a ZERO. An alert exists, so something plainly scanned — and a flag
    // reading off beside an open alert is a repository that has since turned scanning off, not a reason to
    // withdraw the finding.
    for (const secretScanning of [true, false, undefined]) {
      const subject = subjectOf({ evidence: evidenceOf({ hygiene: hygiene({ secretScanning }), secrets: { open: 1, oldestOpenDays: 9 } }) });

      expect(outcomeOf(subject, AssuranceCriterion.NoCommittedSecrets)).toBe(AssuranceOutcome.Unmet);
      expect(detailOf(subject, AssuranceCriterion.NoCommittedSecrets)).toBe("1 secret-scanning alert open, the oldest for 9 days");
    }
  });

  it("should be unknown where the org-wide read failed, never clean", () => {
    // THE ONE WRONG ANSWER THAT READS LIKE GOOD NEWS. One failed call must make every repository unknown rather
    // than reporting the estate as having no leaked credentials at all.
    expect(outcomeOf(subjectOf({ evidence: evidenceOf({ secretsRead: false, secrets: undefined }) }), AssuranceCriterion.NoCommittedSecrets)).toBe(
      AssuranceOutcome.Unknown
    );
  });

  it("should be unknown where the read succeeded but this repository has no summary at all", () => {
    // Defensive rather than reachable through the collector, which writes `{ open: 0 }` for a clean repository.
    // Read as unknown rather than clean, because a summary that should exist and does not is a fault, not an
    // answer — and the conservative direction on a security criterion is to admit ignorance.
    expect(outcomeOf(subjectOf({ evidence: evidenceOf({ secretsRead: true, secrets: undefined }) }), AssuranceCriterion.NoCommittedSecrets)).toBe(
      AssuranceOutcome.Unknown
    );
  });
});

/**
 * The security-contact criterion, reported and deliberately not graded.
 *
 * These cases are mostly about the DETAIL, because the outcome carries almost no information: it reads met for 40
 * of 40 sampled repositories. What the page has to do is say why.
 */
describe("the security-contact criterion", () => {
  it("should say what the answer actually evidences, not merely that it is met", () => {
    // A reader meeting a column of Yes would otherwise conclude every repository has its own intake route. It does
    // not; the organisation has one, and GitHub reports it against every repository that does not override it.
    expect(detailOf(subjectOf(), AssuranceCriterion.SecurityContact)).toBe(
      "a security policy applies, usually the organisation's own rather than this repository's"
    );
  });

  it("should be unmet where not even the organisation's policy applies", () => {
    // Rare to the point of being nearly unobservable on this estate, which is exactly why it is worth keeping: if
    // it ever fires it is a real finding rather than noise.
    const subject = subjectOf({ evidence: evidenceOf({ securityPolicy: false }) });

    expect(outcomeOf(subject, AssuranceCriterion.SecurityContact)).toBe(AssuranceOutcome.Unmet);
    expect(detailOf(subject, AssuranceCriterion.SecurityContact)).toBe("no security policy applies, not even the organisation's");
  });

  it("should be unknown where GitHub said nothing about it", () => {
    expect(outcomeOf(subjectOf({ evidence: evidenceOf({ securityPolicy: undefined }) }), AssuranceCriterion.SecurityContact)).toBe(AssuranceOutcome.Unknown);
  });

  it("should not lift a repository's grade by being met, which is why it is not counted", () => {
    // THE REASON IT IS EXCLUDED, asserted rather than only argued in a comment: a repository failing one graded
    // criterion is `partial` whether or not the security contact is met, so the always-true signal cannot flatter
    // it. Counted, the same repository would read three-of-four met instead of two-of-three.
    const failing = subjectOf({ ownerKind: "none" });

    expect(assuranceGrade(judgeAssurance(failing))).toBe(AssuranceGrade.Partial);
    expect(assuranceGrade(judgeAssurance({ ...failing, evidence: evidenceOf({ securityPolicy: false }) }))).toBe(AssuranceGrade.Partial);
  });
});

/**
 * The named-owner criterion, which asks whether the repository has an OWNER — not whether it has a TEAM.
 *
 * Any individual owner at all was `unmet` until 2026-09-15, on the reading that the criterion asks for a team.
 * Measured on AAT that marked down 217 repositories with a named person to ask about them, reporting 367 findings
 * where there are 150.
 */
describe("the named-owner criterion", () => {
  it("should be met by a team", () => {
    expect(outcomeOf(subjectOf({ ownerKind: "team" }), AssuranceCriterion.NamedOwner)).toBe(AssuranceOutcome.Met);
    expect(detailOf(subjectOf({ ownerKind: "team" }), AssuranceCriterion.NamedOwner)).toBe("assigned to a team");
  });

  it("should be met by a named individual, who is somebody to ask", () => {
    // 217 of this estate's repositories are this case and every one of them used to be reported as a finding. No
    // membership check qualifies it: the ladder resolves owners from the graph's live people, so a login that has
    // left is not an owner by the time this reads one — see `AssuranceCriterion.NamedOwner`.
    const subject = subjectOf({ ownerKind: "person" });

    expect(outcomeOf(subject, AssuranceCriterion.NamedOwner)).toBe(AssuranceOutcome.Met);
    expect(detailOf(subject, AssuranceCriterion.NamedOwner)).toBe("assigned to a named individual");
  });

  it("should not grade an individual owner below a team, the criterion asking for neither in particular", () => {
    // THE CASE THAT STOPS THE OLD RULE COMING BACK. A person and a team are different facts about a repository —
    // which is why `owner_kind` exists — and this criterion is not where the difference is a verdict.
    expect(outcomeOf(subjectOf({ ownerKind: "person" }), AssuranceCriterion.NamedOwner)).toBe(
      outcomeOf(subjectOf({ ownerKind: "team" }), AssuranceCriterion.NamedOwner)
    );
  });

  it("should be unmet only by an orphan, which is the finding the criterion exists for", () => {
    // 150 repositories on this estate. `OwnerKind.None` is stored as a row rather than as an absence, so the
    // ladder ran and attributed nothing — a finding rather than a gap.
    expect(outcomeOf(subjectOf({ ownerKind: "none" }), AssuranceCriterion.NamedOwner)).toBe(AssuranceOutcome.Unmet);
    expect(detailOf(subjectOf({ ownerKind: "none" }), AssuranceCriterion.NamedOwner)).toBe("nothing owns it, so nobody is accountable for it");
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
    expect(detailOf(subject, AssuranceCriterion.AutomatedHygiene)).toBe("not configured: automated dependency updates");
  });

  /**
   * THE RENOVATE CASE, which this criterion failed on 244 repositories of the live estate.
   *
   * Renovate keeps dependencies current and does not turn GitHub's Dependabot security updates on, so requiring
   * both signals marked down every repository that uses it. They are one requirement and either tool meets it.
   */
  it("should be met where Renovate updates the dependencies and Dependabot security updates is off", () => {
    const subject = subjectOf({ evidence: evidenceOf({ hygiene: hygiene({ dependabotSecurityUpdates: false, updateConfiguration: true }) }) });

    expect(outcomeOf(subject, AssuranceCriterion.AutomatedHygiene)).toBe(AssuranceOutcome.Met);
    expect(detailOf(subject, AssuranceCriterion.AutomatedHygiene)).toBe("every hygiene signal is on");
  });

  it("should be met where Dependabot updates them and no configuration file is committed", () => {
    // The mirror of the case above: Dependabot security updates is a repository setting rather than a file, so a
    // repository can be updating perfectly well with nothing in its tree to find.
    const subject = subjectOf({ evidence: evidenceOf({ hygiene: hygiene({ dependabotSecurityUpdates: true, updateConfiguration: false }) }) });

    expect(outcomeOf(subject, AssuranceCriterion.AutomatedHygiene)).toBe(AssuranceOutcome.Met);
  });

  it("should hold the update answer back where one tool is off and the other could not be read", () => {
    // Not `false`: a repository whose Dependabot setting is off and whose default branch could not be listed has
    // not been shown to lack dependency updates. Secret scanning being off is what fails it here.
    const subject = subjectOf({ evidence: evidenceOf({ hygiene: { secretScanning: false, dependabotSecurityUpdates: false } }) });

    expect(detailOf(subject, AssuranceCriterion.AutomatedHygiene)).toBe("not configured: secret scanning");
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
    // The criterion's whole point, and why stale repositories had to be admitted to the estate: 334 unarchived
    // HMCTS repositories are a year or more stale, and the cohort's activity window used to remove every one.
    const subject = subjectOf({ archived: false, unmaintained: true });

    expect(outcomeOf(subject, AssuranceCriterion.Maintained)).toBe(AssuranceOutcome.Unmet);
    expect(detailOf(subject, AssuranceCriterion.Maintained)).toBe("not archived and not pushed to for longer than the policy allows, so it should be archived");
  });

  it("should name no duration in the detail, so a change of boundary cannot falsify the sentence", () => {
    // The string read "not pushed to for years", written against a two-year boundary, and became wrong the day
    // the boundary moved to one without any test failing. The number is policy — `cohort.unmaintained_after_days`
    // — and the detail is the verdict.
    expect(detailOf(subjectOf({ archived: false, unmaintained: true }), AssuranceCriterion.Maintained)).not.toMatch(/year|month|\d/);
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
  it("should read met when every graded criterion is met AND every one of them was read", () => {
    expect(assuranceGrade(judgeAssurance(subjectOf()))).toBe(AssuranceGrade.Met);
  });

  it("should read partial on any shortfall", () => {
    expect(assuranceGrade(judgeAssurance(subjectOf({ ownerKind: "none" })))).toBe(AssuranceGrade.Partial);
  });

  /**
   * THE CASE THAT MOVES THE WHOLE ESTATE AT ONCE, and the reason this grade exists.
   *
   * `GET /orgs/{org}/secret-scanning/alerts` is ONE call for every repository, so when it fails `secretsRead` is
   * false on all ~1,889 rows in the same collection. Read as neutral, that made `met` a three-criterion claim
   * across the estate with nothing on the page changing — no column moved, because the criterion's own cell
   * already read as a dash and the grade beside it still said "Meets criteria".
   */
  it("should not read met when the org-wide secret read failed, on a repository that is otherwise fully compliant", () => {
    const unread = subjectOf({ evidence: evidenceOf({ secretsRead: false, secrets: undefined }) });

    expect(outcomeOf(unread, AssuranceCriterion.NoCommittedSecrets)).toBe(AssuranceOutcome.Unknown);
    expect(assuranceGrade(judgeAssurance(unread))).toBe(AssuranceGrade.PartlyRead);
    expect(assuranceGrade(judgeAssurance(unread))).not.toBe(AssuranceGrade.Met);
  });

  it("should read met for an individually-owned repository, the grade needing no team either", () => {
    // The named-owner rule reaching the grade: 217 of this estate's repositories are person-owned and none of them
    // is held off `met` by that alone.
    expect(assuranceGrade(judgeAssurance(subjectOf({ ownerKind: "person" })))).toBe(AssuranceGrade.Met);
  });

  it("should read partly-read for a repository the batched hygiene read missed, the other single point of failure", () => {
    // A repository simply absent from the batched GraphQL map loses `AutomatedHygiene` the same way one failed
    // org-wide call loses the secrets criterion. Two met of four here rather than three, because an empty hygiene
    // map also withholds the scanning flag the secrets criterion needs — and still no shortfall to report.
    expect(assuranceGrade(judgeAssurance(subjectOf({ evidence: evidenceOf({ hygiene: {} }) })))).toBe(AssuranceGrade.PartlyRead);
  });

  it("should read partly-read where the secrets criterion is the only one that could not be answered", () => {
    // THE GRADE THE UNSCANNED REPOSITORY BELONGS IN. Ownership, hygiene and maintenance all read met, and the
    // secrets answer is missing rather than failed — so there is nothing to report against the repository and no
    // basis for claiming it clean either. Not `met`, which would be the old bug one level up.
    const subject = subjectOf({ evidence: evidenceOf({ hygiene: hygiene({ secretScanning: undefined }) }) });

    expect(outcomeOf(subject, AssuranceCriterion.NoCommittedSecrets)).toBe(AssuranceOutcome.Unknown);
    expect(outcomeOf(subject, AssuranceCriterion.AutomatedHygiene)).toBe(AssuranceOutcome.Met);
    expect(assuranceGrade(judgeAssurance(subject))).toBe(AssuranceGrade.PartlyRead);
    expect(assuranceGrade(judgeAssurance(subject))).not.toBe(AssuranceGrade.Met);
    expect(assuranceGrade(judgeAssurance(subject))).not.toBe(AssuranceGrade.Partial);
  });

  it("should still read partial where another criterion is unmet beside an unanswerable secrets one", () => {
    // THE PRECEDENCE, ON THE SHAPE THIS CHANGE CREATES: an unread criterion must not pull a repository off a
    // finding it plainly has. A stale unarchived repository stays `partial` however little could be read about its
    // secrets.
    const subject = subjectOf({ unmaintained: true, evidence: evidenceOf({ hygiene: hygiene({ secretScanning: undefined }) }) });

    expect(outcomeOf(subject, AssuranceCriterion.NoCommittedSecrets)).toBe(AssuranceOutcome.Unknown);
    expect(outcomeOf(subject, AssuranceCriterion.Maintained)).toBe(AssuranceOutcome.Unmet);
    expect(assuranceGrade(judgeAssurance(subject))).toBe(AssuranceGrade.Partial);
  });

  it("should read partial rather than partly-read where scanning is off, hygiene failing on the same flag", () => {
    // WHAT THE 890 UNSCANNED REPOSITORIES ACTUALLY GRADE, and it is not this change's headline. `secret_scanning`
    // is one of `AutomatedHygiene`'s four signals as well as this criterion's precondition, so a repository with it
    // off carries a real shortfall and `partial` outranks the unread secrets answer. The grade beside these rows
    // does not move; the SECRETS COLUMN does, from a met it had not earned to an honest unknown.
    const subject = subjectOf({ evidence: evidenceOf({ hygiene: hygiene({ secretScanning: false }) }) });

    expect(outcomeOf(subject, AssuranceCriterion.NoCommittedSecrets)).toBe(AssuranceOutcome.Unknown);
    expect(assuranceGrade(judgeAssurance(subject))).toBe(AssuranceGrade.Partial);
  });

  it("should read partly-read where nothing has been collected at all but the graph still answers two criteria", () => {
    // Ownership and maintenance come from the graph, so a repository with no collection is answerable on two of
    // the four. Two of four met used to be `met`, which is the claim this whole change is about.
    expect(assuranceGrade(judgeAssurance(subjectOf({ evidence: undefined })))).toBe(AssuranceGrade.PartlyRead);
  });

  it("should not read met on a judgement list a graded criterion is missing from entirely", () => {
    // Counted against the judgements PRESENT rather than against `GradedAssuranceCriteria`, a list of three met
    // criteria would grade `met` — and a criterion nobody judged has not been shown met. The report layer always
    // judges all six, so this guards the contract of the function rather than a reachable row.
    const short = judgeAssurance(subjectOf()).filter((judgement) => judgement.criterion !== AssuranceCriterion.Maintained);

    expect(assuranceGrade(short)).toBe(AssuranceGrade.PartlyRead);
  });

  it("should keep a shortfall apart from an unread criterion rather than grading both partial", () => {
    // The distinction the fourth grade buys, on this module's own argument for excluding `SecurityContact`:
    // "three of four met reads better than two of three met, on identical evidence." An unread criterion is not a
    // finding against the repository, and a criterion read and failed is.
    const shortfall = judgeAssurance(subjectOf({ ownerKind: "none" }));
    const unread = judgeAssurance(subjectOf({ evidence: evidenceOf({ secretsRead: false, secrets: undefined }) }));

    expect(assuranceGrade(shortfall)).not.toBe(assuranceGrade(unread));
  });

  it("should let a shortfall outrank an unreadable signal rather than the other way round", () => {
    // THE PRECEDENCE THAT MATTERS, and the same argument `assessment.ts` makes for putting red above
    // cannot-assess: read the other way, one withheld signal would hide a criterion the repository plainly fails.
    const subject = subjectOf({ ownerKind: "none", evidence: evidenceOf({ hygiene: {} }) });

    expect(assuranceGrade(judgeAssurance(subject))).toBe(AssuranceGrade.Partial);
  });

  it("should read unknown only when nothing at all could be graded", () => {
    // EVERY graded criterion unreadable: no ownership attributed, no hygiene signal read, and the org-wide secret
    // scan failed. Maintenance is dropped from the list rather than made unreadable because the graph always
    // answers it — there is no subject for which it cannot, which is why it is filtered here instead.
    const nothing = judgeAssurance(subjectOf({ ownerKind: undefined, evidence: evidenceOf({ hygiene: {}, secretsRead: false, secrets: undefined }) })).filter(
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
