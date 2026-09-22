import type * as contract from "../../../lib/types.ts";
import { ALERT_FAMILIES, AlertScanState, type SecurityAlertDetail, type StoredAlertScan } from "../../domain/alert-detail.ts";
import type { OpenAlertCount, SecurityAlertEvidence } from "../../domain/security-alerts.ts";

/**
 * The three security alert families in the shape the UI declares, which is not the shape they are collected in.
 *
 * IN `report/contract/` for `./observation.ts`'s reason: a pure function of its argument, so the suite that runs on
 * every build holds it rather than the integration run.
 */

/**
 * The three alert families in the shape `src/lib/types.ts` declares.
 *
 * SNAKE_CASE, and all three families always present. The UI reads `alerts.code_scanning` unconditionally — an
 * absent family throws rather than rendering as unmeasured — so the object is always whole and it is each
 * family's own `open` that is absent when nobody could read it. That is the same absent-means-unmeasured rule one
 * level down, and it is the level the UI was written to read it at.
 */
export function reportedAlerts(alerts: SecurityAlertEvidence | undefined): contract.SecurityAlertEvidence {
  return {
    dependabot: reportedFamily(alerts?.dependabot),
    code_scanning: reportedFamily(alerts?.codeScanning),
    secret_scanning: reportedFamily(alerts?.secretScanning)
  };
}

/**
 * One family, in the shape the UI declares.
 *
 * `by_severity` is REQUIRED and snake_case: `tone.ts` reads `by_severity.critical` without a guard, so an absent
 * map throws. An empty object is the honest value for a family with nothing open and for one nobody could read —
 * what separates those two is `open`, which stays absent when it was never measured.
 */
function reportedFamily(family: OpenAlertCount | undefined): contract.OpenAlertCount {
  if (family === undefined) {
    return { by_severity: {}, detail: "the alert families have not been collected" };
  }
  return {
    ...(family.open === undefined ? {} : { open: family.open }),
    by_severity: family.bySeverity ?? {},
    ...(family.detail === undefined ? {} : { detail: family.detail })
  };
}

/**
 * The alert block, or the reason there is none.
 *
 * THROUGH `reportedAlerts`, which is the same translation the estate row makes: the stored evidence is the domain's
 * `codeScanning`/`bySeverity` and the contract declares `code_scanning`/`by_severity`. Handing the stored object
 * straight over type-checks — both are `SecurityAlertEvidence`, one per module — and then `severityDetail` reads
 * `by_severity.critical` off an object that has no such key and throws. Two shapes, one name, in two files.
 *
 * THE SCANS ARE SENT ON BOTH ARMS, including the one that has no counts at all. The two come from different places —
 * the counts off `repository_state.payload`, the scans off `security_alert_scans` — so a repository can hold one and
 * not the other, and a page that drew the individual alerts only beside a count block would show nothing for exactly
 * the repositories whose alerts were collected and whose state was not.
 */
export function securityReport(alerts: SecurityAlertEvidence | undefined, fetched: string, scans: readonly StoredAlertScan[]): contract.SecurityAlertReport {
  const reported = reportedAlertScans(scans);
  if (alerts === undefined) {
    return { detail: "no security alert family was collected for this repository", scans: reported };
  }
  return { fetched_at: fetched, alerts: reportedAlerts(alerts), scans: reported };
}

/** Said for a family `security_alert_scans` holds no row for at all, which is unmeasured and never clean. */
const NOT_SCANNED = "no scan of this family has been recorded for this repository";

/**
 * Each family's scan and the alerts under it, ALWAYS THREE ENTRIES.
 *
 * THE UNIVERSE IS `ALERT_FAMILIES` AND NOT THE STORED ROWS, which is the whole correctness of this translation. A
 * family with no row is what a repository nothing has walked since VIBE-597 looks like, and emitting only the rows
 * that exist would leave that family off the page — where a reader cannot tell a family that was omitted from one
 * that was read and found clean. So a missing row becomes an explicit `unmeasured` carrying `NOT_SCANNED`, and the
 * page has three states to draw rather than three states and a silence.
 *
 * SECRET SCANNING FIRST, in `ALERT_FAMILIES`' own order, which is not the order the counts above are listed in. A
 * leaked credential is the sharpest of the three and has no low-severity form, so it is the family a reader meets
 * first.
 *
 * `detail` IS DROPPED ON A `read` SCAN even where a row carries one. The stored sentence explains an ABSENCE of
 * alerts, and beside a family that was read it would read as a caveat on a measurement that has none — the writer
 * already blanks it for that reason, and this is the second half of the same rule.
 */
export function reportedAlertScans(scans: readonly StoredAlertScan[]): contract.SecurityAlertFamilyScan[] {
  const stored = new Map(scans.map((scan) => [scan.family, scan]));
  return ALERT_FAMILIES.map((family) => {
    const scan = stored.get(family);
    if (scan === undefined) {
      return { family, state: AlertScanState.Unmeasured, detail: NOT_SCANNED, alerts: [] };
    }
    return {
      family,
      state: scan.state,
      ...(scan.state === AlertScanState.Read || scan.detail === undefined ? {} : { detail: scan.detail }),
      observed_at: scan.observedAt.toISOString(),
      // EMITTED WHATEVER THE STATE SAYS, so a row that somehow holds alerts under a state that should have none
      // reports them rather than hiding them. Dropping them to match the state would make the page agree with the
      // state word by suppressing the evidence against it.
      alerts: scan.alerts.map(reportedAlert)
    };
  });
}

/**
 * One alert in the shape `src/lib/types.ts` declares.
 *
 * SNAKE_CASE AND INSTANTS AS STRINGS, which is the pair of translations every other block at this boundary makes:
 * the domain holds `alertType` and a `Date`, the contract declares `alert_type` and an ISO-8601 string.
 *
 * THERE IS NO `repository` FIELD. The block already belongs to one repository, so repeating its name on each of a
 * hundred alerts would be a key the contract has to declare for no reader — and `SecurityAlertDetail` carries it only
 * because a walk of the whole organisation has to attribute each record to something.
 */
function reportedAlert(alert: SecurityAlertDetail): contract.SecurityAlertRecord {
  return {
    family: alert.family,
    number: alert.number,
    ...(alert.alertType === undefined ? {} : { alert_type: alert.alertType }),
    ...(alert.subject === undefined ? {} : { subject: alert.subject }),
    ...(alert.severity === undefined ? {} : { severity: alert.severity }),
    ...(alert.path === undefined ? {} : { path: alert.path }),
    ...(alert.line === undefined ? {} : { line: alert.line }),
    ...(alert.state === undefined ? {} : { state: alert.state }),
    ...(alert.resolution === undefined ? {} : { resolution: alert.resolution }),
    ...(alert.createdAt === undefined ? {} : { created_at: alert.createdAt.toISOString() }),
    ...(alert.resolvedAt === undefined ? {} : { resolved_at: alert.resolvedAt.toISOString() }),
    ...(alert.htmlUrl === undefined ? {} : { html_url: alert.htmlUrl })
  };
}
