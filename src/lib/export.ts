/**
 * What the estate table exports: one row per repository, in the columns the reader is looking at.
 *
 * PURE, AND SEPARATE FROM THE BUTTON THAT DOWNLOADS IT, for the reason `lib/rows.ts` gives about filtering: this
 * is the part that can be wrong in a way nobody notices. A column reading the wrong criterion, or a cell that says
 * "No" where the page says a dash, is invisible in a file somebody opens in a spreadsheet a week later — where a
 * misplaced button is not.
 *
 * EVERY CELL IS THE WORD THE PAGE PRINTS, through the same functions the table's cells read: `day`, `answerWord`,
 * `alertAge`, `ASSURANCE_GRADE_LABEL`. A CSV that reported `met` where the page reads "Meets criteria", or an ISO
 * instant where the page reads a UTC day, would be a second rendering of the same window — which is the thing
 * `lib/format.ts` exists to prevent between this page and the text report.
 *
 * TWO COLUMNS THE TABLE DOES NOT HAVE, both about the owning team. `Team` is on the table already, and the estate
 * table's Team cell is the one place a reader cannot see who those people are: the team name links to a page that
 * lists them, which a spreadsheet cannot follow. So the contributors are unpacked into the row beside it.
 */

import { ABSENT, day } from "@/lib/format";
import { contributorEntry } from "@/lib/person";
import {
  ASSURANCE_CRITERIA,
  ASSURANCE_GRADE_LABEL,
  ASSURANCE_LABEL,
  alertAge,
  answerWord,
  criterionResult,
  foundOutcome,
  metOutcome,
  ownedByIndividual,
  SECRETS_CRITERION
} from "@/lib/rows";
import type { Contributor, RepositoryRow } from "@/lib/types";

/**
 * What separates one contributor from the next inside a single cell.
 *
 * The user's own suggestion, and the right one: a comma would be quoted by the writer and then read back as one
 * field by a human who splits the cell on commas anyway, and a team's contributors are up to a few dozen people
 * whose names contain spaces. A semicolon and a space is what a spreadsheet's own "split column" defaults offer.
 */
export const CONTRIBUTOR_SEPARATOR = "; ";

/**
 * The heading of each column, left to right.
 *
 * The criteria's headings are `ASSURANCE_LABEL`'s rather than restated, so a criterion added to the domain reaches
 * the file under the same name it reaches the table under — and cannot appear in one and be missing from the other,
 * which is the reason the table generates its own criterion columns instead of listing them.
 */
export const REPOSITORY_EXPORT_HEADINGS: readonly string[] = [
  "Team",
  "Team contributors",
  "Repository",
  "Detail",
  "Last pushed",
  "Visibility",
  ...ASSURANCE_CRITERIA.map((criterion) => ASSURANCE_LABEL[criterion]),
  "Production",
  "Assurance"
];

/**
 * One repository's cells, in the headings' order.
 *
 * `detail` is its own column here where the table draws it under the repository name. It is the sentence that says
 * why a row has no figures — "No merge activity in this window." — and it is also the field most likely to carry a
 * comma, which is what the writer's quoting is for.
 */
function repositoryExportRow(row: RepositoryRow, contributors: readonly Contributor[] | undefined): string[] {
  return [
    row.team,
    teamContributorCell(row, contributors),
    row.repository,
    row.detail ?? "",
    day(row.pushed_at),
    row.visibility ?? ABSENT,
    ...ASSURANCE_CRITERIA.map((criterion) => criterionCell(row, criterion)),
    answerWord(row.production),
    ASSURANCE_GRADE_LABEL[row.assurance?.grade ?? "unknown"]
  ];
}

/**
 * One criterion's cell: the same word its column prints, including the one column that answers inverted.
 *
 * `Secrets` states what was FOUND rather than whether the criterion passed, so the export inverts with it. Reading
 * every criterion the same way here would put "Yes" against a clean repository in the one column where Yes is the
 * bad answer — which is the exact confusion that column was reworded to remove.
 *
 * `patching` prints an AGE and no verdict, for the reason its cell gives: no SLA has been agreed, so the number is
 * the finding.
 */
function criterionCell(row: RepositoryRow, criterion: (typeof ASSURANCE_CRITERIA)[number]): string {
  if (criterion === "patching") {
    return alertAge(row.assurance?.oldest_severe_alert_days);
  }
  const outcome = criterionResult(row, criterion)?.outcome;
  return answerWord(criterion === SECRETS_CRITERION ? foundOutcome(outcome) : metOutcome(outcome));
}

/**
 * The owning team's contributors, unpacked into one cell.
 *
 * THE DASH AND THE EMPTY CELL SAY DIFFERENT THINGS, which is this codebase's rule everywhere else and is worth
 * keeping in a file somebody reports from. An individually-owned repository has NO TEAM, so there are no team
 * contributors to list and the cell reads a dash — the same mark the page uses for a question that does not apply.
 * A team-owned repository whose team nobody contributed to in this window reads EMPTY: the window was read and the
 * answer is nobody, which is a measurement rather than an absence.
 *
 * The unowned bucket keeps its contributors, as it keeps its team card: `unowned` is a reported destination with
 * repositories under it and people landing changes in them.
 */
function teamContributorCell(row: RepositoryRow, contributors: readonly Contributor[] | undefined): string {
  if (ownedByIndividual(row)) {
    return ABSENT;
  }
  return (contributors ?? []).map(contributorEntry).join(CONTRIBUTOR_SEPARATOR);
}

/**
 * The whole document as rows of strings, the heading row first.
 *
 * Takes the rows ALREADY FILTERED AND ORDERED, and re-filters nothing. The reader is looking at a table and this is
 * a copy of it: deciding the scope here as well as in the component would be two answers to "what is on screen",
 * and the one this file gave would be the one nobody could see.
 */
export function repositoryExportRows(rows: readonly RepositoryRow[], teamContributors: Readonly<Record<string, Contributor[]>>): string[][] {
  return [[...REPOSITORY_EXPORT_HEADINGS], ...rows.map((row) => repositoryExportRow(row, teamContributors[row.team]))];
}
