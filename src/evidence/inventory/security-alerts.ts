import { z } from "zod";
import { AvailabilityReason, GitHubError } from "../domain/availability.ts";
import { AlertSeverity, type OpenAlertCount, SEVERITY_ORDER, type SecurityAlertEvidence } from "../domain/security-alerts.ts";
import type { GitHubClient } from "../github/client.ts";

/**
 * Counting open security alerts. Ported from `metrics.inventory`'s alert half.
 *
 * Three separate endpoints behind three separate permissions, so ONE FAMILY BEING REFUSED SAYS NOTHING ABOUT
 * THE OTHER TWO and must not suppress them.
 */

const FEATURE_NOT_CONFIGURED: ReadonlySet<AvailabilityReason> = new Set([AvailabilityReason.NotFoundOrInaccessible, AvailabilityReason.FeatureDisabled]);

/** GitHub's "you never turned this on" answer, in the words the readers share. */
export const FEATURE_NOT_ENABLED = "is not enabled for this repository";

const dependabotAlertSchema = z.object({ security_advisory: z.object({ severity: z.string().nullish() }).nullish() });
const codeScanningAlertSchema = z.object({ rule: z.object({ security_severity_level: z.string().nullish() }).nullish() });

/** One family's result: the count to report, and the reason to record as a failure if there was one. */
export interface AlertFamilyResult {
  count: OpenAlertCount;
  reason?: AvailabilityReason;
}

/**
 * Counts the gradings GitHub asserted, ignoring anything it did not grade or this tool cannot name.
 *
 * An unrecognised grading is DROPPED rather than mapped onto the nearest known one: GitHub adding a severity
 * should leave the counts it does understand correct, not silently reclassify the new one.
 *
 * Returned in severity order rather than in the order encountered, so two runs of the same data read the
 * same way.
 */
export function countBySeverity(severities: Iterable<string | undefined>): Partial<Record<AlertSeverity, number>> {
  const counts = new Map<AlertSeverity, number>();
  const known = new Set<string>(Object.values(AlertSeverity));
  for (const severity of severities) {
    if (severity === undefined) {
      continue;
    }
    const folded = severity.toLowerCase();
    if (!known.has(folded)) {
      continue;
    }
    const graded = folded as AlertSeverity;
    counts.set(graded, (counts.get(graded) ?? 0) + 1);
  }
  const ordered: Partial<Record<AlertSeverity, number>> = {};
  for (const severity of SEVERITY_ORDER) {
    const count = counts.get(severity);
    if (count !== undefined) {
      ordered[severity] = count;
    }
  }
  return ordered;
}

/**
 * Counts one family's open alerts by severity, or reports why the family could not be read.
 *
 * Only OPEN alerts are requested: this is a current-state source, and how long a resolved alert took to close
 * is a windowed question this deliberately does not answer.
 *
 * A 404 IS NOT A REFUSAL. The caller reads the repository's metadata with this same token before asking for
 * its alerts, so by the time this runs the repository is known to exist and be readable; GitHub answering 404
 * for one family therefore says that family is not turned on. Reporting it as "not found or inaccessible"
 * would assert a permission problem that is not there, and counting it as a collection failure would fail a
 * run for every repository that simply does not use the feature — which is most of them.
 *
 * A 403 GITHUB EXPLAINED AS A DISABLED FEATURE IS READ THE SAME WAY. Across 1850 repositories all 945 of
 * these were feature or plan messages and not one was a genuine refusal. An unrecognised 403 still arrives
 * here as a permission denial and is still recorded as a failure.
 */
export async function openAlerts(
  client: GitHubClient,
  organization: string,
  repository: string,
  family: string,
  severityOf: (record: unknown) => string | undefined
): Promise<AlertFamilyResult> {
  const records: unknown[] = [];
  try {
    // `per_page=100` for GitHub's default of 30. HMCTS repositories routinely carry 50-200 open Dependabot
    // alerts, so the default was paying for three or four pages where one would do.
    for await (const page of client.paginate<unknown>(`/repos/${organization}/${repository}/${family}`, { state: "open", per_page: 100 })) {
      records.push(...page);
    }
  } catch (error) {
    if (!(error instanceof GitHubError)) {
      throw error;
    }
    if (FEATURE_NOT_CONFIGURED.has(error.reason)) {
      return { count: { detail: `${family} ${FEATURE_NOT_ENABLED}` } };
    }
    return { count: { detail: error.message }, reason: error.reason };
  }

  try {
    const severities = records.map((record) => severityOf(record));
    return { count: { open: records.length, bySeverity: countBySeverity(severities) } };
  } catch (error) {
    return {
      count: { detail: `GitHub returned invalid ${family} records: ${error instanceof Error ? error.message : String(error)}` },
      reason: AvailabilityReason.CollectionFailed
    };
  }
}

/**
 * Counts records somebody else fetched FOR THIS REPOSITORY, in the same shape `openAlerts` returns.
 *
 * `undefined` records mean the family was UNREAD rather than empty, and that stays absent rather than becoming a
 * zero — the distinction this whole module is built around. No `reason` is reported with it: the caller that
 * fetched it has already decided the family is not enabled, and raising a second failure for one refusal would
 * double-count it in the exit status.
 */
function countFetched(records: readonly unknown[] | undefined, family: string, severityOf: (record: unknown) => string | undefined): AlertFamilyResult {
  if (records === undefined) {
    return { count: { detail: `${family} ${FEATURE_NOT_ENABLED}` } };
  }
  return countRecords(records, family, severityOf);
}

/** The count, or the reason a set of records this build cannot read produced none. */
function countRecords(records: readonly unknown[], family: string, severityOf: (record: unknown) => string | undefined): AlertFamilyResult {
  try {
    return { count: { open: records.length, bySeverity: countBySeverity(records.map((record) => severityOf(record))) } };
  } catch (error) {
    return {
      count: { detail: `GitHub returned invalid ${family} records: ${error instanceof Error ? error.message : String(error)}` },
      reason: AvailabilityReason.CollectionFailed
    };
  }
}

/**
 * Where one repository stands in an organisation-wide alert response.
 *
 * Carried apart from the records themselves because two families read the same response differently: the
 * Dependabot one hands back records, which the patching age also needs, and the secret-scanning one hands back
 * a count, because the records carry the detected credential and are projected away at the boundary. Both ask
 * the same question of this, and `organisationAnswer` is the single answer to it.
 */
export interface OrganisationPlace {
  /** Whether the organisation-wide read succeeded at all. `false` makes every repository unmeasured. */
  read: boolean;
  /** Whether the response NAMED this repository. An absence is not an answer on its own. */
  named: boolean;
  /**
   * Whether the feature is switched on here, from the signal that reports it — `hasVulnerabilityAlertsEnabled`
   * for Dependabot alerts, `security_and_analysis.secret_scanning` for secret scanning. `undefined` where that
   * signal could not be read, which is a third answer and not a false.
   */
  enabled: boolean | undefined;
}

/**
 * One family's records for one repository, and where they came from.
 *
 * WHERE THEY CAME FROM DECIDES WHAT AN ABSENCE MEANS, which is the only reason this is a discriminated union
 * rather than a list of records. Records fetched for one repository answer for that repository, so an unread
 * family is unread and nothing further is inferred. Records taken out of an organisation-wide response answer
 * for the whole estate at once — and that response names only the repositories the feature is switched on for,
 * so an absence from it is not an answer on its own.
 */
export type AlertSource =
  | { from: "repository"; records: readonly unknown[] | undefined }
  // `place.named` is what says whether the response mentioned this repository, so `records` is simply the ones
  // it carried — empty where it did not name it. Two ways of saying "absent" would be one too many.
  | { from: "organisation"; place: OrganisationPlace; records: readonly unknown[] };

/** What one repository's absence from an organisation-wide response amounts to. */
export const OrganisationAnswer = {
  /** The response named this repository, so its records are the count. */
  Counted: "counted",
  /** It did not name this repository, and the feature is on: genuinely nothing open. */
  Clean: "clean",
  /** It did not name this repository, and the feature is off: nothing scanned, so nothing to count. */
  NotEnabled: "not-enabled",
  /** It did not name this repository and nothing says whether the feature is on. Unmeasured. */
  Unmeasured: "unmeasured",
  /** The organisation-wide read itself failed, so it says nothing about any repository. */
  Unread: "unread"
} as const;

export type OrganisationAnswer = (typeof OrganisationAnswer)[keyof typeof OrganisationAnswer];

/**
 * How one repository's place in an organisation-wide alert response reads. FIVE ANSWERS, and the last three all
 * produce no count for three different reasons.
 *
 * THE ORG-WIDE RESPONSE ONLY NAMES REPOSITORIES THE FEATURE IS ON FOR, so absence cannot be read as clean on
 * its own — that is the whole hazard of this shape. A repository with no scanner would otherwise be reported as
 * having no findings, which is the one wrong answer that reads like good news, and across this estate the
 * enablement signal is false or absent for roughly 890 repositories. So absence is only clean where a
 * separately-collected signal says the feature is switched ON, is "not enabled" where it says OFF, and is
 * UNMEASURED where it says nothing at all.
 */
export function organisationAnswer(place: OrganisationPlace): OrganisationAnswer {
  if (!place.read) {
    return OrganisationAnswer.Unread;
  }
  if (place.named) {
    // Named in the response, whatever the enablement signal says. Something found those, so something scanned.
    return OrganisationAnswer.Counted;
  }
  if (place.enabled === true) {
    return OrganisationAnswer.Clean;
  }
  return place.enabled === false ? OrganisationAnswer.NotEnabled : OrganisationAnswer.Unmeasured;
}

/**
 * The reason there is no count, for each answer that produces none, or `undefined` for the two that do.
 *
 * ONE PLACE FOR THE THREE SENTENCES so that the alert block and the assurance evidence report the same absence
 * in the same words. "Not enabled", "nothing says whether it is enabled" and "the estate's read failed" are
 * three different findings, and a reader given one sentence for all three cannot act on any of them.
 */
export function organisationAbsence(answer: OrganisationAnswer, family: string): string | undefined {
  switch (answer) {
    case OrganisationAnswer.NotEnabled:
      return `${family} ${FEATURE_NOT_ENABLED}`;
    case OrganisationAnswer.Unmeasured:
      return `${family} named no alerts for this repository and nothing says whether it is enabled`;
    case OrganisationAnswer.Unread:
      return `${family} could not be read for the organisation`;
    default:
      return undefined;
  }
}

/**
 * One family's count for one repository, out of an organisation-wide response that hands back RECORDS.
 *
 * NO `reason` ON ANY PATH, on `countFetched`'s rule: the read is one call for the whole estate and its failure
 * is counted once by the caller that made it. Inflating one refusal to 1,889 would swamp the exit status.
 */
export function alertsFromOrganisation(
  source: Extract<AlertSource, { from: "organisation" }>,
  family: string,
  severityOf: (record: unknown) => string | undefined
): AlertFamilyResult {
  const answer = organisationAnswer(source.place);
  const absence = organisationAbsence(answer, family);
  if (absence !== undefined) {
    return { count: { detail: absence } };
  }
  // Clean is a real observation: the response covers every repository the feature is on for, and this one is on
  // and not in it. Counted is the records themselves.
  return answer === OrganisationAnswer.Clean ? { count: { open: 0, bySeverity: {} } } : countRecords(source.records, family, severityOf);
}

/**
 * One family's count for one repository, out of an organisation-wide response that hands back a COUNT.
 *
 * The secret-scanning read is the one that does. Its records carry the detected credential in a `secret` field
 * and are projected to a count and an instant at the boundary, so there is nothing left to count by severity —
 * which GitHub does not report for them anyway.
 */
export function countedAlertsFromOrganisation(place: OrganisationPlace, open: number, family: string): AlertFamilyResult {
  const answer = organisationAnswer(place);
  const absence = organisationAbsence(answer, family);
  if (absence !== undefined) {
    return { count: { detail: absence } };
  }
  return { count: { open, bySeverity: {} } };
}

/**
 * The records to age, or `undefined` where nothing about this repository was measured.
 *
 * `severeAlertAge` needs the records themselves and `severeAlertsRead` needs to know whether there were any to
 * have — so an empty array and `undefined` are different answers here, exactly as `open: 0` and an absent
 * `open` are above. ONE DECISION, TWO CONSUMERS: both read `organisationAnswer`, so the counted block and the
 * patching age can never disagree about whether a repository was measured.
 */
export function organisationRecords(source: Extract<AlertSource, { from: "organisation" }>): readonly unknown[] | undefined {
  switch (organisationAnswer(source.place)) {
    case OrganisationAnswer.Counted:
      return source.records;
    case OrganisationAnswer.Clean:
      return [];
    default:
      return undefined;
  }
}

/** Reads one Dependabot alert's severity from the advisory that carries it. */
export function dependabotSeverity(record: unknown): string | undefined {
  return dependabotAlertSchema.parse(record).security_advisory?.severity ?? undefined;
}

/** Reads one code-scanning alert's security grading, which a non-security rule does not have. */
export function codeScanningSeverity(record: unknown): string | undefined {
  return codeScanningAlertSchema.parse(record).rule?.security_severity_level ?? undefined;
}

/**
 * Grades a secret-scanning alert, which GitHub does not grade and neither may this tool.
 *
 * NOT a placeholder for a lookup nobody has written yet: GitHub's secret-scanning API exposes no severity,
 * and treating every leaked secret as critical would rank a test fixture alongside a live production key.
 */
export function noSeverity(): string | undefined {
  return undefined;
}

/**
 * One family's count from whichever source its records came from.
 *
 * The two branches are `countFetched`'s rule and `alertsFromOrganisation`'s, and keeping the choice here rather
 * than at each call site is what stops a caller pairing organisation-wide records with a per-repository reading
 * of their absence.
 */
export function countFromSource(source: AlertSource, family: string, severityOf: (record: unknown) => string | undefined): AlertFamilyResult {
  return source.from === "repository" ? countFetched(source.records, family, severityOf) : alertsFromOrganisation(source, family, severityOf);
}

/**
 * Every open alert of one family in the ORGANISATION, keyed by repository.
 *
 * ONE PAGINATED READ FOR THE WHOLE ESTATE against one call per repository, which is what
 * `collectOrganisationSecretAlerts` already documents as this shape's motivation and what
 * `security-alerts.ts` was paying 1,889 times over for Dependabot. Verified against live GitHub with the
 * collector App's installation token before this was built: `GET /orgs/hmcts/dependabot/alerts?state=open` is
 * answered 200 with a `Link` header, and every record carries a `repository` naming the one it belongs to.
 *
 * RECORDS ARE NARROWED AT THE BOUNDARY rather than stored whole, and that is the same rule the org-wide secret
 * read follows for a stronger reason than economy: a secret-scanning record carries the detected credential
 * itself. Here the projection also states the contract — `created_at` for the patching age and
 * `security_advisory.severity` for the counts are what the two consumers read, and they read them through the
 * schemas they always did.
 *
 * `undefined` for a failed read, so the caller reports every repository as unmeasured rather than as clean. An
 * empty map would mean "the whole estate has no open alerts", which is the wrong answer that reads like good
 * news.
 */
export async function collectOrganisationDependabotAlerts(client: GitHubClient, organization: string): Promise<Map<string, unknown[]> | undefined> {
  const byRepository = new Map<string, unknown[]>();
  try {
    for await (const page of client.paginate<unknown>(`/orgs/${organization}/dependabot/alerts`, { state: "open", per_page: 100 })) {
      for (const record of page) {
        const parsed = organisationDependabotAlertSchema.safeParse(record);
        // A record this build cannot read is skipped rather than failing the estate, on `openAlerts`' rule: one
        // unparseable alert must not turn every repository's answer into unmeasured. An alert naming no
        // repository is skipped for the same reason — it cannot be attributed to one.
        if (!parsed.success) {
          continue;
        }
        const repository = alertRepositoryName(parsed.data.repository);
        if (repository === undefined) {
          continue;
        }
        byRepository.set(repository, [
          ...(byRepository.get(repository) ?? []),
          { created_at: parsed.data.created_at ?? null, security_advisory: { severity: parsed.data.security_advisory?.severity ?? null } }
        ]);
      }
    }
  } catch (error) {
    console.warn(
      `Could not read the open Dependabot alerts of ${organization}; every repository's answer will be unmeasured: ${error instanceof Error ? error.message : String(error)}`
    );
    return undefined;
  }
  return byRepository;
}

/**
 * One organisation-wide Dependabot alert, projected to the two fields its consumers read.
 *
 * Both `nullish`, because an alert whose advisory or instant GitHub omitted is still an alert: `severeAlertAge`
 * drops an unreadable instant and `countBySeverity` drops an ungraded record, and neither wants the whole
 * record refused for it.
 */
const organisationDependabotAlertSchema = z.object({
  created_at: z.string().nullish(),
  security_advisory: z.object({ severity: z.string().nullish() }).nullish(),
  repository: z.object({ name: z.string().nullish(), full_name: z.string().nullish() }).nullish()
});

/**
 * Which repository one organisation-wide alert belongs to.
 *
 * `name` FIRST, matching the map every caller keys by, with `full_name` as the fallback because that is the
 * field the live check confirmed populated on every record. Reading only the fallback would key the estate by
 * `hmcts/thing` where the cohort is keyed by `thing`, and reading only `name` would drop every record if GitHub
 * ever narrowed the block to the qualified form.
 */
export function alertRepositoryName(repository: { name?: string | null; full_name?: string | null } | null | undefined): string | undefined {
  if (repository == null) {
    return undefined;
  }
  if (repository.name != null && repository.name !== "") {
    return repository.name;
  }
  const qualified = repository.full_name;
  if (qualified == null) {
    return undefined;
  }
  const unqualified = qualified.slice(qualified.lastIndexOf("/") + 1);
  return unqualified === "" ? undefined : unqualified;
}

/**
 * Collects open security alerts from all three families, each failing independently.
 *
 * A refused family is BOTH reported on the block and recorded as a collection failure. The block is what a
 * reader sees; the failure is what the exit status is computed from, and the three alert permissions do not
 * travel with a ruleset migration — so a population that answers for every repository while withholding
 * every alert family must not exit clean as though it were complete.
 *
 * A family that is merely NOT ENABLED is reported on the block and is NOT a failure. Both cases leave `open`
 * unset, because a family nobody can read and a family nobody turned on are equally not zero open alerts.
 *
 * TWO OF THE THREE FAMILIES NO LONGER COST A CALL HERE. Dependabot and secret-scanning alerts are read
 * organisation-wide by the caller — one paginated response each for the whole estate — and handed in. Secret
 * scanning in particular was the contradiction this module carried: `assurance.ts` states the per-repository
 * endpoint "is deliberately not used: 1,880 calls against one" while this file called it once per walked
 * repository, so one fact was read twice at 1,240 times the cost and the two readings could disagree.
 *
 * CODE SCANNING IS STILL READ PER REPOSITORY, and that is a decision rather than an omission. The organisation
 * endpoint exists and works, but it names only repositories the feature is on for — and unlike the other two
 * there is no collected signal saying whether code scanning is on: `hasVulnerabilityAlertsEnabled` answers for
 * Dependabot alerts, `security_and_analysis` answers for secret scanning, and the eight keys live GitHub
 * returns in that block name code scanning nowhere. Absence would therefore be indistinguishable from a
 * repository that never enabled it, and reporting an unmeasured posture as zero open findings is the one thing
 * this module refuses to do. It costs 1,240 calls to keep that distinction honest.
 */
export async function collectSecurityAlerts(
  client: GitHubClient,
  organization: string,
  repository: string,
  /** Where the two families this no longer fetches got their answers. */
  sources: {
    dependabot: AlertSource;
    /** The estate-wide secret-scanning read's place for this repository, and the count it reported there. */
    secretScanning: { place: OrganisationPlace; open: number };
  }
): Promise<{ evidence: SecurityAlertEvidence; failures: { family: string; reason: AvailabilityReason; detail: string }[] }> {
  const families: [string, AlertFamilyResult][] = [
    ["dependabot/alerts", countFromSource(sources.dependabot, "dependabot/alerts", dependabotSeverity)],
    ["code-scanning/alerts", await openAlerts(client, organization, repository, "code-scanning/alerts", codeScanningSeverity)],
    ["secret-scanning/alerts", countedAlertsFromOrganisation(sources.secretScanning.place, sources.secretScanning.open, "secret-scanning/alerts")]
  ];

  const byName = new Map(families);
  return {
    evidence: {
      dependabot: byName.get("dependabot/alerts")?.count ?? {},
      codeScanning: byName.get("code-scanning/alerts")?.count ?? {},
      secretScanning: byName.get("secret-scanning/alerts")?.count ?? {}
    },
    failures: families
      .filter(([, result]) => result.reason !== undefined)
      .map(([family, result]) => ({ family, reason: result.reason as AvailabilityReason, detail: `${family}: ${result.count.detail}` }))
  };
}
