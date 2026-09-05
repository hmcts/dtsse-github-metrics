import { type SonarDeclaration, SonarGateLevel, type SonarMeasures, type SonarQualityGate, type SonarRating } from "../domain/sonar.ts";

/**
 * Reading SonarCloud's measures and a repository's declaration. Ported from `metrics.sonar`.
 *
 * The rule running through all of it: AN UNREAD SIGNAL MUST NEVER RENDER AS THE GOOD ANSWER. A measure
 * SonarCloud did not send, one that did not parse, a rating off the scale and a gate level this build does not
 * know are all reported as absent rather than as zero, `A`, or `OK`.
 */

/** Every metric key one measures request asks for. */
export const SONAR_METRIC_KEYS: readonly string[] = [
  "alert_status",
  "quality_gate_details",
  "coverage",
  "duplicated_lines_density",
  "ncloc",
  "violations",
  "software_quality_reliability_issues",
  "software_quality_maintainability_issues",
  "software_quality_security_issues",
  "reliability_rating",
  "sqale_rating",
  "security_rating"
];

const PROJECT_KEY_PROPERTY = "sonar.projectKey";
const ORGANIZATION_PROPERTY = "sonar.organization";

/** Recognised only at the start of a line, as the properties format specifies: a `#` inside a value is a `#`. */
const PROPERTY_COMMENT_MARKERS = ["#", "!"];
const PROPERTY_PATTERN = /^([^=:\s]+)\s*[=:]\s*(.*)$/;

/**
 * Reads one `alert_status` value, treating anything unrecognised as no level at all.
 *
 * A level this build does not know is reported as no gate rather than as a passing one, for the same reason an
 * off-scale rating has no letter.
 */
export function gateLevel(value: string | undefined): SonarGateLevel | undefined {
  if (value === undefined) {
    return undefined;
  }
  const known = new Set<string>(Object.values(SonarGateLevel));
  return known.has(value) ? (value as SonarGateLevel) : undefined;
}

/**
 * Reads one numeric measure, treating an absent or unreadable value as absent.
 *
 * NEVER ZERO. SonarCloud reports every measure as a string, so a value it did not send and a value that did
 * not parse are both "not measured" — and a rendered `0.0%` would be a claim about the code rather than about
 * the measurement.
 */
export function measuredNumber(values: Map<string, string>, key: string): number | undefined {
  const raw = values.get(key);
  if (raw === undefined) {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    console.warn(`SonarCloud reported an unreadable value for ${key}: ${raw}`);
    return undefined;
  }
  return parsed;
}

/** Reads one counted measure, which SonarCloud sends as a string like every other. */
export function measuredCount(values: Map<string, string>, key: string): number | undefined {
  const number = measuredNumber(values, key);
  return number === undefined ? undefined : Math.trunc(number);
}

/** Reads one `1.0`-to-`5.0` rating, keeping the number the letter is derived from. */
export function measuredRating(values: Map<string, string>, key: string): SonarRating | undefined {
  const number = measuredNumber(values, key);
  return number === undefined ? undefined : { value: number };
}

/**
 * Builds the gate from its conditions, falling back to the bare level when they do not parse.
 *
 * `quality_gate_details` carries the level AND every condition behind it, so it is preferred; `alert_status`
 * says only whether the gate passed. A details document this build cannot read therefore degrades to the
 * verdict rather than to nothing, and says so in the log.
 */
export function measuredGate(values: Map<string, string>): SonarQualityGate | undefined {
  const level = gateLevel(values.get("alert_status"));
  const details = values.get("quality_gate_details");
  if (details === undefined) {
    return level === undefined ? undefined : { level };
  }
  try {
    const parsed = JSON.parse(details) as { level?: unknown; conditions?: unknown };
    const detailLevel = gateLevel(typeof parsed.level === "string" ? parsed.level : undefined);
    const conditions = Array.isArray(parsed.conditions)
      ? parsed.conditions.map((condition) => {
          const entry = condition as Record<string, unknown>;
          return {
            metric: String(entry.metric ?? ""),
            level: String(entry.level ?? ""),
            ...(entry.op === undefined ? {} : { comparator: String(entry.op) }),
            ...(entry.error === undefined ? {} : { errorThreshold: String(entry.error) }),
            ...(entry.actual === undefined ? {} : { actual: String(entry.actual) })
          };
        })
      : undefined;
    const resolved = detailLevel ?? level;
    if (resolved === undefined) {
      return undefined;
    }
    return conditions === undefined ? { level: resolved } : { level: resolved, conditions };
  } catch {
    console.warn("SonarCloud returned quality gate details this build cannot read");
    return level === undefined ? undefined : { level };
  }
}

/** Turns one measures response into the evidence model, keeping every absence an absence. */
export function parseMeasures(project: string, measures: readonly { metric: string; value?: string }[], analysisAt: Date | undefined): SonarMeasures {
  const values = new Map<string, string>();
  for (const measure of measures) {
    if (measure.value !== undefined) {
      values.set(measure.metric, measure.value);
    }
  }
  const gate = measuredGate(values);
  const optional = <T>(key: keyof SonarMeasures, value: T | undefined) => (value === undefined ? {} : { [key]: value });

  return {
    projectKey: project,
    ...(analysisAt === undefined ? {} : { analysisAt }),
    ...(gate === undefined ? {} : { gate }),
    ...optional("coverage", measuredNumber(values, "coverage")),
    ...optional("duplicatedLinesDensity", measuredNumber(values, "duplicated_lines_density")),
    ...optional("linesOfCode", measuredCount(values, "ncloc")),
    ...optional("violations", measuredCount(values, "violations")),
    ...optional("reliabilityIssues", measuredCount(values, "software_quality_reliability_issues")),
    ...optional("maintainabilityIssues", measuredCount(values, "software_quality_maintainability_issues")),
    ...optional("securityIssues", measuredCount(values, "software_quality_security_issues")),
    ...optional("reliabilityRating", measuredRating(values, "reliability_rating")),
    ...optional("maintainabilityRating", measuredRating(values, "sqale_rating")),
    ...optional("securityRating", measuredRating(values, "security_rating"))
  };
}

/**
 * Reads a Java properties file well enough to find the two properties this module asks about.
 *
 * Later definitions win, as the format specifies, and comments are recognised only at the start of a line,
 * again as the format specifies. DELIBERATELY NOT A FULL PROPERTIES PARSER: line continuations and escapes
 * exist in the format and appear in none of the 240 declarations measured, and a parser that silently
 * mis-read one would produce a key rather than an absence.
 */
export function parseProperties(text: string): Map<string, string> {
  const properties = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const stripped = line.trim();
    if (stripped === "" || PROPERTY_COMMENT_MARKERS.some((marker) => stripped.startsWith(marker))) {
      continue;
    }
    const matched = PROPERTY_PATTERN.exec(stripped);
    if (matched) {
      properties.set(matched[1] as string, (matched[2] as string).trim());
    }
  }
  return properties;
}

/**
 * Reads one repository's declaration, or `undefined` where it has no `sonar-project.properties`.
 *
 * `undefined` means the file is not there; a declaration whose `projectKey` is absent means the file IS there
 * and leaves the key to the build — a real case, since a properties file can configure sources and exclusions
 * and nothing else. The two are kept apart so the report can say which.
 */
export function declaredProject(text: string | undefined): SonarDeclaration | undefined {
  if (text === undefined) {
    return undefined;
  }
  const properties = parseProperties(text);
  const projectKey = properties.get(PROJECT_KEY_PROPERTY);
  const organization = properties.get(ORGANIZATION_PROPERTY);
  return {
    ...(projectKey ? { projectKey } : {}),
    ...(organization ? { organization } : {})
  };
}
