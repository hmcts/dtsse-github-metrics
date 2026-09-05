/**
 * SonarCloud evidence. Ported from `metrics.domain`'s Sonar models.
 */

export const SONAR_RATING_LETTERS = ["A", "B", "C", "D", "E"] as const;

/**
 * One SonarCloud rating as the number it was reported as, and the letter it names.
 *
 * SonarCloud reports a rating as `1.0` to `5.0` and every human reads it as `A` to `E`, so the number is
 * stored — it is what the API said — and the letter is derived for rendering.
 */
export interface SonarRating {
  value: number;
}

/**
 * The `A` to `E` letter one rating names, or `undefined` when it is off the scale.
 *
 * Absent for any value outside the scale rather than clamped to an end of it: A RATING THIS BUILD DOES NOT
 * UNDERSTAND MUST NOT BE REPORTED AS THE BEST ONE, which is what defaulting to `A` would do.
 */
export function ratingLetter(rating: SonarRating): string | undefined {
  if (!Number.isInteger(rating.value) || rating.value < 1 || rating.value > SONAR_RATING_LETTERS.length) {
    return undefined;
  }
  return SONAR_RATING_LETTERS[rating.value - 1];
}

/**
 * How one SonarCloud quality gate stands, using only the levels SonarCloud reports.
 *
 * `NONE` is SonarCloud's own value for a project that has been created and never analysed — 14 of one
 * organisation's 289 were in that state. It is a THIRD ANSWER and not a failure: the project exists, and
 * nothing has been measured against it.
 */
export const SonarGateLevel = {
  Ok: "OK",
  Error: "ERROR",
  None: "NONE"
} as const;

export type SonarGateLevel = (typeof SonarGateLevel)[keyof typeof SonarGateLevel];

/** One condition behind a quality gate's verdict. */
export interface SonarGateCondition {
  metric: string;
  level: string;
  comparator?: string;
  errorThreshold?: string;
  actual?: string;
}

export interface SonarQualityGate {
  level: SonarGateLevel;
  conditions?: SonarGateCondition[];
}

/**
 * One project's measures, with every absence kept an absence.
 *
 * NEVER ZERO for an unmeasured value. SonarCloud reports every measure as a string, so a value it did not
 * send and a value that did not parse are both "not measured" — and a rendered `0.0%` would be a claim about
 * the code rather than about the measurement.
 */
export interface SonarMeasures {
  projectKey: string;
  analysisAt?: Date;
  gate?: SonarQualityGate;
  coverage?: number;
  duplicatedLinesDensity?: number;
  linesOfCode?: number;
  violations?: number;
  reliabilityIssues?: number;
  maintainabilityIssues?: number;
  securityIssues?: number;
  reliabilityRating?: SonarRating;
  maintainabilityRating?: SonarRating;
  securityRating?: SonarRating;
}

/**
 * How a project key was attributed to a repository.
 *
 * The ladder, in the order it is climbed. NAME MATCHING IS ABSENT ON PURPOSE: it was measured and rejected,
 * being wrong for 6 of 70 projects — close enough to look right and wrong often enough to mislead.
 */
export const SonarResolutionMethod = {
  /** An explicit `sonar_projects:` override in the configuration. The answer of last resort, and the first tried. */
  Configured: "configured",
  /** The repository declares a key, and the stored map agrees that key analyses this repository. */
  DeclaredConfirmedByMap: "declared_confirmed_by_map",
  /** The repository declares a key, and a commit search confirms the analysed revision is one of ours. */
  DeclaredConfirmedByCommit: "declared_confirmed_by_commit",
  /** No declaration, but the stored map already attributes a project to this repository. */
  StoredMap: "stored_map"
} as const;

export type SonarResolutionMethod = (typeof SonarResolutionMethod)[keyof typeof SonarResolutionMethod];

/** What one repository declares in its `sonar-project.properties`. */
export interface SonarDeclaration {
  projectKey?: string;
  organization?: string;
}

/**
 * One stored `project → repository` attribution.
 *
 * A row with no `repository` and a `detail` is a REMEMBERED NEGATIVE: somebody paid the quota to discover
 * that this project could not be attributed, and storing the answer is what stops the next run paying again.
 */
export interface StoredSonarMapping {
  projectKey: string;
  repository?: string;
  analysisAt?: Date;
  revision?: string;
  method?: SonarResolutionMethod;
  resolvedAt: Date;
  detail?: string;
}
