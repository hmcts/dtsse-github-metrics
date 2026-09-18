/**
 * SonarCloud evidence. Ported from `metrics.domain`'s Sonar models.
 *
 * REACHED FROM TWO DIRECTIONS, and the difference is what most of this file records. `map-sonar` walks the
 * projects a SonarCloud organisation lists and asks GitHub which repository holds each one's analysed commit
 * (`sonar/attribute.ts`), storing every answer — including the ones that say there is no repository. `collect`
 * then walks the estate and asks the reverse question of the map it left (`sonar/resolve.ts`), measuring the
 * projects that resolved.
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
  /**
   * A commit search found the repository that holds the project's analysed revision.
   *
   * NOT A RUNG OF THE REPOSITORY-DIRECTION LADDER: it is how `map-sonar` builds the map that `stored_map` and
   * `declared_confirmed_by_map` then answer from for nothing. It is the only method that spends the scarce
   * commit-search quota to DISCOVER a repository rather than to confirm one somebody proposed.
   */
  AnalysisRevision: "analysis_revision",
  /** No declaration, but the stored map already attributes a project to this repository. */
  StoredMap: "stored_map"
} as const;

export type SonarResolutionMethod = (typeof SonarResolutionMethod)[keyof typeof SonarResolutionMethod];

/**
 * How one attempt to name the repository behind one project ended.
 *
 * FIVE OF THE SIX ARE OBSERVATIONS ABOUT THE PROJECT and one is a failure of this run, and that distinction is
 * the whole point of the enum. A project nobody has ever analysed, and a project whose analysis names a commit
 * no repository holds, have both been ANSWERED — there is nothing more to learn about either until it is
 * analysed again, so each is stored with its reason and the next run pays no quota for it. Only `Failed` means
 * the question was never put, and only `Failed` may make a run partial.
 */
export const SonarMappingOutcome = {
  Resolved: "resolved",
  NoAnalysis: "no_analysis",
  NoRevision: "no_revision",
  UnknownCommit: "unknown_commit",
  OutsideOrganization: "outside_organization",
  Failed: "failed"
} as const;

export type SonarMappingOutcome = (typeof SonarMappingOutcome)[keyof typeof SonarMappingOutcome];

/** Whether one outcome describes the project rather than this run's own failure, and so may be stored. */
export function isSonarObservation(outcome: SonarMappingOutcome): boolean {
  return outcome !== SonarMappingOutcome.Failed;
}

/**
 * One attempt to name the repository behind one SonarCloud project.
 *
 * `mapping` is present exactly when the outcome is `Resolved`, and `detail` exactly when it is not: an
 * unresolved project is stored WITH its reason, so that the next run does not spend the scarcest quota there
 * is asking the same hopeless question again.
 *
 * `analysesTried` counts the commit searches this attempt issued, which is what it cost. It is zero for a
 * project that had no revision to search for, and it is what a run summary needs to report what was spent.
 */
export interface SonarResolutionAttempt {
  projectKey: string;
  outcome: SonarMappingOutcome;
  mapping?: StoredSonarMapping;
  analysesTried: number;
  detail?: string;
}

/**
 * What one collection established about a repository's SonarCloud project, and what it measured.
 *
 * THREE STATES, and keeping them apart is what this block exists for. A `mapping` with `measures` is a
 * repository whose project was found and read; a `mapping` with a `detail` is a project that was found and
 * could not be read; a `detail` alone is the answer that no project analyses this repository. What no state
 * here can say is "nobody looked" — that is the ABSENCE of the block, and `report/contract/sonar.ts` is where
 * the difference is put into words.
 */
export interface SonarState {
  mapping?: StoredSonarMapping;
  measures?: SonarMeasures;
  detail?: string;
}

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
