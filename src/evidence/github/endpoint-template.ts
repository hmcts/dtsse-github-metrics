/**
 * Normalising a URL into the endpoint it belongs to, so a run can be counted by it.
 *
 * Ported from `metrics.github.endpoint_template`. Without this, a collection of 1850 repositories
 * produces 1850 "endpoints" and no reader can take a total from the summary.
 */

/**
 * The path segments that name WHOSE repository or organisation a call is about.
 *
 * Every one of them is a value rather than a route, so counting them apart turns one endpoint read for
 * 1850 repositories into 1850 endpoints nobody can read a total from.
 */
const OWNED_PREFIXES: Record<string, readonly string[]> = {
  repos: ["{organization}", "{repository}"],
  orgs: ["{organization}"]
};

/**
 * The path segments whose SUCCESSOR is a value, and the placeholder each one's value takes.
 *
 * A branch name and a commit SHA are values the same way an organisation is, but neither is at a fixed
 * position and neither is all digits, so the two rules above miss them. The SHA matters most: it is
 * never repeated, so `GET /repos/{org}/{repo}/commits/{sha}` — the Sonar mapping's cheap confirmation,
 * issued once per repository declaring a key — would otherwise contribute one summary line per
 * repository, which is the exact fragmentation these placeholders exist to prevent.
 */
const NAMED_VALUES: Record<string, string> = { branches: "{branch}", commits: "{sha}" };

/**
 * The query parameters whose value is a POSITION in a list rather than a description of the call.
 *
 * Left alone, a paginated read fragments into one counted endpoint per page, and a Link header carrying
 * a cursor rather than a page number fragments it per repository. GraphQL never reaches this: it
 * collapses to its bare URL, and its cursors travel in the POST body.
 */
export const PAGINATION_PARAMETERS = new Set(["page", "after", "before", "cursor"]);

export function endpointTemplate(target: string): string {
  const url = new URL(target);
  const segments = url.pathname.replace(/^\/+|\/+$/g, "").split("/");

  if (segments.length === 1 && segments[0] === "graphql") {
    // Every GraphQL call is a POST to the same address, and the query naming what it asked for is in
    // the body.
    return `${url.origin}/graphql`;
  }

  const owned = OWNED_PREFIXES[segments[0] ?? ""] ?? [];
  const templated = segments.map((segment, position) => {
    if (position > 0 && position <= owned.length) {
      return owned[position - 1] as string;
    }
    if (/^\d+$/.test(segment)) {
      return "{id}";
    }
    const previous = position > 0 ? segments[position - 1] : undefined;
    if (previous !== undefined && previous in NAMED_VALUES) {
      return NAMED_VALUES[previous] as string;
    }
    return segment;
  });

  const query = [...url.searchParams.entries()].map(([name, value]) => (PAGINATION_PARAMETERS.has(name) ? `${name}={${name}}` : `${name}=${value}`)).join("&");

  return `${url.origin}/${templated.join("/")}${query === "" ? "" : `?${query}`}`;
}
