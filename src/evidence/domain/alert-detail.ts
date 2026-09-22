import { type AlertSeverity, FEATURE_NOT_ENABLED, type OpenAlertCount } from "./security-alerts.ts";

/**
 * ONE ALERT, rather than a count of them.
 *
 * `security-alerts.ts` beside this file answers "how many are open"; this answers "which ones". The two are
 * separate because they are collected differently and cost differently — a count rides on a response the
 * collector already has, and the identity of each alert needs the whole record kept rather than folded.
 *
 * NOTHING HERE MAY CARRY A SECRET VALUE. The secret-scanning API returns the detected credential in a `secret`
 * field, and this shape has no field it could be put in: `alerts/records.ts` drops it inside the response schema,
 * so it is gone before a `SecurityAlertDetail` exists. That ordering is the guarantee — a type with no home for a
 * credential cannot be refactored into one by accident, where a filter applied afterwards can be lost.
 */

/**
 * The three families, spelled as `src/lib/types.ts` spells them.
 *
 * DELIBERATELY NOT THE API PATHS. `inventory/security-alerts.ts` names families by endpoint — `dependabot/alerts`
 * — because what it produces is a log line about a call it made. What this produces is a stored column read by a
 * page, so it uses the contract's vocabulary and VIBE-598 needs no translation table to render it.
 */
export const AlertFamily = {
  Dependabot: "dependabot",
  CodeScanning: "code-scanning",
  SecretScanning: "secret-scanning"
} as const;

export type AlertFamily = (typeof AlertFamily)[keyof typeof AlertFamily];

/** Every family, in the order a report presents them. */
export const ALERT_FAMILIES: readonly AlertFamily[] = [AlertFamily.SecretScanning, AlertFamily.Dependabot, AlertFamily.CodeScanning];

/**
 * Whether anybody looked at one family for one repository, WHICH IS NOT THE SAME QUESTION AS WHAT THEY FOUND.
 *
 * THREE STATES AND NOT TWO, for the reason `OpenAlertCount` keeps `open` absent rather than zero: a repository
 * with no scanner and a repository nobody may read are both "no alerts stored", and neither is "no alerts". A
 * reader given two states reads every refusal as good news, and across this estate the refusals are the majority
 * of the two private visibilities — VIBE-590 measured the App installation refused on 39% of internal and 60% of
 * private repositories.
 *
 * So a repository's alerts are only ever read through its scan row: `Read` with no alerts beside it is a measured
 * clean, and the other two states mean the absence of rows says nothing at all. That is `cve_scans`' structure
 * applied to the same problem — the row that says somebody looked is separate from the rows describing what they
 * saw, so no query can manufacture one from the other.
 */
export const AlertScanState = {
  /** The family was read for this repository. The stored alerts are all of them, and none of them is none. */
  Read: "read",
  /** The family is switched off here, so there was nothing to scan and nothing to read. */
  NotEnabled: "not-enabled",
  /** Nobody could look: the walk was refused, or no signal says whether the family is even on. NEVER "no alerts". */
  Unmeasured: "unmeasured"
} as const;

export type AlertScanState = (typeof AlertScanState)[keyof typeof AlertScanState];

/**
 * One alert, projected to what a reader needs and nothing more.
 *
 * EVERY FIELD BUT THE IDENTITY IS OPTIONAL, and that is the absent-versus-zero rule applied to a record rather
 * than to a figure. GitHub populates all of these in practice — verified against live responses for all three
 * families — but an alert whose `path` this build could not read is still an alert, and refusing the record for it
 * would turn a leaked credential into silence. Only `(repository, family, number)` is required, because without
 * those three there is nothing to store the alert against.
 */
export interface SecurityAlertDetail {
  /** The repository the alert belongs to, as GitHub spelled it in the response. */
  repository: string;
  family: AlertFamily;
  /** GitHub's own alert number, which is unique within one repository and one family. */
  number: number;
  /**
   * What KIND of thing this is: `secret_type` for secret scanning, the advisory's `ghsa_id` for Dependabot, the
   * rule's `id` for code scanning.
   *
   * For secret scanning this is the whole of what may be stored about the finding itself — `azure_storage_account_key`
   * beside a path tells a reader what to go and revoke, and the credential itself is never read out of the response.
   */
  alertType?: string;
  /** What the alert is ABOUT where the type does not say: the vulnerable package, for Dependabot. */
  subject?: string;
  /** GitHub's grading, where GitHub grades this family. Secret scanning has none — see `noSeverity`. */
  severity?: AlertSeverity;
  /** Where in the repository, where the API gives a location. Dependabot gives a manifest path and no line. */
  path?: string;
  line?: number;
  /** GitHub's own state word — `open`, `resolved`, `dismissed`, `fixed`, `auto_dismissed`. */
  state?: string;
  /** GitHub's own resolution word, present only on a resolved alert. Never this tool's paraphrase of one. */
  resolution?: string;
  createdAt?: Date;
  resolvedAt?: Date;
  /** So a page can link to the alert on GitHub rather than reproducing it. */
  htmlUrl?: string;
}

/** GitHub's own word for an alert nobody has dealt with, which is the only state a reader has to act on. */
const OPEN = "open";

/**
 * The order one family's alerts are reported in: open first, longest-exposed first inside that.
 *
 * NOT GITHUB'S OWN ORDER, which is newest-first by alert number and puts the credential leaked this morning above
 * the one that has been public for 900 days. The oldest open alert is the one the `patching` criterion's sentence is
 * about, so it is the one a reader should meet first.
 *
 * A COMPARATOR AND NOT A BARE `sort()`, per CONTRIBUTING.md: the three keys are a state word, an instant and a
 * number, and sorting any of them as a default string is the failure that rule is named for. An alert with no
 * readable `createdAt` sorts after every dated one rather than at the top — an unknown age is not evidence of a long
 * exposure — and the alert number is the final tie-break so two runs over unchanged alerts produce one order.
 */
export function byExposure(left: SecurityAlertDetail, right: SecurityAlertDetail): number {
  const open = Number(right.state === OPEN) - Number(left.state === OPEN);
  if (open !== 0) {
    return open;
  }
  const dated = Number(left.createdAt === undefined) - Number(right.createdAt === undefined);
  if (dated !== 0) {
    return dated;
  }
  // Both dated or both undated by now, so this subtraction cannot produce the `NaN` that `Infinity - Infinity`
  // would — a comparator returning `NaN` leaves `sort` free to produce any order at all.
  const age = (left.createdAt?.getTime() ?? 0) - (right.createdAt?.getTime() ?? 0);
  return age === 0 ? left.number - right.number : age;
}

/**
 * One family's stored scan for one repository, as a reader finds it rather than as a walk produced it.
 *
 * THE READ SIDE OF `AlertScan`, and separate from it because the two carry different facts. A walk's scan names the
 * repository it is about and has no instant — the run supplies one for every row it writes; a stored scan is already
 * keyed by repository and carries the `observed_at` the row was written with, which is what lets a page say WHEN a
 * family was last looked at rather than only what was found.
 */
export interface StoredAlertScan {
  family: AlertFamily;
  state: AlertScanState;
  /** Why there are no alerts, for the two states that have none for a reason. */
  detail?: string;
  observedAt: Date;
  /** The alerts, meaningful ONLY beside a `Read` state, in `byExposure` order. */
  alerts: SecurityAlertDetail[];
}

/**
 * What one repository's stored COUNT for a family says about whether anybody could read it.
 *
 * THE COUNT BLOCK IS WHERE THE THREE-STATE ANSWER ALREADY LIVES, and re-deriving it would mean paying for it
 * twice. `collect` establishes it from signals the alert walk does not have and could not cheaply get: the
 * GraphQL `hasVulnerabilityAlertsEnabled` for Dependabot (38 aliased documents), `security_and_analysis` off the
 * estate listing for secret scanning (19 pages), and for code scanning a per-repository call for all 1,240 active
 * repositories, because — as `collectSecurityAlerts` records — no collected signal reports whether code scanning
 * is on. Reading the answer it already reached costs one query.
 *
 * `open` IS THE PRIMARY SIGNAL AND THE SENTENCE IS ONLY CONSULTED WHEN IT IS ABSENT. A number means the family was
 * read, whatever else the block says. The two absences then have to be told apart, and the block records the
 * difference as prose — so `FEATURE_NOT_ENABLED` is matched against, which is exactly why that sentence is a shared
 * constant rather than written out at each of the three places that produce it.
 */
export function alertScanState(count: OpenAlertCount | undefined): AlertScanState {
  if (count?.open !== undefined) {
    return AlertScanState.Read;
  }
  if (count?.detail?.endsWith(FEATURE_NOT_ENABLED) === true) {
    return AlertScanState.NotEnabled;
  }
  return AlertScanState.Unmeasured;
}
