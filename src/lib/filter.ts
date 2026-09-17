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
