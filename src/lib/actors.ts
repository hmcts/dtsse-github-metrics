/**
 * Which of `/contributors`' rows the reader is looking at, and in what order.
 *
 * ONE ANSWER FOR THE TABLE AND THE EXPORT, for `RepositoriesExport`'s reason: the term, the readiness tile and the
 * civil-servant toggle all live in the URL, and a file that re-derived "what is on screen" its own way would be the
 * answer nobody could see. `ActorsTable` and `ContributorsExport` both filter through here.
 */

import { matchesCivilServant, parseCivilServantFilter } from "@/lib/civil-servant";
import { CONTRIBUTOR_TERM_PARAMETER, matchesAny } from "@/lib/filter";
import { combinationKey } from "@/lib/rag";
import { classify, contributorLabels, matchesReadiness, READINESS_PARAMETER } from "@/lib/readiness";
import { sorted } from "@/lib/sort";
import type { ActorRow } from "@/lib/types";

/** The rows the page's filters let through, in the order the service sent them. */
export function filterActors(rows: readonly ActorRow[], read: (parameter: string) => string | null, labelled: boolean): ActorRow[] {
  const term = read(CONTRIBUTOR_TERM_PARAMETER) ?? "";
  const readiness = read(READINESS_PARAMETER) ?? "";
  const civilServantsOnly = parseCivilServantFilter(read);
  return rows.filter(
    (row) =>
      matchesAny([row.login, row.name], term) &&
      matchesReadiness(classify(contributorLabels(row.labels, labelled)), readiness) &&
      matchesCivilServant(row, civilServantsOnly)
  );
}

/**
 * The order the table opens on: readiness ascending, all green first and the unlabelled last.
 *
 * The export cannot read the table's sort, which is component state, so it takes this one — only the sequence can
 * differ from a list somebody has re-sorted, never the rows.
 */
export function orderActors(rows: readonly ActorRow[]): ActorRow[] {
  return sorted(rows, (row) => combinationKey(row.labels), "ascending");
}
