import { CosmosClient } from "@azure/cosmos";
import { CVE_CONTAINER, type CveDatabase, type CveDocument } from "./collect.ts";
import type { CveCredentials } from "./credentials.ts";
import { CVE_PAGE_SIZE, cveDocumentQuery, cveDocumentsFrom } from "./documents.ts";

/**
 * The one call that reaches the `pipeline-metrics` Cosmos account.
 *
 * THE DRIVER CALL AND NOTHING ELSE, which is why this module is the only part of `cve/**` excluded from coverage —
 * a test of it is a test of `@azure/cosmos`. Everything that decides anything lives next door and is tested:
 * `./credentials.ts` resolves the account, `./documents.ts` holds the query and the per-document guard,
 * `./reports.ts` parses a report and `./collect.ts` folds the stream.
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
export async function* readCveDocuments(credentials: CveCredentials, database: CveDatabase, fromTs: number | undefined): AsyncGenerator<CveDocument> {
  const client = new CosmosClient({ endpoint: credentials.endpoint, key: credentials.key });
  const iterator = client.database(database).container(CVE_CONTAINER).items.query(cveDocumentQuery(fromTs), { maxItemCount: CVE_PAGE_SIZE });
  const pages = async function* (): AsyncGenerator<unknown[]> {
    while (iterator.hasMoreResults()) {
      yield (await iterator.fetchNext()).resources;
    }
  };
  yield* cveDocumentsFrom(pages(), database);
}
