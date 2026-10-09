/**
 * Where a filter box navigates to when its term changes.
 *
 * A pure function because the interesting part is which parameters survive the navigation. The term
 * lives in the URL so a filtered table can be reloaded, bookmarked and shared, and the rest of the
 * query — above all `weeks`, which every page is read at — has to come through untouched.
 *
 * The caller passes the live `window.location.search` rather than Next's `useSearchParams`, which
 * catches up a React transition later — so a parameter the control beside it wrote a moment ago is
 * already in `window.location` and not yet in the hook. Reading the hook here would silently drop it.
 */

export function filterTarget(pathname: string, search: string, parameter: string, term: string): string {
  const parameters = new URLSearchParams(search);
  const trimmed = term.trim();
  if (trimmed === "") {
    // An empty box means "no filter", which is the parameter's absence — not `?filter=`, which would
    // read back as a filter for the empty string on the next render.
    parameters.delete(parameter);
  } else {
    parameters.set(parameter, trimmed);
  }
  const query = parameters.toString();
  return query === "" ? pathname : `${pathname}?${query}`;
}

/** Case-insensitive substring match, the comparison every filter box on the site makes. */
export function matches(text: string, term: string): boolean {
  return text.toLocaleLowerCase().includes(term.trim().toLocaleLowerCase());
}

/** The parameter the `/teams` filter box writes, which `TeamsList` reads back. */
export const TEAM_TERM_PARAMETER = "team";

/** The parameter the `/contributors` filter box writes, which `ActorsTable` reads back. */
export const CONTRIBUTOR_TERM_PARAMETER = "contributor";

/**
 * Whether any of a row's names holds the term, an empty term holding everything.
 *
 * Every name a reader might know a team or a person by — a team's slug and display name, a contributor's login and
 * profile name — so a reader who knows "Civil" finds `civil-admins`, and one who knows a person's name finds their
 * login. An absent name is skipped rather than matched as an empty string.
 */
export function matchesAny(names: readonly (string | undefined)[], term: string): boolean {
  return term.trim() === "" || names.some((name) => name !== undefined && matches(name, term));
}
