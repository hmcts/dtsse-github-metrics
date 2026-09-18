import type { CveFinding } from "../domain/cves.ts";
import { byCodePoint } from "../org/graph.ts";
import { repositoryFromGitUrl } from "./identity.ts";
import { cveFindings, distinctFindings } from "./reports.ts";

/**
 * Folding a stream of published reports into one scan per repository per language.
 *
 * PURE OVER WHAT IT IS HANDED, so the whole of "which document wins, and what is dropped" is held to the unit
 * bar rather than needing a Cosmos account to exercise. `./cosmos.ts` is the reader that supplies the documents
 * and `../store/cve.ts` is what writes the result; neither decision is made here.
 */

/** The two databases `CosmosDbTargetResolver` routes a build to, and the container both hold the reports in. */
export const CVE_DATABASES = ["jenkins", "sds-jenkins"] as const;

export type CveDatabase = (typeof CVE_DATABASES)[number];

export const CVE_CONTAINER = "cve-reports";

/** The branch a report has to be from. A report of a pull request branch describes a proposal, not the estate. */
export const CVE_BRANCH = "master";

/** One published report, in the shape the reader hands it over. */
export interface CveDocument {
  database: string;
  /** Cosmos's own `_ts`, in seconds, which is the only ordering the container offers. */
  ts: number;
  gitUrl: unknown;
  codebaseType: unknown;
  buildTag?: unknown;
  report: unknown;
}

/** One repository's latest scan of one language, ready to be written. */
export interface CveScan {
  organization: string;
  repository: string;
  codebaseType: string;
  sourceDatabase: string;
  /** When the report this came from was written, taken from the document's `_ts`. */
  reportedAt: Date;
  buildTag?: string;
  findings: CveFinding[];
}

/** What a fold dropped and why, so a run reports its own blind spots rather than only its successes. */
export interface CveSkips {
  /** Reports whose `build.git_url` names no GitHub repository, so nothing could be attributed. */
  unattributable: number;
  /** Reports whose `build.codebase_type` has no parser. NOT recorded as scans — see `cveFindings`. */
  unreadable: number;
  /** The `codebase_type` values that were unreadable, so a new publishing builder is named rather than counted. */
  unreadableTypes: string[];
}

export interface CveFold {
  scans: CveScan[];
  skipped: CveSkips;
}

/**
 * A fold in progress, so documents can be reduced as they stream rather than after they have all arrived.
 *
 * STATEFUL BECAUSE THE ALTERNATIVE DOES NOT FIT IN A POD. Buffering the read and folding it afterwards is the
 * obvious shape and it is unrunnable here: the report body cannot be projected away — it is what the findings are
 * parsed out of — so a list of one database's 107,010 `master` documents is the whole scan output of the estate
 * held at once. Measured on a real run, that reached 3.7 GB of RSS before it had finished the first database,
 * against a CronJob limit of 1Gi. Folded as they arrive, the peak is one page plus the 362 scans that survive.
 */
export interface CveFolder {
  add(document: CveDocument): void;
  /** The scans and the skips as they stand. Reading it does not end the fold. */
  fold(): CveFold;
}

/**
 * A fold that keeps the newest report per repository per language, and counts what it could not read.
 *
 * ONE SCAN PER `(repository, codebaseType)` AND NOT PER BUILD. A repository builds several times a day and each
 * build publishes a whole report, so the container holds 762,779 documents describing 361 repositories. What a
 * dashboard reports is the current position, which is the latest report and not a history — and keeping a history
 * would mean storing the same few thousand findings again every day for the life of the estate.
 *
 * PER LANGUAGE AND NOT PER REPOSITORY, because a repository whose pipeline publishes both a `java` and a `node`
 * report is scanned twice and the two reports do not supersede one another. Folding on repository alone would
 * leave whichever built last as the only answer and silently drop the other language's findings.
 *
 * TIES GO TO THE INCUMBENT. `_ts` has one-second resolution and two builds of one repository can land inside the
 * same second; either is a defensible answer and picking one deterministically is what stops a re-run producing a
 * different result from the same documents.
 *
 * THE FINDINGS ARE PARSED ON ARRIVAL AND THE REPORT BODY IS DROPPED. That is what bounds the accumulator: a
 * superseded document's findings are replaced rather than kept, and no report body is retained at all.
 */
export function cveFolder(): CveFolder {
  const scans = new Map<string, CveScan>();
  const unreadableTypes = new Set<string>();
  let unattributable = 0;
  let unreadable = 0;

  return {
    add(document: CveDocument): void {
      const identity = repositoryFromGitUrl(document.gitUrl);
      if (identity === undefined) {
        unattributable += 1;
        return;
      }
      const findings = cveFindings(document.codebaseType, document.report);
      if (findings === undefined) {
        // NOT RECORDED AS A SCAN. A report nothing here can read leaves the repository unmeasured, which is the
        // honest answer and the one a fourth publishing builder should produce until somebody writes its parser.
        unreadable += 1;
        unreadableTypes.add(typeof document.codebaseType === "string" ? document.codebaseType : "(absent)");
        return;
      }
      const codebaseType = document.codebaseType as string;
      const key = `${identity.organization}/${identity.repository}/${codebaseType}`;
      const existing = scans.get(key);
      const reportedAt = new Date(document.ts * 1000);
      if (existing !== undefined && existing.reportedAt.getTime() >= reportedAt.getTime()) {
        return;
      }
      scans.set(key, {
        ...identity,
        codebaseType,
        sourceDatabase: document.database,
        reportedAt,
        ...(typeof document.buildTag === "string" ? { buildTag: document.buildTag } : {}),
        findings: distinctFindings(findings)
      });
    },
    fold(): CveFold {
      // `byCodePoint` AND NOT A BARE `.sort()`, which is this repository's stated convention — see its own
      // comment, and `CONTRIBUTING.md`. The order only has to be stable so a run's summary line reads the same
      // way twice, and a comparator says that rather than leaving a reader to wonder which collation applied.
      return { scans: [...scans.values()], skipped: { unattributable, unreadable, unreadableTypes: [...unreadableTypes].sort(byCodePoint) } };
    }
  };
}

/** A whole fold over documents already in hand, which is how the unit suite exercises `cveFolder`. */
export function foldCveDocuments(documents: Iterable<CveDocument>): CveFold {
  const folder = cveFolder();
  for (const document of documents) {
    folder.add(document);
  }
  return folder.fold();
}

/**
 * How far back a database has to be re-read, given what was stored last time.
 *
 * `>=` AND NOT `>`, which costs one second of documents re-read and buys correctness. Cosmos `_ts` is
 * second-granular, so a document written in the same second as the newest one already stored would be skipped
 * for ever by a strict predicate. Re-reading them is free of consequence because the write is an upsert keyed on
 * the repository and its language: the same document folded twice produces the same scan.
 *
 * NOTHING STORED MEANS READ EVERYTHING. The first run scans every `master` document in both databases — 171,396
 * of them, measured 2026-09-18 — with the report bodies projected away, and every run after it reads one day.
 */
export function readFrom(watermark: Date | undefined): number | undefined {
  return watermark === undefined ? undefined : Math.floor(watermark.getTime() / 1000);
}
