import type { AlertScan, StoredCounts } from "../alerts/collect.ts";
import { type AlertFamily, type AlertScanState, byExposure, type SecurityAlertDetail, type StoredAlertScan } from "../domain/alert-detail.ts";
import type { SecurityAlertEvidence } from "../domain/security-alerts.ts";
import { prisma } from "./prisma.ts";
import { StorageError } from "./storage-error.ts";

/**
 * Where the individual security alerts are kept.
 *
 * THE ABSENT-VERSUS-ZERO RULE IS STRUCTURAL HERE AND NOT A CONVENTION TO REMEMBER, exactly as it is in `cve.ts`:
 * `security_alert_scans` records that a family was read and `security_alerts` records what was found, so a scan row
 * with no alerts is a measured clean and no scan row at all is a repository nobody looked at. A reader that joins
 * through the scan cannot manufacture one answer from the other, because the row that would have to exist does not.
 */

/** What one call to `recordSecurityAlerts` changed, so a run reports it rather than claiming a number. */
export interface AlertWriteOutcome {
  scans: number;
  alerts: number;
}

/**
 * Replaces each repository-family's scan row and its alerts with this walk's.
 *
 * ONE TRANSACTION PER SCAN, which is `recordCveScans`' choice of unit and made for its reason: a scan row and the
 * alerts hanging off it have to land together, or a reader sees alerts with no scan to read them through, or a scan
 * whose alerts are half replaced. Widening the unit to "everything this run found" would be a worse thing to
 * half-apply — this run writes one row per cohort repository per family, which is about 5,600 of them.
 *
 * THE ALERTS ARE REPLACED WHOLESALE AND NOT MERGED. An alert that has been fixed is simply absent from the next
 * walk, so merging would leave it stored and reported as open for ever. `deleteMany` then `createMany` is what makes
 * the stored set the walk's set — and because the scan row is upserted on its own key and the alerts are keyed by
 * GitHub's own alert number, RE-RUNNING THE COLLECTION OVER UNCHANGED ALERTS REWRITES THE SAME ROWS AND ADDS NONE.
 * That is the acceptance criterion about re-running, enforced by the statements rather than by a caller being careful.
 *
 * A SCAN WITH NO ALERTS STILL WRITES ITS ROW, and that is the case the whole table exists for. Skipping it as an
 * empty write would leave a clean repository indistinguishable from one nobody read.
 */
export async function recordSecurityAlerts(organization: string, scans: readonly AlertScan[], observedAt: Date): Promise<AlertWriteOutcome> {
  let written = 0;
  let alerts = 0;
  for (const scan of scans) {
    const key = { organization, repository: scan.repository, family: scan.family };
    try {
      await prisma.$transaction(async (tx) => {
        await tx.securityAlertScan.upsert({
          where: { organization_repository_family: key },
          create: { ...key, state: scan.state, detail: scan.detail ?? null, observedAt },
          // The detail is written even when absent, so a family that WAS unreadable and now reads clean does not
          // keep yesterday's sentence beside today's answer.
          update: { state: scan.state, detail: scan.detail ?? null, observedAt }
        });
        await tx.securityAlert.deleteMany({ where: key });
        await tx.securityAlert.createMany({
          data: scan.alerts.map((alert) => ({
            ...key,
            alertNumber: alert.number,
            alertType: alert.alertType ?? null,
            subject: alert.subject ?? null,
            severity: alert.severity ?? null,
            path: alert.path ?? null,
            line: alert.line ?? null,
            state: alert.state ?? null,
            resolution: alert.resolution ?? null,
            createdAt: alert.createdAt ?? null,
            resolvedAt: alert.resolvedAt ?? null,
            htmlUrl: alert.htmlUrl ?? null
          }))
        });
      });
      written += 1;
      alerts += scan.alerts.length;
    } catch (error) {
      // NAMED WITHOUT THE ALERTS. The message carries the repository and the family and never a record, because one
      // of the three families' records is the family whose records must not reach a log at all.
      throw new StorageError(`could not record the ${scan.family} alerts for ${scan.repository}`, error);
    }
  }
  return { scans: written, alerts };
}

/**
 * One repository's scans and the alerts hanging off each, for its own page.
 *
 * READ THROUGH THE SCAN AND NOT OVER THE ALERTS, which is the structure this pair of tables exists for. Querying
 * `security_alerts` alone would hand back an empty list for a family that is off, for a family nobody may read and
 * for a family read and found clean — one answer for three questions, and the wrong one two times in three. The scan
 * row is what says which, so it is the row that is selected and the alerts ride it.
 *
 * ONE QUERY AND NOT FOUR. Prisma's `include` issues a second statement for the alerts and joins them in the client,
 * so this is two round trips for however many families a repository has rows for, rather than one per family — which
 * is what keeps it affordable on a per-page path beside the fact reads `repositoryEvidence` already makes.
 *
 * KEYED BY GITHUB'S OWN CASING AND NOT CASEFOLDED. `resolveAlertScans` writes one row per COHORT repository, spelled
 * as the cohort spells it, and this is called with the name the same cohort answered — so an exact match is right
 * here where `storedAlertCounts` below has to fold, because that one joins a walk's key to a payload's.
 */
export async function storedRepositoryAlertScans(organization: string, repository: string): Promise<StoredAlertScan[]> {
  try {
    const rows = await prisma.securityAlertScan.findMany({
      where: { organization, repository },
      include: { alerts: true }
    });
    return rows.map((row) => ({
      family: row.family as AlertFamily,
      state: row.state as AlertScanState,
      ...(row.detail === null ? {} : { detail: row.detail }),
      observedAt: row.observedAt,
      // Sorted HERE rather than in the statement: the order is "open first, longest-exposed first", which is three
      // keys over a state word, an instant and a number — `ORDER BY state` would order it alphabetically and put
      // `auto_dismissed` above `open`. `byExposure` states the rule once and a unit case can reach it.
      alerts: row.alerts.map(storedAlert).sort(byExposure)
    }));
  } catch (error) {
    // NAMED WITHOUT THE ALERTS, for `recordSecurityAlerts`' reason: one of the three families' records is the family
    // whose records must not reach a log.
    throw new StorageError(`could not read the stored security alerts for ${repository}`, error);
  }
}

/** One stored row as the domain holds it, with every `null` column back to the absence it stands for. */
function storedAlert(row: {
  repository: string;
  family: string;
  alertNumber: number;
  alertType: string | null;
  subject: string | null;
  severity: string | null;
  path: string | null;
  line: number | null;
  state: string | null;
  resolution: string | null;
  createdAt: Date | null;
  resolvedAt: Date | null;
  htmlUrl: string | null;
}): SecurityAlertDetail {
  return {
    repository: row.repository,
    family: row.family as AlertFamily,
    number: row.alertNumber,
    ...present("alertType", row.alertType),
    ...present("subject", row.subject),
    ...present("severity", row.severity as SecurityAlertDetail["severity"]),
    ...present("path", row.path),
    ...present("line", row.line),
    ...present("state", row.state),
    ...present("resolution", row.resolution),
    ...present("createdAt", row.createdAt),
    ...present("resolvedAt", row.resolvedAt),
    ...present("htmlUrl", row.htmlUrl)
  };
}

/**
 * One column as a key that is either there or absent, never present holding `null`.
 *
 * `stripAbsent` would catch a `null` at the report boundary, but this is the boundary it enters at and a `null`
 * reaching the domain means every reader between here and there has to handle a third value the type does not
 * declare. Eleven columns spelled out one at a time is how the last two of them came to be forgotten.
 */
function present<K extends string, V>(key: K, value: V | null): Partial<Record<K, V>> {
  return value === null ? {} : ({ [key]: value } as Record<K, V>);
}

/**
 * Every repository's stored alert COUNTS, casefolded, for the three-state fallback the walk cannot answer alone.
 *
 * READS THE COUNTS AND NOT THE WHOLE STATE. `storedRepositoryStates` in `facts.ts` hands back every payload, which
 * for 1,890 repositories is tens of MB of jsonb carrying merge gates, assurance blocks and Sonar states this has no
 * use for. Postgres projects the one member out instead, so what crosses the wire is three small objects per
 * repository — the same reasoning `pull_request_facts` records for not storing a body it would only project away.
 *
 * A REPOSITORY WITH NO ROW IS ABSENT FROM THIS MAP and not present with an empty block, because `alertScanState`
 * grades a missing block as unmeasured and a present-but-empty one identically — but only the first is honest about
 * a repository `collect` has never reached.
 */
export async function storedAlertCounts(organization: string): Promise<StoredCounts> {
  try {
    const rows = await prisma.$queryRaw<{ repository: string; security_alerts: unknown }[]>`
      SELECT repository, payload -> 'securityAlerts' AS security_alerts
      FROM repository_state
      WHERE organization = ${organization}
    `;
    const counts = new Map<string, SecurityAlertEvidence | undefined>();
    for (const row of rows) {
      counts.set(row.repository.toLowerCase(), (row.security_alerts ?? undefined) as SecurityAlertEvidence | undefined);
    }
    return counts;
  } catch (error) {
    throw new StorageError("could not read the stored security alert counts", error);
  }
}
