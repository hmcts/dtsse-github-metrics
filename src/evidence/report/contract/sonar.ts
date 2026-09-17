import type * as contract from "../../../lib/types.ts";

/**
 * What a collection stored about a repository's SonarCloud project, in the shape the UI declares.
 *
 * IN `report/contract/` for `./observation.ts`'s reason: a pure function of its argument, so the suite that runs
 * on every build holds it rather than the integration run.
 *
 * THREE ANSWERS AND NOT TWO, which is the whole reason this module exists. Until it did, every repository in the
 * estate read "no SonarCloud project is mapped for this repository" — a sentence about the repository, emitted
 * by a service that had never looked at SonarCloud at all. The three are:
 *
 *   • NOBODY LOOKED — no `sonar` block in the stored payload. Either this repository's state was collected before
 *     the layer was wired, or `map-sonar` has never built the map and `collect` said so. Never a claim that the
 *     repository has no project.
 *   • NO PROJECT — a block carrying a reason. The mapping ran, and nothing in the SonarCloud organisation
 *     analyses this repository, or the project it named could no longer be read.
 *   • MEASURED — a block carrying a mapping, and the figures where they were read.
 *
 * It is the absent-versus-zero contract applied to a whole section: absent means unmeasured, and a stated reason
 * means measured and there is nothing there.
 */

/** What the payload holds, with every instant as the string a `jsonb` round trip turned it into. */
interface StoredMapping {
  projectKey?: unknown;
  repository?: unknown;
  method?: unknown;
  analysisAt?: unknown;
  revision?: unknown;
}

interface StoredRating {
  value?: unknown;
}

interface StoredGateCondition {
  metric?: unknown;
  level?: unknown;
  comparator?: unknown;
  errorThreshold?: unknown;
  actual?: unknown;
}

interface StoredGate {
  level?: unknown;
  conditions?: unknown;
}

interface StoredMeasures {
  projectKey?: unknown;
  analysisAt?: unknown;
  gate?: unknown;
  coverage?: unknown;
  duplicatedLinesDensity?: unknown;
  linesOfCode?: unknown;
  violations?: unknown;
  reliabilityIssues?: unknown;
  maintainabilityIssues?: unknown;
  securityIssues?: unknown;
  reliabilityRating?: unknown;
  maintainabilityRating?: unknown;
  securityRating?: unknown;
}

interface StoredSonar {
  mapping?: StoredMapping;
  measures?: StoredMeasures;
  detail?: unknown;
}

/** No collection has asked SonarCloud anything about this repository, which is not the same as it having no project. */
export const SONAR_UNATTEMPTED_DETAIL = "no collection has looked for a SonarCloud project for this repository";

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** A stored number, and never a `0` invented for one that is absent or arrived unreadable. */
function figure(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function count(value: unknown): number | undefined {
  const number = figure(value);
  return number === undefined ? undefined : Math.trunc(number);
}

function rating(value: unknown): contract.SonarRating | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const number = figure((value as StoredRating).value);
  return number === undefined ? undefined : { value: number };
}

/** One `alert_status` level, or `undefined` for anything this build does not know. See `domain/sonar.ts`. */
function level(value: unknown): contract.SonarGateLevel | undefined {
  return value === "OK" || value === "ERROR" || value === "NONE" ? value : undefined;
}

/**
 * The gate in the shape the UI declares, or nothing where no level was stored.
 *
 * `conditions` is required on the contract and optional in the domain, so a gate whose `quality_gate_details`
 * did not parse — which degrades to the bare verdict, per `sonar/measures.ts` — carries an empty list. Nothing
 * renders the conditions; what is rendered is the level, and that is the one field that must not be invented.
 */
function gate(value: unknown): contract.SonarQualityGate | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const stored = value as StoredGate;
  const verdict = level(stored.level);
  if (verdict === undefined) {
    return undefined;
  }
  const conditions = Array.isArray(stored.conditions) ? stored.conditions : [];
  return {
    level: verdict,
    conditions: conditions.map((condition) => {
      const entry = (typeof condition === "object" && condition !== null ? condition : {}) as StoredGateCondition;
      return {
        metric: text(entry.metric) ?? "",
        level: text(entry.level) ?? "",
        comparator: text(entry.comparator) ?? "",
        ...(text(entry.errorThreshold) === undefined ? {} : { threshold: text(entry.errorThreshold) as string }),
        ...(text(entry.actual) === undefined ? {} : { actual: text(entry.actual) as string })
      };
    })
  };
}

/**
 * The measures in the shape the UI declares, which is the same measures under different names.
 *
 * EVERY FIELD IS RENAMED, and the pair that would survive a careless copy is `duplicatedLinesDensity` against
 * `duplicated_lines_density` and `linesOfCode` against `lines_of_code`: `sonarRows` reads the snake_case ones and
 * would render a dash for a figure the collection has, which is the one thing an unmeasured value is meant to say.
 */
function measures(value: StoredMeasures): contract.SonarMeasures | undefined {
  const projectKey = text(value.projectKey);
  if (projectKey === undefined) {
    return undefined;
  }
  const optional = <T>(key: keyof contract.SonarMeasures, measure: T | undefined) => (measure === undefined ? {} : { [key]: measure });
  return {
    project_key: projectKey,
    ...optional("analysis_at", text(value.analysisAt)),
    ...optional("gate", gate(value.gate)),
    ...optional("coverage", figure(value.coverage)),
    ...optional("duplicated_lines_density", figure(value.duplicatedLinesDensity)),
    ...optional("lines_of_code", count(value.linesOfCode)),
    ...optional("violations", count(value.violations)),
    ...optional("reliability_issues", count(value.reliabilityIssues)),
    ...optional("maintainability_issues", count(value.maintainabilityIssues)),
    ...optional("security_issues", count(value.securityIssues)),
    ...optional("reliability_rating", rating(value.reliabilityRating)),
    ...optional("maintainability_rating", rating(value.maintainabilityRating)),
    ...optional("security_rating", rating(value.securityRating))
  };
}

/**
 * The mapping in the shape the UI declares, or nothing where the stored one names no project and repository.
 *
 * BOTH NAMES ARE REQUIRED on the contract, and a stored mapping always carries both — a row that names no
 * repository is a remembered negative, and `collect` reports one as a reason rather than as a mapping. A
 * half-written one is dropped here instead of being rendered as a project attributed to nothing.
 */
function mapping(value: StoredMapping | undefined): contract.SonarProjectMapping | undefined {
  if (value === undefined) {
    return undefined;
  }
  const projectKey = text(value.projectKey);
  const repository = text(value.repository);
  if (projectKey === undefined || repository === undefined) {
    return undefined;
  }
  return {
    project_key: projectKey,
    repository,
    method: text(value.method) ?? "",
    ...(text(value.analysisAt) === undefined ? {} : { analysis_at: text(value.analysisAt) as string }),
    ...(text(value.revision) === undefined ? {} : { revision: text(value.revision) as string })
  };
}

/**
 * The SonarCloud section of one repository's page, from the state a collection stored.
 *
 * `fetched_at` is carried only where something was actually read, because the page renders it as "read <when>"
 * beside the section heading — and a "read" instant above "nobody has looked" is the contradiction this whole
 * module exists to avoid.
 */
export function storedSonar(payload: unknown, fetched: string): contract.SonarReport {
  if (typeof payload !== "object" || payload === null) {
    return { detail: "nothing has been collected for this repository" };
  }
  const stored = (payload as { sonar?: unknown }).sonar;
  if (typeof stored !== "object" || stored === null) {
    return { detail: SONAR_UNATTEMPTED_DETAIL };
  }
  const state = stored as StoredSonar;
  const attributed = mapping(state.mapping);
  if (attributed === undefined) {
    return { fetched_at: fetched, detail: text(state.detail) ?? SONAR_UNATTEMPTED_DETAIL };
  }
  const measured = state.measures === undefined ? undefined : measures(state.measures);
  return {
    fetched_at: fetched,
    mapping: attributed,
    ...(measured === undefined ? {} : { measures: measured }),
    // A project that resolved and could not be measured keeps its reason beside the project it is about, which is
    // what `sonarGateCard` prints under the gate: the project name is the first thing needed to chase it.
    ...(text(state.detail) === undefined ? {} : { detail: text(state.detail) as string })
  };
}
