import type * as contract from "../../../lib/types.ts";
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
 */
export function securityReport(alerts: SecurityAlertEvidence | undefined, fetched: string): contract.SecurityAlertReport {
  if (alerts === undefined) {
    return { detail: "no security alert family was collected for this repository" };
  }
  return { fetched_at: fetched, alerts: reportedAlerts(alerts) };
}
