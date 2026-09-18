/**
 * Whether this process was given a Cosmos account to read, and which.
 *
 * ITS OWN MODULE so it is a tested, covered decision rather than a few lines inside the driver call. It used to
 * sit in `./cosmos.ts`, which is excluded from coverage for `store/**`'s reason — and that exclusion then hid the
 * one decision in that file that a test can reach. What is left in `cosmos.ts` is `new CosmosClient(...)`.
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
 *
 * BLANK IS ABSENT. A Key Vault reference that resolved to an empty file satisfies "the variable is set" and
 * authenticates nothing, so it has to be the same answer as a variable nobody set.
 */
export function cveCredentials(env: Record<string, string | undefined> = process.env): CveCredentials | undefined {
  const account = env[CVE_ACCOUNT_VARIABLE]?.trim();
  const key = env[CVE_KEY_VARIABLE]?.trim();
  if (account === undefined || account === "" || key === undefined || key === "") {
    return undefined;
  }
  return { endpoint: `https://${account}.documents.azure.com:443/`, key };
}
