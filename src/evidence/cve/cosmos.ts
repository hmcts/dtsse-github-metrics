import { CosmosClient } from "@azure/cosmos";
import { CVE_BRANCH, CVE_CONTAINER, type CveDatabase, type CveDocument } from "./collect.ts";

/**
 * Reading the published CVE reports out of the `pipeline-metrics` Cosmos account.
 *
 * THE I/O AND NOTHING ELSE. Everything that decides what a report MEANS is in `./reports.ts` and `./collect.ts`,
 * which are pure and held at the unit bar; this module is excluded from coverage for `store/**`'s reason — it is
 * a driver call, and a test of it is a test of `@azure/cosmos`.
 *
 * BOTH DATABASES, ALWAYS. `CosmosDbTargetResolver` in `cnp-jenkins-library` picks the database from the
 * repository's GitHub topics: `jenkins-sds` routes to `sds-jenkins` and everything else defaults to `jenkins`.
 * Measured 2026-09-18, the 361 repositories with a `master` report divide 316 in `jenkins`, 55 in `sds-jenkins`
 * and 10 in BOTH — so reading only `jenkins` would report **45 repositories** as never scanned while looking like
 * a complete collection. That is the failure the acceptance criteria name.
 *
 * THE TEN IN BOTH ARE REPOSITORIES THAT MOVED, not a routing bug: `pre-api`, `opal-fines-service`, `opal-frontend`
 * and seven others gained the `jenkins-sds` topic, so their historic reports sit in `jenkins` and their current
 * ones in `sds-jenkins`. The store's key deliberately does NOT include the database — see `CveScan` — so one
 * repository is one answer and the newest report wins whichever container it came from.
 *
 * A READ-ONLY ACCOUNT KEY, AND THE WEB POD DOES NOT HOLD IT. The collector CronJob mounts `cve-cosmos-account`
 * and `cve-cosmos-readonly-key`; the web pod's secret list is unchanged, because it contacts no external service
 * and that is deliberate. The key is read-only at the account level, which is wider than this needs — a Cosmos
 * data-plane RBAC role on the existing `dtsse` workload identity would be tighter and remove the stored secret
 * altogether, but it needs a role assignment on a production account and so is a platform ask.
 */

/** Where the account name and its read-only key arrive from, mounted by the collector's `keyVaults` block. */
export const CVE_ACCOUNT_VARIABLE = "CVE_COSMOS_ACCOUNT";
export const CVE_KEY_VARIABLE = "CVE_COSMOS_KEY";

export interface CveCredentials {
  endpoint: string;
  key: string;
}

/**
 * The account to read, or nothing where this process was not given one.
 *
 * NOTHING RATHER THAN A THROW, so the collection reports "no credential, nothing collected" and leaves every
 * repository reading exactly as it did. A missing secret must not be able to look like a clean estate, and it
 * cannot: with nothing read, nothing is written, and an unmeasured repository stays unmeasured.
 */
export function cveCredentials(env: Record<string, string | undefined> = process.env): CveCredentials | undefined {
  const account = env[CVE_ACCOUNT_VARIABLE]?.trim();
  const key = env[CVE_KEY_VARIABLE]?.trim();
  if (account === undefined || account === "" || key === undefined || key === "") {
    return undefined;
  }
  return { endpoint: `https://${account}.documents.azure.com:443/`, key };
}

/**
 * How many documents one page carries.
 *
 * SMALL BECAUSE A PAGE IS THE PEAK. Documents are capped at 2MB and a java report routinely runs to hundreds of
 * kilobytes, so a page IS the memory ceiling of this job — a thousand of them is most of a gigabyte held to save
 * round trips a daily read does not care about. A hundred bounds the page at roughly 200MB in the worst case the
 * publisher permits, which leaves the heap this job is given for the fold rather than for the transport. A first
 * run over all 171,407 `master` documents peaked at 540 MiB of RSS at this page size.
 */
const PAGE_SIZE = 100;

/**
 * One database's `master` reports written at or after `fromTs`, a page at a time.
 *
 * THE REPORT BODY IS THE ONLY LARGE THING IN THE DOCUMENT AND IT CANNOT BE PROJECTED AWAY — it is what the
 * findings are parsed out of — so the read is paged rather than fetched whole. `maxItemCount` bounds a page and
 * the generator yields document by document, so a run's peak memory is one page and the fold's accumulator rather
 * than 171,396 reports. A CALLER THAT COLLECTS THE GENERATOR INTO A LIST UNDOES ALL OF THAT: buffering one
 * database's documents reached 3.7 GB of RSS on a real run against a CronJob limit of 1Gi, which is why
 * `cveFolder` exists and why `runCveCollection` folds as it iterates.
 *
 * FILTERED ON `branch_name` IN THE QUERY AND NOT AFTER IT. Only 171,396 of the 762,779 documents are `master`;
 * the rest describe pull-request branches, and reading them to discard them would be four fifths of the transfer.
 */
export async function* readCveDocuments(credentials: CveCredentials, database: CveDatabase, fromTs: number | undefined): AsyncGenerator<CveDocument> {
  const client = new CosmosClient({ endpoint: credentials.endpoint, key: credentials.key });
  const container = client.database(database).container(CVE_CONTAINER);
  const predicate = fromTs === undefined ? "" : " AND c._ts >= @from";
  const iterator = container.items.query(
    {
      query: `SELECT c._ts, c.build.git_url, c.build.codebase_type, c.build.build_tag, c.report FROM c WHERE c.build.branch_name = @branch${predicate}`,
      parameters: [{ name: "@branch", value: CVE_BRANCH }, ...(fromTs === undefined ? [] : [{ name: "@from", value: fromTs }])]
    },
    { maxItemCount: PAGE_SIZE }
  );

  while (iterator.hasMoreResults()) {
    const { resources } = await iterator.fetchNext();
    for (const resource of resources) {
      const document = resource as { _ts?: unknown; git_url?: unknown; codebase_type?: unknown; build_tag?: unknown; report?: unknown };
      // A document with no `_ts` cannot be ordered against the watermark, so it is left out rather than dated
      // now — dating it now would make it the newest report for its repository for ever.
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
