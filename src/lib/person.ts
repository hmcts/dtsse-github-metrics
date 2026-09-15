/**
 * How a contributor is NAMED, wherever the site names one.
 *
 * The dashboard showed the bare login everywhere until now, and a login is not what a reader is looking for: they
 * are looking for a person. So a row that carries a profile name shows it, and a row that does not shows the
 * login — see `Contributor` in `lib/types.ts` for why that is 58% of the organisation and why there is no third
 * tier to fall back to.
 *
 * TWO FORMS, ONE RULE ABOUT WHICH NAME WINS. `contributorLabel` is what a table cell leads on and what its column
 * sorts by; `contributorEntry` is the same answer written for somewhere that has no second line to put a login on.
 * Both read `name ?? login` and neither invents anything, which is the part that must not be duplicated: a page
 * showing a name where an export shows a login would read as two different people.
 *
 * NEITHER EVER RETURNS AN EMPTY STRING. `Contributor.name` is absent rather than blank by the time it reaches
 * here — the report layer trims and drops — and these fall back to `login`, which is required on every row. That
 * is the same shape the team card's " contributors" bug had: a template literal over a value nobody guaranteed.
 */

import type { Contributor } from "@/lib/types";

/** What a cell leads on and what its column sorts by: the person's name, or their login where GitHub holds none. */
export function contributorLabel(person: Contributor): string {
  return person.name ?? person.login;
}

/**
 * One person written as a single value, for a place with no room for a second line.
 *
 * THE LOGIN IS KEPT rather than dropped, and in the same parentheses whichever way round the reader meets it: a
 * name says who somebody is and a login is what joins them to GitHub, a commit and every other report. A cell
 * carrying only "Paris Freire" cannot be looked up, and one carrying only `parisfreire` is what this change was
 * asked to fix — so a named person carries both and an unnamed one carries the one thing there is.
 */
export function contributorEntry(person: Contributor): string {
  return person.name === undefined ? person.login : `${person.name} (${person.login})`;
}
