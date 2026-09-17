import type * as contract from "../../lib/types.ts";
import { OwnerKind } from "../org/graph.ts";
import { stripAbsent } from "./absent.ts";

/**
 * Each team's card, aggregated over the repositories it owns.
 *
 * PURE OVER THE ROWS THE BUILD ALREADY HOLDS. The cards are a fold of the estate rows and the two activity reports,
 * so nothing here reads the database: `servedCohort` was called for the team list here and again for the count in
 * the overview, which was two uncached queries against the change-versioned graph on every `/teams` render.
 */

/** What a merge or direct-push row is asked for the contributor count: which repository, and who landed it. */
export interface AttributedChange {
  repository: string;
  author?: string;
}

/** What the team aggregation reads off a repository row. */
interface TeamAggregableRow {
  /** Which repository the row is, so a team's holding can be matched against the window's activity. */
  repository: string;
  team?: string;
  teams?: string[];
  owner_kind?: string;
  readiness?: string;
  detail?: string;
  required_approving_reviews?: number;
  required_status_checks?: number;
  unreviewed_substantial?: string;
  merged_pull_requests?: number;
  direct_commits?: number;
  /**
   * How many substantial changes reached the default branch with no independent review, and out of how many.
   *
   * The COUNTS behind `unreviewed_substantial`, which is only the policy's verdict. A team page reporting
   * "8 of 24 clear" is reporting how many of its repositories were graded clear; what a reader then wants is how
   * many CHANGES went unreviewed, which is a different denominator and the one with teeth.
   */
  unreviewed_substantial_merges?: number;
  substantial_merges?: number;
  /** The median hours a merged pull request waited for its first independent review, where one was observed. */
  time_to_first_review_hours?: number;
  /** The median hours from ready-for-review to merge. */
  merge_cycle_time_hours?: number;
}

/**
 * Each cohort team's row.
 *
 * A repository counts for EVERY team that owns it, not only the one that happens to lead its row. The
 * consequence is deliberate and should not be "fixed": the team cards' repository counts now sum to MORE
 * than `overview.repositories`. A shared repository is one repository in the estate and a holding of two
 * teams, and both numbers are right.
 *
 * THE CONTRIBUTOR COUNT COMES FROM THE TWO ACTIVITY REPORTS and not from a second walk of the facts — they are
 * built beside the rows in the same cache entry, and deriving the count from the facts instead would be the drift
 * `authorsByRepository` records.
 *
 * `teams` is the cohort's list and never the configuration's. The file names only the teams somebody has
 * overridden an owner for, so iterating it would have reported a handful of cards for an estate of 154 teams.
 */
export function builtTeamRows(
  rows: readonly contract.RepositoryRow[],
  changes: readonly AttributedChange[],
  teams: readonly string[],
  names: ReadonlyMap<string, string>
): contract.TeamRow[] {
  const authors = authorsByRepository(changes);
  // A person-owned row belongs to no card, and is dropped here rather than left to miss every identifier by
  // luck: nothing stops a login matching a team slug, and one that did would put somebody's repository under
  // that team's count.
  const attributable = rows.filter((row) => row.owner_kind !== OwnerKind.Person);

  return stripAbsent(
    // ANNOTATED ON THE CALLBACK rather than on `stripAbsent` alone, which is what makes the contract's own excess
    // property check run: a return type on the outer function is satisfied by a wider object, where an annotated
    // literal is compared field for field. This is what catches a key the row emits and the contract does not name.
    teams.map((identifier): contract.TeamRow => {
      // `teams` is absent on the ordinary single-owner row, so fall back to the primary rather than treating
      // its absence as "owned by nobody".
      const owned = attributable.filter((row) => (row.teams ?? (row.team === undefined ? [] : [row.team])).includes(identifier));
      const labels: Record<string, number> = {};
      const contributors = new Set<string>();
      for (const row of owned) {
        if (row.readiness !== undefined) {
          labels[row.readiness] = (labels[row.readiness] ?? 0) + 1;
        }
        // Unioned across the team's repositories rather than summed, so somebody working in three of them is one
        // contributor to the team. A sum would be a count of rows dressed as a count of people.
        for (const author of authors.get(row.repository) ?? []) {
          contributors.add(author);
        }
      }
      return {
        team: identifier,
        // The slug IS the display name for most teams: only an overridden team has one in the file. Falling back
        // rather than prettifying the slug, because a generated title would read as a name somebody chose.
        display_name: names.get(identifier) ?? identifier,
        repositories: owned.length,
        // BOTH OF THESE ARE REQUIRED ON EVERY ROW. `src/app/teams/[team]/page.tsx` calls `.length` on
        // `TeamDetail.actors`, so omitting it is a TypeError caught as `notFound()` — which renders as a page
        // reporting "no such team" for a team that exists. `unavailable` is read by the readiness donut on the
        // same page and by `lib/team.ts`.
        //
        // `actors` IS A COUNT HERE, and a list one interface away: `TeamRow.actors` is a `number` while
        // `TeamDetail.actors` is a `TeamActorRow[]`. Two interfaces, one field name, and the double cast in
        // `src/lib/api.ts` means the compiler will not catch a confusion between them. `TeamsList` prints this
        // through `count(...)`, a template literal, so a value of the wrong shape degrades silently to a card
        // reading " contributors" with no figure — check the type this row declares, not the name.
        actors: contributors.size,
        unavailable: owned.filter((row) => row.detail !== undefined).length,
        practice: teamPractice(owned),
        labels
      };
    })
  );
}

/**
 * Who authored a reported change in each repository, case-folded.
 *
 * OFF THE EMITTED ROWS AND NOT THE FACTS, which is what makes a team card's count and the table on that team's own
 * page one answer rather than two: `teamActors` in `src/lib/api.ts` folds these same two reports for the page, and a
 * second derivation over the estate's facts would drift from it in two ways that are easy to miss —
 * `builtDirectPushRows` falls back to the git author name where GitHub matched no account, and `contributorLogins`,
 * which `builtActorRows` goes through, drops the logins it judges not to be people. Either difference would put a
 * number on a card that the table below it contradicts, and the ticket's own acceptance criterion is that the two
 * agree.
 *
 * FOLDED, because a GitHub login is unique case-insensitively and one person can appear spelled two ways across a
 * window's rows — the same fold `builtActorRows` and `teamActors` both make. An unattributed change is skipped
 * rather than counted as an anonymous contributor: it is one change nobody could attribute, not one more person.
 */
function authorsByRepository(changes: readonly AttributedChange[]): Map<string, Set<string>> {
  const authors = new Map<string, Set<string>>();
  for (const change of changes) {
    if (change.author === undefined) {
      continue;
    }
    const seen = authors.get(change.repository) ?? new Set<string>();
    seen.add(change.author.toLowerCase());
    authors.set(change.repository, seen);
  }
  return authors;
}

/**
 * How one team works, aggregated over the repositories it owns.
 *
 * PROPORTIONS OF A STATED DENOMINATOR, and not a score. Three shapes were possible — a count, a proportion, or a
 * worst-case — and the choice matters because `TeamsList` is explicit that there is "no combined team label and no
 * team score", and that ordering teams by a label count would be a ranking. So:
 *
 *   • NOT A WORST CASE. "This team's weakest repository requires no review" reduces a team to its worst holding,
 *     which is a grade in everything but name, and it makes a team of forty repositories look worse than a team
 *     of one for holding the same lapse.
 *   • NOT A BARE COUNT ALONE. "12 enforce review" says nothing without the 40 beside it.
 *   • A COUNT OVER A DENOMINATOR, which is what the readiness distribution already does on the same page: it
 *     states how many of a team's repositories are in each state and stops. A reader compares 12 of 40 with
 *     38 of 40 themselves, and nothing here computes a share, a percentage or a position.
 *
 * `measured` is the denominator and is NOT the team's repository count: a repository whose gate GitHub withheld
 * has no answer, and dividing by the holding would report an unreadable gate as a repository that fails. Where a
 * figure is unmeasured for every repository the count is absent rather than zero, which `stripAbsent` then drops.
 *
 * NOTHING HERE IS ORDERED BY, which `cohortTeams` guarantees rather than this function: the cards arrive
 * largest-holding-first and that is a count of what a team is on the hook for, not a grade.
 */
function teamPractice(owned: readonly TeamAggregableRow[]): contract.TeamPractice {
  const reviewed = owned.filter((row) => row.required_approving_reviews !== undefined);
  const checked = owned.filter((row) => row.required_status_checks !== undefined);
  const graded = owned.filter((row) => row.unreviewed_substantial !== undefined);
  return {
    // How many of the team's gates were readable at all, so every figure below has its denominator stated.
    gates_measured: reviewed.length,
    enforces_review: reviewed.filter((row) => (row.required_approving_reviews ?? 0) >= 1).length,
    checks_measured: checked.length,
    enforces_checks: checked.filter((row) => (row.required_status_checks ?? 0) >= 1).length,
    // The policy's own verdict on unreviewed substantial merging, counted in its own three words rather than
    // folded into a pass and a fail: `within` is the allowance forgiving what it was configured to forgive,
    // which is a different fact from nothing having merged unreviewed at all.
    unreviewed_measured: graded.length,
    unreviewed_clear: graded.filter((row) => row.unreviewed_substantial === "none").length,
    unreviewed_within: graded.filter((row) => row.unreviewed_substantial === "within").length,
    unreviewed_above: graded.filter((row) => row.unreviewed_substantial === "above").length,
    // THE CHANGES rather than the repositories, which is a different denominator and the one with teeth. The four
    // figures above count how many of a team's repositories the policy graded clear; these count how many
    // substantial changes actually reached the default branch unreviewed. A team can be "8 of 24 clear" and have
    // two unreviewed merges or two hundred.
    unreviewed_substantial_merges: owned.reduce((total, row) => total + (row.unreviewed_substantial_merges ?? 0), 0),
    substantial_merges: owned.reduce((total, row) => total + (row.substantial_merges ?? 0), 0),
    // Throughput, stated because the figures above are unreadable without it: 2 of 40 gates unenforced reads
    // differently for a team that merged 400 changes and one that merged none.
    merged_pull_requests: owned.reduce((total, row) => total + (row.merged_pull_requests ?? 0), 0),
    direct_commits: owned.reduce((total, row) => total + (row.direct_commits ?? 0), 0),
    ...timings(owned)
  };
}

/**
 * The two timing medians, aggregated across a team's repositories.
 *
 * A MEDIAN OF MEDIANS, and it is worth being honest about what that is: it is not the median wait across the
 * team's changes, which would need every per-change value rather than each repository's summary. It is the typical
 * repository's typical wait. That is the figure a reader of a TEAM page actually wants — one repository with a
 * three-week review does not become the team's story — and it is what the per-repository medians can support
 * without re-deriving the whole cohort here.
 *
 * The alternative, a mean of medians, was rejected for the reason the metrics themselves read at the median: one
 * stalled repository would drag the team's figure and the page would report a number no repository experienced.
 *
 * ABSENT WHERE NO REPOSITORY REPORTED ONE, rather than zero. A team whose repositories all had too few reviews to
 * measure has no wait to report, and `0 hours` would read as instant review.
 */
function timings(owned: readonly TeamAggregableRow[]): Pick<contract.TeamPractice, "time_to_first_review_hours" | "merge_cycle_time_hours"> {
  const median = (values: number[]): number | undefined => {
    if (values.length === 0) {
      return undefined;
    }
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    // The mean of the two central values on an even count, which is the definition `distribution` in
    // `behaviour/metrics.ts` uses — so a team of one repository reports exactly that repository's own figure.
    return sorted.length % 2 === 1 ? (sorted[middle] as number) : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
  };
  return {
    time_to_first_review_hours: median(owned.map((row) => row.time_to_first_review_hours).filter((hours): hours is number => hours !== undefined)),
    merge_cycle_time_hours: median(owned.map((row) => row.merge_cycle_time_hours).filter((hours): hours is number => hours !== undefined))
  };
}
