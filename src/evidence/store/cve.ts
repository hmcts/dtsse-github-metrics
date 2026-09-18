import type { CveScan } from "../cve/collect.ts";
import { type CveEvidence, type CveOccurrence, countedCves, cveSeverity } from "../domain/cves.ts";
import { byCodePoint } from "../org/graph.ts";
import { prisma } from "./prisma.ts";
import { StorageError } from "./storage-error.ts";

/**
 * Where the published CVE reports are kept, and the three questions asked of them.
 *
 * THE ABSENT-VERSUS-ZERO RULE IS STRUCTURAL HERE AND NOT A CONVENTION TO REMEMBER. `cve_scans` records that a
 * scan was published and `cve_findings` records what it found, so a repository with a scan row and no findings is
 * a measured zero and a repository with no scan row was never scanned. `storedCveEvidence` returns an entry only
 * for the former, which means no caller can accidentally read the latter as clean — there is nothing there to
 * read.
 */

/**
 * How far each database has been read, as `source_database → the newest report stored from it`.
 *
 * DERIVED FROM THE ROWS RATHER THAN STORED BESIDE THEM, which removes a whole failure mode: a watermark in its
 * own table can advance while the write that earned it fails, and the documents it skips past are then never
 * read again. `MAX(reported_at)` cannot get ahead of the rows because it IS the rows.
 *
 * PER DATABASE, because `CosmosDbTargetResolver` routes a build by GitHub topic and the two containers fill
 * independently — one watermark across both would re-read whichever is behind on every run, or skip it.
 */
export async function cveWatermarks(organization: string): Promise<Map<string, Date>> {
  try {
    const rows = await prisma.cveScan.groupBy({
      by: ["sourceDatabase"],
      where: { organization: organization.toLowerCase() },
      _max: { reportedAt: true }
    });
    const watermarks = new Map<string, Date>();
    for (const row of rows) {
      if (row._max.reportedAt !== null) {
        watermarks.set(row.sourceDatabase, row._max.reportedAt);
      }
    }
    return watermarks;
  } catch (error) {
    throw new StorageError("could not read the CVE collection watermarks", error);
  }
}

/** What one call to `recordCveScans` changed, so a run can report it rather than claiming a number. */
export interface CveWriteOutcome {
  /** Scans written, which is repositories-times-languages and not repositories. */
  written: number;
  /** Scans skipped because what is stored is already at least as new. */
  superseded: number;
  findings: number;
}

/**
 * Replaces each repository's scan and findings with a newer report's, and leaves an older one alone.
 *
 * ONE TRANSACTION PER SCAN, and that is a deliberate choice of unit rather than a missed batching. The unit of
 * meaning is a repository's language: its scan row and its findings have to land together or a reader sees counts
 * without a scan, or a scan whose findings are half replaced. Batching across repositories would widen that unit
 * to "everything this run found", which is a worse thing to half-apply. The first run is 362 transactions and
 * every run after it is the handful of repositories that built since — measured against the real container,
 * 362 scans exist in total.
 *
 * AN OLDER REPORT CANNOT OVERWRITE A NEWER ONE. The `updateMany` guard compares `reported_at` before anything is
 * deleted, so re-running the collection over documents it has already seen — which the `>=` watermark in
 * `../cve/collect.ts` guarantees it will — changes nothing and duplicates nothing. That is the acceptance
 * criterion about re-running, enforced by the statement rather than by the caller being careful.
 *
 * THE FINDINGS ARE REPLACED WHOLESALE AND NOT MERGED. A fixed CVE is absent from the new report, so merging would
 * leave it counted for ever; `deleteMany` then `createMany` is what makes the stored set the report's set.
 */
export async function recordCveScans(scans: readonly CveScan[], collectedAt: Date = new Date()): Promise<CveWriteOutcome> {
  let written = 0;
  let superseded = 0;
  let findings = 0;
  for (const scan of scans) {
    const key = {
      organization: scan.organization.toLowerCase(),
      repository: scan.repository.toLowerCase(),
      codebaseType: scan.codebaseType
    };
    try {
      const stored = await prisma.$transaction(async (tx) => {
        // The guard and the insert are one statement between them: `updateMany` reports 0 where the stored
        // report is at least as new, and where there is no row at all — the `upsert` below then settles which
        // of those two it was.
        const { count } = await tx.cveScan.updateMany({
          where: { ...key, reportedAt: { lt: scan.reportedAt } },
          data: { sourceDatabase: scan.sourceDatabase, reportedAt: scan.reportedAt, buildTag: scan.buildTag ?? null, collectedAt }
        });
        if (count === 0) {
          const existing = await tx.cveScan.findUnique({ where: { organization_repository_codebaseType: key }, select: { reportedAt: true } });
          if (existing !== null) {
            // Stored report is at least as new. Nothing is deleted and nothing is written — which is what
            // makes a re-read of the same documents a no-op rather than a churn of the same rows.
            return 0;
          }
          await tx.cveScan.create({
            data: { ...key, sourceDatabase: scan.sourceDatabase, reportedAt: scan.reportedAt, buildTag: scan.buildTag ?? null, collectedAt }
          });
        }
        await tx.cveFinding.deleteMany({ where: key });
        await tx.cveFinding.createMany({
          data: scan.findings.map((finding) => ({
            ...key,
            identifier: finding.identifier,
            packageName: finding.package,
            suppressed: finding.suppressed,
            // NULL and never the string `unknown`: the column's vocabulary is four words, and the bucket a
            // severity-less finding is counted in is the report layer's business. See the migration's CHECK.
            severity: finding.severity ?? null,
            score: finding.score ?? null,
            // NULL where nobody wrote a reason, AND where the format has nowhere to write one. The two are told
            // apart on read by `codebase_type` rather than stored apart — see `recordsSuppressionNotes`.
            notes: finding.notes ?? null
          }))
        });
        return scan.findings.length + 1;
      });
      if (stored === 0) {
        superseded += 1;
      } else {
        written += 1;
        findings += stored - 1;
      }
    } catch (error) {
      throw new StorageError(`could not record the CVE scan for ${key.repository} (${scan.codebaseType})`, error);
    }
  }
  return { written, superseded, findings };
}

/**
 * Each SCANNED repository's CVE position, keyed on the casefolded repository name.
 *
 * A REPOSITORY IS IN THIS MAP IF AND ONLY IF A SCAN WAS PUBLISHED FOR IT. That is the whole interface: the
 * report layer reads a missing key as unmeasured and a present entry with empty count maps as a measured zero,
 * and neither answer can be manufactured from the other.
 *
 * THREE READS FOR THE WHOLE ESTATE, on `storedRepositoryStates`' precedent: the scans, the DISTINCT occurrence
 * tuples, and the occurrence count per repository.
 *
 * `DISTINCT` AND NOT `GROUP BY` BECAUSE THE UNIT REPORTED IS A CVE AND NOT AN OCCURRENCE. The store keeps one row
 * per (package, CVE) — that is the evidence, and aggregating it away would lose which packages are affected — but
 * one CVE routinely spans many packages: `pcs-api`'s newest java scan holds 262 occurrences of 26 distinct CVEs.
 * Counting occurrences would put every figure about an order of magnitude above the number of things wrong. So the
 * package dimension is collapsed on the way out, taking 29,632 rows to a few thousand, and the ROLLUP RULES — live
 * anywhere wins, worst grading wins, documented if any suppression explains it — live in `countedCves`, which is
 * pure and held at the unit bar. Putting them in SQL would put the one judgement in this feature somewhere no test
 * of the rule can reach.
 *
 * SCANS ARE READ SEPARATELY, which is what makes a clean scan reportable: a repository whose scan found nothing
 * has no occurrence rows at all, so any join would drop exactly the repositories whose measured zero is the point.
 */
export async function storedCveEvidence(organization: string): Promise<Map<string, CveEvidence>> {
  const folded = organization.toLowerCase();
  try {
    const [scans, tuples, occurrences] = await Promise.all([
      prisma.cveScan.findMany({ where: { organization: folded }, select: { repository: true, codebaseType: true, reportedAt: true } }),
      // RAW, FOR THE `notes IS NOT NULL`. What the rollup needs is WHETHER a suppression was explained, not the
      // paragraph explaining it — and the difference is not only bytes. Selecting the text would put it in the
      // `DISTINCT` key, so two packages whose notes are worded differently would produce two tuples for one CVE
      // instead of one; reducing it to a boolean in the database collapses them and leaves the justification
      // where it belongs, which is in the table for whoever asks why.
      prisma.$queryRaw<{ repository: string; codebase_type: string; identifier: string; suppressed: boolean; severity: string | null; documented: boolean }[]>`
        SELECT DISTINCT repository, codebase_type, identifier, suppressed, severity, notes IS NOT NULL AS documented
        FROM cve_findings
        WHERE organization = ${folded}
      `,
      prisma.cveFinding.groupBy({ by: ["repository"], where: { organization: folded }, _count: { _all: true } })
    ]);

    const scanned = new Map<string, { scannedAt: Date; codebaseTypes: string[] }>();
    for (const scan of scans) {
      const existing = scanned.get(scan.repository);
      if (existing === undefined) {
        scanned.set(scan.repository, { scannedAt: scan.reportedAt, codebaseTypes: [scan.codebaseType] });
        continue;
      }
      // A repository scanned in two languages carries both names and the NEWER instant, because that is what
      // "as at" means for a figure that covers both.
      //
      // `byCodePoint` AND NOT A BARE `.sort()`, which is this repository's stated convention — see `CONTRIBUTING.md`.
      // It matters more here than in a log line: this list goes on the wire as `codebase_types` and into a report
      // held per `collection_state.revision`, so a collation that reordered it would make two builds of unchanged
      // evidence differ.
      existing.codebaseTypes = [...existing.codebaseTypes, scan.codebaseType].sort(byCodePoint);
      existing.scannedAt = scan.reportedAt > existing.scannedAt ? scan.reportedAt : existing.scannedAt;
    }

    const perRepository = new Map<string, CveOccurrence[]>();
    for (const row of tuples) {
      if (!scanned.has(row.repository)) {
        // Unreachable while the foreign key holds: an occurrence cannot exist without its scan. Skipped rather
        // than counted, because a count with no scan behind it is the one thing that would let an unmeasured
        // repository report a figure.
        continue;
      }
      const severity = cveSeverity(row.severity);
      const list = perRepository.get(row.repository) ?? [];
      // The package is not selected at all: it has already done its work by making these rows distinct, and
      // `CveOccurrence` is narrower than a finding for exactly that reason.
      list.push({
        identifier: row.identifier,
        codebaseType: row.codebase_type,
        suppressed: row.suppressed,
        documented: row.documented,
        ...(severity === undefined ? {} : { severity })
      });
      perRepository.set(row.repository, list);
    }

    const counted = new Map(occurrences.map((row) => [row.repository, row._count._all]));
    const evidence = new Map<string, CveEvidence>();
    for (const [repository, scan] of scanned) {
      evidence.set(repository, {
        ...scan,
        ...countedCves(perRepository.get(repository) ?? []),
        // The stored grain, not the number of distinct tuples that survived the `DISTINCT` above.
        occurrences: counted.get(repository) ?? 0
      });
    }
    return evidence;
  } catch (error) {
    throw new StorageError("could not read the stored CVE evidence", error);
  }
}
