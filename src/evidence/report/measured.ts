import { EvidenceSource } from "../domain/coverage.ts";
import type { CohortEntry } from "../org/cohort.ts";

/**
 * Which repositories a collection actually READ each behaviour source for.
 *
 * The one answer the whole absent-versus-zero rule rests on, and pure over the coverage edges so that it can be
 * asserted without a `source_coverage` table: `./estate.ts` does the read and hands the edges here.
 */

/** Whether each of one repository's two behaviour sources was read. See `measuredSources`. */
export interface MeasuredRow {
  pullRequests: boolean;
  directCommits: boolean;
}

/** The repositories each behaviour source was read for, by the collection every span derived here is anchored at. */
export interface MeasuredSources {
  pullRequests: Set<string>;
  directCommits: Set<string>;
}

/**
 * Which repositories each source was READ for, over the window every span derived from one read shares.
 *
 * WAS IT MEASURED, NOT WAS IT COLLECTABLE, and that distinction is the whole of this function. A collection
 * records coverage only for what it actually walked, so a repository whose merge walk was refused — `FORBIDDEN:
 * Resource not accessible by integration`, a 502, an exhausted rate limit — leaves a `repository_state` row and
 * no coverage, and one on the stale path never walks at all. Neither holds a merge history anybody fetched, and
 * `0 merged pull requests` on either is a measurement nobody made. Gating on the collection POLICY instead would
 * answer for the second and miss the first.
 *
 * READ UP TO THE ANCHOR, rather than covering the span, and the weaker test is the correct one here. Collection
 * fills `lookback.operational_days` — 90 days, against a widest offered span of 26 weeks — so no repository's
 * coverage contains a long window, and asking for containment would report the whole estate as unmeasured at 12
 * and 26 weeks. What a report can ask is whether the last run to reach the estate reached THIS repository:
 * `endsAt` is the modal edge `collectedAnchor` snapped to, so a repository that run walked sits at that edge or
 * past it and one it did not sits behind. That is the property `modalEdge` was chosen for — it holds the anchor
 * still against a straggler and against a minority collected ahead — so falling short of it says something
 * about a repository rather than about arithmetic.
 *
 * The residual `modalEdge` already names is inherited and not introduced: a `collect` that dies past halfway
 * moves the mode, and the repositories it never reached report their merges as unmeasured until the next run
 * reaches them. Unmeasured is what they are.
 *
 * `cohort.no_direct_pushes` IS THE ONE EXCEPTION, and it is a declaration rather than a second reading of the
 * coverage table: a repository named there counts as read for its direct commits whatever was walked, because
 * somebody has stated that no person pushes to its default branch. The gate cannot be inferred from the branch
 * ruleset instead — 91 of the 413 repositories on this estate whose default branch requires a pull request still
 * hold direct-commit facts — and it is not inferred from the facts either, since having none is exactly the state
 * an unread walk and an empty one share. It permits the figure; the facts still supply it.
 */
export function measuredSources(
  edges: ReadonlyMap<string, ReadonlyMap<string, Date>>,
  endsAt: Date,
  cohort: readonly CohortEntry[],
  noDirectPushes: readonly string[]
): MeasuredSources {
  const measured: MeasuredSources = { pullRequests: new Set<string>(), directCommits: new Set<string>() };
  for (const [repository, bySource] of edges) {
    if (reachesAnchor(bySource.get(EvidenceSource.PullRequests), endsAt)) {
      measured.pullRequests.add(repository);
    }
    if (reachesAnchor(bySource.get(EvidenceSource.DirectCommits), endsAt)) {
      measured.directCommits.add(repository);
    }
  }
  // Resolved through the cohort so the set holds the repository's OWN spelling, which is what both readers of it
  // look up by, and so the comparison folds on both sides: the configured name is typed by hand and the
  // repository's is not, and adding a hand-typed name directly would leave a mis-cased one matching nothing.
  const declared = new Set(noDirectPushes.map((repository) => repository.toLowerCase()));
  for (const entry of cohort) {
    if (declared.has(entry.repository.toLowerCase())) {
      measured.directCommits.add(entry.repository);
    }
  }
  return measured;
}

function reachesAnchor(edge: Date | undefined, endsAt: Date): boolean {
  return edge !== undefined && edge.getTime() >= endsAt.getTime();
}
