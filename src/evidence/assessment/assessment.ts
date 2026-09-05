import { eligibleReviews, ratePercentage, sizeClass } from "../behaviour/analysis.ts";
import {
  approvalCoverage,
  type BehaviourMetric,
  checksPassingAtMerge,
  independentReviewCoverage,
  mergeCycleTime,
  Percentile,
  pullRequestSize,
  reviewDepth,
  timeToFirstReview
} from "../behaviour/metrics.ts";
import { roundHalfEven } from "../behaviour/rounding.ts";
import { type DistributionObservation, type Merge, type Merges, ObservationStatus, type RateObservation } from "../domain/facts.ts";
import { type MergeGateEvidence, type MergeGateReport, requiredApprovals, requiredContexts } from "../domain/merge-gate.ts";
import { type ReadinessAssessment, type ReadinessCondition, ReadinessLabel, UnreviewedSubstantialOutcome } from "../domain/readiness.ts";
import type { AssessmentConfiguration, Configuration, DistributionThreshold, ReadinessThresholds, TrivialityConfiguration } from "../policy/schema.ts";

/**
 * Readiness for AI enablement, judged from declared governance and observed behaviour. Ported from
 * `metrics.assessment`.
 *
 * This is the policy layer and it is deliberately outside `../behaviour/metrics.ts`: metrics stay neutral
 * aggregates with no target and no verdict, which is what makes them reusable when the policy changes. The
 * assessment consumes them.
 *
 * Every condition the policy checks reports into exactly one section — blocking, caution, or clear — so a
 * reader can see what was examined rather than only what failed, and a green label is as auditable as a red
 * one.
 *
 * `clear` means "checked, and did not hold the label back" rather than "checked and satisfied". The three
 * neutral merge-gate rules are reported whether configured or NOT, because each bears on none of the
 * decision questions and the alternative was leaving three collected rules out of the assessment entirely:
 * a check which is never reported cannot be argued with.
 */

const Outcome = {
  Blocking: "blocking",
  Caution: "caution",
  Clear: "clear"
} as const;

type Outcome = (typeof Outcome)[keyof typeof Outcome];

interface Judgement {
  outcome: Outcome;
  condition: ReadinessCondition;
}

/**
 * Worst first. RED outranks CANNOT_ASSESS so an unreadable gate can never hide a disqualifier.
 */
const PRECEDENCE: readonly ReadinessLabel[] = [ReadinessLabel.Red, ReadinessLabel.CannotAssess, ReadinessLabel.Amber];

/** Formats a number the way Python's `%g` does: no trailing zeros, no decimal point on an integer. */
function g(value: number): string {
  return String(Number(value));
}

function blocking(condition: string, label: ReadinessLabel, detail: string): Judgement {
  return { outcome: Outcome.Blocking, condition: { condition, label, detail } };
}

function caution(condition: string, detail: string): Judgement {
  return { outcome: Outcome.Caution, condition: { condition, detail } };
}

function clear(condition: string, detail: string, informational = false): Judgement {
  return { outcome: Outcome.Clear, condition: informational ? { condition, detail, informational: true } : { condition, detail } };
}

/**
 * Reports one rule that was checked and imposes no ceiling in either of its states.
 *
 * Always `clear`, whether the rule is configured or absent: the three rules judged this way trace to none of
 * the decision questions, so an absent one is not a shortfall and must not be dressed as a caution. The
 * detail says so, since a reader meeting an absent rule under `clear` would otherwise have to work out why
 * it is there.
 *
 * Informational by definition: this function IS the policy declining to judge, so the flag and the sentence
 * in the detail are one statement rather than two that could disagree.
 */
function neutral(condition: string, detail: string): Judgement {
  return clear(condition, `${detail}, which does not bear on the readiness label`, true);
}

export function readinessPolicy(configuration: Configuration) {
  return createPolicy(configuration.assessment, configuration.triviality);
}

export function createPolicy(configuration: AssessmentConfiguration, triviality: TrivialityConfiguration) {
  /** Whether the gate requires an approving review, which is the FIRST VETO and is not configurable. */
  function reviewRequirement(gate: MergeGateEvidence): Judgement {
    const required = requiredApprovals(gate);
    if (required === 0) {
      return blocking(
        "pull-request-review-not-required",
        ReadinessLabel.Red,
        `approving reviews required before merging to ${gate.branch}: 0, so review is not enforced at all`
      );
    }
    return clear("pull-request-review-required", `approving reviews required before merging to ${gate.branch}: ${required}`);
  }

  /**
   * Whether the gate requires any status check.
   *
   * A caution rather than a veto: `checks-passing-at-merge` measures whether CI actually held at the merge
   * point, which is the stronger signal than whether a rule nominally demanded it.
   */
  function statusChecks(gate: MergeGateEvidence): Judgement {
    const contexts = requiredContexts(gate);
    if (contexts.length === 0) {
      return caution("status-checks-not-required", `status checks required before merging to ${gate.branch}: 0, so CI cannot block a merge`);
    }
    return clear("status-checks-required", `status checks required before merging to ${gate.branch}: ${contexts.length} (${[...contexts].sort().join(", ")})`);
  }

  /** Whether the gate binds administrators, which was deliberately rejected as a veto. */
  function administrators(gate: MergeGateEvidence): Judgement {
    if (gate.appliesToAdministrators === undefined) {
      return caution(
        "gate-enforcement-on-administrators-unknown",
        `whether the gate on ${gate.branch} binds administrators was not disclosed, so a bypass is neither confirmed nor ruled out`
      );
    }
    if (!gate.appliesToAdministrators) {
      return caution("administrators-can-bypass-the-gate", `the gate on ${gate.branch} does not apply to administrators, so it can be bypassed`);
    }
    return clear("gate-applies-to-administrators", `the gate on ${gate.branch} applies to administrators too`);
  }

  /**
   * Whether an approval survives a later push.
   *
   * Worth weighing before agentic tooling in particular: where an agent revises a branch after approval, a
   * surviving approval means the reviewed code and the merged code are not the same.
   */
  function staleReviews(gate: MergeGateEvidence): Judgement {
    if (gate.pullRequests.some((rule) => rule.dismissStaleReviewsOnPush)) {
      return clear("stale-reviews-dismissed", `an approval on ${gate.branch} is dismissed when the branch is pushed again`);
    }
    return caution("stale-reviews-not-dismissed", `an approval on ${gate.branch} survives a later push, so reviewed and merged code can differ`);
  }

  /**
   * Whether the branch can be force pushed after a review has been given.
   *
   * A CAUTION and never a veto: the veto set is fixed at two conditions, and this does not reopen it.
   */
  function forcePushes(gate: MergeGateEvidence): Judgement {
    if (!gate.blocksForcePushes) {
      return caution("force-pushes-not-blocked", `${gate.branch} accepts a force push, so an approved history can be rewritten after review`);
    }
    return clear("force-pushes-blocked", `a force push to ${gate.branch} is blocked, so an approved history cannot be rewritten after review`);
  }

  function deletions(gate: MergeGateEvidence): Judgement {
    return gate.restrictsDeletions
      ? neutral("branch-deletion-restricted", `deleting ${gate.branch} is blocked by the gate`)
      : neutral("branch-deletion-not-restricted", `deleting ${gate.branch} is not blocked by the gate`);
  }

  function linearHistory(gate: MergeGateEvidence): Judgement {
    return gate.requiresLinearHistory
      ? neutral("linear-history-required", `merging to ${gate.branch} requires a linear history`)
      : neutral("linear-history-not-required", `merging to ${gate.branch} does not require a linear history`);
  }

  function branchNames(gate: MergeGateEvidence): Judgement {
    return gate.restrictsBranchNames
      ? neutral("branch-names-restricted", `the gate on ${gate.branch} restricts branch names`)
      : neutral("branch-names-not-restricted", `the gate on ${gate.branch} does not restrict branch names`);
  }

  /**
   * Judges the declared merge gate, or states that it could not be read.
   *
   * THE ORDER IS THE ARGUMENT. An unprotected default branch is an observed fact and vetoes even though no
   * rule detail came with it, while a protected branch whose rules GitHub withheld is evidence of nothing at
   * all — so it must not be read as a gate that requires no review, and nothing further about it is
   * reported.
   *
   * The three rules that can never hold the label back are reported LAST so that a run of neutral rule
   * names cannot crowd out the graded and veto-adjacent conditions above them.
   */
  function governance(report: MergeGateReport): Judgement[] {
    const gate = report.gate;
    if (gate === undefined) {
      return [blocking("merge-gate-not-collected", ReadinessLabel.CannotAssess, report.detail ?? "the merge gate has not been collected")];
    }
    if (!gate.protected) {
      return [blocking("branch-not-protected", ReadinessLabel.Red, `the default branch ${gate.branch} has no protection, so any push can bypass review`)];
    }
    if (!gate.rulesObserved) {
      return [
        blocking(
          "merge-gate-rules-not-observable",
          ReadinessLabel.CannotAssess,
          `${gate.branch} is protected but GitHub did not disclose its rules; reading them needs Administration access, or a move to rulesets`
        )
      ];
    }
    return [
      clear("branch-protected", `the default branch ${gate.branch} is protected`),
      reviewRequirement(gate),
      statusChecks(gate),
      administrators(gate),
      staleReviews(gate),
      forcePushes(gate),
      deletions(gate),
      linearHistory(gate),
      branchNames(gate)
    ];
  }

  /**
   * Whether the cohort holds enough merges for a pattern to be read from it.
   *
   * Counted over BOTH routes onto the default branch. A repository doing most of its work in direct commits
   * has plenty of evidence to grade, and counting merged pull requests alone would report it as unassessable
   * precisely where the bypass is worst.
   */
  function sufficient(cohort: Merges): boolean {
    return cohort.pullRequests.length + cohort.directCommits.length >= configuration.minimum_merges;
  }

  function sample(cohort: Merges): Judgement {
    const merged = cohort.pullRequests.length;
    const commits = cohort.directCommits.length;
    const reported = merged + commits;
    const minimum = configuration.minimum_merges;
    const measured = `merges into the default branch: ${reported} (${merged} merged pull requests and ${commits} direct commits)`;
    if (!sufficient(cohort)) {
      return blocking(
        "insufficient-merges",
        ReadinessLabel.CannotAssess,
        `${measured}, below the minimum of ${minimum}, so no behavioural condition was graded`
      );
    }
    // Informational: a cohort large enough to grade is a PRECONDITION for grading rather than a practice
    // that went well. A repository is not better governed for having merged more.
    return clear("sufficient-merges", `${measured}, at or above the minimum of ${minimum}`, true);
  }

  /**
   * One rate and how it reads, or `undefined` when there was no denominator to divide by.
   *
   * Shared by every graded rate so a change to how a percentage is phrased is made once. The percentage
   * itself comes from `ratePercentage`, which a trend reads too.
   */
  function measuredRate(identifier: string, observation: RateObservation): { percentage: number; measured: string } | undefined {
    const percentage = ratePercentage(observation);
    if (percentage === undefined) {
      return undefined;
    }
    return { percentage, measured: `${identifier} is ${g(percentage)}% (${observation.numerator} of ${observation.denominator})` };
  }

  /** Compares one observed rate against its configured green and amber boundaries. */
  function gradeRate(metric: BehaviourMetric, thresholds: ReadinessThresholds, observation: RateObservation): Judgement {
    const graded = measuredRate(metric.identifier, observation);
    if (graded === undefined) {
      return caution(`${metric.identifier}-not-observed`, `${metric.identifier} has no denominator in this window, so it was not graded`);
    }
    const { percentage, measured } = graded;
    if (percentage >= thresholds.green_percentage) {
      return clear(`${metric.identifier}-at-target`, `${measured}, at or above the ${g(thresholds.green_percentage)}% target`);
    }
    return blocking(
      `${metric.identifier}-below-target`,
      percentage >= thresholds.amber_percentage ? ReadinessLabel.Amber : ReadinessLabel.Red,
      `${measured}, below the ${g(thresholds.green_percentage)}% target`
    );
  }

  /**
   * Weighs whether approvals carry evidence of scrutiny, without ever imposing a ceiling.
   *
   * Caution only: no defensible label-deciding threshold exists yet for how many approvals ought to carry a
   * comment, and a caution must never impose one regardless.
   */
  function gradeReviewDepth(observation: RateObservation): Judgement {
    const identifier = reviewDepth.identifier;
    const graded = measuredRate(identifier, observation);
    if (graded === undefined) {
      return caution(`${identifier}-not-observed`, `${identifier} has no denominator in this window, so it was not graded`);
    }
    const boundary = configuration["review-depth-minimum-percentage"];
    if (graded.percentage >= boundary) {
      return clear(`${identifier}-at-target`, `${graded.measured}, at or above the ${g(boundary)}% boundary`);
    }
    return caution(`${identifier}-below-target`, `${graded.measured}, below the ${g(boundary)}% boundary`);
  }

  /** The value a distribution is graded at, read from the percentile the metric declares. */
  function percentileValue(metric: BehaviourMetric, observation: DistributionObservation): number | undefined {
    if (metric.percentile === Percentile.Percentile75) {
      return observation.percentile75;
    }
    if (metric.percentile === Percentile.Percentile90) {
      return observation.percentile90;
    }
    return observation.median;
  }

  function percentileLabel(metric: BehaviourMetric): string {
    if (metric.percentile === Percentile.Percentile75) {
      return "75th percentile";
    }
    if (metric.percentile === Percentile.Percentile90) {
      return "90th percentile";
    }
    return "median";
  }

  /**
   * Compares one observed percentile against its configured maximum, AS A CAUTION ONLY.
   *
   * Which percentile is read comes from the metric, so the assessment and a trend compare the same number: a
   * series measuring movement in the median while the label graded the 75th percentile would be two reports
   * describing one window differently.
   *
   * Lower is better here, the opposite direction from a rate: a value at or below its maximum is `clear` and
   * one above it a caution, since the metric measures cost, not compliance.
   *
   * A cost NEVER decides the label, however far above the maximum it sits. Letting one impose a ceiling made
   * two very different findings indistinguishable: on the HMCTS estate the fastest merge-cycle-time medians
   * all belonged to repositories that merge almost nothing through review — 0.003 hours on a repository with
   * 0% review coverage — while a repository reviewing 99.3% of 294 merges was held below ready for taking
   * four days.
   */
  function gradeDistribution(metric: BehaviourMetric, threshold: DistributionThreshold, observation: DistributionObservation): Judgement {
    const identifier = metric.identifier;
    const value = percentileValue(metric, observation);
    if (observation.status !== ObservationStatus.Observed || value === undefined) {
      return caution(`${identifier}-not-observed`, `${identifier} has no observations in this window, so it was not graded`);
    }
    const measured = `${identifier} ${percentileLabel(metric)} is ${g(value)} ${observation.unit}`;
    if (value <= threshold.maximum) {
      return clear(`${identifier}-at-target`, `${measured}, at or below the ${g(threshold.maximum)} ${observation.unit} target`);
    }
    return caution(`${identifier}-above-target`, `${measured}, above the ${g(threshold.maximum)} ${observation.unit} target`);
  }

  /** Whether one merge is too large to be treated as trivial. */
  function substantial(change: Merge): boolean {
    return sizeClass(change, triviality.maximum_lines, triviality.maximum_files) === "substantial";
  }

  /**
   * The substantial merges made unreviewed, every substantial merge, and the percentage.
   *
   * Counted from facts rather than from the `unreviewed-merge` rule's findings, so disabling that rule
   * cannot turn an unmeasured count into a passing one.
   *
   * The percentage is rounded HERE, ONCE, because it is both the figure the condition's detail reports and
   * the figure the allowance is tested against. Rounding it twice would let a reader see a number that
   * appears to sit inside a boundary it was judged outside of.
   */
  function unreviewedSubstantialCounts(cohort: Merges): { unreviewed: number; merges: number; percentage: number } {
    const merged = cohort.pullRequests.filter((pullRequest) => substantial(pullRequest));
    const pushed = cohort.directCommits.filter((commit) => substantial(commit));
    // Every substantial direct commit is unreviewed: there was no pull request to review it.
    const unreviewed = merged.filter((pullRequest) => eligibleReviews(pullRequest).length === 0).length + pushed.length;
    const merges = merged.length + pushed.length;
    return { unreviewed, merges, percentage: merges > 0 ? roundHalfEven((unreviewed / merges) * 100, 1) : 0 };
  }

  /**
   * Whether either allowance forgives the unreviewed substantial merges counted.
   *
   * A proportional allowance and an absolute one, forgiving when EITHER holds. A count alone cannot separate
   * a lapse from a habit — the same two unreviewed merges are noise against 246 and a pattern against 20 —
   * so `maximum_percentage` carries the judgement and `maximum_count` is the floor that keeps a thin cohort
   * from being condemned by arithmetic.
   */
  function withinUnreviewedAllowance(unreviewed: number, percentage: number): boolean {
    const thresholds = configuration["unreviewed-substantial-merges"];
    return percentage <= thresholds.maximum_percentage || unreviewed <= thresholds.maximum_count;
  }

  /**
   * Contrasts substantial merges made unreviewed against every substantial merge.
   *
   * Amber rather than red on its own: the coverage rate is what shows a systemic failure, and this stops a
   * green without duplicating it.
   */
  function unreviewedSubstantial(cohort: Merges): Judgement {
    const { unreviewed, merges, percentage } = unreviewedSubstantialCounts(cohort);
    const thresholds = configuration["unreviewed-substantial-merges"];
    const measured = `substantial merges with no independent human review: ${unreviewed} of ${merges} (${g(percentage)}%)`;
    const boundary = `${g(thresholds.maximum_percentage)}% or ${thresholds.maximum_count} merges`;
    if (withinUnreviewedAllowance(unreviewed, percentage)) {
      return clear("substantial-changes-reviewed", `${measured}, within the maximum of ${boundary}`);
    }
    return blocking("substantial-changes-merged-unreviewed", ReadinessLabel.Amber, `${measured}, above the maximum of ${boundary}`);
  }

  /**
   * Projects the verdict `unreviewedSubstantial` reaches, or nothing where it graded nothing.
   *
   * Nothing on a cohort below `minimum_merges`, whose behavioural conditions are suppressed entirely rather
   * than graded, and nothing on a window holding no substantial merge, where there was no denominator to
   * judge. Both are unmeasured, and an unmeasured thing must never be reported as a pass — the reader of a
   * projection cannot see the detail that would say so.
   *
   * `None` is kept apart from `Within` because they are different facts: nothing merged unreviewed, against
   * an allowance forgiving what it was configured to forgive.
   */
  function unreviewedSubstantialOutcome(cohort: Merges): UnreviewedSubstantialOutcome | undefined {
    if (!sufficient(cohort)) {
      return undefined;
    }
    const { unreviewed, merges, percentage } = unreviewedSubstantialCounts(cohort);
    if (merges === 0) {
      return undefined;
    }
    if (unreviewed === 0) {
      return UnreviewedSubstantialOutcome.None;
    }
    return withinUnreviewedAllowance(unreviewed, percentage) ? UnreviewedSubstantialOutcome.Within : UnreviewedSubstantialOutcome.Above;
  }

  /**
   * Judges observed behaviour, or states that the window holds too little to judge.
   *
   * An insufficient sample SUPPRESSES every graded condition rather than sitting beside them: a rate over
   * four merges is arithmetic, and reporting it as a shortfall would dress a thin window up as a finding.
   *
   * Approval coverage is graded beside independent review rather than instead of it. An approval implies a
   * review, so the two rates move together for most teams; what the second adds is the team that reviews
   * diligently and never approves, where the reviewed code carries no record of anyone accepting it.
   */
  function behaviour(cohort: Merges): Judgement[] {
    const sampled = sample(cohort);
    if (sampled.outcome === Outcome.Blocking) {
      return [sampled];
    }
    return [
      sampled,
      gradeRate(independentReviewCoverage, configuration["independent-review-coverage"], independentReviewCoverage.summary(cohort) as RateObservation),
      gradeRate(approvalCoverage, configuration["approval-coverage"], approvalCoverage.summary(cohort) as RateObservation),
      gradeRate(checksPassingAtMerge, configuration["checks-passing-at-merge"], checksPassingAtMerge.summary(cohort) as RateObservation),
      gradeReviewDepth(reviewDepth.summary(cohort) as RateObservation),
      gradeDistribution(pullRequestSize, configuration["pull-request-size"], pullRequestSize.summary(cohort) as DistributionObservation),
      gradeDistribution(mergeCycleTime, configuration["merge-cycle-time"], mergeCycleTime.summary(cohort) as DistributionObservation),
      gradeDistribution(timeToFirstReview, configuration["time-to-first-review"], timeToFirstReview.summary(cohort) as DistributionObservation),
      unreviewedSubstantial(cohort)
    ];
  }

  function section(judgements: readonly Judgement[], outcome: Outcome): ReadinessCondition[] {
    return judgements.filter((judgement) => judgement.outcome === outcome).map((judgement) => judgement.condition);
  }

  /** The most severe label any blocking condition imposes. */
  function label(blockingConditions: readonly ReadinessCondition[]): ReadinessLabel {
    const imposed = new Set(blockingConditions.map((condition) => condition.label));
    return PRECEDENCE.find((candidate) => imposed.has(candidate)) ?? ReadinessLabel.Green;
  }

  return {
    get enabled(): boolean {
      return configuration.enabled;
    },
    sufficient,
    unreviewedSubstantialCounts,
    unreviewedSubstantialOutcome,
    /** Judges one repository's readiness for agentic tooling. */
    assess(cohort: Merges, report: MergeGateReport): ReadinessAssessment {
      const judgements = [...governance(report), ...behaviour(cohort)];
      const blockingConditions = section(judgements, Outcome.Blocking);
      return {
        label: label(blockingConditions),
        blocking: blockingConditions,
        caution: section(judgements, Outcome.Caution),
        clear: section(judgements, Outcome.Clear)
      };
    }
  };
}

export type ReadinessPolicy = ReturnType<typeof createPolicy>;
