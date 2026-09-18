import type * as contract from "../../lib/types.ts";
import { readinessPolicy } from "../assessment/assessment.ts";
import { botAccounts, excludedAuthors, type ReportedCohort, reportedCohort } from "../behaviour/analysis.ts";
import { behaviourMetrics } from "../behaviour/metrics.ts";
import type { Merges } from "../domain/facts.ts";
import type { SecurityAlertEvidence } from "../domain/security-alerts.ts";
import type { CohortEntry } from "../org/cohort.ts";
import type { Configuration } from "../policy/schema.ts";
import type { ReportingWindow } from "../window/window.ts";
import { stripAbsent } from "./absent.ts";
import { contractAssessment } from "./contract/assessment.ts";
import { contractGate, storedGate } from "./contract/merge-gate.ts";
import { contractObservation } from "./contract/observation.ts";
import { securityReport } from "./contract/security.ts";
import type { MeasuredRow } from "./measured.ts";

/** Everything one repository's page is assembled from, all of it read by the caller. See `repositoryEvidence`. */
export interface RepositoryEvidenceInput {
  repository: string;
  /** The cohort entry, which is where the owning team comes from. */
  entry: CohortEntry;
  /** The collected state, whose payload holds the merge gate and the alert families. */
  state: { fetchedAt: Date; payload: unknown };
  /** Everything the collection cached for this repository over the window, before the cohort rule narrows it. */
  walked: Merges;
  window: ReportingWindow;
  measured: MeasuredRow;
}

/**
 * One repository's evidence block: what the window holds for it, section by section.
 *
 * The page for a repository has been rendering "this span holds no evidence" since the port landed, not because
 * nothing was collected but because nothing assembled this. Every section below it was already written.
 *
 * FOUR SECTIONS CAN ONLY STATE AN ABSENCE, and they say so in their own `detail` rather than being omitted:
 * open pull requests, CODEOWNERS, maintenance and Sonar are not collected by `collect` at all — no call is made
 * for any of them. Reporting them as empty would be indistinguishable from a repository that has no CODEOWNERS
 * file and no open pull requests, which is the one confusion this contract exists to prevent. What IS collected —
 * the merge gate, the three alert families, the merge facts — feeds the sections that carry real answers.
 *
 * `measured` IS HANDED IN AND NOT READ HERE, exactly as `repositoryRow` is handed its own. `src/lib/api.ts` holds
 * this repository's estate row by the time it calls this, and that row's two counts are absent precisely where a
 * source went unread — so the answer is already in the caller's hand, and reading `source_coverage` again would
 * add a query to a per-page path for a fact one read of the estate has already settled.
 */
export function builtRepositoryEvidence(configuration: Configuration, input: RepositoryEvidenceInput): contract.RepositoryPracticeEvidence {
  const policy = readinessPolicy(configuration);
  const gate = storedGate(input.state.payload);
  const payload = input.state.payload as { securityAlerts?: SecurityAlertEvidence };
  const fetched = input.state.fetchedAt.toISOString();
  // The per-repository half of the one seam. `walked` is everything the collection cached and `reported.merges`
  // is what this page counts, so every figure below — the assessment, the metric summaries and the unreviewed
  // verdict — is computed on the same cohort the estate row's figures are, and the two pages cannot disagree.
  const reported = reportedCohort(input.walked, excludedAuthors(configuration.cohort.excluded_authors), botAccounts(configuration.cohort.bot_accounts));
  const merges = reported.merges;

  return stripAbsent<contract.RepositoryPracticeEvidence>({
    repository: input.repository,
    team: input.entry.owners[0] ?? "",
    starts_at: input.window.startsAt.toISOString(),
    ends_at: input.window.endsAt.toISOString(),
    // `offline` because this reads the cache and never GitHub — a report is served from what a collection left,
    // which is the whole point of the fact tables. No interval is fetched to render a page.
    provenance: { offline: true, intervals_fetched: 0 },
    cohort: cohortSummary(input.walked, reported, input.measured),
    // THROUGH `contractAssessment`, which is the fourth translation at this boundary and the only one that was
    // already correct. The domain and the contract spell every field of an assessment the same way, so the policy's
    // own object was handed straight over — see `./contract/assessment.ts` for why that being right was luck.
    assessment: policy.enabled ? contractAssessment(policy.assess(merges, gate)) : undefined,
    unreviewed_substantial: policy.unreviewedSubstantialOutcome(merges),
    merge_gate: contractGate(gate, fetched),
    security: securityReport(payload.securityAlerts, fetched),
    metrics: metricSummaries(configuration, merges),
    // NOT COLLECTED, each said in the words of the thing that would have collected it. See this function's header:
    // an empty section here would read as a repository with nothing to report.
    open_pull_requests: { detail: "open pull-request state is not collected" },
    codeowners: { detail: "the CODEOWNERS file is not read for this report; ownership is attributed from the organisation graph" },
    maintenance: { windows: [], detail: "maintenance windows are not collected" },
    sonar: { detail: "no SonarCloud project is mapped for this repository" },
    // PER-ACTOR RULE BREACHES, WHICH NOTHING COMPUTES AND NOTHING NOW CONFIGURES. There is no producer: no
    // module in `src/evidence/` evaluates a practice rule, and the `practices:` policy block that declared
    // them was removed for validating without deciding anything. `FindingsTable` and `TeamPractice` are wired
    // and read this, so they render an empty list on every repository and every team.
    //
    // Wiring it means all three: a rule set in the schema, a producer over the merge facts, and this array
    // carrying its output. Whether to build that or to drop the two components is an open product decision.
    behaviour: []
  });
}

/**
 * The window's merge cohort as the page's three cards read it: what was walked, what is reported, and who was left
 * out of the difference.
 *
 * A REAL SPLIT, from 2026-09-16. `reported` used to equal `merged` and `excluded_authors` used to be empty, which
 * was an honest statement of a service that applied `cohort.excluded_authors` to nothing at all. It applies it now,
 * at the one seam `reportedCohort` documents, so the figures beside these cards ARE computed over the smaller
 * cohort — and stating the split is what makes that visible rather than a quiet drop in throughput.
 *
 * `walked` is what the cache held and `reported` is what everything else on the page counted, so `merged` and
 * `reported` are two counts of one window rather than two windows. `excluded_authors` names every author the
 * difference is owed to, counted over BOTH ROUTES and by both rules, so its total is not always `merged -
 * reported`: a bot's direct commit was left out of the direct-commit figure instead.
 *
 * THE THREE COUNTS ARE GATED ON MEASURED-NESS, per source, exactly as `behaviourFigures` gates the estate row's
 * copies of them. `/repositories/<name>` drew three zeros and "no author was excluded from this window" for a
 * repository whose merge walk was refused — a measurement nobody made, stated as confidently as a real one.
 *
 * THE MAP IS NOT GATED, because it accounts for facts rather than for a measurement: it says what was dropped from
 * the cohort the assessment below still grades, which is computed from every fact in the cache whether the window
 * reports its counts or not. Where nothing was read there is nothing to drop and it is empty, and
 * `lib/repository.cohortCards` reads the absent counts — not the empty map — as the signal that nobody looked.
 *
 * EXPORTED FOR `./trend.ts`, which reports the same split per period. A series and the block above it describe
 * the same repository, so the cards on one and the columns on the other have to be one derivation: a second copy
 * would eventually disagree about which merges a window held.
 */
export function cohortSummary(walked: Merges, reported: ReportedCohort, measured: MeasuredRow): contract.CohortSummary {
  return {
    ...(measured.pullRequests ? { merged: walked.pullRequests.length, reported: reported.merges.pullRequests.length } : {}),
    excluded_authors: reported.excluded,
    ...(measured.directCommits ? { direct_commits: reported.merges.directCommits.length } : {})
  };
}

/**
 * Every behaviour metric's aggregate and the classification counts behind it.
 *
 * Computed HERE rather than stored, for the reason the assessment is: a metric's definition can change with a
 * deployment and a stored summary could not. `commitClassification` returning `undefined` is a metric declining to
 * count commits — the flow metrics do, since a direct push has no cycle to time — and those samples are left out
 * rather than counted as a zero.
 *
 * THROUGH `contractObservation`, which is the field-renaming translation this emitted without for as long as it has
 * existed: `metric.summary` answers in the domain's `sampleSize`/`percentile75` and the contract declares
 * `sample_size`/`percentile_75`. See `./contract/observation.ts` for what a reader saw instead.
 */
function metricSummaries(configuration: Configuration, merges: Merges): contract.BehaviourMetricSummary[] {
  return behaviourMetrics(configuration.traceability).map((metric): contract.BehaviourMetricSummary => {
    const classifications: Record<string, number> = {};
    for (const pullRequest of merges.pullRequests) {
      const answer = metric.classification(pullRequest);
      classifications[answer] = (classifications[answer] ?? 0) + 1;
    }
    for (const commit of merges.directCommits) {
      const answer = metric.commitClassification(commit);
      if (answer !== undefined) {
        classifications[answer] = (classifications[answer] ?? 0) + 1;
      }
    }
    return { metric: metric.identifier, summary: contractObservation(metric.summary(merges)), classifications };
  });
}
