/**
 * How a civil servant is marked, wherever the site marks one, and the `/contributors` filter on it.
 *
 * The flag comes from the `civil_servants` table and only ever reads `true` — see `Contributor.civil_servant`.
 * The badge's ABSENCE IS NOT A CLAIM, as the production badge's is not: somebody with no badge is somebody nobody
 * has flagged.
 */

import type { Contributor } from "@/lib/types";

export const CIVIL_SERVANT_LABEL = "Civil servant";

/** Teal, which nothing else on the site uses: the RAG colours are grades and royal is production. */
export const CIVIL_SERVANT_BADGE = "bg-teal-950/60 text-teal-300 border border-teal-800";

export const CIVIL_SERVANT_TOGGLE_ACTIVE = "bg-teal-950/60 text-teal-300 ring-1 ring-teal-800";

export const CIVIL_SERVANT_TOGGLE_INACTIVE = "bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-slate-200";

export const CIVIL_SERVANT_DOT = "bg-teal-400";

/** The toggle's parameter on `/contributors`. */
export const CIVIL_SERVANT_PARAMETER = "civil-servants";

/** The only value the toggle writes, and so the only one that reads back as on — `PRODUCTION_VALUE`'s rule. */
export const CIVIL_SERVANT_VALUE = "true";

/** Whether the civil-servant filter is on, read off the URL. */
export function parseCivilServantFilter(read: (parameter: string) => string | null): boolean {
  return read(CIVIL_SERVANT_PARAMETER) === CIVIL_SERVANT_VALUE;
}

/** Whether a row passes the filter: everybody while it is off, only the flagged while it is on. */
export function matchesCivilServant(person: Contributor, only: boolean): boolean {
  return !only || person.civil_servant === true;
}
