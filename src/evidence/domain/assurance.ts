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
 * SEVEN CRITERIA. FIVE ARE REPORTED — four of them fully, one in part — AND ONE IS OMITTED. That is six; the
 * seventh, a maintenance plan, is not a separate column because `NamedOwner` is the only part of it GitHub can
 * answer: a plan is a document, and who is accountable for the code is the collectable half.
 *
 * The omission and the partial are different things and the page says so separately, because a tick on a secrets
 * column otherwise reads as a broader assurance than it is:
 *
 *   • OMITTED — SECURE BY DESIGN needs a threat model and a review of what the service exposes. Nothing in a
 *     GitHub API answers it, and no proxy for it would be honest.
 *   • PARTIAL — "no secrets or SENSITIVE OPERATIONAL DETAIL" is evidenced for secrets only. `NoCommittedSecrets`
 *     reads secret-scanning alerts, which find committed credentials; hostnames, IP ranges, admin endpoints and
 *     capacity thresholds need a human reading the content and stay uncollectable. The criterion is named for the
 *     half it evidences rather than the full wording, which is what keeps the column from claiming the other.
 *
 * ONE CRITERION IS REPORTED WITHOUT BEING GRADED. `SecurityContact` is collectable and reads met for essentially
 * the whole estate, so it is shown and kept out of `GradedAssuranceCriteria` — see its own note for why including
 * it would inflate the grade rather than inform it.
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
   * A named owner and a maintenance plan: SOMEBODY WHO STILL WORKS HERE is accountable for the code.
   *
   * Read from `owner_kind`, which the ownership ladder already resolves — NOT from CODEOWNERS. The distinction
   * matters because a CODEOWNERS column shipped on this table for months and rendered a dash for the entire
   * estate: nothing ever populated `codeowners_files`. `owner_kind` is on every row, on both branches, from
   * PR #17.
   *
   * A CURRENT INDIVIDUAL IS MET AND A DEPARTED ONE IS NOT, from 2026-09-15, where any individual at all used to
   * be `Unmet` on the grounds that the criterion asks for a team. It does not: it asks for a named owner, and a
   * named person who is still in the organisation is one — somebody a reader can go and ask. What the criterion
   * exists to find is code with NOBODY accountable, and the two shapes of that are a repository nothing owns and
   * a repository owned by a login that has left. Measured on AAT: 1,523 team-owned, 217 person-owned of which
   * 215 name at least one current member, and 150 unowned. So the old rule reported 367 findings where there are
   * 152, and the 215 it marked down had an owner all along.
   *
   * MEMBERSHIP IS A THIRD ANSWER, not a default. An individual owner whose organisation membership could not be
   * read is `Unknown`: read as met it would claim an owner nobody checked for, and read as unmet it would blame
   * an unread member list on the team that owns the code. That is the same rule `secretsRead` and
   * `severeAlertsRead` exist for one level down.
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
   * No committed secrets: nothing found by secret scanning is still open.
   *
   * HALF OF A CRITERION, AND NAMED FOR THE HALF IT EVIDENCES. The published criterion is "no secrets or sensitive
   * operational detail"; hostnames, IP ranges, admin endpoints and capacity thresholds need a human reading the
   * content and stay uncollectable. A committed CREDENTIAL does not: GitHub finds it, and an alert still open
   * means it was found and not resolved. Calling this `no-committed-secrets` rather than the full wording is what
   * keeps the page from claiming the other half.
   *
   * DETECTION AND PREVENTION ARE DIFFERENT CLAIMS AND BOTH ARE REPORTED, in different places. `secret_scanning`
   * and `secret_scanning_push_protection` say scanning is ON, and they sit in `AutomatedHygiene` where they
   * belong; this says something was FOUND and is outstanding. A repository with scanning enabled and an open
   * alert is worse than one with scanning enabled and none, and folding the two together would hide exactly that.
   *
   * MEASURED ON AAT, and the reason this is worth a column: 18 alerts open across 12 repositories, the oldest
   * raised 2022-05-26 — 1,572 days. That single finding is the kind of thing this dashboard exists to surface,
   * and it was invisible while the criterion was written off as needing human judgement.
   *
   * ONE CALL FOR THE WHOLE ESTATE. `GET /orgs/{org}/secret-scanning/alerts?state=open` covers every repository,
   * so a repository NOT NAMED in the response is genuinely clean rather than merely unasked-about — which is a
   * real distinction from the per-repository endpoint, where absence is ambiguous. That is why the org-wide form
   * is used and the per-repository one is not.
   */
  NoCommittedSecrets: "no-committed-secrets",
  /**
   * A security contact and an intake route: somewhere to report a vulnerability.
   *
   * REPORTED BUT NOT GRADED, and this is the one criterion here whose own comment argues against trusting it.
   * `isSecurityPolicyEnabled` reads `true` for 40 of 40 sampled repositories, including every one with no
   * `SECURITY.md` of its own, because GitHub inherits the organisation's `.github` repository. So the field
   * evidences that HMCTS HAS AN ORG-LEVEL POLICY — which it does, once — and says nothing about any individual
   * repository.
   *
   * It is shown because the criterion is one of the seven and a reader checking the page against the published
   * list is entitled to see it answered. It is kept out of `GradedAssuranceCriteria` because a criterion that is
   * met everywhere cannot distinguish anything: folded into the grade it would be a free pass on every row,
   * making a repository that meets two of three graded criteria look like one that meets three of four. The
   * column reads Yes almost everywhere and the detail says why, which is the honest way to show a signal that
   * evidences org-level intake rather than per-repository intake.
   */
  SecurityContact: "security-contact",
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
   * and GitHub enforces it — and an unarchived one nobody has pushed to for long enough is the risk. The
   * boundary is `cohort.unmaintained_after_days`, ONE YEAR from 2026-09-15 where it was two.
   *
   * Measured on AAT at the move: of 1,890 unarchived repositories, 1,250 were pushed to inside 90 days, 306
   * between 90 days and a year, 186 between one and two years, 100 between two and three, and 48 beyond three.
   * So a two-year boundary flagged 148 and a one-year boundary flags 334 — the 186 in the middle band are what
   * moved, and they are a year without a commit each.
   *
   * NO DURATION IS NAMED IN THE JUDGEMENT'S DETAIL, deliberately. The sentence used to read "not pushed to for
   * years", which was written against the two-year boundary and became wrong the day the boundary moved without
   * anything failing. The boundary is policy and the detail states the verdict, so the number lives in
   * `metrics.yaml` and in this comment and in neither of the strings a reader sees.
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
  AssuranceCriterion.NoCommittedSecrets,
  AssuranceCriterion.SecurityContact,
  AssuranceCriterion.Patching,
  AssuranceCriterion.Maintained
];

/**
 * The criteria that take part in the overall grade.
 *
 * TWO OF THE SIX ARE EXCLUDED, for opposite reasons, and stating this as a list rather than filtering on some
 * property of the outcome is what keeps both arguments visible:
 *
 *   • `Patching` reports an age against no threshold, so it has no pass or fail to contribute. Folding it in as
 *     "unknown" would drag every graded repository towards cannot-assess on the strength of a column that was
 *     never meant to judge. When a threshold is agreed, adding it here is the whole change.
 *   • `SecurityContact` is met for essentially the whole estate, because GitHub inherits the organisation's
 *     policy — so it can only ever add a pass. A criterion that never discriminates does not make a grade more
 *     accurate, it makes it more generous: three of four met reads better than two of three met, on identical
 *     evidence. It is reported and not counted.
 *
 * `NoCommittedSecrets` IS counted, and that is the distinction between the two exclusions above and it. An open
 * secret-scanning alert is a real, varying, actionable finding — 12 repositories on this estate have one — so it
 * separates repositories rather than flattering them.
 */
export const GradedAssuranceCriteria: readonly AssuranceCriterion[] = [
  AssuranceCriterion.NamedOwner,
  AssuranceCriterion.AutomatedHygiene,
  AssuranceCriterion.NoCommittedSecrets,
  AssuranceCriterion.Maintained
];

/**
 * What one repository's automated hygiene looked like: FIVE SIGNALS behind FOUR checks.
 *
 * The last two are one requirement between them — see `hygieneJudgement`. They are collected and stored separately
 * because they are separate facts about a repository, and folding them together here would lose which tool is
 * doing the updating.
 */
export interface HygieneSignals {
  /** `security_and_analysis.secret_scanning`, from the metadata read the collector already makes. */
  secretScanning?: boolean;
  /** `security_and_analysis.secret_scanning_push_protection`. */
  pushProtection?: boolean;
  /** GraphQL `hasVulnerabilityAlertsEnabled`. */
  vulnerabilityAlerts?: boolean;
  /** `security_and_analysis.dependabot_security_updates`. Satisfies the update requirement on its own. */
  dependabotSecurityUpdates?: boolean;
  /** Whether `.github/dependabot.yml` or `renovate.json` is present on the default branch. Satisfies it too. */
  updateConfiguration?: boolean;
}

/**
 * What secret scanning found in one repository and nobody has resolved.
 *
 * NO SECRET VALUE IS CARRIED HERE, and that is deliberate rather than incidental. Each alert GitHub returns
 * includes the literal detected credential in a `secret` field — which is why `github/client.ts` refuses to log
 * response bodies at all — so this holds a COUNT and an AGE and nothing else. A leaked key must not be copied out
 * of GitHub's access controls into a `jsonb` column that every reader of the report can select.
 *
 * `secret_type` is left out for the same reason at one remove: "Azure Storage Account Access Key" tells an
 * attacker reading the dashboard what to go looking for, and the repository name beside it tells them where. The
 * count is what the criterion needs.
 */
export interface SecretAlertSummary {
  /** How many alerts are open. Zero is a real answer and means clean — see `secretsRead`. */
  open: number;
  /**
   * How old the oldest open alert is, in days, or absent where none is open.
   *
   * Worth carrying for the reason `Patching` carries its own age: a secret open since 2022 is a different finding
   * from one raised yesterday, and on this estate the oldest is 1,572 days. It is reported in the detail rather
   * than in its own column — the criterion's answer is binary, and the age is what qualifies it.
   */
  oldestOpenDays?: number;
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
  /**
   * Whether GitHub reports a security policy for this repository.
   *
   * Reads `true` for essentially every repository, inherited from the organisation's `.github` — see
   * `AssuranceCriterion.SecurityContact`. Stored anyway, because the criterion is reported.
   */
  securityPolicy?: boolean;
  /**
   * Open secret-scanning alerts for this repository, or absent where the org-wide read failed.
   *
   * ABSENT MEANS UNREAD AND `{ open: 0 }` MEANS CLEAN, which the org-wide endpoint is what makes sound: it covers
   * every repository in one call, so a repository the response does not name genuinely has none. Were this read
   * per repository, an absence could not be told from a refusal.
   */
  secrets?: SecretAlertSummary;
  /**
   * Whether the org-wide secret-scanning read succeeded.
   *
   * Carried beside `secrets` rather than inferred from it, for the reason `severeAlertsRead` exists: one failed
   * call must make every repository UNKNOWN rather than every repository clean, and a collector that wrote
   * `{ open: 0 }` on failure would report the estate as having no leaked credentials at all.
   */
  secretsRead: boolean;
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
  /** Every graded criterion met, AND every one of them read. */
  Met: "met",
  /**
   * Nothing was found wanting and not everything could be looked at.
   *
   * A FOURTH GRADE FROM 2026-09-15, and the bug it fixes is that `Met` used to mean this too. `Unknown` was
   * folded in as neutral, so a repository whose hygiene and secret signals nobody could read graded `met` — which
   * this map documents as "every graded criterion met" — on two criteria out of four.
   *
   * That is not a rare shape. ONE FAILED ORG-WIDE SECRET-SCANNING CALL makes `NoCommittedSecrets` unknown for the
   * WHOLE ESTATE at once, and a repository the batched GraphQL read missed loses `AutomatedHygiene` the same way.
   * Either way `met` silently became a three-criterion claim with nothing on the page changing, which is exactly
   * the distinction `severeAlertsRead` and `secretsRead` exist one level down to preserve.
   *
   * SEPARATE FROM `Partial` RATHER THAN FOLDED INTO IT, on this module's own argument for excluding
   * `SecurityContact` from the grade: "three of four met reads better than two of three met, on identical
   * evidence." A repository with an unread criterion has no shortfall to report, so grading it as one would
   * invent a finding; grading it `met` claims evidence nobody has. It is the READ that is partial here, not the
   * meeting, and the label says so.
   */
  PartlyRead: "partly-read",
  /** Something was not met. Amber rather than red: none of these four is a disqualifier on its own. */
  Partial: "partial",
  /** Nothing could be graded. */
  Unknown: "unknown"
} as const;

export type AssuranceGrade = (typeof AssuranceGrade)[keyof typeof AssuranceGrade];

/**
 * Whether one of two signals answers yes, for a requirement two different tools can satisfy.
 *
 * `true` beats everything: one tool doing the job is the requirement met, whatever the other says. Both known and
 * neither doing it is `false`. Anything else is unread — a repository whose Dependabot state is plainly off and
 * whose default branch could not be listed has not been shown to lack dependency updates.
 */
function either(left: boolean | undefined, right: boolean | undefined): boolean | undefined {
  if (left === true || right === true) {
    return true;
  }
  return left === false && right === false ? false : undefined;
}

/**
 * Whether every signal a criterion needs was read, in the order they are reported.
 *
 * FOUR CHECKS OVER FIVE SIGNALS, from 2026-09-15. Dependabot security updates and the presence of a
 * `dependabot.yml` or `renovate.json` used to be two independent requirements, and a repository had to satisfy
 * BOTH — which failed every repository that keeps its dependencies current with Renovate, because Renovate does
 * not turn GitHub's Dependabot setting on. Measured on the live estate: 244 repositories carried an update
 * configuration with Dependabot security updates off, and every one of them was marked down for it.
 *
 * They are one requirement — SOMETHING UPDATES THE DEPENDENCIES — and either tool meets it. The criterion still
 * fails a repository with neither, which is the gap it exists to find.
 */
function hygieneJudgement(signals: HygieneSignals): AssuranceJudgement {
  const checks: [string, boolean | undefined][] = [
    ["secret scanning", signals.secretScanning],
    ["push protection", signals.pushProtection],
    ["vulnerability alerts", signals.vulnerabilityAlerts],
    ["automated dependency updates", either(signals.dependabotSecurityUpdates, signals.updateConfiguration)]
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

/**
 * The named-owner criterion, read off the kind the ownership ladder resolved and — for an individual — whether
 * that individual is still here.
 *
 * THE INDIVIDUAL CASE IS THE ONE WITH THREE ANSWERS, and the branch order says which. A team owner needs no
 * membership read at all: a team is the criterion met whoever is currently in it, and asking about its members
 * would make an emptied team fail a criterion it satisfies. An individual owner needs the read, and its absence
 * is `Unknown` rather than either verdict — see `AssuranceCriterion.NamedOwner`.
 *
 * `none` AND AN UNRECOGNISED KIND ANSWER TOGETHER, and both are `Unmet`: the ladder ran and attributed nothing,
 * which is the finding rather than a gap. That is different from `ownerKind` being absent, which is the ladder
 * not having run.
 */
function ownerJudgement(ownerKind: string | undefined, ownerIsCurrentMember: boolean | undefined): AssuranceJudgement {
  const criterion = AssuranceCriterion.NamedOwner;
  if (ownerKind === undefined) {
    return { criterion, outcome: AssuranceOutcome.Unknown, detail: "no ownership has been attributed" };
  }
  if (ownerKind === "team") {
    return { criterion, outcome: AssuranceOutcome.Met, detail: "assigned to a team" };
  }
  if (ownerKind === "person") {
    if (ownerIsCurrentMember === undefined) {
      return { criterion, outcome: AssuranceOutcome.Unknown, detail: "assigned to an individual whose organisation membership could not be read" };
    }
    return ownerIsCurrentMember
      ? { criterion, outcome: AssuranceOutcome.Met, detail: "assigned to an individual who is still a member of the organisation" }
      : { criterion, outcome: AssuranceOutcome.Unmet, detail: "assigned to an individual who has left the organisation, so nobody is accountable for it" };
  }
  return { criterion, outcome: AssuranceOutcome.Unmet, detail: "no owner could be attributed" };
}

/**
 * The committed-secrets criterion: nothing secret scanning found is still open.
 *
 * The age of the oldest open alert is carried in the DETAIL rather than in a column of its own: the criterion's
 * answer is binary — there is an outstanding leaked credential or there is not — and how long it has been
 * outstanding is what a reader needs next, not a second verdict.
 */
function secretsJudgement(evidence: AssuranceEvidence): AssuranceJudgement {
  if (!evidence.secretsRead || evidence.secrets === undefined) {
    return { criterion: AssuranceCriterion.NoCommittedSecrets, outcome: AssuranceOutcome.Unknown, detail: "the secret-scanning alerts could not be read" };
  }
  const { open, oldestOpenDays } = evidence.secrets;
  if (open === 0) {
    // CLEAN, and soundly so: the org-wide read covers every repository, so not being named in it is an answer.
    return { criterion: AssuranceCriterion.NoCommittedSecrets, outcome: AssuranceOutcome.Met, detail: "no secret-scanning alert is open" };
  }
  const alerts = `${open} secret-scanning alert${open === 1 ? "" : "s"} open`;
  return {
    criterion: AssuranceCriterion.NoCommittedSecrets,
    outcome: AssuranceOutcome.Unmet,
    detail: oldestOpenDays === undefined ? alerts : `${alerts}, the oldest for ${oldestOpenDays} days`
  };
}

/**
 * The security-contact criterion, which is reported and deliberately not graded.
 *
 * The detail says WHAT THE ANSWER ACTUALLY EVIDENCES, because a reader meeting a column of Yes will otherwise
 * conclude that every repository has been given its own intake route. It has not; the organisation has one, and
 * GitHub reports it against every repository that does not override it.
 */
function securityContactJudgement(evidence: AssuranceEvidence): AssuranceJudgement {
  if (evidence.securityPolicy === undefined) {
    return { criterion: AssuranceCriterion.SecurityContact, outcome: AssuranceOutcome.Unknown, detail: "GitHub did not say whether a security policy applies" };
  }
  if (evidence.securityPolicy) {
    return {
      criterion: AssuranceCriterion.SecurityContact,
      outcome: AssuranceOutcome.Met,
      detail: "a security policy applies, usually the organisation's own rather than this repository's"
    };
  }
  return { criterion: AssuranceCriterion.SecurityContact, outcome: AssuranceOutcome.Unmet, detail: "no security policy applies, not even the organisation's" };
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
      detail: "not archived and not pushed to for longer than the policy allows, so it should be archived"
    };
  }
  return { criterion: AssuranceCriterion.Maintained, outcome: AssuranceOutcome.Met, detail: "pushed to recently enough to read as maintained" };
}

/** What one repository is being judged on, beside its collected assurance evidence. */
export interface AssuranceSubject {
  /** `OwnerKind` as the row carries it, or absent where no ownership was attributed. */
  ownerKind?: string;
  /**
   * Whether ANY of the individuals the repository is owned by is still a member of the organisation.
   *
   * ANY RATHER THAN ALL, because the criterion asks for a named owner and one person who still works here is
   * one. A repository with two individual owners, one departed, has somebody to ask.
   *
   * ABSENT MEANS THE MEMBER LIST WAS NOT READ, which grades `Unknown` — never met and never unmet. Meaningless
   * for a team owner, which needs no membership read at all, so a caller resolving `ownerKind` to `team` should
   * leave it absent rather than answering it.
   */
  ownerIsCurrentMember?: boolean;
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
  /** The four criteria read from the collection, each unknown where nothing was collected. */
  const collected = (criterion: AssuranceCriterion, judge: (read: AssuranceEvidence) => AssuranceJudgement): AssuranceJudgement =>
    evidence === undefined ? { criterion, outcome: AssuranceOutcome.Unknown, detail: "nothing has been collected for this repository" } : judge(evidence);

  // IN `AssuranceCriteria` ORDER, which `judgeAssurance` is tested against: the table generates a column per
  // entry in that list and finds each result by name, so a mismatch would not misalign the columns — but a
  // criterion missing here renders as a dash for the whole estate, which is the failure the CODEOWNERS column
  // shipped with.
  return [
    ownerJudgement(subject.ownerKind, subject.ownerIsCurrentMember),
    collected(AssuranceCriterion.AutomatedHygiene, (read) => hygieneJudgement(read.hygiene)),
    collected(AssuranceCriterion.NoCommittedSecrets, secretsJudgement),
    collected(AssuranceCriterion.SecurityContact, securityContactJudgement),
    collected(AssuranceCriterion.Patching, patchingJudgement),
    maintainedJudgement(subject.archived, subject.unmaintained)
  ];
}

/**
 * The one grade the graded criteria add up to.
 *
 * FOUR STEPS, IN THIS ORDER, and each of the three boundaries is a decision:
 *
 *   • `Partial` on any shortfall FIRST, so a repository failing one criterion and unable to answer another is
 *     failing rather than unassessable. Reading it the other way would let an unreadable signal hide a real gap,
 *     which is the same argument `PRECEDENCE` in `assessment.ts` makes for putting red above cannot-assess.
 *   • `Met` only where the count of met criteria reaches `GradedAssuranceCriteria` IN FULL. Counted against the
 *     judgements that happen to be present instead, a list missing a criterion entirely would grade `met` on the
 *     rest — and a criterion nobody judged has not been shown met.
 *   • `Unknown` where NOT ONE of them was readable, which is a different report from some of them being
 *     readable and all of those met. That middle case is `PartlyRead`; see its own note for why it is a grade
 *     rather than a shade of `Partial`.
 *
 * ARITHMETIC ON THE MET COUNT rather than three `some` calls, because two of the three boundaries are about HOW
 * MANY were met and a predicate cannot say four of four.
 */
export function assuranceGrade(judgements: readonly AssuranceJudgement[]): AssuranceGrade {
  const graded = judgements.filter((judgement) => GradedAssuranceCriteria.includes(judgement.criterion));
  if (graded.some((judgement) => judgement.outcome === AssuranceOutcome.Unmet)) {
    return AssuranceGrade.Partial;
  }
  const met = graded.filter((judgement) => judgement.outcome === AssuranceOutcome.Met).length;
  if (met === GradedAssuranceCriteria.length) {
    return AssuranceGrade.Met;
  }
  return met === 0 ? AssuranceGrade.Unknown : AssuranceGrade.PartlyRead;
}

/** How many days old an instant is, floored, or `undefined` where there is no instant. */
export function ageInDays(instant: Date | undefined, reference: Date): number | undefined {
  if (instant === undefined) {
    return undefined;
  }
  return Math.max(0, Math.floor((reference.getTime() - instant.getTime()) / (24 * 60 * 60 * 1000)));
}
