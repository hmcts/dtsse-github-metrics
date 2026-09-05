import yaml from "js-yaml";

/**
 * The published list of repositories approved to deploy to production. Ported from `metrics.production`.
 *
 * HMCTS states that approval in ONE organisation-wide document, `environment-approvals.yml` in
 * `cnp-jenkins-config`, which the deployment pipeline reads to decide whether a repository may be promoted to
 * an environment at all. The `prod:` sequence in it is therefore the only public statement of which
 * repositories are production services, and it is what puts a `Production` badge on a row.
 *
 * THE FETCH CARRIES NO CREDENTIAL AND MUST NOT BE GIVEN ONE. The file is served by a public raw content host,
 * so a token would buy nothing and sending one to a host outside the GitHub API is a leak with no benefit.
 * Nothing in this module takes a client, a token or an environment.
 *
 * Every failure here is reported as `undefined` — NOT as an empty set. "The list could not be read" and "no
 * repository is approved for production" are different answers, and only one of them is ever true of this
 * organisation; collapsing the first into the second would quietly clear 250 badges on the day the content
 * host returned a 502.
 */

/** Pinned to `master` because that is the branch the pipeline itself reads. */
export const PRODUCTION_LIST_URL = "https://raw.githubusercontent.com/hmcts/cnp-jenkins-config/refs/heads/master/environment-approvals.yml";

/**
 * The one environment this project asks about.
 *
 * The document names others, and every one of them is ignored: a repository approved for `demo` or `ithc` is
 * not a production service.
 */
const PRODUCTION_ENVIRONMENT = "prod";

const REQUEST_TIMEOUT_MS = 30_000;
const REPOSITORY_KEY = "repo";

/** Reports a production list this build cannot read as a list of repositories. */
export class ProductionListError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProductionListError";
  }
}

/**
 * Reads one repository URL as a casefolded `owner/name` key.
 *
 * CASEFOLDING IS NOT OPTIONAL. The live document holds
 * `https://github.com/HMCTS/adoption-shared-infrastructure.git` among 200-odd otherwise lowercase `hmcts`
 * entries, so a case-sensitive comparison against a configured organisation would silently drop that
 * repository's badge — and GitHub owner and repository names are case-insensitive anyway, which makes the
 * fold a correction rather than a convenience.
 *
 * Returns `undefined` for anything that does not read as exactly an owner and a name, so a URL nobody can
 * interpret is skipped rather than becoming a pair that matches nothing.
 */
export function parseRepositoryUrl(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // A HOST IS REQUIRED. The `scp`-style `git@github.com:hmcts/bar-api.git` that a Git remote is often
    // written as has no parseable host, and treating the whole text as a path would split it into two parts
    // reading as the organisation `git@github.com:hmcts` — a pair that matches nothing, badges nothing, and
    // logs nothing, because a pair was returned. Refusing it here is what makes it one of the entries the
    // caller counts as unreadable.
    return undefined;
  }
  if (parsed.host === "") {
    return undefined;
  }
  const parts = parsed.pathname.split("/").filter((part) => part !== "");
  if (parts.length !== 2) {
    return undefined;
  }
  const [organization, repository] = parts as [string, string];
  const name = repository.endsWith(".git") ? repository.slice(0, -".git".length) : repository;
  return name === "" ? undefined : `${organization.toLowerCase()}/${name.toLowerCase()}`;
}

/** Reads one entry of the `prod:` sequence, returning `undefined` for one this build cannot read. */
export function entryRepository(entry: unknown): string | undefined {
  if (typeof entry !== "object" || entry === null) {
    return undefined;
  }
  const url = (entry as Record<string, unknown>)[REPOSITORY_KEY];
  return typeof url === "string" ? parseRepositoryUrl(url) : undefined;
}

/**
 * Reads the `prod:` sequence of one approvals document as casefolded `owner/name` keys.
 *
 * Every other top-level key is ignored: this asks one question of the document, and an environment that is
 * not production is not an answer to it.
 *
 * Throws if the document does not parse, is not a mapping, holds no `prod:` sequence, or holds one whose
 * every entry is unreadable. Deliberately NOT an empty set: those are the shapes that say the file was
 * reorganised, and a reorganised file must not be reported as an organisation that deploys nothing.
 */
export function parseProductionRepositories(document: string): Set<string> {
  let parsed: unknown;
  try {
    parsed = yaml.load(document, { json: true });
  } catch (error) {
    throw new ProductionListError(`the production list is not a YAML document: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ProductionListError(`the production list is not a mapping but a ${Array.isArray(parsed) ? "list" : typeof parsed}`);
  }
  const entries = (parsed as Record<string, unknown>)[PRODUCTION_ENVIRONMENT];
  if (!Array.isArray(entries)) {
    throw new ProductionListError(`the production list holds no '${PRODUCTION_ENVIRONMENT}' sequence`);
  }

  const repositories = new Set<string>();
  for (const entry of entries) {
    const key = entryRepository(entry);
    if (key === undefined) {
      // Debug rather than warning: the document is maintained by another team for another purpose, and one
      // entry this build cannot read is not a fault in the report.
      console.debug(`Ignoring an unreadable production list entry: ${JSON.stringify(entry)}`);
      continue;
    }
    repositories.add(key);
  }

  // ONE unreadable entry costs that entry; EVERY entry unreadable is the file having changed shape, and is
  // the same fault as a missing `prod:` key read one level down. The day the other team renames `repo:`,
  // each of 250 entries fails on its own and the parse would otherwise "succeed" with nothing in it —
  // serving a confident `false` to the whole estate, which is the one answer this module exists to refuse.
  // An explicitly EMPTY sequence is not this: it is a document stating that nothing is approved.
  if (entries.length > 0 && repositories.size === 0) {
    throw new ProductionListError(`no entry of the '${PRODUCTION_ENVIRONMENT}' sequence names a repository this build can read`);
  }
  return repositories;
}

/**
 * Fetches and parses the production list, returning `undefined` for any failure to read it.
 *
 * One unauthenticated GET. A network failure, a response that is not a 200, and a body that does not parse
 * are all the same answer to the caller — nobody could say which repositories are production services — and
 * each is logged at warning level, because a list that has been failing all day should be visible in the
 * log rather than only in the missing badges.
 */
export async function fetchProductionRepositories(url: string, fetchImpl: typeof globalThis.fetch = globalThis.fetch): Promise<Set<string> | undefined> {
  let response: Response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (error) {
    console.warn(`Could not fetch the production list from ${url}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
  if (response.status !== 200) {
    console.warn(`The production list at ${url} returned HTTP ${response.status}`);
    return undefined;
  }
  try {
    return parseProductionRepositories(await response.text());
  } catch (error) {
    console.warn(`Could not read the production list from ${url}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

/**
 * Whether one repository deploys to production, or `undefined` when the list could not be read.
 *
 * TRI-STATE, and the distinction is carried all the way to an absent JSON key: an unread list has said
 * nothing, while an empty list has said "nothing deploys to production". Reporting the first as `false`
 * would state a fact nobody observed.
 */
export function deploysToProduction(repositories: Set<string> | undefined, organization: string, repository: string): boolean | undefined {
  return repositories === undefined ? undefined : repositories.has(`${organization.toLowerCase()}/${repository.toLowerCase()}`);
}
