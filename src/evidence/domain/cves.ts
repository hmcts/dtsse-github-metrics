/**
 * What a published CVE report says, in the one vocabulary three different scanners can be read into.
 *
 * The Jenkins security stage publishes a report per build, and `CVEPublisher.publishCVEReport` in
 * `cnp-jenkins-library` is called from exactly three builders — `YarnBuilder` (`node`), `GradleBuilder` (`java`)
 * and `PythonBuilder` (`python`). Each hands over its scanner's native JSON, so the three shapes have nothing in
 * common: OWASP dependency-check nests findings under each dependency, yarn audit lists them flat, and uv audit
 * carries no severity at all.
 *
 * MOST OF THE ESTATE HAS NEVER PUBLISHED ONE, and that is the fact this whole module is shaped around. Measured
 * against both databases on 2026-09-18, 361 repositories have a `master` report against an estate of about 1,890
 * — so four repositories in five are UNMEASURED, and a severity count that reads absence as zero would report the
 * estate as very nearly clean. A repository with no report and one whose scan found nothing are different
 * answers, and nothing here may collapse them.
 */

/** The four words both scanners that grade severity agree on, after folding. */
export const CVE_SEVERITIES = ["critical", "high", "medium", "low"] as const;

export type CveSeverity = (typeof CVE_SEVERITIES)[number];

/**
 * The bucket a finding whose severity nobody stated is counted in.
 *
 * A BUCKET AND NOT A SEVERITY. It never reaches the `severity` column — that column is NULL for these — and it
 * exists only where findings are counted, because a count has to put every finding somewhere. Reading these as
 * `low` is the specific mistake it prevents.
 *
 * WHAT ACTUALLY LANDS IN IT, measured 2026-09-18: uv audit states no severity for any finding at all, and 10 of
 * dependency-check's 208,384 live `master` findings carry neither a CVSS v3 nor a CVSS v2 block. It is EMPTY on
 * today's estate, because both Python repositories' latest scans are clean — which is a fact about today and not a
 * reason to drop the bucket.
 *
 * IT IS NOT WHERE YARN AUDIT'S NULL SEVERITIES GO, and that is worth knowing because it looks as though it should
 * be: 51,359 of yarn audit's 462,521 live entries carry `severity: null`, and every one of those is an
 * ENTIRELY-NULL PLACEHOLDER — all nine fields null, roughly one per report. It names no CVE and no package, so
 * `cveFindings` drops it rather than counting it as an ungraded finding. Counting it would add about one phantom
 * finding per node repository.
 */
export const UNKNOWN_SEVERITY = "unknown";

export type CveSeverityBucket = CveSeverity | typeof UNKNOWN_SEVERITY;

/** How many findings fall in each bucket. A bucket with none is ABSENT rather than zero. */
export type CveSeverityCounts = Partial<Record<CveSeverityBucket, number>>;

/**
 * One CVE against one package, as one scan found it.
 *
 * `severity` ABSENT MEANS THE REPORT DID NOT STATE ONE, which is why it is optional rather than defaulted. See
 * `UNKNOWN_SEVERITY` for what absence costs if it is filled in.
 *
 * `suppressed` is the field the acceptance criteria turn on: a suppressed finding is one somebody has reviewed
 * and accepted, so it must be counted separately and must never be added to the live figure.
 */
export interface CveFinding {
  /** The CVE or advisory identifier — `CVE-2025-7962`, `GHSA-cq5v-8q36-5273`, or an advisory URL. */
  identifier: string;
  /** The package or artefact the finding is against, in whatever spelling the scanner used. */
  package: string;
  severity?: CveSeverity;
  /** The CVSS base score where the report carried one. Reported by nothing yet; stored because it is free. */
  score?: number;
  suppressed: boolean;
}

/**
 * One repository's CVE position as the collection last read it, folded to counts.
 *
 * THE OBJECT EXISTING IS THE MEASUREMENT. A repository absent from the map nobody scanned; one present with
 * empty count maps was scanned and had nothing, which is the honest zero. That distinction is carried by
 * presence and not by a number, so there is no value anywhere that could be mistaken for the other answer.
 *
 * `codebaseTypes` can hold more than one, and one repository in the estate does: a repository whose pipeline
 * publishes both a `java` and a `node` report is scanned twice and its counts are the sum. Naming which says
 * what a figure covers — a `java` count says nothing about that repository's JavaScript dependencies.
 */
export interface CveEvidence {
  /** The newest report this repository's counts were folded from. */
  scannedAt: Date;
  codebaseTypes: string[];
  live: CveSeverityCounts;
  suppressed: CveSeverityCounts;
}

/**
 * One severity word folded to the vocabulary above, or nothing for a word this does not name.
 *
 * NARROWED RATHER THAN CAST, for `reportedVisibility`'s reason in `report/rows/repository.ts`: a scanner can
 * emit a fifth word, and the honest reading of one is UNMEASURED rather than admitting it to a union no reader's
 * own type holds.
 *
 * THE CASES REAL DATA ACTUALLY CARRIES, all three measured against both databases:
 *
 *   dependency-check  `MEDIUM` `HIGH` `CRITICAL` `LOW` — upper case, off `cvssv3.baseSeverity`
 *   yarn audit        `moderate` `high` `critical` `low` — lower case, plus a `null` on the placeholder entry
 *                     `cveFindings` drops
 *   uv audit          nothing at all
 *
 * `moderate` IS `medium`. It is yarn audit's own word for the same band and by far its most common — 261,445 of
 * 462,521 live findings — so leaving it unfolded would put the bulk of the node estate in a bucket no reader
 * looks in.
 */
export function cveSeverity(raw: unknown): CveSeverity | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const folded = raw.trim().toLowerCase();
  if (folded === "moderate") {
    return "medium";
  }
  return (CVE_SEVERITIES as readonly string[]).includes(folded) ? (folded as CveSeverity) : undefined;
}

/** Which bucket a finding is counted in, which is the one place an absent severity becomes a word. */
export function severityBucket(finding: CveFinding): CveSeverityBucket {
  return finding.severity ?? UNKNOWN_SEVERITY;
}

/**
 * Findings folded into the two count maps, live and suppressed kept apart.
 *
 * A BUCKET WITH NOTHING IN IT IS LEFT OUT, which is `reportedFamily`'s convention in
 * `report/contract/security.ts`: an empty map is the honest answer both for a scan that found nothing and for
 * one nobody ran, and what separates those two is whether there is an evidence object at all.
 */
export function countedFindings(findings: Iterable<CveFinding>): { live: CveSeverityCounts; suppressed: CveSeverityCounts } {
  const live: CveSeverityCounts = {};
  const suppressed: CveSeverityCounts = {};
  for (const finding of findings) {
    const counts = finding.suppressed ? suppressed : live;
    const bucket = severityBucket(finding);
    counts[bucket] = (counts[bucket] ?? 0) + 1;
  }
  return { live, suppressed };
}

/** How many findings a count map holds altogether. Zero where it is empty, which is a measured nothing. */
export function totalCount(counts: CveSeverityCounts): number {
  let total = 0;
  for (const bucket of Object.values(counts)) {
    total += bucket;
  }
  return total;
}
