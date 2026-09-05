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
