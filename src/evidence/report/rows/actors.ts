import type * as contract from "../../../lib/types.ts";
import { contributorLogins } from "../../behaviour/analysis.ts";
import type { Merges } from "../../domain/facts.ts";
import { stripAbsent } from "../absent.ts";

/**
 * Where one readiness label sits in the order a combination is read in: best first, ungraded last.
 *
 * The same order `lib/rag.ts` gives the labels through `COMBINATION_DIGIT` — green 1, amber 2, red 3, and the
 * ungraded ones no digit at all. Restated here rather than imported, because the report layer does not read the
 * UI's RENDERING modules: `rag.ts`, `tone.ts` and `sort.ts` are colours, wording and table order, they are
 * bundled with the pages, and a report reaching into them would make what the JSON says depend on how a
 * component draws it. The CONTRACT is the exception and not a loophole — `src/lib/types.ts` is type-only, so
 * importing it adds no runtime edge and nothing to bundle, and it is the one module whose whole purpose is to
 * state what this layer emits.
 *
 * An unknown label sorts last rather than throwing, so a label added to the domain appears at the end of a badge
 * row instead of taking a page down.
 */
const READINESS_ORDER: readonly string[] = ["green", "amber", "red", "cannot_assess"];

function readinessRank(label: string): number {
  const rank = READINESS_ORDER.indexOf(label);
  return rank === -1 ? READINESS_ORDER.length : rank;
}

/**
 * Everyone who authored a merge into a reported repository, with the repositories they appeared in.
 *
 * GITHUB LOGINS AND NOTHING ELSE. No display name, no email, no directory lookup: the login is what the facts
 * carry, and it is the only identifier this report can stand behind. A person's name would have to come from
 * somewhere else and would go stale the moment they changed it.
 *
 * A COUNT AND A SET OF LABELS, never a metric. The scope boundary `lib/sort.ts` states is that people may not be
 * ranked, so this deliberately emits nothing two contributors could be ordered by — the repository count is
 * navigation ("where would I find them"), and the labels belong to their repositories rather than to them.
 *
 * `contributorLogins` rather than a rule of its own, so "who is a person" is answered once. It folds case because
 * a GitHub login is unique case-insensitively; the ORIGINAL spelling is kept alongside for display, because
 * lower-casing somebody's login on screen is a small wrongness with no upside.
 *
 * PURE OVER THE ROWS AND FACTS `buildEstateReports` already holds. It used to await `repositoryRows` for the
 * readiness labels and load the facts again for itself. Both are in hand by the time this is called, which is the
 * point of building the reports together — and it removes a report reading another report, which was one build
 * waiting on a second that shared its data.
 */
export function builtActorRows(
  rows: readonly contract.RepositoryRow[],
  facts: ReadonlyMap<string, Merges>,
  names: ReadonlyMap<string, string>,
  bots: ReadonlySet<string>
): contract.ActorRow[] {
  const readinessOf = new Map(rows.map((row) => [row.repository, row.readiness]));
  const spelling = new Map<string, string>();
  const appearances = new Map<string, Set<string>>();

  for (const [repository, merges] of facts) {
    const changes = [...merges.pullRequests, ...merges.directCommits];
    for (const change of changes) {
      // First spelling seen wins. Any is as good as any other — GitHub is case-insensitive on logins — and
      // picking one deterministically keeps the rows stable between builds.
      const login = change.authorLogin;
      if (login !== undefined && !spelling.has(login.toLowerCase())) {
        spelling.set(login.toLowerCase(), login);
      }
    }
    for (const login of contributorLogins(changes, bots)) {
      const seen = appearances.get(login) ?? new Set<string>();
      seen.add(repository);
      appearances.set(login, seen);
    }
  }

  const actors = [...appearances.entries()].map(([login, repositories]): contract.ActorRow => {
    // Their repositories' labels, deduplicated, in the estate's own order rather than discovery order: the
    // contributor row RENDERS them in the order sent, so two people carrying the same set must be shown the
    // same badges in the same sequence.
    //
    // A bare `.sort()` did this alphabetically until 2026-09-15 — `amber, cannot_assess, green, red`, which is
    // neither the order the labels mean anything in nor stable across locales. `combinationKey` normalises the
    // SORT key on its own, so this order was only ever the rendered one, and alphabetical was the wrong choice
    // for it.
    const labels = [...new Set([...repositories].map((repository) => readinessOf.get(repository)).filter((label) => label !== undefined))].sort(
      (left, right) => readinessRank(left) - readinessRank(right)
    );
    return {
      login: spelling.get(login) ?? login,
      // `login` here is already folded, which is what the name map is keyed on. Absent for the 58% of the
      // organisation who have set no profile name, and `stripAbsent` below drops the key rather than sending an
      // empty string a cell would render as a blank line.
      name: names.get(login),
      repositories: repositories.size,
      ...(labels.length === 0 ? {} : { labels })
    };
  });

  // Alphabetical, case-insensitively, which is the order `ActorsTable` documents it receives and keeps for ties.
  return stripAbsent(actors.sort((left, right) => left.login.toLowerCase().localeCompare(right.login.toLowerCase())));
}
