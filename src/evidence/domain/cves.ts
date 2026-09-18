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
  /**
   * Why this finding was accepted, where whoever suppressed it wrote that down.
   *
   * ONLY DEPENDENCY-CHECK HAS ANYWHERE TO PUT THIS. Its suppression entries carry a `notes` field and HMCTS
   * practice fills it with a ticket and a rationale — the `kotlin-stdlib` CVE-2026-53914 suppression reads
   * "HDPI-8150: temporary. … no fixed release published upstream yet. The risk vector (build-cache
   * deserialization) is irrelevant to PCS's runtime". yarn audit's suppression list has NO such field at all,
   * verified against every node document in both databases: no `notes`, `justification`, `reason` or `comment`.
   *
   * SO AN ABSENT NOTE IS TWO DIFFERENT ANSWERS, and `recordsSuppressionNotes` is what tells them apart. A blank
   * one on a java finding is an undocumented risk acceptance — somebody silently accepted a vulnerability. An
   * absent one on a node finding is a limitation of the builder, and counting it as undocumented would blame
   * every node team on the estate for something their tooling cannot do.
   */
  notes?: string;
}

/**
 * Which report formats can carry a written justification for a suppression at all.
 *
 * `java` ONLY, and this is a capability of the FORMAT rather than a fact about a row — which is why it is a
 * function of the codebase type and not a stored column. Deriving it keeps the two meanings of "no note" apart
 * without a column that could disagree with the report it came from.
 */
export function recordsSuppressionNotes(codebaseType: string): boolean {
  return codebaseType === "java";
}

/**
 * One occurrence as the ROLLUP needs it: what the CVE is, how it was graded, and how it was accepted.
 *
 * NOT `CveFinding` AND DELIBERATELY NARROWER. A finding is what a parser produces and carries the package it was
 * found against; by the time occurrences reach a rollup the package has already done its work — it is what made
 * them distinct — and nothing downstream reads it. Declaring it here would oblige the store to invent a value for
 * a column it has no reason to select.
 *
 * THE CODEBASE TYPE RIDES IT because `notes` cannot be interpreted without it — see `CveFinding.notes`. It is not
 * on `CveFinding` because a parser is already inside one format and cannot be wrong about which.
 */
export interface CveOccurrence {
  identifier: string;
  codebaseType: string;
  severity?: CveSeverity;
  suppressed: boolean;
  /**
   * Whether a justification was written for this occurrence — the PRESENCE of a note and not the note itself.
   *
   * A BOOLEAN AND NOT THE TEXT, because the text is evidence for a person querying the table and the rollup only
   * needs the predicate. Reducing it in the database is also what lets the read collapse: with the paragraph in
   * the `DISTINCT` key, two packages whose suppressions are worded differently would yield two tuples for one CVE.
   *
   * MEANINGLESS ON ITS OWN. `false` says only that there is no note here, which for a node occurrence is a fact
   * about yarn audit rather than about anybody's diligence — `recordsSuppressionNotes` is what decides whether to
   * believe it, and `DistinctCve.documented` is where the answer becomes three-valued.
   */
  documented: boolean;
}

/**
 * One distinct CVE, folded from every package it was found against.
 *
 * THE UNIT A REPOSITORY IS REPORTED IN. An occurrence is (package, CVE) and one CVE routinely spans many
 * packages: `pcs-api`'s newest java scan holds 262 occurrences of 26 distinct CVEs, with `CVE-2026-47884` and two
 * others each reaching 13 packages. Reporting occurrences would put every figure about an order of magnitude
 * above the number of things actually wrong.
 */
export interface DistinctCve {
  identifier: string;
  /** The worst grading any of its occurrences carried. */
  severity?: CveSeverity;
  /** Whether it is suppressed in EVERY package it was found against. See `distinctCves`. */
  suppressed: boolean;
  /**
   * Whether somebody wrote down why it was accepted, or nothing where no occurrence could have said.
   *
   * THREE STATES, and the third is the point: `true` documented, `false` accepted with no reason given, and
   * ABSENT where every suppression of it came from a format with no notes field. Only the middle one is a finding
   * about the team.
   */
  documented?: boolean;
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
  /**
   * Every distinct CVE the scan found, suppressed or not — the "X" in "this repository has X CVEs, Y of them
   * suppressed". `live` and `suppressed` partition it, so their totals always sum to this one's.
   */
  all: CveSeverityCounts;
  live: CveSeverityCounts;
  suppressed: CveSeverityCounts;
  /**
   * How many (package, CVE) occurrences the counts above were folded from.
   *
   * CARRIED SO THE RELATIONSHIP IS VISIBLE RATHER THAN SURPRISING. It is roughly ten times the distinct count —
   * 262 against 26 on `pcs-api` — so a reader who meets the fine-grained figure elsewhere can see why the two
   * differ instead of assuming one of them is wrong.
   */
  occurrences: number;
  /**
   * Of the suppressed CVEs, how many somebody wrote a reason for, and how many they did not.
   *
   * BOTH ABSENT TOGETHER where no suppression of this repository's could have carried a reason — a node-only
   * repository, whose builder has no notes field. Absent means "this cannot be assessed here", which is not the
   * same answer as zero documented, and reporting `0` would read as a team that documents nothing.
   *
   * THEY NEED NOT SUM TO `suppressed`. A repository publishing both a java and a node report has suppressions of
   * both kinds, and the node ones are in neither figure.
   */
  documentedSuppressions?: number;
  undocumentedSuppressions?: number;
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

/** Which bucket a CVE is counted in, which is the one place an absent severity becomes a word. */
export function severityBucket(cve: { severity?: CveSeverity }): CveSeverityBucket {
  return cve.severity ?? UNKNOWN_SEVERITY;
}

/** The severity order a fold keeps, worst first. An absent severity is the weakest claim of all. */
const SEVERITY_RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };

function rankOf(severity: CveSeverity | undefined): number {
  return SEVERITY_RANK[severity ?? ""] ?? 0;
}

/**
 * Occurrences folded to one entry per distinct CVE.
 *
 * **A CVE THAT IS LIVE ANYWHERE COUNTS AS LIVE.** This is the one judgement in the module and it is stated here
 * rather than left to emerge from a `GROUP BY`: `suppressed` is `true` only when EVERY occurrence of the CVE is
 * suppressed, so a CVE accepted against one package and still open against another is reported live. Something
 * unsuppressed is still exposed, and a rule that let one suppression speak for every package would let a team
 * retire a live vulnerability from the figures by accepting it somewhere else. Measured across the estate, the
 * mixed case is rare — but rare is not never, and this is the direction that cannot understate.
 *
 * THE WORST GRADING WINS, for `distinctFindings`' reason: two occurrences of one CVE can be graded differently
 * where only one carries a CVSS block, and the direction that cannot understate a finding is the one to take.
 *
 * DOCUMENTED IF ANY SUPPRESSION EXPLAINS IT. One written reason covers the acceptance; requiring a note on all
 * thirteen packages a CVE touches would mark a properly documented suppression as undocumented because the
 * suppression file names the CVE once. Absent where no occurrence came from a format that could carry one — see
 * `DistinctCve.documented`.
 */
export function distinctCves(occurrences: Iterable<CveOccurrence>): DistinctCve[] {
  const folded = new Map<string, DistinctCve>();
  for (const occurrence of occurrences) {
    // Only a SUPPRESSION can be documented, and only in a format with somewhere to write it.
    const recordable = occurrence.suppressed && recordsSuppressionNotes(occurrence.codebaseType);
    const documented = occurrence.documented;
    const existing = folded.get(occurrence.identifier);
    if (existing === undefined) {
      folded.set(occurrence.identifier, {
        identifier: occurrence.identifier,
        ...(occurrence.severity === undefined ? {} : { severity: occurrence.severity }),
        suppressed: occurrence.suppressed,
        ...(recordable ? { documented } : {})
      });
      continue;
    }
    // LIVE ANYWHERE WINS: still suppressed only if this occurrence is suppressed as well.
    existing.suppressed = existing.suppressed && occurrence.suppressed;
    if (rankOf(occurrence.severity) > rankOf(existing.severity)) {
      existing.severity = occurrence.severity;
    }
    if (recordable) {
      // `undefined === true` is false, so the first recordable occurrence settles it and a later note upgrades it.
      existing.documented = existing.documented === true || documented;
    }
  }
  return [...folded.values()];
}

/**
 * One repository's distinct CVEs folded to the counts a row reports.
 *
 * A BUCKET WITH NOTHING IN IT IS LEFT OUT, which is `reportedFamily`'s convention in
 * `report/contract/security.ts`: an empty map is the honest answer both for a scan that found nothing and for
 * one nobody ran, and what separates those two is whether there is an evidence object at all.
 */
export function countedCves(
  occurrences: Iterable<CveOccurrence>
): Pick<CveEvidence, "all" | "live" | "suppressed" | "documentedSuppressions" | "undocumentedSuppressions"> {
  const all: CveSeverityCounts = {};
  const live: CveSeverityCounts = {};
  const suppressed: CveSeverityCounts = {};
  let documented = 0;
  let undocumented = 0;
  let assessable = false;

  for (const cve of distinctCves(occurrences)) {
    const bucket = severityBucket(cve);
    all[bucket] = (all[bucket] ?? 0) + 1;
    const counts = cve.suppressed ? suppressed : live;
    counts[bucket] = (counts[bucket] ?? 0) + 1;
    // THE TWO FIGURES ARE ABOUT SUPPRESSIONS, so a CVE reported live is out of both even where one of its
    // occurrences was suppressed and explained. Counting it would put a documented suppression beside a
    // vulnerability the same row reports as still open.
    if (!cve.suppressed || cve.documented === undefined) {
      continue;
    }
    assessable = true;
    if (cve.documented) {
      documented += 1;
    } else {
      undocumented += 1;
    }
  }

  return {
    all,
    live,
    suppressed,
    // ABSENT TOGETHER where nothing could have carried a reason, which is not the same as zero documented.
    //
    // `occurrences` IS NOT COMPUTED HERE. What arrives is the DISTINCT tuples, not the stored rows, so counting
    // them would report a number close to the occurrence total and quietly wrong. Its one honest source is a
    // `COUNT(*)` over the table, which is the caller's to supply.
    ...(assessable ? { documentedSuppressions: documented, undocumentedSuppressions: undocumented } : {})
  };
}

/** How many CVEs a count map holds altogether. Zero where it is empty, which is a measured nothing. */
export function totalCount(counts: CveSeverityCounts): number {
  let total = 0;
  for (const bucket of Object.values(counts)) {
    total += bucket;
  }
  return total;
}
