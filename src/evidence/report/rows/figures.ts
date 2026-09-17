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
    ...(measured.pullRequests && measured.directCommits
      ? {
          unreviewed_substantial: policy.unreviewedSubstantialOutcome(merges),
          // THE COUNTS BEHIND THAT VERDICT, which the team page aggregates: how many substantial changes reached
          // the default branch with no independent review, out of how many substantial changes there were. The
          // verdict alone cannot be summed across a team's repositories, and the policy already computes both.
          ...substantialCounts(policy, merges),
          // The two timing medians. Read off `BehaviourMetric.summary`, so the page and the assessment compare the
          // same number at the same percentile rather than two derivations that could disagree.
          ...timingMedians(merges)
        }
      : {})
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

/**
 * The two timing medians, or nothing where the facts cannot support them.
 *
 * GUARDED, and the guard is not defensive padding — it is a real shape in the cache. `eligibleReviews` reads
 * `pullRequest.reviews` without a check, so a stored payload lacking that array throws rather than reporting an
 * absence, and the report layer must not turn one such row into a 500 for the whole page. Rows like that exist:
 * `deserialiseMerges` passes a payload through as it was stored, and the projection in `loadCachedFactsForOrganisation`
 * has been narrowed once already, so "every payload carries every field the metrics read" is an assumption about
 * history rather than a guarantee.
 *
 * The failure is reported as an ABSENT median, which is the same answer a window with no reviews gives, and the
 * reason is logged once per repository rather than swallowed — an unmeasurable metric is worth knowing about, and a
 * page that renders is worth more than a page that is right about one column.
 */
function timingMedians(merges: Merges): Pick<BehaviourFigures, "time_to_first_review_hours" | "merge_cycle_time_hours"> {
  try {
    return {
      time_to_first_review_hours: medianOf(timeToFirstReview.summary(merges)),
      merge_cycle_time_hours: medianOf(mergeCycleTime.summary(merges))
    };
  } catch (error) {
    console.warn(`the review timings could not be measured: ${error instanceof Error ? error.message : String(error)}`);
    return {};
  }
}
