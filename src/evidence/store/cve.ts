import type { CveScan } from "../cve/collect.ts";
import { type CveEvidence, type CveSeverityBucket, cveSeverity, UNKNOWN_SEVERITY } from "../domain/cves.ts";
import { prisma } from "./prisma.ts";
import { StorageError } from "./storage-error.ts";

/**
 * Where the published CVE reports are kept, and the two questions asked of them.
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
            score: finding.score ?? null
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
 * TWO AGGREGATED QUERIES FOR THE WHOLE ESTATE, on `storedRepositoryStates`' precedent. The findings are grouped
 * in the database rather than fetched and counted here: 362 scans hold about 30,500 findings between them, and
 * moving all of them into the estate read to fold them in JavaScript would be the largest thing on it for figures
 * that are counts. Counting in SQL is also what keeps the stored grain fine — see `CveFinding`'s note.
 *
 * SCANS ARE READ EVEN WHERE A REPOSITORY HAS NO FINDINGS, which is the reason this is two queries and not one
 * grouped join: a clean scan produces no finding rows at all, so a join would drop exactly the repositories whose
 * measured zero is the point.
 */
export async function storedCveEvidence(organization: string): Promise<Map<string, CveEvidence>> {
  const folded = organization.toLowerCase();
  try {
    const [scans, counts] = await Promise.all([
      prisma.cveScan.findMany({ where: { organization: folded }, select: { repository: true, codebaseType: true, reportedAt: true } }),
      prisma.cveFinding.groupBy({
        by: ["repository", "suppressed", "severity"],
        where: { organization: folded },
        _count: { _all: true }
      })
    ]);

    const evidence = new Map<string, CveEvidence>();
    for (const scan of scans) {
      const existing = evidence.get(scan.repository);
      if (existing === undefined) {
        evidence.set(scan.repository, { scannedAt: scan.reportedAt, codebaseTypes: [scan.codebaseType], live: {}, suppressed: {} });
        continue;
      }
      // A repository scanned in two languages carries both names and the NEWER instant, because that is what
      // "as at" means for a figure that sums the two.
      existing.codebaseTypes = [...existing.codebaseTypes, scan.codebaseType].sort();
      existing.scannedAt = scan.reportedAt > existing.scannedAt ? scan.reportedAt : existing.scannedAt;
    }

    for (const row of counts) {
      const entry = evidence.get(row.repository);
      if (entry === undefined) {
        // Unreachable while the foreign key holds: a finding cannot exist without its scan. Skipped rather
        // than counted, because a count with no scan behind it is the one thing that would let an unmeasured
        // repository report a figure.
        continue;
      }
      const counted = row.suppressed ? entry.suppressed : entry.live;
      const bucket: CveSeverityBucket = cveSeverity(row.severity) ?? UNKNOWN_SEVERITY;
      counted[bucket] = (counted[bucket] ?? 0) + row._count._all;
    }
    return evidence;
  } catch (error) {
    throw new StorageError("could not read the stored CVE evidence", error);
  }
}
