import type * as contract from "../../../lib/types.ts";
import type { ReadinessPolicy } from "../../assessment/assessment.ts";
import { mergeCycleTime, timeToFirstReview } from "../../behaviour/metrics.ts";
import type { Merges } from "../../domain/facts.ts";
import type { MergeGateReport } from "../../domain/merge-gate.ts";
import { medianOf } from "../contract/observation.ts";
import type { MeasuredRow } from "../measured.ts";

/**
 * What one repository's row states about the window, and why it states less than a full set.
 *
 * ABSENT MEANS UNMEASURED AND ZERO MEANS MEASURED-AS-NOTHING is the rule this whole module exists to apply, and it
 * is a decision about the two SOURCES rather than about the facts: which figures a window can honestly state
 * follows from whether anybody read the merge history, which `measuredSources` answers off the coverage table.
 */

/**
 * The figures a row states about its window, named as the seven fields of the row they land on.
 *
 * A `Pick` OF THE CONTRACT and not a shape of its own, so a field renamed on the row is a compile error here rather
 * than a key that stops appearing. All seven are optional on the row for one rule — absent means unmeasured — and
 * this function's whole job is to decide which of them the window can honestly state.
 */
export type BehaviourFigures = Pick<
  contract.RepositoryRow,
  | "merged_pull_requests"
  | "direct_commits"
  | "unreviewed_substantial"
  | "unreviewed_substantial_merges"
  | "substantial_merges"
  | "time_to_first_review_hours"
  | "merge_cycle_time_hours"
>;

/**
 * Everything the window's merge cohort supports, or nothing for a source that was not read.
 *
 * ABSENT MEANS UNMEASURED AND ZERO MEANS MEASURED-AS-NOTHING, applied to the figures where the difference is
 * invisible. A repository walked through a quiet window merged nothing and says `0`; one whose walk was refused
 * and one the stale path skipped merged an unknown amount, and a `0` on either is the estate's throughput
 * quietly counting a repository nobody read. `detail` below names which it was.
 *
 * THE TWO COUNTS ARE GATED INDEPENDENTLY, because they are two walks recording two coverage series: a repository
 * whose pull requests were refused and whose commits came back has one honest figure and one absence. The graded
 * figures need BOTH — `sufficient` counts merges and direct commits together, and a verdict over half a cohort
 * would be a finding about the half that answered.
 */
export function behaviourFigures(policy: ReadinessPolicy, merges: Merges, measured: MeasuredRow): BehaviourFigures {
  return {
    ...(measured.pullRequests ? { merged_pull_requests: merges.pullRequests.length } : {}),
    ...(measured.directCommits ? { direct_commits: merges.directCommits.length } : {}),
    ...(measured.pullRequests && measured.directCommits ? reviewDerivedFigures(policy, merges) : {})
  };
}

/**
 * Why a row carries less than a full set of figures, or nothing where it carries them all.
 *
 * WHAT `unavailable` COUNTS, on both pages that count it, and what the estate table prints under a repository's
 * name — so a reader meeting an empty Merged column is told whether nobody merged or nobody looked. Before this,
 * a refused merge walk left the whole row indistinguishable from a quiet repository: the only `detail` a
 * populated row could carry came from the merge gate, which is a separate REST call that usually succeeds.
 *
 * TWO INDEPENDENT ABSENCES, joined rather than ranked. An unread source and an unreadable gate are different
 * failures of different calls, a stale repository has both, and dropping either sentence would leave a figure on
 * the row with nothing to explain it.
 */
export function unreportedDetail(gate: MergeGateReport, measured: MeasuredRow): string | undefined {
  const unread = unreadSources(measured);
  const reasons = [...(unread === undefined ? [] : [unread]), ...(gate.gate === undefined && gate.detail !== undefined ? [gate.detail] : [])];
  return reasons.length === 0 ? undefined : reasons.join("; ");
}

/** Which merge sources went unread, as the sentence a reader of the row is owed. */
function unreadSources(measured: MeasuredRow): string | undefined {
  if (measured.pullRequests && measured.directCommits) {
    return undefined;
  }
  if (!measured.pullRequests && !measured.directCommits) {
    return "no merge history was read for this repository, so its merges are unmeasured rather than none";
  }
  return measured.pullRequests
    ? "the direct commits were not read for this repository, so they are unmeasured rather than none"
    : "the merged pull requests were not read for this repository, so they are unmeasured rather than none";
}

/**
 * The substantial-merge counts, or nothing where the policy graded nothing.
 *
 * Suppressed on a cohort below `minimum_merges` for the reason `unreviewedSubstantialOutcome` is: the policy
 * declines to grade thin evidence, and reporting the raw counts anyway would let the team page state a rate the
 * policy refused to state. `minimum_merges` is untouched — this reads its answer rather than second-guessing it.
 */
function substantialCounts(policy: ReadinessPolicy, merges: Merges): Pick<BehaviourFigures, "unreviewed_substantial_merges" | "substantial_merges"> {
  if (!policy.sufficient(merges)) {
    return {};
  }
  const counts = policy.unreviewedSubstantialCounts(merges);
  return { unreviewed_substantial_merges: counts.unreviewed, substantial_merges: counts.merges };
}

/** The five figures every one of which is derived from the stored review history. */
type ReviewDerivedFigures = Pick<
  BehaviourFigures,
  "unreviewed_substantial" | "unreviewed_substantial_merges" | "substantial_merges" | "time_to_first_review_hours" | "merge_cycle_time_hours"
>;

/**
 * Every figure derived from the review history, or nothing where that history cannot be read.
 *
 * ONE GUARD OVER ALL FIVE, because all five reach `pullRequest.reviews` through the same unchecked `eligibleReviews`
 * and so are unmeasurable together. Guarding the medians alone made the guard hold only for the case it was not
 * written for: `unreviewed_substantial` is evaluated first, so a SUBSTANTIAL merge missing that array threw before
 * any catch below it was reached, and a trivial merge — the one shape the narrower guard did hold for — is the shape
 * where the counts never read the array in the first place.
 *
 * THE COHORT IS THE UNIT and not the individual merge, because these are rates and medians over a denominator.
 * Dropping the merges whose reviews were not stored would count them as reviewed by nobody, which is the confusion
 * ABSENT MEANS UNMEASURED AND ZERO MEANS MEASURED-AS-NOTHING exists to prevent; a rate over the subset that happens
 * to have round-tripped is not the rate the column claims to state.
 *
 * DECIDED FROM THE SHAPE AND NOT CAUGHT, so a real defect in the policy still surfaces as one rather than reading
 * as a cache that predates a field. The catch is what remains for the fields this cannot name in advance.
 */
function reviewDerivedFigures(policy: ReadinessPolicy, merges: Merges): ReviewDerivedFigures {
  if (!reviewsStored(merges)) {
    console.warn("the review history was not stored for every merge, so the figures derived from it are unmeasured rather than none");
    return {};
  }
  try {
    return {
      unreviewed_substantial: policy.unreviewedSubstantialOutcome(merges),
      // THE COUNTS BEHIND THAT VERDICT, which the team page aggregates: how many substantial changes reached
      // the default branch with no independent review, out of how many substantial changes there were. The
      // verdict alone cannot be summed across a team's repositories, and the policy already computes both.
      ...substantialCounts(policy, merges),
      // The two timing medians. Read off `BehaviourMetric.summary`, so the page and the assessment compare the
      // same number at the same percentile rather than two derivations that could disagree.
      time_to_first_review_hours: medianOf(timeToFirstReview.summary(merges)),
      merge_cycle_time_hours: medianOf(mergeCycleTime.summary(merges))
    };
  } catch (error) {
    // ANY OTHER FIELD THE METRICS READ. The reviews array is the absence the cache is known to hold and is checked
    // above; a payload that failed to round-trip can be short of anything. One such row must not become a 500 for
    // the whole page, so the figures are ABSENT — the answer a window with nothing to measure gives — and the
    // reason is logged rather than swallowed, because an unmeasurable metric is worth knowing about.
    console.warn(`the review figures could not be measured: ${error instanceof Error ? error.message : String(error)}`);
    return {};
  }
}

/**
 * Whether every merged pull request in the cohort carries the reviews array those figures read.
 *
 * A REAL SHAPE IN THE CACHE and not defensive padding: `deserialiseMerges` passes a payload through as it was
 * stored, and the projection in `loadCachedFactsForOrganisation` has been narrowed once already, so "every payload
 * carries every field the metrics read" is an assumption about history rather than a guarantee. `builtMergeRows`
 * keeps the same check on the same field, on the array's PRESENCE rather than its contents — an empty array was read
 * and found no reviews, which is a measurement.
 */
function reviewsStored(merges: Merges): boolean {
  return merges.pullRequests.every((pullRequest) => Array.isArray(pullRequest.reviews));
}
