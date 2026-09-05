/**
 * The readiness verdict and its supporting conditions. Ported from `metrics.domain`.
 */

export const ReadinessLabel = {
  Green: "green",
  Amber: "amber",
  Red: "red",
  CannotAssess: "cannot_assess"
} as const;

export type ReadinessLabel = (typeof ReadinessLabel)[keyof typeof ReadinessLabel];

/**
 * Where a window's unreviewed substantial merging sat against the allowance it was judged by.
 *
 * `within` is neither a pass nor a failure: it is the allowance forgiving what it was configured to
 * forgive, which is a different fact from nothing having merged unreviewed at all — so the three words are
 * three answers, not a scale of two.
 */
export const UnreviewedSubstantialOutcome = {
  None: "none",
  Within: "within",
  Above: "above"
} as const;

export type UnreviewedSubstantialOutcome = (typeof UnreviewedSubstantialOutcome)[keyof typeof UnreviewedSubstantialOutcome];

/**
 * One condition the policy checked.
 *
 * `label` is present only on a blocking condition — it is what that condition imposes. `informational`
 * marks a condition the policy reported WITHOUT judging: the three neutral merge-gate rules and a
 * sufficient cohort. A reader meeting one under `clear` would otherwise have to work out why it is there.
 *
 * Both are optional rather than nullable because the report omits absent fields, and the UI reads them
 * with `== null`.
 */
export interface ReadinessCondition {
  condition: string;
  detail: string;
  label?: ReadinessLabel;
  informational?: boolean;
}

/**
 * One repository's verdict, with everything that was examined rather than only what failed.
 *
 * A green label is as auditable as a red one, which is the point of reporting all three sections.
 */
export interface ReadinessAssessment {
  label: ReadinessLabel;
  blocking: ReadinessCondition[];
  caution: ReadinessCondition[];
  clear: ReadinessCondition[];
}
