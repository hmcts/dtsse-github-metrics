/**
 * The "coding in the open" assurance criteria, as far as GitHub can evidence them.
 *
 * A DIFFERENT QUESTION FROM READINESS, and the distinction is the whole reason this file exists rather than
 * another condition in `assessment/assessment.ts`. That module grades READINESS FOR AI ENABLEMENT and every
 * condition it checks is ways-of-working — branch protection, review coverage, force pushes, stale reviews. This
 * grades whether a repository meets the published assurance criteria for working in the open, which is about
 * ownership, security tooling, patching and whether the code is maintained at all. The two share the RAG
 * machinery in `lib/rag.ts` and nothing else: neither is a version of the other, and neither replaces the other.
 *
 * SEVEN CRITERIA, OF WHICH THIS EVIDENCES FOUR. The three left out are left out because no proxy for them would
 * be honest, which was a decision rather than an omission:
 *
 *   • NO SECRETS OR SENSITIVE DETAIL IN THE REPOSITORY needs a human reading the diff. Secret scanning finds
 *     credentials matching a known provider pattern and says nothing about a hostname, an internal URL or a
 *     customer name, so reporting it as this criterion would grade the tooling and claim it graded the content.
 *   • SECURE BY DESIGN needs a threat model and a review of what the service exposes. Nothing in a GitHub API
 *     answers it.
 *   • A SECURITY CONTACT AND INTAKE ROUTE is collectable and is deliberately NOT reported, which is the one of
 *     the three worth explaining. `isSecurityPolicyEnabled` reads `true` for 40 of 40 sampled repositories,
 *     including every one with no `SECURITY.md` of its own: GitHub inherits the organisation's `.github`
 *     repository, so the field evidences that HMCTS has an org-level policy — which it does, once — and carries
 *     no information about any individual repository. A column reading Yes for the entire estate is not a
 *     finding, and presenting it as per-repository intake would be the proxy this set was built to avoid.
 *
 * What is graded is stated on each criterion below, with the measured spread that justifies including it.
 */

/** One criterion's answer: met, not met, or unmeasured. */
export const AssuranceOutcome = {
  Met: "met",
  Unmet: "unmet",
  /**
   * Nobody could read it.
   *
   * A THIRD VALUE AND NEVER FOLDED INTO `Unmet`, on the same rule the rest of this codebase reports absence by:
   * a repository whose tooling GitHub would not disclose has not failed the criterion, and grading it as a
   * failure would blame a missing permission on the team that owns the code.
   */
  Unknown: "unknown"
} as const;

export type AssuranceOutcome = (typeof AssuranceOutcome)[keyof typeof AssuranceOutcome];

/**
 * The criteria this build reports, in the order a reader meets them.
 *
 * Ordered as the assurance criteria themselves are rather than by how well the estate does on them: the page is
 * read against the published list, and reordering it by outcome would make it a different document.
 */
export const AssuranceCriterion = {
  /**
   * A named owner and a maintenance plan: the repository is assigned to a TEAM rather than to an individual.
   *
   * Read from `owner_kind`, which the ownership ladder already resolves — NOT from CODEOWNERS. The distinction
   * matters because a CODEOWNERS column shipped on this table for months and rendered a dash for the entire
   * estate: nothing ever populated `codeowners_files`. `owner_kind` is on every row, on both branches, from
   * PR #17. Measured on AAT: 1,499 team-owned, 206 person-owned, 141 unowned, and no repository has both.
   *
   * A PERSON IS UNMET RATHER THAN UNKNOWN. The criterion asks for a team, the ladder answered with a person, and
   * that is an answer — 206 repositories whose maintenance rests on one individual is the finding, not a gap.
   */
  NamedOwner: "named-owner",
  /**
   * Automated hygiene: dependency updates, vulnerability alerting, and secret scanning at the push.
   *
   * FOUR SIGNALS, GRADED AS ONE CRITERION, which is a departure from the thin-column instinct and the
   * measurement is why. On a 40-repository random public sample, `secret_scanning` is enabled on 39 and push
   * protection on 39 — both are organisation-wide defaults, so a column of either is a column of Yes. What
   * varies is `dependabot_security_updates` (27 of 40) and whether the repository configures an update tool at
   * all (14 of 40). Four thin columns would therefore be two columns of noise beside two that say something,
   * and the composite is what makes the criterion readable. `detail` names WHICH signal is missing, so the
   * actionable part is not lost — that is the objection to a composite, and naming the gap is the answer to it.
   */
  AutomatedHygiene: "automated-hygiene",
  /**
   * Patching expectations: how old the oldest open critical or high alert is.
   *
   * MEASUREMENT FIRST, WITH NO THRESHOLD. This criterion is deliberately never `Unmet`: it reports the age and
   * grades nothing, because no SLA has been agreed and inventing one here would publish a policy nobody chose.
   * `oldestSevereAlertDays` on the evidence is where a threshold would read from when one is agreed, so applying
   * it later is a comparison rather than a reshaping of the data.
   */
  Patching: "patching",
  /**
   * Unmaintained code is handled safely: archived, or being pushed to.
   *
   * The one criterion that grades an ABSENCE of activity. An archived repository is handled — somebody said so
   * and GitHub enforces it — and an unarchived one nobody has pushed to in years is the risk. The boundary is
   * `cohort.unmaintained_after_days`, two years by default and measured: 148 unarchived HMCTS repositories sit
   * past it.
   *
   * This criterion is why stale repositories had to be admitted to the estate at all. Until 2026-09-14 the
   * cohort's activity window removed them, so the column would have been structurally empty — the repositories
   * it exists to flag were the ones filtered out upstream.
   */
  Maintained: "maintained"
} as const;

export type AssuranceCriterion = (typeof AssuranceCriterion)[keyof typeof AssuranceCriterion];

/** Every criterion in reporting order, so a table's columns and a grade's inputs cannot disagree. */
export const AssuranceCriteria: readonly AssuranceCriterion[] = [
  AssuranceCriterion.NamedOwner,
  AssuranceCriterion.AutomatedHygiene,
  AssuranceCriterion.Patching,
  AssuranceCriterion.Maintained
];

/**
 * The criteria that take part in the overall grade.
 *
 * `Patching` is EXCLUDED, and stating it as a list rather than a filter over an outcome is deliberate: the
 * criterion reports an age against no threshold, so it has no pass or fail to contribute. Folding it in as
 * "unknown" would drag every graded repository towards cannot-assess on the strength of a column that was never
 * meant to judge. When a threshold is agreed, adding it here is the whole change.
 */
export const GradedAssuranceCriteria: readonly AssuranceCriterion[] = [
  AssuranceCriterion.NamedOwner,
  AssuranceCriterion.AutomatedHygiene,
  AssuranceCriterion.Maintained
];

/** What one repository's automated hygiene looked like, as the four signals behind the one answer. */
export interface HygieneSignals {
  /** `security_and_analysis.secret_scanning`, from the metadata read the collector already makes. */
  secretScanning?: boolean;
  /** `security_and_analysis.secret_scanning_push_protection`. */
  pushProtection?: boolean;
  /** `security_and_analysis.dependabot_security_updates`. The signal that actually varies. */
  dependabotSecurityUpdates?: boolean;
  /** GraphQL `hasVulnerabilityAlertsEnabled`. */
  vulnerabilityAlerts?: boolean;
  /** Whether `.github/dependabot.yml` or `renovate.json` is present on the default branch. */
  updateConfiguration?: boolean;
}

/**
 * One repository's assurance evidence, collected rather than derived.
 *
 * Stored in `repository_state.payload`, which is `jsonb` — so this needs no migration, exactly as that table's
 * own comment promises: "adding a field to a fact needs no migration".
 */
export interface AssuranceEvidence {
  hygiene: HygieneSignals;
  /**
   * How many days old the OLDEST open critical or high Dependabot alert is.
   *
   * Absent means either that nothing severe is open or that the alerts could not be read, and those are
   * different — `severeAlertsRead` is what separates them. Kept as a number of days rather than an instant
   * because it is what the column prints and what a threshold would compare; the instant it was computed from is
   * the collection's own `fetchedAt`.
   */
  oldestSevereAlertDays?: number;
  /** Whether the alert list was read at all, so "nothing open" stays apart from "nobody could look". */
  severeAlertsRead: boolean;
}

/** One criterion's verdict, with the evidence a reader needs to weigh it. */
export interface AssuranceJudgement {
  criterion: AssuranceCriterion;
  outcome: AssuranceOutcome;
  /** Why this outcome — which signal was missing, how old the alert is, how long since the last push. */
  detail: string;
}

/**
 * How the assurance grade reads, in the vocabulary `lib/rag.ts` already draws.
 *
 * The RAG MACHINERY IS REUSED AND THE WORDS ARE NOT. `RAG_LABEL` reads "Ready / Caution / Blocked" for the
 * AI-enablement question, which would be actively wrong here — a repository can be perfectly ready to enable
 * agentic tooling on and still fail the assurance criteria, and the reverse. So this carries its own labels and
 * shares only the colours and the sort order. The two grades sit on different pages for the same reason.
 */
export const AssuranceGrade = {
  /** Every graded criterion met. */
  Met: "met",
  /** Something was not met. Amber rather than red: none of these four is a disqualifier on its own. */
  Partial: "partial",
  /** Nothing could be graded. */
  Unknown: "unknown"
} as const;

export type AssuranceGrade = (typeof AssuranceGrade)[keyof typeof AssuranceGrade];

/** Whether every signal a criterion needs was read, in the order they are reported. */
function hygieneJudgement(signals: HygieneSignals): AssuranceJudgement {
  const checks: [string, boolean | undefined][] = [
    ["secret scanning", signals.secretScanning],
    ["push protection", signals.pushProtection],
    ["Dependabot security updates", signals.dependabotSecurityUpdates],
    ["vulnerability alerts", signals.vulnerabilityAlerts],
    ["a dependency update configuration", signals.updateConfiguration]
  ];
  const unread = checks.filter(([, value]) => value === undefined);
  // EVERY SIGNAL UNREAD IS UNKNOWN; some unread and the rest present is still judged on what was read. A
  // repository whose Dependabot state GitHub withheld but whose secret scanning is plainly off has failed the
  // criterion, and holding the whole answer back for the missing field would hide a real gap.
  if (unread.length === checks.length) {
    return { criterion: AssuranceCriterion.AutomatedHygiene, outcome: AssuranceOutcome.Unknown, detail: "none of the hygiene signals could be read" };
  }
  const missing = checks.filter(([, value]) => value === false).map(([name]) => name);
  if (missing.length === 0) {
    const read = checks.length - unread.length;
    return {
      criterion: AssuranceCriterion.AutomatedHygiene,
      outcome: AssuranceOutcome.Met,
      detail: read === checks.length ? "every hygiene signal is on" : `every one of the ${read} readable hygiene signals is on`
    };
  }
  // The gap is NAMED rather than counted, which is the answer to the objection that a composite hides which
  // control is missing — the actionable part is the name of the control.
  return { criterion: AssuranceCriterion.AutomatedHygiene, outcome: AssuranceOutcome.Unmet, detail: `not configured: ${missing.join(", ")}` };
}

/** The named-owner criterion, read off the kind the ownership ladder resolved. */
function ownerJudgement(ownerKind: string | undefined): AssuranceJudgement {
  if (ownerKind === undefined) {
    return { criterion: AssuranceCriterion.NamedOwner, outcome: AssuranceOutcome.Unknown, detail: "no ownership has been attributed" };
  }
  if (ownerKind === "team") {
    return { criterion: AssuranceCriterion.NamedOwner, outcome: AssuranceOutcome.Met, detail: "assigned to a team" };
  }
  return {
    criterion: AssuranceCriterion.NamedOwner,
    outcome: AssuranceOutcome.Unmet,
    detail: ownerKind === "person" ? "assigned to one individual rather than a team" : "no owner could be attributed"
  };
}

/** The patching criterion, which reports an age and grades nothing. See `AssuranceCriterion.Patching`. */
function patchingJudgement(evidence: AssuranceEvidence): AssuranceJudgement {
  if (!evidence.severeAlertsRead) {
    return { criterion: AssuranceCriterion.Patching, outcome: AssuranceOutcome.Unknown, detail: "the alert list could not be read" };
  }
  const age = evidence.oldestSevereAlertDays;
  if (age === undefined) {
    return { criterion: AssuranceCriterion.Patching, outcome: AssuranceOutcome.Met, detail: "no critical or high alert is open" };
  }
  // MET WHATEVER THE AGE, because there is no threshold to fail. The number is the finding and the reader is
  // the judge; see the criterion's own comment for why no SLA is invented here.
  return { criterion: AssuranceCriterion.Patching, outcome: AssuranceOutcome.Met, detail: `the oldest open critical or high alert is ${age} days old` };
}

/** The maintained criterion: archived is handled, stale and unarchived is the risk. */
function maintainedJudgement(archived: boolean, unmaintained: boolean): AssuranceJudgement {
  if (archived) {
    return { criterion: AssuranceCriterion.Maintained, outcome: AssuranceOutcome.Met, detail: "archived, so it is clearly marked as no longer maintained" };
  }
  if (unmaintained) {
    return {
      criterion: AssuranceCriterion.Maintained,
      outcome: AssuranceOutcome.Unmet,
      detail: "not archived and not pushed to for years, so it should be archived"
    };
  }
  return { criterion: AssuranceCriterion.Maintained, outcome: AssuranceOutcome.Met, detail: "pushed to recently enough to read as maintained" };
}

/** What one repository is being judged on, beside its collected assurance evidence. */
export interface AssuranceSubject {
  /** `OwnerKind` as the row carries it, or absent where no ownership was attributed. */
  ownerKind?: string;
  archived: boolean;
  /** Whether the repository is past `cohort.unmaintained_after_days`, which the cohort decided. */
  unmaintained: boolean;
  evidence?: AssuranceEvidence;
}

/**
 * Judge every criterion, in reporting order.
 *
 * A subject with NO collected evidence still gets judgements: ownership and maintenance come from the graph, so
 * a repository nothing has been collected for is still answerable on two of the four. That is the same reason
 * `owner_kind` is on both branches of `repositoryRow` — who owns a repository, and whether anybody is pushing to
 * it, are not facts about a reporting window.
 */
export function judgeAssurance(subject: AssuranceSubject): AssuranceJudgement[] {
  const evidence = subject.evidence;
  return [
    ownerJudgement(subject.ownerKind),
    evidence === undefined
      ? { criterion: AssuranceCriterion.AutomatedHygiene, outcome: AssuranceOutcome.Unknown, detail: "nothing has been collected for this repository" }
      : hygieneJudgement(evidence.hygiene),
    evidence === undefined
      ? { criterion: AssuranceCriterion.Patching, outcome: AssuranceOutcome.Unknown, detail: "nothing has been collected for this repository" }
      : patchingJudgement(evidence),
    maintainedJudgement(subject.archived, subject.unmaintained)
  ];
}

/**
 * The one grade the graded criteria add up to.
 *
 * `Partial` on any shortfall and `Unknown` only when NOTHING was graded, which is the precedence worth stating:
 * a repository failing one criterion and unable to answer another is failing, not unassessable. Reading it the
 * other way would let an unreadable signal hide a real gap, which is the same argument `PRECEDENCE` in
 * `assessment.ts` makes for putting red above cannot-assess.
 */
export function assuranceGrade(judgements: readonly AssuranceJudgement[]): AssuranceGrade {
  const graded = judgements.filter((judgement) => GradedAssuranceCriteria.includes(judgement.criterion));
  if (graded.some((judgement) => judgement.outcome === AssuranceOutcome.Unmet)) {
    return AssuranceGrade.Partial;
  }
  return graded.some((judgement) => judgement.outcome === AssuranceOutcome.Met) ? AssuranceGrade.Met : AssuranceGrade.Unknown;
}

/** How many days old an instant is, floored, or `undefined` where there is no instant. */
export function ageInDays(instant: Date | undefined, reference: Date): number | undefined {
  if (instant === undefined) {
    return undefined;
  }
  return Math.max(0, Math.floor((reference.getTime() - instant.getTime()) / (24 * 60 * 60 * 1000)));
}
