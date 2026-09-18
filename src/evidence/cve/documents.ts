import { CVE_BRANCH, type CveDocument } from "./collect.ts";

/**
 * What to ask the container for, and how to read what comes back.
 *
 * SEPARATE FROM `./cosmos.ts` SO IT IS TESTED. The query text and the per-document guard below are decisions —
 * which branch is read, what happens to a document that cannot be ordered — and they were inside the driver call,
 * which is excluded from coverage because a test of it is a test of `@azure/cosmos`. Paging over an injected page
 * source needs no account at all.
 */

/**
 * How many documents one page carries.
 *
 * SMALL BECAUSE A PAGE IS THE PEAK. Documents are capped at 2MB and a java report routinely runs to hundreds of
 * kilobytes, so a page IS the memory ceiling of this job — a thousand of them is most of a gigabyte held to save
 * round trips a daily read does not care about. A hundred bounds the page at roughly 200MB in the worst case the
 * publisher permits, which leaves the heap this job is given for the fold rather than for the transport. A first
 * run over all 171,407 `master` documents peaked at 540 MiB of RSS at this page size.
 */
export const CVE_PAGE_SIZE = 100;

/** A Cosmos SQL query as the driver takes it. Declared here so the text is testable without a client. */
export interface CveQuery {
  query: string;
  parameters: { name: string; value: string | number }[];
}

/**
 * The query for one database's `master` reports, optionally from a watermark onwards.
 *
 * FILTERED ON `branch_name` IN THE QUERY AND NOT AFTER IT. Only 171,407 of the 762,779 documents are `master`;
 * the rest describe pull-request branches, and reading them to discard them would be four fifths of the transfer.
 *
 * THE REPORT BODY IS SELECTED BECAUSE IT CANNOT BE PROJECTED AWAY — it is what the findings are parsed out of.
 * That is why the read is paged rather than fetched whole; see `CVE_PAGE_SIZE`.
 *
 * PARAMETERISED, not interpolated. `fromTs` comes from a stored timestamp rather than from a person, but a query
 * assembled by hand is the kind of thing that stops being true the first time something else calls it.
 */
export function cveDocumentQuery(fromTs: number | undefined): CveQuery {
  const predicate = fromTs === undefined ? "" : " AND c._ts >= @from";
  return {
    query: `SELECT c._ts, c.build.git_url, c.build.codebase_type, c.build.build_tag, c.report FROM c WHERE c.build.branch_name = @branch${predicate}`,
    parameters: [{ name: "@branch", value: CVE_BRANCH }, ...(fromTs === undefined ? [] : [{ name: "@from", value: fromTs }])]
  };
}

/** One raw Cosmos document, in the shape the projection above returns it. */
interface RawCveDocument {
  _ts?: unknown;
  git_url?: unknown;
  codebase_type?: unknown;
  build_tag?: unknown;
  report?: unknown;
}

/**
 * Pages of raw documents read one document at a time.
 *
 * A GENERATOR OVER PAGES, so a run's peak memory is one page and the fold's accumulator rather than 171,407
 * reports. A CALLER THAT COLLECTS IT INTO A LIST UNDOES ALL OF THAT: buffering one database's documents reached
 * 3.7 GB of RSS on a real run against a CronJob limit of 1Gi, which is why `cveFolder` exists and why
 * `runCveCollection` folds as it iterates.
 */
export async function* cveDocumentsFrom(pages: AsyncIterable<unknown[]>, database: string): AsyncGenerator<CveDocument> {
  for await (const page of pages) {
    for (const resource of page) {
      const document = resource as RawCveDocument;
      // A document with no `_ts` cannot be ordered against the watermark, so it is left out rather than dated
      // now — dating it now would make it the newest report for its repository for ever, and no later build
      // could replace it.
      if (typeof document._ts !== "number") {
        continue;
      }
      yield {
        database,
        ts: document._ts,
        gitUrl: document.git_url,
        codebaseType: document.codebase_type,
        buildTag: document.build_tag,
        report: document.report
      };
    }
  }
}
