import { type CveFinding, cveSeverity } from "../domain/cves.ts";

/**
 * Reading the three published report shapes, each with its own scanner's idea of what a finding is.
 *
 * ONE PARSER PER `codebase_type`, and a type with no parser yields NOTHING RATHER THAN AN EMPTY LIST — see
 * `cveFindings`. That is the absent-versus-zero rule applied to the estate's future: a fourth builder starting to
 * publish would otherwise have every one of its repositories recorded as a clean scan on the day it landed.
 *
 * Every field read below was checked against real documents in the `jenkins` and `sds-jenkins` databases on
 * 2026-09-18; where the shape held a surprise, the surprise is recorded beside the field.
 */

/** The `build.codebase_type` values `CVEPublisher` is reached from, which is the whole of what can be parsed. */
export const PARSEABLE_CODEBASE_TYPES = ["java", "node", "python"] as const;

export type ParseableCodebaseType = (typeof PARSEABLE_CODEBASE_TYPES)[number];

/** Whether a `codebase_type` is one there is a parser for. */
export function parseable(codebaseType: unknown): codebaseType is ParseableCodebaseType {
  return typeof codebaseType === "string" && (PARSEABLE_CODEBASE_TYPES as readonly string[]).includes(codebaseType);
}

/**
 * One report's findings, or NOTHING where nothing here can read it.
 *
 * THE DIFFERENCE BETWEEN `[]` AND `undefined` IS THE WHOLE CONTRACT. An empty list is a scan that ran and found
 * nothing, and the caller records it as a measured zero; `undefined` is a report this code cannot read, and the
 * caller records no scan at all so the repository stays unmeasured. A parser that returned `[]` on a shape it did
 * not understand would manufacture the most misleading answer available — a clean bill of health nobody issued.
 */
export function cveFindings(codebaseType: unknown, report: unknown): CveFinding[] | undefined {
  if (!parseable(codebaseType) || !isRecord(report)) {
    return undefined;
  }
  switch (codebaseType) {
    case "java":
      return dependencyCheckFindings(report);
    case "node":
      return yarnAuditFindings(report);
    default:
      return uvAuditFindings(report);
  }
}

/**
 * OWASP dependency-check, as `GradleBuilder` publishes it.
 *
 * Findings hang off each dependency: live ones in `dependencies[].vulnerabilities[]` and accepted ones in
 * `dependencies[].suppressedVulnerabilities[]`, with `fileName` naming the artefact.
 *
 * SEVERITY COMES OFF CVSS AND NOT OFF THE ENTRY'S OWN `severity` FIELD, and that is a measurement rather than a
 * preference. Across the `jenkins` database's `master` documents, `severity` is present on 208,384 of 208,384
 * live findings and on 0 of 2,499,605 suppressed ones — so grading by it would report every suppressed finding as
 * unknown severity and make the two figures the acceptance criteria compare incomparable. `cvssv3.baseSeverity`
 * is present on both sides, and where it is not, `cvssv2.severity` is: only 10 live findings in the whole
 * database carry neither, and those are honestly unknown.
 *
 * The two also disagree, which is worth knowing before anyone changes this back. `severity` follows CVSS 4.0
 * where a finding has a v4 vector, so CVE-2025-7962 against `angus-activation-2.0.3.jar` is `MEDIUM` by its own
 * field and `HIGH` by `cvssv3.baseSeverity`.
 *
 * THE REPORT IS NOT NECESSARILY THE WHOLE SCAN. Documents are capped at 2MB, so `GradleBuilder` filters to
 * vulnerable dependencies before publishing — a dependency absent from the report is one with no findings, not
 * one that was not scanned.
 */
function dependencyCheckFindings(report: Record<string, unknown>): CveFinding[] {
  const findings: CveFinding[] = [];
  for (const dependency of asArray(report.dependencies)) {
    if (!isRecord(dependency)) {
      continue;
    }
    const artefact = asString(dependency.fileName);
    for (const [key, suppressed] of [
      ["vulnerabilities", false],
      ["suppressedVulnerabilities", true]
    ] as const) {
      for (const entry of asArray(dependency[key])) {
        if (!isRecord(entry)) {
          continue;
        }
        const identifier = asString(entry.name);
        if (identifier === undefined || artefact === undefined) {
          continue;
        }
        const cvssv3 = isRecord(entry.cvssv3) ? entry.cvssv3 : {};
        const cvssv2 = isRecord(entry.cvssv2) ? entry.cvssv2 : {};
        findings.push({
          identifier,
          package: artefact,
          suppressed,
          ...optionalSeverity(cveSeverity(cvssv3.baseSeverity) ?? cveSeverity(cvssv2.severity)),
          ...optionalScore(asNumber(cvssv3.baseScore) ?? asNumber(cvssv2.score))
        });
      }
    }
  }
  return findings;
}

/**
 * yarn audit, as `YarnBuilder` publishes it.
 *
 * Live findings in `vulnerabilities[]` and accepted ones in `suppressed[]`, both flat, both the same entry shape.
 * `report.suppressed` is present on 158,851 node documents, so the key is real rather than inferred from the
 * ingestion SQL.
 *
 * `moderate` IS FOLDED TO `medium` by `cveSeverity`. It is yarn audit's own word for the band and its most common
 * one — 261,445 of 462,521 live `master` entries.
 *
 * EVERY REPORT CARRIES AN ENTIRELY-NULL PLACEHOLDER ENTRY, and dropping it is the reason the two guards below are
 * not defensive boilerplate. 51,359 of those 462,521 live entries have all nine fields null — roughly one per
 * report, verified against `rpx-xui-approve-org`'s latest scan, where 1 of 18 entries is `{"title": null, "cves":
 * null, …, "module_name": null}`. It names no CVE and no package, so it is not a finding; counting it would add
 * about one phantom CVE to every node repository on the estate, and counting it as ungraded would put that phantom
 * in the unknown band where somebody would go looking for it.
 *
 * THE IDENTIFIER PREFERS A REAL CVE AND FALLS BACK TO THE ADVISORY URL. `cves` is populated on 236,679 live
 * entries and empty or null on the rest, and an advisory with no CVE assigned is still a finding — naming it by
 * its GitHub advisory URL is what stops it being dropped.
 */
function yarnAuditFindings(report: Record<string, unknown>): CveFinding[] {
  const findings: CveFinding[] = [];
  for (const [key, suppressed] of [
    ["vulnerabilities", false],
    ["suppressed", true]
  ] as const) {
    for (const entry of asArray(report[key])) {
      if (!isRecord(entry)) {
        continue;
      }
      const identifier = asArray(entry.cves).map(asString).find(defined) ?? asString(entry.url);
      const module = asString(entry.module_name);
      if (identifier === undefined || module === undefined) {
        continue;
      }
      const cvss = isRecord(entry.cvss) ? entry.cvss : {};
      findings.push({
        identifier,
        package: module,
        suppressed,
        ...optionalSeverity(cveSeverity(entry.severity)),
        ...optionalScore(asNumber(cvss.score))
      });
    }
  }
  return findings;
}

/**
 * uv audit, as `PythonBuilder` publishes it — the weak case, and deliberately not forced into the other two.
 *
 * THERE IS NO SEVERITY AND NO SUPPRESSION, and neither is invented here. Every finding is recorded live with no
 * severity, so a Python repository's findings land in the unknown bucket and its suppressed figure is a measured
 * zero rather than an absence — which is true: uv audit has no suppression concept to report on.
 *
 * `display_id` is the GHSA identifier and `aliases[]` carries the CVE beside it. The GHSA is preferred because it
 * is the identifier the report is keyed by and is always present; a report with neither is dropped.
 *
 * IT IS A SMALL ESTATE. 101 `master` documents across 2 repositories, against 107,010 java and 51,530 node — so
 * this parser is the one with the least real data behind it, and the shape above is what two repositories'
 * reports show rather than a documented schema.
 */
function uvAuditFindings(report: Record<string, unknown>): CveFinding[] {
  const findings: CveFinding[] = [];
  for (const entry of asArray(report.vulnerabilities)) {
    if (!isRecord(entry)) {
      continue;
    }
    const identifier = asString(entry.display_id) ?? asString(entry.id) ?? asArray(entry.aliases).map(asString).find(defined);
    const module = asString(entry.package) ?? (isRecord(entry.dependency) ? asString(entry.dependency.name) : undefined);
    if (identifier === undefined || module === undefined) {
      continue;
    }
    findings.push({ identifier, package: module, suppressed: false });
  }
  return findings;
}

/**
 * The same CVE against the same package listed once.
 *
 * DEDUPLICATED BECAUSE THE STORE'S KEY SAYS SO, and the worse severity wins where two entries disagree. A
 * dependency-check report can list one artefact more than once — the same jar reached through two dependency
 * paths — and an insert of both would be rejected on the primary key. Keeping the worse of two gradings is the
 * direction that cannot understate a finding.
 *
 * LIVE AND SUPPRESSED ARE NEVER MERGED. `suppressed` is part of the key, so a CVE that is somehow both is
 * recorded as both, which is the answer that keeps the suppressed figure out of the live one.
 */
export function distinctFindings(findings: readonly CveFinding[]): CveFinding[] {
  const kept = new Map<string, CveFinding>();
  for (const finding of findings) {
    const key = `${finding.identifier} ${finding.package} ${finding.suppressed}`;
    const existing = kept.get(key);
    if (existing === undefined || worseThan(finding, existing)) {
      kept.set(key, finding);
    }
  }
  return [...kept.values()];
}

/** The severity order the deduplication keeps, worst first. An absent severity is the weakest claim of all. */
const SEVERITY_RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };

function worseThan(candidate: CveFinding, incumbent: CveFinding): boolean {
  return (SEVERITY_RANK[candidate.severity ?? ""] ?? 0) > (SEVERITY_RANK[incumbent.severity ?? ""] ?? 0);
}

function optionalSeverity(severity: CveFinding["severity"]): Pick<CveFinding, "severity"> {
  return severity === undefined ? {} : { severity };
}

function optionalScore(score: number | undefined): Pick<CveFinding, "score"> {
  return score === undefined ? {} : { score };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** A non-blank string, or nothing. Blank is treated as absent: it names no CVE and no package. */
function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** A finite number, or nothing. A score arrives as a number in both shapes, and as a string in neither. */
function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function defined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
