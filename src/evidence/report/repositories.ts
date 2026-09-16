import "server-only";
import { type ReadinessPolicy, readinessPolicy } from "../assessment/assessment.ts";
import {
  botAccounts,
  changeSize,
  contributorLogins,
  eligibleChecks,
  eligibleReviews,
  excludedAuthors,
  inCohort,
  isPassingCheck,
  type ReportedCohort,
  reportedCohort,
  reportedDirectCommit
} from "../behaviour/analysis.ts";
import { deserialise, loadCachedMerges } from "../behaviour/fill.ts";
import { behaviourMetrics, mergeCycleTime, timeToFirstReview } from "../behaviour/metrics.ts";
import { sourceSignature } from "../behaviour/queries.ts";
import { type AssuranceEvidence, assuranceGrade, judgeAssurance } from "../domain/assurance.ts";
import { EvidenceSource } from "../domain/coverage.ts";
import {
  type DirectCommitFact,
  type DistributionObservation,
  type Merges,
  ObservationStatus,
  type PullRequestFact,
  type RateObservation
} from "../domain/facts.ts";
import { type MergeGateEvidence, type MergeGateReport, requiredApprovals, requiredContexts } from "../domain/merge-gate.ts";
import type { OpenAlertCount, SecurityAlertEvidence } from "../domain/security-alerts.ts";
import { type CohortEntry, cohortTeams, servedCohort } from "../org/cohort.ts";
import { OwnerKind } from "../org/graph.ts";
import { contributorNames } from "../org/people.ts";
import { teamDisplayNames } from "../policy/repositories.ts";
import type { Configuration } from "../policy/schema.ts";
import { collectionState } from "../store/collection-state.ts";
import { cachedCoverageEdges, prevailingCachedCoverage } from "../store/coverage.ts";
import { loadCachedFactsForOrganisation, storedRepositoryStates } from "../store/facts.ts";
import { declaredProduction, type ProductionLayers, productionOverrides, reportedProduction } from "../store/production-override.ts";
import { storedRepositoryState } from "../store/repository-state.ts";
import { collectedAnchor, collectionIsStale, days, type ReportingWindow, reportingWindow } from "../window/window.ts";
import { stripAbsent } from "./absent.ts";
import { builtReport, CACHEABLE_SPANS, forgetBuiltReports } from "./cache.ts";
import { contractObservation } from "./observation.ts";

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
  production: ProductionLayers,
  measured: MeasuredRow
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
    //
    // THE PRODUCTION ANSWER IS ON THIS BRANCH TOO, on `owner_kind`'s precedent and for a stronger reason: two of
    // its three layers are STATEMENTS rather than observations, so a repository nobody has collected can still be
    // named in `production_repositories` or marked in the column, and answering nothing there would make policy
    // conditional on a walk having happened. The approvals list is passed as unread — that answer really does
    // live in the collected payload — so nothing here can invent a `false`.
    return {
      repository,
      team,
      teams: shared,
      ...facts,
      ...reportedRowProduction(undefined, production, repository),
      detail: "nothing has been collected for this repository"
    };
  }

  const gate = storedGate(state.payload);
  const assessment = policy.enabled ? policy.assess(merges, gate) : undefined;
  const payload = state.payload as { securityAlerts?: SecurityAlertEvidence; deploysToProduction?: boolean };

  return {
    repository,
    team,
    teams: shared,
    ...facts,
    // GRADED ON BOTH BRANCHES OF MEASURED-NESS, unlike the figures below, and the label is why: an unread merge
    // history grades `cannot_assess` through `insufficient-merges`, which is the right verdict for a repository
    // nobody walked. Suppressing it would take 650 repositories out of the readiness distribution the donut
    // accounts for, to say in an absence what the label already says in a word.
    readiness: assessment?.label,
    // The two gate figures are ABSENT where there is no gate to read them off, rather than zero: a repository
    // whose rules nobody may see is not a repository requiring no reviews.
    required_approving_reviews: gate.gate === undefined ? undefined : requiredApprovals(gate.gate),
    required_status_checks: gate.gate === undefined ? undefined : requiredContexts(gate.gate).length,
    ...behaviourFigures(policy, merges, measured),
    security: reportedAlerts(payload.securityAlerts),
    // THE COLUMN OVER THE UNION OF THE TWO LISTS, in both directions, and `undefined` where none of the three has
    // an answer — `reportedProduction` holds the whole rule, including the fold that lets a repository the graph
    // spells `PCS-API` be listed as `pcs-api`. Absent stays absent: an unread approvals list, a configured list
    // that does not name it and nobody with an opinion reports no key at all rather than a confident `false`.
    //
    // `production_source` rides beside it because the answer now has three possible authors — see
    // `ProductionSource`. Absent exactly where `production` is, so a reader cannot meet a provenance for an
    // answer nobody gave.
    ...reportedRowProduction(payload.deploysToProduction, production, repository),
    detail: unreportedDetail(gate, measured)
  };
}

/**
 * The production answer in the row's own spelling: `production` and, where something answered, `production_source`.
 *
 * SNAKE_CASE HERE AND NOWHERE ELSE, which is the same seam `reportedAlerts` crosses: the rule returns a domain
 * answer and this names it as the UI contract does. Both keys pass through `undefined` for `stripAbsent` to drop
 * rather than being conditionally spread, because the pair is absent or present together and one test of that is
 * enough.
 */
function reportedRowProduction(deploysToProduction: boolean | undefined, layers: ProductionLayers, repository: string): Record<string, unknown> {
  const answer = reportedProduction(deploysToProduction, layers, repository);
  return { production: answer.production, production_source: answer.source };
}

/** Whether each of one repository's two behaviour sources was read. See `measuredSources`. */
export interface MeasuredRow {
  pullRequests: boolean;
  directCommits: boolean;
}

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
function behaviourFigures(policy: ReadinessPolicy, merges: Merges, measured: MeasuredRow): Record<string, unknown> {
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
function unreportedDetail(gate: MergeGateReport, measured: MeasuredRow): string | undefined {
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
 *
 * `read` is the estate this span is derived from, for a caller building SEVERAL spans — see `estateForEverySpan`.
 * Omitted, this span reads the estate for itself, which is what a reader arriving on a cold span does.
 */
export async function repositoryRows(configuration: Configuration, weeks: number, reference = new Date(), read?: Estate): Promise<unknown[]> {
  return (await estateReports(configuration, weeks, reference, read)).rows;
}

/** The four reports one window's facts produce, built together because they read the same facts. */
interface EstateReports {
  rows: unknown[];
  actors: unknown[];
  merges: unknown[];
  directPushes: unknown[];
}

/** A repository the window holds no facts for. Whether that is a measured nothing is `measuredSources`' answer. */
const NO_MERGES: Merges = { pullRequests: [], directCommits: [] };

/** The widest span on offer, and so the one window a read has to cover to answer for all of them. */
const WIDEST_SPAN = Math.max(...WEEK_OPTIONS);

/** One fact and the instant the window that selected it was compared against, as a number to compare cheaply. */
interface Dated<FactT> {
  at: number;
  fact: FactT;
}

/** One repository's facts over a read's whole window, each still carrying the instant it was selected on. */
interface DatedFacts {
  pullRequests: Dated<PullRequestFact>[];
  directCommits: Dated<DirectCommitFact>[];
}

/**
 * The estate as one read of the database left it, which every span ending at `endsAt` is derived from.
 *
 * THE COHORT AND THE STATES DO NOT DEPEND ON THE SPAN AT ALL — they are facts about a repository rather than about
 * a window — and the facts that do are NESTED: every offered span is `[endsAt - weeks, endsAt)` against one
 * anchor, so the widest span's rows contain every narrower span's. That is what `estateForEverySpan` exploits and
 * what `covers` refuses to exploit wrongly.
 */
export interface Estate {
  /** How far back this read reaches. A span starting earlier than this cannot be answered from it. */
  startsAt: Date;
  /** Where every span derived from this read ends — the collected anchor `resolveReportWindow` snapped to. */
  endsAt: Date;
  cohort: CohortEntry[];
  states: Map<string, { fetchedAt: Date; payload: unknown }>;
  facts: Map<string, DatedFacts>;
  /** Which repositories each behaviour source was actually read for. See `measuredSources`. */
  measured: MeasuredSources;
  /**
   * What a person has said about which repositories are production services, keyed by casefolded name.
   *
   * On the estate read for the same reason the cohort and the states are: it is a fact about a repository and
   * not about a window, so one read answers for every offered span rather than one per span or one per row.
   */
  production: ReadonlyMap<string, boolean>;
}

/** The repositories each behaviour source was read for, by the collection every span derived here is anchored at. */
interface MeasuredSources {
  pullRequests: Set<string>;
  directCommits: Set<string>;
}

/**
 * The estate over one window: the cohort, the collected states, the coverage edges, the hand-set production flags,
 * and the window's facts deserialised ONCE.
 *
 * The five reads go together because none of them needs another's answer, and because the four that are not the
 * fact cache are the ones a per-span build was paying for five times over: `servedCohort` is two queries against
 * the change-versioned graph and `storedRepositoryStates` is 1,891 rows of `jsonb`.
 *
 * THE COHORT IS NARROWED HERE, which is the estate's half of the one seam `reportedCohort` states —
 * `cohort.excluded_authors` on the pull requests and the whole all-bots rule on the direct commits. It has to be
 * this read rather than `mergesSince` or `repositoryRow`: whether a merge counts is a fact about the merge and not
 * about a span, so narrowing once here settles it for all five spans and all four reports built from them, where
 * narrowing per span would run it five times and per row once per repository per span. Everything derived below
 * therefore counts the reported cohort and nothing else — the rows' figures, the readiness labels, the
 * substantial-merge denominators, the two timing medians, the contributor rows and both activity tables.
 *
 * It cannot disturb `measured`, and that separation is deliberate: measured-ness comes off the COVERAGE table and
 * this filters the FACTS. A repository whose walk succeeded and whose only merges were Renovate's is measured and
 * reports `0`; one nobody walked reports nothing at all. Filtering can move a count to zero and never to absent.
 */
async function readEstate(configuration: Configuration, window: ReportingWindow, reference: Date): Promise<Estate> {
  const organization = configuration.organization;
  const signatures = { pullRequests: sourceSignature(EvidenceSource.PullRequests), directCommits: sourceSignature(EvidenceSource.DirectCommits) };
  const excluded = excludedAuthors(configuration.cohort.excluded_authors);
  const bots = botAccounts(configuration.cohort.bot_accounts);
  const [cohort, states, stored, edges, production] = await Promise.all([
    servedCohort(configuration, reference),
    storedRepositoryStates(organization),
    loadCachedFactsForOrganisation(organization, signatures, window.startsAt, window.endsAt),
    cachedCoverageEdges(organization, signatures),
    productionOverrides(organization)
  ]);

  return {
    startsAt: window.startsAt,
    endsAt: window.endsAt,
    cohort,
    states,
    production,
    measured: measuredSources(edges, window.endsAt, cohort, configuration.cohort.no_direct_pushes),
    facts: new Map(
      [...stored].map(([repository, cached]) => [
        repository,
        {
          // `deserialise` rather than `deserialiseMerges`, because the payloads arrive dated: the same primitive
          // the per-repository path reads a payload with, so there is still one definition of what reviving one is.
          pullRequests: cached.pullRequests
            .map((row) => ({ at: row.at.getTime(), fact: deserialise<PullRequestFact>(row.payload) }))
            .filter((row) => inCohort(row.fact, excluded)),
          directCommits: cached.directCommits
            .map((row) => ({ at: row.at.getTime(), fact: deserialise<DirectCommitFact>(row.payload) }))
            .filter((row) => reportedDirectCommit(row.fact, excluded, bots))
        }
      ])
    )
  };
}

/**
 * Which repositories each source was READ for, over the window every span derived from this read shares.
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
function measuredSources(
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

/**
 * Where one span starts, given where the read it is derived from ends.
 *
 * The SAME arithmetic `resolveReportWindow` does, and not an approximation of it: both are
 * `anchor - weeks * 7 days` against the anchor `collectedAnchor` snapped to, and `reportingWindow` returns the
 * instants it was handed. So a span derived from a shared read and the same span read for itself resolve to the
 * identical window rather than to two windows that happen to agree.
 */
function spanStartsAt(endsAt: Date, weeks: number): Date {
  return new Date(endsAt.getTime() - days(weeks * 7));
}

/** Whether one read reaches far enough back, and ends at the right instant, to answer for a span. */
function covers(read: Estate, weeks: number, window: ReportingWindow): boolean {
  return read.endsAt.getTime() === window.endsAt.getTime() && spanStartsAt(read.endsAt, weeks).getTime() >= read.startsAt.getTime();
}

/**
 * One span's merges, taken out of a read that may cover a wider window.
 *
 * Filtered on the instant the QUERY selected each fact on rather than on the payload's own copy of it — see
 * `DatedFact` — so this returns exactly what a query for this span would have returned. `>=` and no upper bound,
 * because every span shares the read's `endsAt` and the window is half-open at that end already.
 *
 * A repository left with nothing is OMITTED rather than carried as empty lists, which is what a query for this
 * span produces: `repositoryRow` reads an absent entry as `NO_MERGES` and the three fact-walking reports would
 * otherwise iterate a map the size of the estate to find nothing in most of it.
 */
function mergesSince(read: Estate, startsAt: Date): Map<string, Merges> {
  const from = startsAt.getTime();
  const merges = new Map<string, Merges>();
  for (const [repository, dated] of read.facts) {
    const pullRequests = dated.pullRequests.filter((row) => row.at >= from).map((row) => row.fact);
    const directCommits = dated.directCommits.filter((row) => row.at >= from).map((row) => row.fact);
    if (pullRequests.length === 0 && directCommits.length === 0) {
      continue;
    }
    merges.set(repository, { pullRequests, directCommits });
  }
  return merges;
}

/**
 * The estate read once, over the widest span on offer, so every span can be built from it.
 *
 * ONE READ FOR FIVE SPANS. Each span was reading the cohort, the collected states and the fact cache for itself,
 * and because the spans are nested that read the same rows over and over: measured on AAT, warming the five
 * offered spans transferred 92 MiB of `jsonb` to derive reports from 32 MiB of it, made five passes over the
 * repository states, resolved the cohort five times and stamped the coverage table five times. The widest span's
 * rows contain every narrower span's, so the other four are a filter rather than a query.
 *
 * The window is resolved for `WIDEST_SPAN` only, which also settles the anchor once: `resolveReportWindow`
 * aggregates `source_coverage` to find it, and each span was asking again for an answer that cannot differ
 * inside one warm.
 *
 * WHAT THIS DOES NOT DO is hold the read. It is handed to the builds, and it goes out of scope when the caller
 * that took it does — the facts are far larger than everything derived from them, which is why `./cache.ts`
 * holds the reports and never these.
 */
export async function estateForEverySpan(configuration: Configuration, reference = new Date()): Promise<Estate> {
  const { window } = await resolveReportWindow(configuration, WIDEST_SPAN, reference);
  return await readEstate(configuration, window, reference);
}

/**
 * Every report one span produces, built from ONE read of the fact cache and held as one entry.
 *
 * FOUR REPORTS, ONE LOAD, and that is the whole point of this function. They were four builds each calling
 * `loadCachedFactsForOrganisation` for itself, which read the window's facts four times over — at 26 weeks that is
 * four passes over 23,000 pull-request payloads. Worse, only the repositories report was warmed, so the first
 * reader of `/contributors` or any team page paid for a fresh load on a cold pod; measured on a staging install,
 * `page.goto` did not finish inside 30 seconds and the regression suite timed out.
 *
 * The facts are deserialised once here and DROPPED when this returns. What is held is the four reports, which are
 * counts, labels and small rows — the facts themselves are far larger than everything derived from them, and
 * holding those per span is how a 2Gi pod runs out of heap.
 *
 * Warming the repositories report now warms all four, because there is only one build to warm.
 */
async function estateReports(configuration: Configuration, weeks: number, reference: Date, read?: Estate): Promise<EstateReports> {
  // Wrapped in a one-element array because `builtReport` holds `unknown[]`. The alternative is widening the cache
  // to `unknown`, which buys nothing: every reader of it goes through the four accessors below.
  const held = await builtReport(configuration.organization, weeks, async () => [await buildEstateReports(configuration, weeks, reference, read)]);
  return held[0] as EstateReports;
}

async function buildEstateReports(configuration: Configuration, weeks: number, reference: Date, shared?: Estate): Promise<EstateReports> {
  const { window } = await resolveReportWindow(configuration, weeks, reference);
  // A shared read that does not reach this span is IGNORED rather than trusted, and the guard is not decoration:
  // a span added to the selector beyond `WIDEST_SPAN`, or an anchor that moved between the read and this build,
  // would otherwise be answered from facts that stop short of the window and reported as a quiet drop in merges.
  const read = shared !== undefined && covers(shared, weeks, window) ? shared : await readEstate(configuration, window, reference);
  const facts = mergesSince(read, spanStartsAt(read.endsAt, weeks));
  // THE TWO LISTS A ROW'S PRODUCTION ANSWER IS RESOLVED THROUGH, folded once for the whole estate. The marked
  // column comes off the shared read; the configured list is policy and is folded here for `measuredSources`'
  // reason — a hand-typed name and a repository name are spelled by different hands, and the comparison has to
  // fold on both sides.
  const production: ProductionLayers = { declared: declaredProduction(configuration.production_repositories), marked: read.production };
  // The measured-ness comes off the shared read like everything else the row is handed: it is a fact about which
  // sources a collection reached, so it is settled once for the estate rather than asked per row or per span.
  const rows = stripAbsent(
    read.cohort.map((entry) =>
      repositoryRow(configuration, entry, read.states.get(entry.repository), facts.get(entry.repository) ?? NO_MERGES, production, {
        pullRequests: read.measured.pullRequests.has(entry.repository),
        directCommits: read.measured.directCommits.has(entry.repository)
      })
    )
  );
  // The graph's names, read once per span build and held with the reports rather than per page. It is 778 rows on
  // this estate and it does not vary by span — but the four reports are what the cache holds, so a name that rode
  // its own entry would be a second thing to invalidate when a collection lands.
  const names = await contributorNames(configuration.organization);

  return {
    rows,
    actors: builtActorRows(rows as { repository: string; readiness?: string }[], facts, names, botAccounts(configuration.cohort.bot_accounts)),
    merges: builtMergeRows(facts),
    directPushes: builtDirectPushRows(facts)
  };
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
    // The length of the contributor rows rather than a second walk of the facts, so the header and `/contributors`
    // cannot disagree about how many people the span holds. Both builds are held per revision, so this is a map
    // lookup on every render but the first.
    actors: (await actorRows(configuration, weeks, reference)).length,
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
  // The rows AND the two activity reports off one read, where this took `repositoryRows` alone: the contributor
  // count below is folded from the merge and direct-push rows, which are already built beside the rows in the same
  // cache entry. See `estateReports` — asking for them separately would be a second lookup of one held report, and
  // deriving the count from the facts instead would be the drift `authorsByRepository` records.
  const reports = await estateReports(configuration, weeks, reference);
  const rows = reports.rows as TeamAggregableRow[];
  const authors = authorsByRepository([...reports.merges, ...reports.directPushes] as AttributedChange[]);
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
        // BOTH OF THESE WERE MISSING, and their absence made `/teams/<team>` throw for every team on the estate:
        // `TeamDetail.actors` is typed as a list and `src/app/teams/[team]/page.tsx` calls `.length` on it, so an
        // absent field was a TypeError caught as `notFound()` — a page reporting "no such team" for every team
        // there is. `unavailable` is read by the readiness donut on the same page and by `lib/team.ts`.
        //
        // A COUNT, from 2026-09-15. This emitted `[]` on the reasoning that the contract types `actors` as
        // `TeamActorRow[]` — which `TeamDetail` does, and this is a `TeamRow`, where it is declared a NUMBER. Two
        // interfaces of one name, and the double cast in `src/lib/api.ts` is what kept the compiler out of it.
        // `TeamsList` prints the field through `count(...)`, a template literal, so an empty array stringified to
        // nothing and all 154 cards read " contributors" with no figure in front of the word.
        actors: contributors.size,
        unavailable: owned.filter((row) => row.detail !== undefined).length,
        practice: teamPractice(owned),
        labels
      };
    })
  );
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
 */
/**
 * Where one readiness label sits in the order a combination is read in: best first, ungraded last.
 *
 * The same order `lib/rag.ts` gives the labels through `COMBINATION_DIGIT` — green 1, amber 2, red 3, and the
 * ungraded ones no digit at all. Restated here rather than imported, because the report layer does not read the
 * UI's modules; an unknown label sorts last rather than throwing, so a label added to the domain appears at the
 * end of a badge row instead of taking a page down.
 */
const READINESS_ORDER: readonly string[] = ["green", "amber", "red", "cannot_assess"];

function readinessRank(label: string): number {
  const rank = READINESS_ORDER.indexOf(label);
  return rank === -1 ? READINESS_ORDER.length : rank;
}

export async function actorRows(configuration: Configuration, weeks: number, reference = new Date()): Promise<unknown[]> {
  return (await estateReports(configuration, weeks, reference)).actors;
}

/**
 * Pure over the rows and facts `estateReports` already holds.
 *
 * It used to await `repositoryRows` for the readiness labels and load the facts again for itself. Both are in hand
 * by the time this is called, which is the point of building the four together — and it removes a report reading
 * another report, which was one build waiting on a second that shared its data.
 */
function builtActorRows(
  rows: readonly { repository: string; readiness?: string }[],
  facts: ReadonlyMap<string, Merges>,
  names: ReadonlyMap<string, string>,
  bots: ReadonlySet<string>
): unknown[] {
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

  const actors = [...appearances.entries()].map(([login, repositories]) => {
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
 * NOT CACHED, unlike the four estate-wide reports. This is keyed by repository as well as by span, and the spans
 * come off a query string: holding one entry per repository per span is a map the size of the estate times the
 * selector, evicted by nothing. It costs two fact queries and one state read for a page a reader asked for by
 * name, which is the shape `loadCachedMerges` exists for.
 *
 * `measured` IS HANDED IN AND NOT READ HERE, exactly as `repositoryRow` is handed its own. `src/lib/api.ts` holds
 * this repository's estate row by the time it calls this, and that row's two counts are absent precisely where a
 * source went unread — so the answer is already in the caller's hand, and reading `source_coverage` again would
 * add a query to a per-page path for a fact one read of the estate has already settled.
 */
export async function repositoryEvidence(
  configuration: Configuration,
  repository: string,
  weeks: number,
  measured: MeasuredRow,
  reference = new Date()
): Promise<unknown | undefined> {
  const organization = configuration.organization;
  const { window } = await resolveReportWindow(configuration, weeks, reference);
  const [cohort, state, walked] = await Promise.all([
    servedCohort(configuration, reference),
    storedRepositoryState(organization, repository),
    loadCachedMerges(organization, repository, window)
  ]);

  const entry = cohort.find((candidate: CohortEntry) => candidate.repository === repository);
  if (entry === undefined || state === undefined) {
    // The page's own empty state handles this, and says which of the two it was through `RepositoryRow.detail`.
    return undefined;
  }

  const policy = readinessPolicy(configuration);
  const gate = storedGate(state.payload);
  const payload = state.payload as { securityAlerts?: SecurityAlertEvidence };
  const fetched = state.fetchedAt.toISOString();
  // The per-repository half of the one seam. `walked` is everything the collection cached and `reported.merges`
  // is what this page counts, so every figure below — the assessment, the metric summaries and the unreviewed
  // verdict — is computed on the same cohort the estate row's figures are, and the two pages cannot disagree.
  const reported = reportedCohort(walked, excludedAuthors(configuration.cohort.excluded_authors), botAccounts(configuration.cohort.bot_accounts));
  const merges = reported.merges;

  return stripAbsent({
    repository,
    team: entry.owners[0] ?? "",
    starts_at: window.startsAt.toISOString(),
    ends_at: window.endsAt.toISOString(),
    // `offline` because this reads the cache and never GitHub — a report is served from what a collection left,
    // which is the whole point of the fact tables. No interval is fetched to render a page.
    provenance: { offline: true, intervals_fetched: 0 },
    cohort: cohortSummary(walked, reported, measured),
    assessment: policy.enabled ? policy.assess(merges, gate) : undefined,
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
    // Per-actor rule breaches, which nothing computes: `configuration.practice` declares the rules and no
    // producer evaluates them, so the honest answer is that there are no findings to show rather than none found.
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
 */
function cohortSummary(walked: Merges, reported: ReportedCohort, measured: MeasuredRow): Record<string, unknown> {
  return {
    ...(measured.pullRequests ? { merged: walked.pullRequests.length, reported: reported.merges.pullRequests.length } : {}),
    excluded_authors: reported.excluded,
    ...(measured.directCommits ? { direct_commits: reported.merges.directCommits.length } : {})
  };
}

/**
 * The stored merge gate in the shape the UI declares, which is NOT the shape it is stored in.
 *
 * Two translations, not one. The obvious one is case: the domain holds `pullRequests` and the contract declares
 * `pull_requests`, and every field differs the same way. The one that would survive a careless rename is
 * STRUCTURAL — the domain holds a status-checks rule's contexts as `string[]`, and the contract declares
 * `required_status_checks` as a list of objects with a `context` each, because it carries an optional
 * `integration_id` the collector does not read.
 *
 * This never surfaced before because `repositoryRow` reads the stored gate only through `requiredApprovals` and
 * `requiredContexts`, which are domain functions over the domain shape. The moment the gate itself went on the
 * contract, `mergeGateRows` called `.map` on an undefined `pull_requests` and took the page down.
 *
 * `required_review_thread_resolution` is OMITTED rather than sent as `false`. The collector does not model it, so
 * `false` would be a claim that a repository does not require thread resolution when nobody asked GitHub. Nothing
 * renders it — `mergeGateRows` prints ten rows and that is not one of them.
 */
function contractGate(report: MergeGateReport, fetched: string): Record<string, unknown> {
  if (report.gate === undefined) {
    return { detail: report.detail ?? "the merge gate has not been collected" };
  }
  const gate = report.gate;
  return {
    fetched_at: fetched,
    gate: {
      branch: gate.branch,
      protected: gate.protected,
      pull_requests: gate.pullRequests.map((rule) => ({
        required_approving_review_count: rule.requiredApprovingReviewCount,
        dismiss_stale_reviews_on_push: rule.dismissStaleReviewsOnPush,
        require_code_owner_review: rule.requireCodeOwnerReview,
        require_last_push_approval: rule.requireLastPushApproval
      })),
      status_checks: gate.statusChecks.map((rule) => ({
        strict_required_status_checks_policy: rule.strictRequiredStatusChecksPolicy,
        required_status_checks: rule.contexts.map((context) => ({ context }))
      })),
      restricts_deletions: gate.restrictsDeletions,
      blocks_force_pushes: gate.blocksForcePushes,
      applies_to_administrators: gate.appliesToAdministrators,
      rules_observed: gate.rulesObserved,
      requires_linear_history: gate.requiresLinearHistory,
      restricts_branch_names: gate.restrictsBranchNames,
      unmodelled_rules: gate.unmodelledRules
    }
  };
}

/**
 * The alert block, or the reason there is none.
 *
 * THROUGH `reportedAlerts`, which is the same translation the estate row makes: the stored evidence is the domain's
 * `codeScanning`/`bySeverity` and the contract declares `code_scanning`/`by_severity`. Handing the stored object
 * straight over type-checks — both are `SecurityAlertEvidence`, one per module — and then `severityDetail` reads
 * `by_severity.critical` off an object that has no such key and throws. Two shapes, one name, in two files.
 */
function securityReport(alerts: SecurityAlertEvidence | undefined, fetched: string): Record<string, unknown> {
  if (alerts === undefined) {
    return { detail: "no security alert family was collected for this repository" };
  }
  return { fetched_at: fetched, alerts: reportedAlerts(alerts) };
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
 * `sample_size`/`percentile_75`. See `./observation.ts` for what a reader saw instead.
 */
function metricSummaries(configuration: Configuration, merges: Merges): Record<string, unknown>[] {
  return behaviourMetrics(configuration.traceability).map((metric) => {
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
export async function mergeRows(configuration: Configuration, weeks: number, reference = new Date()): Promise<unknown[]> {
  return (await estateReports(configuration, weeks, reference)).merges;
}

function builtMergeRows(facts: ReadonlyMap<string, Merges>): unknown[] {
  const rows = [];
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

export async function directPushRows(configuration: Configuration, weeks: number, reference = new Date()): Promise<unknown[]> {
  return (await estateReports(configuration, weeks, reference)).directPushes;
}

function builtDirectPushRows(facts: ReadonlyMap<string, Merges>): unknown[] {
  const rows = [];
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

/** What a merge or direct-push row is asked for the contributor count: which repository, and who landed it. */
interface AttributedChange {
  repository: string;
  author?: string;
}

/**
 * Who authored a reported change in each repository, case-folded.
 *
 * OFF THE EMITTED ROWS AND NOT THE FACTS, which is what makes a team card's count and the table on that team's own
 * page one answer rather than two: `teamActors` in `src/lib/api.ts` folds these same two reports for the page, and a
 * second derivation over `read.facts` would drift from it in two ways that are easy to miss — `builtDirectPushRows`
 * falls back to the git author name where GitHub matched no account, and `contributorLogins`, which `builtActorRows`
 * goes through, drops the logins it judges not to be people. Either difference would put a number on a card that
 * the table below it contradicts, and the ticket's own acceptance criterion is that the two agree.
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
