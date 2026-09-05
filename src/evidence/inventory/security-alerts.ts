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
    for await (const page of client.paginate<unknown>(`/repos/${organization}/${repository}/${family}`, { state: "open" })) {
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
 * Collects open security alerts from all three families, each failing independently.
 *
 * A refused family is BOTH reported on the block and recorded as a collection failure. The block is what a
 * reader sees; the failure is what the exit status is computed from, and the three alert permissions do not
 * travel with a ruleset migration — so a population that answers for every repository while withholding
 * every alert family must not exit clean as though it were complete.
 *
 * A family that is merely NOT ENABLED is reported on the block and is NOT a failure. Both cases leave `open`
 * unset, because a family nobody can read and a family nobody turned on are equally not zero open alerts.
 */
export async function collectSecurityAlerts(
  client: GitHubClient,
  organization: string,
  repository: string
): Promise<{ evidence: SecurityAlertEvidence; failures: { family: string; reason: AvailabilityReason; detail: string }[] }> {
  const families: [string, AlertFamilyResult][] = [
    ["dependabot/alerts", await openAlerts(client, organization, repository, "dependabot/alerts", dependabotSeverity)],
    ["code-scanning/alerts", await openAlerts(client, organization, repository, "code-scanning/alerts", codeScanningSeverity)],
    ["secret-scanning/alerts", await openAlerts(client, organization, repository, "secret-scanning/alerts", noSeverity)]
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
