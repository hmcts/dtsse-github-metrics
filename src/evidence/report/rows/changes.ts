import type * as contract from "../../../lib/types.ts";
import { changeSize, eligibleChecks, eligibleReviews, isPassingCheck } from "../../behaviour/analysis.ts";
import type { Merges } from "../../domain/facts.ts";
import { stripAbsent } from "../absent.ts";

/**
 * Every merged pull request in the window, and every commit that reached a default branch without one.
 *
 * BUILT FOR THE ESTATE AND FILTERED PER TEAM, not built per team. A repository with two owning teams would
 * otherwise hold its merges twice, and `/teams/<team>` would pay a fresh walk of the fact cache on every render.
 * Held per revision like every other report, so the second reader of a span is free.
 *
 * Ordered newest first, which is the order both tables open in and the order a reader asks for — "what has this
 * team merged lately" rather than "what did it merge first".
 *
 * TIES ARE BROKEN ON THE DATA and not left to the order the facts happen to be held in. Two merges at the same
 * second are ordinary rather than exotic — measured on AAT, the four-week window's 7,375 merges include 62 sharing
 * 31 instants — and `Array.prototype.sort` is stable, so a tied pair came out in whatever order the fact map was
 * iterated. That order is a function of which repository the QUERY returned first, so one window built from a
 * 26-week read and the same window read for itself produced the same rows in a different sequence: identical as a
 * set, different as a report, and this is a table a reader diffs against last week's. `(repository, number)` and
 * `(repository, sha)` are unique, so the order below is now a function of the facts alone.
 */
export function builtMergeRows(facts: ReadonlyMap<string, Merges>): contract.TeamMergeRow[] {
  const rows: contract.TeamMergeRow[] = [];
  for (const [repository, merges] of facts) {
    for (const pullRequest of merges.pullRequests) {
      const size = changeSize(pullRequest);
      // GUARDED ON THE ARRAY'S PRESENCE, not on its contents, which is the same guard `timingMedians` keeps and for
      // its reason: `eligibleReviews` and `eligibleChecks` both call `.filter` on the stored array without checking
      // it is one, and the projection this reads through has been narrowed once already — so "every payload carries
      // every field" is a claim about history rather than a guarantee. An absent array is UNMEASURED; an empty one
      // is measured and found nothing, and the two must not render alike.
      const checks = Array.isArray(pullRequest.checks) ? eligibleChecks(pullRequest) : undefined;
      rows.push({
        repository,
        number: pullRequest.number,
        merged_at: pullRequest.mergedAt.toISOString(),
        author: pullRequest.authorLogin,
        ...(Array.isArray(pullRequest.reviews) ? { reviewed: eligibleReviews(pullRequest).length > 0 } : {}),
        // A check that finished before the merge, with nothing that finished having failed. An empty list is
        // `false` rather than absent: the merge was looked at and no check had reported on it.
        ...(checks === undefined ? {} : { ci: checks.length > 0 && checks.every((check) => isPassingCheck(check)) }),
        ...(size === undefined ? {} : { lines: size.lines, files: size.files })
      });
    }
  }
  return stripAbsent(
    rows.sort((left, right) => right.merged_at.localeCompare(left.merged_at) || left.repository.localeCompare(right.repository) || left.number - right.number)
  );
}

export function builtDirectPushRows(facts: ReadonlyMap<string, Merges>): contract.TeamDirectPushRow[] {
  const rows: contract.TeamDirectPushRow[] = [];
  for (const [repository, merges] of facts) {
    for (const commit of merges.directCommits) {
      const size = changeSize(commit);
      rows.push({
        repository,
        sha: commit.sha,
        committed_at: commit.committedAt.toISOString(),
        // The linked login where GitHub matched one, otherwise the git author name — the same fallback
        // `isHumanCommitAuthor` reads, and the reason a direct push can be attributed to a name and no account.
        author: commit.authorLogin ?? commit.authorName,
        ...(commit.checkState === undefined ? {} : { ci: commit.checkState.toLowerCase() === "success" }),
        ...(size === undefined ? {} : { lines: size.lines, files: size.files })
      });
    }
  }
  // Ties broken for `builtMergeRows`' reason, and on the repository FIRST: a sha is not unique across the estate
  // — `GAPS2` and `GAPS2-archive` hold the same commit — so ordering on the sha alone would still leave the pair
  // to the map's iteration order.
  return stripAbsent(
    rows.sort(
      (left, right) =>
        right.committed_at.localeCompare(left.committed_at) || left.repository.localeCompare(right.repository) || left.sha.localeCompare(right.sha)
    )
  );
}
