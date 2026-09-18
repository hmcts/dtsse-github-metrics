import type * as contract from "../../../lib/types.ts";
import { type CveEvidence, totalCount } from "../../domain/cves.ts";

/**
 * One repository's CVE position in the shape the UI declares, or the reason it has none.
 *
 * IN `report/contract/` for `./security.ts`'s reason: a pure function of its argument, so the suite that runs on
 * every build holds it rather than the integration run.
 *
 * THE TWO ANSWERS THIS DISTINGUISHES ARE THE WHOLE FEATURE. Only three CNP builders publish a CVE report, so 361
 * of roughly 1,890 repositories have ever had one — and a `0` shown against the other 1,529 would tell a reader
 * the estate is almost entirely free of known vulnerabilities when nothing has ever looked.
 */

/** What a repository with no published report reports instead of a figure. */
export const UNSCANNED_DETAIL = "the Jenkins security stage has published no CVE report for this repository";

/**
 * One repository's counts, or the detail saying nobody scanned it.
 *
 * `cves` PRESENT AND `detail` PRESENT ARE MUTUALLY EXCLUSIVE, which is what lets a component branch on one key.
 * Where `cves` is present both its figures are measured — including a `total` of `0`, which is the measured
 * nothing — so nothing inside it is ever absent for want of measurement. The measurement question is settled
 * one level up by which of the two keys arrived, exactly as `securityReport` settles it.
 */
export function cveReport(evidence: CveEvidence | undefined): contract.CveReport {
  if (evidence === undefined) {
    return { detail: UNSCANNED_DETAIL };
  }
  return {
    scanned_at: evidence.scannedAt.toISOString(),
    codebase_types: evidence.codebaseTypes,
    cves: {
      live: { total: totalCount(evidence.live), by_severity: evidence.live },
      suppressed: { total: totalCount(evidence.suppressed), by_severity: evidence.suppressed }
    }
  };
}
