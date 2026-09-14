import "server-only";
import { type ReadinessPolicy, readinessPolicy } from "../assessment/assessment.ts";
import { deserialiseMerges } from "../behaviour/fill.ts";
import { mergeCycleTime, timeToFirstReview } from "../behaviour/metrics.ts";
import { sourceSignature } from "../behaviour/queries.ts";
import { type AssuranceEvidence, assuranceGrade, judgeAssurance } from "../domain/assurance.ts";
import { EvidenceSource } from "../domain/coverage.ts";
import { type DistributionObservation, type Merges, ObservationStatus, type RateObservation } from "../domain/facts.ts";
import { type MergeGateEvidence, type MergeGateReport, requiredApprovals, requiredContexts } from "../domain/merge-gate.ts";
import type { OpenAlertCount, SecurityAlertEvidence } from "../domain/security-alerts.ts";
import { type CohortEntry, cohortTeams, servedCohort } from "../org/cohort.ts";
import { OwnerKind } from "../org/graph.ts";
import { teamDisplayNames } from "../policy/repositories.ts";
import type { Configuration } from "../policy/schema.ts";
import { collectionState } from "../store/collection-state.ts";
import { prevailingCachedCoverage } from "../store/coverage.ts";
import { loadCachedFactsForOrganisation, storedRepositoryStates } from "../store/facts.ts";
import { collectedAnchor, collectionIsStale, days, type ReportingWindow, reportingWindow } from "../window/window.ts";
import { stripAbsent } from "./absent.ts";
import { builtReport, CACHEABLE_SPANS, forgetBuiltReports } from "./cache.ts";

/**
 * Assembling what the dashboard reads. Ported from `metrics.evidence` and the report-building half of
 * `metrics.service`.
 *
 * Every shape here is `src/lib/types.ts` verbatim, in snake_case, because that file is the UI's contract and was
 * carried over unchanged. `stripAbsent` is applied on the way out so a `null` from Prisma or a jsonb round trip
 * can never reach a component that reads the field as optional.
 */

/**
 * The spans the week selector offers, which are the spans the cache holds.
 *
 * Read from `./cache.ts` rather than declared twice: a span on offer that the cache does not hold is a page
 * every reader pays a cold build for, and a span held but not offered is an entry nothing reads. One list
 * cannot disagree with itself.
 */
const WEEK_OPTIONS = CACHEABLE_SPANS;
const DEFAULT_WEEKS = 4;

/** The most periods one trend request may ask for. The UI reads the cut from here rather than assuming one. */
const MAXIMUM_TREND_PERIODS = 13;

/** The window one `?weeks=` selection resolves to, anchored where the caches end. */
export async function resolveReportWindow(
  configuration: Configuration,
  weeks: number,
  reference = new Date()
): Promise<{ window: ReportingWindow; collectedThrough?: Date }> {
  const collectedThrough = await prevailingCachedCoverage(
    configuration.organization,
    EvidenceSource.PullRequests,
    sourceSignature(EvidenceSource.PullRequests)
  );
  // Anchored at the collected edge rather than at today's midnight, so a page served the day after a collection
  // reports the same figures it did the day the run landed.
  const anchor = collectedAnchor(collectedThrough, reference);
  return {
    window: reportingWindow(new Date(anchor.getTime() - days(weeks * 7)), anchor),
    ...(collectedThrough === undefined ? {} : { collectedThrough })
  };
}

/** The spans on offer, and what the collection behind them looks like. */
export async function windowOptions(configuration: Configuration, reference = new Date()): Promise<unknown> {
  const collectedThrough = await prevailingCachedCoverage(
    configuration.organization,
    EvidenceSource.PullRequests,
    sourceSignature(EvidenceSource.PullRequests)
  );
  return stripAbsent({
    options: WEEK_OPTIONS,
    default: DEFAULT_WEEKS,
    trend_periods: MAXIMUM_TREND_PERIODS,
    collected_through: collectedThrough?.toISOString(),
    collection_stale: collectionIsStale(collectedThrough, reference, days(configuration.lookback.stale_collection_days))
  });
}

/** The merge gate one collection stored, or the reason there is none to grade. */
function storedGate(payload: unknown): MergeGateReport {
  if (typeof payload !== "object" || payload === null) {
    return { detail: "nothing has been collected for this repository" };
  }
  const stored = (payload as { mergeGate?: unknown }).mergeGate;
  if (typeof stored !== "object" || stored === null) {
    return { detail: "the merge gate has not been collected" };
  }
  const report = stored as { gate?: MergeGateEvidence; detail?: string };
  return report.gate === undefined ? { detail: report.detail ?? "the merge gate has not been collected" } : { gate: report.gate };
}

/**
 * The three alert families in the shape `src/lib/types.ts` declares.
 *
 * SNAKE_CASE, and all three families always present. The UI reads `alerts.code_scanning` unconditionally — an
 * absent family throws rather than rendering as unmeasured — so the object is always whole and it is each
 * family's own `open` that is absent when nobody could read it. That is the same absent-means-unmeasured rule one
 * level down, and it is the level the UI was written to read it at.
 */
function reportedAlerts(alerts: SecurityAlertEvidence | undefined): Record<string, unknown> {
  return {
    dependabot: reportedFamily(alerts?.dependabot),
    code_scanning: reportedFamily(alerts?.codeScanning),
    secret_scanning: reportedFamily(alerts?.secretScanning)
  };
}

/**
 * One family, in the shape the UI declares.
 *
 * `by_severity` is REQUIRED and snake_case: `tone.ts` reads `by_severity.critical` without a guard, so an absent
 * map throws. An empty object is the honest value for a family with nothing open and for one nobody could read —
 * what separates those two is `open`, which stays absent when it was never measured.
 */
function reportedFamily(family: OpenAlertCount | undefined): Record<string, unknown> {
  if (family === undefined) {
    return { by_severity: {}, detail: "the alert families have not been collected" };
  }
  return {
    ...(family.open === undefined ? {} : { open: family.open }),
    by_severity: family.bySeverity ?? {},
    ...(family.detail === undefined ? {} : { detail: family.detail })
  };
}

/**
 * One repository's row, whether this window could be reported for it or not.
 *
 * `teams` carries every owner and `team` carries the first of them. Both, rather than widening `team` to a
 * list: every component that renders a row reads `team` as a string, and `src/lib/**` is held at 100%
 * coverage, so widening it would be a large change to prove for no gain a second field does not give. That
 * `team` is the first owner in the reporting order is a STATED CONVENTION, not a claim that there is only
 * one — silent truncation is the failure mode here, and naming the rule is the fix.
 *
 * `owner_kind` is what those names ARE, and it is sent on EVERY ROW rather than only on the person-owned
 * ones. A team slug and a login are the same shape, so a reader with the names alone cannot tell them apart:
 * the estate table needs it to mark an individually-owned repository and to not link one to a team page that
 * no longer exists, since `/teams` lists teams only. Always present, so an absent field means an older
 * service and nothing about this repository — the rule `ActorRow.labels` follows.
 */
function repositoryRow(
  configuration: Configuration,
  entry: CohortEntry,
  state: { fetchedAt: Date; payload: unknown } | undefined,
  merges: Merges,
  production: boolean | undefined
): Record<string, unknown> {
  const policy = readinessPolicy(configuration);
  const teams = entry.owners;
  const ownerKind = entry.ownerKind;
  const repository = entry.repository;
  const team = teams[0] ?? "";
  // Absent for the ordinary single-owner repository, so a reader is not shown a one-element list restating
  // `team` on every row of an estate where sharing is the exception.
  const shared = teams.length > 1 ? teams : undefined;

  // WHAT A REPOSITORY IS, rather than what happened in the window, so these are on BOTH branches — the rule
  // `owner_kind` already follows. `pushed_at` is the table's default sort and `visibility` its default filter,
  // so a row missing either would sort and filter as unmeasured on a fact the graph knows perfectly well.
  //
  // `pushed_at` is an ISO STRING and never a `Date`. `stripAbsent` passes a `Date` through untouched and
  // `SortValue` has no `Date` case, so a raw one would fall to `String(...).localeCompare(...)` and sort
  // alphabetically by weekday name — plausible-looking and wrong. Every other instant on the contract is a
  // string for the same reason; `overviewSummary` below is the pattern.
  const facts = {
    owner_kind: ownerKind,
    pushed_at: entry.pushedAt?.toISOString(),
    visibility: entry.visibility.toLowerCase(),
    archived: entry.archived,
    unmaintained: entry.unmaintained,
    assurance: reportedAssurance(entry, state?.payload)
  };

  if (state === undefined) {
    // Nothing collected: the row exists so the estate is complete, and says why it carries no figures.
    return { repository, team, teams: shared, ...facts, detail: "nothing has been collected for this repository" };
  }

  const gate = storedGate(state.payload);
  const assessment = policy.enabled ? policy.assess(merges, gate) : undefined;
  const payload = state.payload as { securityAlerts?: SecurityAlertEvidence; deploysToProduction?: boolean };

  return {
    repository,
    team,
    teams: shared,
    ...facts,
    readiness: assessment?.label,
    merged_pull_requests: merges.pullRequests.length,
    direct_commits: merges.directCommits.length,
    // The two gate figures are ABSENT where there is no gate to read them off, rather than zero: a repository
    // whose rules nobody may see is not a repository requiring no reviews.
    required_approving_reviews: gate.gate === undefined ? undefined : requiredApprovals(gate.gate),
    required_status_checks: gate.gate === undefined ? undefined : requiredContexts(gate.gate).length,
    unreviewed_substantial: policy.unreviewedSubstantialOutcome(merges),
    // THE COUNTS BEHIND THAT VERDICT, which the team page aggregates: how many substantial changes reached the
    // default branch with no independent review, out of how many substantial changes there were. The verdict alone
    // cannot be summed across a team's repositories, and the policy already computes both.
    ...substantialCounts(policy, merges),
    // The two timing medians. Read off `BehaviourMetric.summary`, so the page and the assessment compare the same
    // number at the same percentile rather than two derivations that could disagree.
    ...timingMedians(merges),
    security: reportedAlerts(payload.securityAlerts),
    production: production ?? payload.deploysToProduction,
    detail: gate.gate === undefined ? gate.detail : undefined
  };
}

/**
 * The substantial-merge counts, or nothing where the policy graded nothing.
 *
 * Suppressed on a cohort below `minimum_merges` for the reason `unreviewedSubstantialOutcome` is: the policy
 * declines to grade thin evidence, and reporting the raw counts anyway would let the team page state a rate the
 * policy refused to state. `minimum_merges` is untouched — this reads its answer rather than second-guessing it.
 */
function substantialCounts(policy: ReadinessPolicy, merges: Merges): Record<string, number | undefined> {
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
function timingMedians(merges: Merges): Record<string, number | undefined> {
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

/**
 * One distribution's median, or nothing where it observed no eligible sample.
 *
 * ABSENT AND NEVER ZERO, which is the same rule the whole contract follows: a repository whose pull requests were
 * never reviewed has no wait to report, and `0 hours` would read as instant review.
 *
 * NARROWED RATHER THAN CAST. `BehaviourMetric.summary` returns a rate or a distribution and only the two metrics
 * read here return the second, so `assessment.ts` casts at its call sites. A cast would be wrong here for a reason
 * that does not apply there: this is the SERVING path, and a metric later changed from a distribution to a rate
 * would put `undefined` on the contract as a silent absence rather than failing. `"unit" in` is the discriminator
 * `lib/format.ts` already uses, so there is one definition of which shape an observation is.
 */
function medianOf(observation: DistributionObservation | RateObservation): number | undefined {
  if (!("unit" in observation) || observation.status !== ObservationStatus.Observed) {
    return undefined;
  }
  return observation.median;
}

/**
 * The assurance criteria judged for one row, in the shape `src/lib/types.ts` declares.
 *
 * Judged HERE rather than in the UI, on the precedent every other graded figure on this contract follows: the
 * page renders a verdict the report reached, so the JSON a reader can curl and the table carry the same answer.
 *
 * TWO SOURCES, and that is why it takes the cohort entry as well as the payload. Ownership and maintenance are
 * facts about the repository that the GRAPH holds, so they answer on a repository nothing has been collected for;
 * hygiene and patching come from the collection. A criterion whose source is missing reads unknown, never unmet.
 */
function reportedAssurance(entry: CohortEntry, payload: unknown): Record<string, unknown> {
  const stored = (payload as { assurance?: AssuranceEvidence } | null | undefined)?.assurance;
  const judgements = judgeAssurance({
    ownerKind: entry.ownerKind,
    archived: entry.archived,
    unmaintained: entry.unmaintained,
    ...(stored === undefined ? {} : { evidence: stored })
  });
  return {
    grade: assuranceGrade(judgements),
    criteria: judgements.map((judgement) => ({ criterion: judgement.criterion, outcome: judgement.outcome, detail: judgement.detail })),
    // Lifted out of the criteria beside it so a column can print the number and a threshold can one day compare
    // it without either having to find the right judgement and parse its sentence.
    oldest_severe_alert_days: stored?.oldestSevereAlertDays
  };
}

/** Forgets every built report, so a test or a development reload starts cold. See `./cache.ts`. */
export function forgetBuiltRows(): void {
  forgetBuiltReports();
}

/**
 * Every cohort repository's row, in the reporting order.
 *
 * TWO QUERIES FOR THE WHOLE ESTATE, not five per repository, and neither of them fetches the two thirds of each
 * payload nothing reads. Fetching per repository inside this loop is what made a page render unusable: measured
 * inside the AAT pod at 1,233 repositories, a four-week `/repositories` render cost 7.89 s of CPU. Batching the
 * reads took it to 1.15 s and narrowing the projection to 0.71 s — see `loadCachedFactsForOrganisation`.
 *
 * The loop that remains is pure. `repositoryRow` is handed its state and its facts, which is what keeps the
 * cost here proportional to the estate rather than to the estate times a round trip.
 *
 * The build is held per span until a collection lands, which is what makes the SECOND reader of a span free
 * rather than only the second call of one render. `./cache.ts` states why that is keyed on the revision and
 * never on a clock.
 */
export async function repositoryRows(configuration: Configuration, weeks: number, reference = new Date()): Promise<unknown[]> {
  return await builtReport(configuration.organization, weeks, () => buildRepositoryRows(configuration, weeks, reference));
}

async function buildRepositoryRows(configuration: Configuration, weeks: number, reference: Date): Promise<unknown[]> {
  const { window } = await resolveReportWindow(configuration, weeks, reference);
  const organization = configuration.organization;
  const [cohort, states, facts] = await Promise.all([
    servedCohort(configuration, reference),
    storedRepositoryStates(organization),
    loadCachedFactsForOrganisation(
      organization,
      { pullRequests: sourceSignature(EvidenceSource.PullRequests), directCommits: sourceSignature(EvidenceSource.DirectCommits) },
      window.startsAt,
      window.endsAt
    )
  ]);

  const rows = cohort.map((entry) =>
    repositoryRow(configuration, entry, states.get(entry.repository), deserialiseMerges(facts.get(entry.repository)), undefined)
  );
  return stripAbsent(rows);
}

/** The estate's summary for one window. */
export async function overviewSummary(configuration: Configuration, weeks: number, reference = new Date()): Promise<unknown> {
  const { window, collectedThrough } = await resolveReportWindow(configuration, weeks, reference);
  const rows = (await repositoryRows(configuration, weeks, reference)) as {
    readiness?: string;
    merged_pull_requests?: number;
    direct_commits?: number;
    detail?: string;
  }[];

  const labels: Record<string, number> = {};
  for (const row of rows) {
    if (row.readiness !== undefined) {
      labels[row.readiness] = (labels[row.readiness] ?? 0) + 1;
    }
  }

  return stripAbsent({
    organization: configuration.organization,
    weeks,
    starts_at: window.startsAt.toISOString(),
    ends_at: window.endsAt.toISOString(),
    built_at: reference.toISOString(),
    collected_through: collectedThrough?.toISOString(),
    repositories: rows.length,
    unavailable: rows.filter((row) => row.detail !== undefined).length,
    // Counted off the rows rather than off `configuration.teams`, which no longer lists the estate's teams —
    // it lists the handful somebody has overridden. Includes the `unowned` bucket, because 360 repositories
    // are reported under it and a team count that omitted it would not add up against the cards below. It
    // excludes the individuals for the same reason: it is a count OF THE CARDS, so whatever `cohortTeams`
    // stops listing this figure has to stop counting.
    teams: cohortTeams(await servedCohort(configuration, reference)).length,
    // Contributor attribution is read from the cached facts, which the contributor rows walk; the estate summary
    // reports the count the rows agree on rather than a second walk that could disagree with them.
    actors: 0,
    merged_pull_requests: rows.reduce((total, row) => total + (row.merged_pull_requests ?? 0), 0),
    direct_commits: rows.reduce((total, row) => total + (row.direct_commits ?? 0), 0),
    labels
  });
}

/**
 * Each configured team's row.
 *
 * A repository counts for EVERY team that owns it, not only the one that happens to lead its row. The
 * consequence is deliberate and should not be "fixed": the team cards' repository counts now sum to MORE
 * than `overview.repositories`. A shared repository is one repository in the estate and a holding of two
 * teams, and both numbers are right.
 */
export async function teamRows(configuration: Configuration, weeks: number, reference = new Date()): Promise<unknown[]> {
  const rows = (await repositoryRows(configuration, weeks, reference)) as TeamAggregableRow[];
  const names = teamDisplayNames(configuration);
  // The teams come from the cohort now, not from the file. The file names only the teams somebody has overridden
  // an owner for, so iterating it would have reported a handful of cards for an estate of 154 teams.
  const teams = cohortTeams(await servedCohort(configuration, reference));
  // A person-owned row belongs to no card, and is dropped here rather than left to miss every identifier by
  // luck: nothing stops a login matching a team slug, and one that did would put somebody's repository under
  // that team's count.
  const attributable = rows.filter((row) => row.owner_kind !== OwnerKind.Person);

  return stripAbsent(
    teams.map((identifier) => {
      // `teams` is absent on the ordinary single-owner row, so fall back to the primary rather than treating
      // its absence as "owned by nobody".
      const owned = attributable.filter((row) => (row.teams ?? (row.team === undefined ? [] : [row.team])).includes(identifier));
      const labels: Record<string, number> = {};
      for (const row of owned) {
        if (row.readiness !== undefined) {
          labels[row.readiness] = (labels[row.readiness] ?? 0) + 1;
        }
      }
      return {
        team: identifier,
        // The slug IS the display name for most teams: only an overridden team has one in the file. Falling back
        // rather than prettifying the slug, because a generated title would read as a name somebody chose.
        display_name: names.get(identifier) ?? identifier,
        repositories: owned.length,
        // BOTH OF THESE WERE MISSING, and their absence made `/teams/<team>` throw for every team on the estate:
        // `TeamDetail.actors` is typed as a list and `src/app/teams/[team]/page.tsx` calls `.length` on it, so an
        // absent field was a TypeError caught as `notFound()` — a page reporting "no such team" for every team
        // there is. `unavailable` is read by the readiness donut on the same page and by `lib/team.ts`.
        //
        // `actors` is `[]` rather than a count: the contract types it as `TeamActorRow[]` and contributor
        // attribution is not assembled yet, so an empty list is the honest shape. `overviewSummary` sends
        // `actors: 0` for the same unbuilt figure because ITS contract types that one as a number.
        actors: [],
        unavailable: owned.filter((row) => row.detail !== undefined).length,
        practice: teamPractice(owned),
        labels
      };
    })
  );
}

/** What the team aggregation reads off a repository row. */
interface TeamAggregableRow {
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
function teamPractice(owned: readonly TeamAggregableRow[]): Record<string, unknown> {
  const reviewed = owned.filter((row) => row.required_approving_reviews !== undefined);
  const checked = owned.filter((row) => row.required_status_checks !== undefined);
  const graded = owned.filter((row) => row.unreviewed_substantial !== undefined);
  return {
    // How many of the team's gates were readable at all, so every figure below has its denominator stated.
    gates_measured: reviewed.length,
    enforces_review: reviewed.filter((row) => (row.required_approving_reviews ?? 0) >= 1).length,
    requires_multiple_reviews: reviewed.filter((row) => (row.required_approving_reviews ?? 0) >= 2).length,
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
function timings(owned: readonly TeamAggregableRow[]): Record<string, number | undefined> {
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

/** When the last collection landed, for the notice the dashboard shows above every page. */
export async function collectionNotice(): Promise<unknown> {
  const state = await collectionState();
  return stripAbsent({ collected_at: state?.collectedAt.toISOString(), revision: state === undefined ? undefined : Number(state.revision) });
}
