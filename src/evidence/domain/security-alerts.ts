/**
 * Open security alerts, by family and severity. Ported from `metrics.domain`.
 */

export const AlertSeverity = {
  Critical: "critical",
  High: "high",
  Medium: "medium",
  Low: "low"
} as const;

export type AlertSeverity = (typeof AlertSeverity)[keyof typeof AlertSeverity];

/** The order a report presents severities in, worst first. */
export const SEVERITY_ORDER: readonly AlertSeverity[] = [AlertSeverity.Critical, AlertSeverity.High, AlertSeverity.Medium, AlertSeverity.Low];

/**
 * One family's open alerts, or the reason there is no count.
 *
 * `open` is ABSENT rather than zero whenever the family could not be read or is not enabled: a family nobody
 * can read and a family nobody turned on are equally not "zero open alerts", and a zero would be a fact
 * nobody observed. `detail` carries which of the two it was.
 */
export interface OpenAlertCount {
  open?: number;
  bySeverity?: Partial<Record<AlertSeverity, number>>;
  detail?: string;
}

/** All three families, each read independently. */
export interface SecurityAlertEvidence {
  dependabot: OpenAlertCount;
  codeScanning: OpenAlertCount;
  secretScanning: OpenAlertCount;
}

/**
 * GitHub's "you never turned this on" answer, in the words every reader of a count shares.
 *
 * HERE RATHER THAN BESIDE THE COLLECTOR THAT WRITES IT, because it is now read as well as written:
 * `alertScanState` in `alert-detail.ts` tells a family that is off from one nobody could read by matching this
 * sentence on the stored `detail`. A collector-local constant would have made that a string literal repeated in
 * two features, which is the form in which the two absences quietly become one.
 */
export const FEATURE_NOT_ENABLED = "is not enabled for this repository";

/** The gradings this tool knows, folded once so every reader of a severity agrees on the vocabulary. */
const KNOWN_SEVERITIES: ReadonlySet<string> = new Set<string>(Object.values(AlertSeverity));

/**
 * The grading GitHub asserted, or nothing where it asserted none or asserted a word this build does not know.
 *
 * AN UNRECOGNISED GRADING IS DROPPED rather than mapped onto the nearest known one: GitHub adding a severity
 * should leave the gradings this tool does understand correct, not silently reclassify the new one as the closest
 * thing to hand.
 */
export function gradedSeverity(value: string | null | undefined): AlertSeverity | undefined {
  if (value == null) {
    return undefined;
  }
  const folded = value.toLowerCase();
  return KNOWN_SEVERITIES.has(folded) ? (folded as AlertSeverity) : undefined;
}
