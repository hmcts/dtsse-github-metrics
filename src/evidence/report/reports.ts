import "server-only";
import type * as contract from "../../lib/types.ts";
import { readinessPolicy } from "../assessment/assessment.ts";
import { botAccounts } from "../behaviour/analysis.ts";
import { loadCachedMerges } from "../behaviour/fill.ts";
import { sourceSignature } from "../behaviour/queries.ts";
import { EvidenceSource } from "../domain/coverage.ts";
import { type CohortEntry, cohortTeams, servedCohort } from "../org/cohort.ts";
import { contributorNames } from "../org/people.ts";
import { enablementInstants, teamDisplayNames } from "../policy/repositories.ts";
import type { Configuration } from "../policy/schema.ts";
import { storedRepositoryAlertScans } from "../store/alerts.ts";
import { getSourceCoverage } from "../store/coverage.ts";
import { declaredProduction, type ProductionLayers } from "../store/production-override.ts";
import { storedRepositoryState } from "../store/repository-state.ts";
import { baselineWindow, days, periodWindows, type ReportingWindow, reportingWindow } from "../window/window.ts";
import { stripAbsent } from "./absent.ts";
import { builtReport, forgetBuiltReports } from "./cache.ts";
import { covers, type Estate, mergesSince, NO_MERGES, readEstate, resolveReportWindow } from "./estate.ts";
import type { MeasuredRow } from "./measured.ts";
import { builtOverviewSummary } from "./overview.ts";
import { builtRepositoryEvidence } from "./repository-evidence.ts";
import { builtActorRows } from "./rows/actors.ts";
import { builtDirectPushRows, builtMergeRows } from "./rows/changes.ts";
import { builtTeamMemberRows } from "./rows/members.ts";
import { repositoryRow } from "./rows/repository.ts";
import { requestedTrendPeriods, spanStartsAt, TREND_PERIOD_DAYS } from "./spans.ts";
import { builtTeamRows } from "./teams.ts";
import { builtRepositoryTrend, trendWithoutEnablement, trendWithoutWholePeriod } from "./trend.ts";

/**
 * Assembling what the dashboard reads. Ported from `metrics.evidence` and the report-building half of
 * `metrics.service`.
 *
 * THE ONE MODULE ABOVE THIS SEAM IMPORTS. `src/lib/api.ts` reaches the whole report layer through this file, so the
 * decomposition below it — `./spans.ts`, `./estate.ts`, `./measured.ts`, `./contract/**`, `./rows/**`,
 * `./overview.ts`, `./teams.ts`, `./repository-evidence.ts` — is invisible to every page. What each of those holds is
 * stated in its own header; what this one holds is the ORCHESTRATION: which reads happen, in what order, and what is
 * built once and shared.
 *
 * EVERY SHAPE HERE IS DECLARED AS THE CONTRACT'S OWN TYPE, imported as `contract` and never by bare name. The
 * contract is `src/lib/types.ts` and it re-declares nine domain type names identically — `MergeGateEvidence`,
 * `SecurityAlertEvidence`, `Observation`, `SonarRating`, `ReadinessLabel`, `MaintenanceEvidence`, `CodeownersFile`,
 * `MaintenanceWindowStatus`, `SonarQualityGate` — plus the latent `TrendMetric`, `TrendDelta`, `TrendThroughput`
 * and `DeltaBasis`. Handing a domain object to a parameter of the same name type-checked cleanly and then threw at
 * `.map`, or rendered `"undefined samples"`; the namespace makes each crossing read `contract.MergeGateEvidence`, so
 * the two shapes cannot be spelled the same way and cannot be confused for one another.
 *
 * THE IMPORT IS TYPE-ONLY AND THE DEPENDENCY GOES ONE WAY. The report layer imports the contract; the contract
 * imports nothing, which is its own stated rule. `import type` is erased, so there is no runtime edge, no bundling
 * consequence and nothing for `tsconfig.cli.json` to resolve — which is also why the specifier is relative: nothing
 * under `src/evidence` may use the `@/*` alias, since the CLI output is run by Node with no rewriter.
 *
 * `stripAbsent` is applied on the way out so a `null` from Prisma or a jsonb round trip can never reach a component
 * that reads the field as optional. It is the runtime half; the declarations above are the compile-time half, and
 * `test/integration/report-rows.test.ts` asserts the emitted key sets against the contract for the places a
 * declaration cannot reach.
 */

export { type Estate, estateForEverySpan, windowOptions } from "./estate.ts";
export type { MeasuredRow } from "./measured.ts";

/** Forgets every built report, so a test or a development reload starts cold. See `./cache.ts`. */
export function forgetBuiltRows(): void {
  forgetBuiltReports();
}

/**
 * The reports one window's facts produce, built together because they read the same facts, and the two answers that
 * come from the graph and the coverage table instead.
 *
 * EACH IS THE CONTRACT'S OWN ROW TYPE, which is what makes `src/lib/api.ts` able to hand them to a page with no
 * cast. It was four `unknown[]`, and that is how `builtTeamRows` came to emit `TeamRow.actors` as a list where the
 * contract declares a number: two interfaces of one name, and nothing between the two able to disagree.
 *
 * `members` IS NOT DERIVED FROM THE FACTS AT ALL, and is held here because of what holding it costs rather than
 * where it comes from: it is what GitHub says about each team, so it does not vary by span and nothing in the
 * window can change it. Its rows ride this entry so that a collection landing invalidates the membership and the
 * fact reports together — one stamp, one thing to reason about — instead of leaving a second cache to notice
 * on its own. See `builtTeamMemberRows`.
 *
 * `teams` AND `window` RIDE IT FOR THE SAME REASON, and both were a repeated query before they did. `servedCohort`
 * is two queries against the change-versioned graph and the overview and the team cards each resolved it for
 * themselves, so every `/teams` render paid for it twice; `resolveReportWindow` aggregates `source_coverage` and the
 * overview asked again for the anchor this build had already snapped to. Holding them also makes the summary
 * describe exactly the window its rows were built over rather than one resolved a moment later.
 */
interface EstateReports {
  rows: contract.RepositoryRow[];
  actors: contract.ActorRow[];
  merges: contract.TeamMergeRow[];
  directPushes: contract.TeamDirectPushRow[];
  /** Each team's members, keyed on the folded team slug. A team absent from it had no membership read. */
  members: ReadonlyMap<string, contract.TeamMemberRow[]>;
  /** The teams the cohort resolved to, in the order the cards are drawn. */
  teams: string[];
  /** The window these reports describe, and how far the collection behind them reached. */
  window: ReportingWindow;
  collectedThrough?: Date;
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
export async function repositoryRows(configuration: Configuration, weeks: number, reference = new Date(), read?: Estate): Promise<contract.RepositoryRow[]> {
  return (await estateReports(configuration, weeks, reference, read)).rows;
}

/** The estate's summary for one window, folded from the reports the same build produced. */
export async function overviewSummary(configuration: Configuration, weeks: number, reference = new Date()): Promise<contract.OverviewSummary> {
  const reports = await estateReports(configuration, weeks, reference);
  return builtOverviewSummary(
    {
      organization: configuration.organization,
      weeks,
      window: reports.window,
      collectedThrough: reports.collectedThrough,
      rows: reports.rows,
      teams: reports.teams,
      actors: reports.actors.length
    },
    reference
  );
}

/**
 * Each cohort team's row.
 *
 * The rows AND the two activity reports off one read, where this took `repositoryRows` alone: the contributor count
 * on a card is folded from the merge and direct-push rows, which are already built beside the rows in the same
 * cache entry. See `estateReports` — asking for them separately would be a second lookup of one held report.
 */
export async function teamRows(configuration: Configuration, weeks: number, reference = new Date()): Promise<contract.TeamRow[]> {
  const reports = await estateReports(configuration, weeks, reference);
  return builtTeamRows(reports.rows, [...reports.merges, ...reports.directPushes], reports.teams, teamDisplayNames(configuration));
}

export async function actorRows(configuration: Configuration, weeks: number, reference = new Date()): Promise<contract.ActorRow[]> {
  return (await estateReports(configuration, weeks, reference)).actors;
}

/**
 * Every team's members, keyed on the folded team slug.
 *
 * A MAP FOR THE WHOLE ESTATE AND NOT ONE TEAM'S LIST, which is what keeps the read off the page: a team page looks
 * its own slug up in a report the estate already built, so the 154th team page of a revision costs a map lookup
 * and no query. `getTeam` is the caller.
 *
 * The `weeks` it takes is the cache key and nothing else — membership does not vary by span, and the read behind
 * this happens once per estate read for all five of them. It is a parameter so that a team page reads the same
 * held entry as the rows and tables beside it rather than a build of its own.
 */
export async function teamMemberRows(
  configuration: Configuration,
  weeks: number,
  reference = new Date()
): Promise<ReadonlyMap<string, contract.TeamMemberRow[]>> {
  return (await estateReports(configuration, weeks, reference)).members;
}

export async function mergeRows(configuration: Configuration, weeks: number, reference = new Date()): Promise<contract.TeamMergeRow[]> {
  return (await estateReports(configuration, weeks, reference)).merges;
}

export async function directPushRows(configuration: Configuration, weeks: number, reference = new Date()): Promise<contract.TeamDirectPushRow[]> {
  return (await estateReports(configuration, weeks, reference)).directPushes;
}

/**
 * One repository's evidence block, or nothing where the estate holds no such repository.
 *
 * NOT CACHED, unlike the estate-wide reports. This is keyed by repository as well as by span, and the spans come
 * off a query string: holding one entry per repository per span is a map the size of the estate times the selector,
 * evicted by nothing. It costs two fact queries, one state read and one scan read for a page a reader asked for by
 * name, which is the shape `loadCachedMerges` exists for. What the reads produce is assembled by
 * `builtRepositoryEvidence`, which states the rest.
 *
 * THE ALERT SCANS ARE A FOURTH READ AND ARE ISSUED WITH THE OTHER THREE, not after them: nothing in the block
 * depends on them, so serialising it behind the cohort would add a round trip to the page for no ordering. It is a
 * per-repository read and stays off the estate path — `/repositories` draws counts and has no alert to name, so
 * loading 1,890 repositories' alerts to render a table that shows none of them would be the estate's cost for this
 * page's feature.
 */
export async function repositoryEvidence(
  configuration: Configuration,
  repository: string,
  weeks: number,
  measured: MeasuredRow,
  reference = new Date()
): Promise<contract.RepositoryPracticeEvidence | undefined> {
  const organization = configuration.organization;
  const { window } = await resolveReportWindow(configuration, weeks, reference);
  const [cohort, state, walked, scans] = await Promise.all([
    servedCohort(configuration, reference),
    storedRepositoryState(organization, repository),
    loadCachedMerges(organization, repository, window),
    storedRepositoryAlertScans(organization, repository)
  ]);

  const entry = cohort.find((candidate: CohortEntry) => candidate.repository === repository);
  if (entry === undefined || state === undefined) {
    // The page's own empty state handles this, and says which of the two it was through `RepositoryRow.detail`.
    return undefined;
  }

  return builtRepositoryEvidence(configuration, { repository, entry, state, walked, window, measured, scans });
}

/**
 * One repository's trend series since its `enablement:` date.
 *
 * NOT CACHED, for the reason `repositoryEvidence` above is not: a series is keyed by repository as well as by the
 * cut it was asked for, so holding one would be a map the size of the estate, evicted by nothing. It costs the
 * same shape of read as the evidence block beside it on the same page — two fact queries and two coverage reads,
 * all four for a page a reader asked for by name — and ONE fact query per source rather than one per window,
 * which is what `TrendSeriesInput.walked` exists to make possible.
 *
 * THE CUT COMES FROM THE REQUEST AND HAS NO SERVER-SIDE DEFAULT. `requestedTrendPeriods` refuses a count above
 * `WindowOptions.trend_periods` rather than truncating it, and an omitted count means every whole period since
 * enablement. See `./spans.ts` for why refusing is the honest answer when the cut drops the recent end.
 *
 * TWO ANSWERS SHORT OF A SERIES, both real states rather than errors: a repository with no enablement date and one
 * enabled too recently for a whole period to have elapsed. `./trend.ts` builds each, and they are told apart by
 * whether the series carries an `enablement_at` and not only by their prose.
 */
export async function repositoryTrend(
  configuration: Configuration,
  repository: string,
  periods?: number,
  reference = new Date()
): Promise<contract.RepositoryTrend> {
  const cut = requestedTrendPeriods(periods);
  // Through `enablementInstants`, which is the one reader of `enablement:` in the codebase. The schema
  // deliberately does NOT check an enablement key against the cohort — it cannot know the cohort without a
  // database — so this is where a key that matches no repository surfaces, as the reason a series has no periods.
  const enablement = enablementInstants(configuration, [repository]).get(repository);
  if (enablement === undefined) {
    return trendWithoutEnablement(repository);
  }
  const span = days(TREND_PERIOD_DAYS);
  const windows = periodWindows(enablement, span, cut, reference);
  const last = windows[windows.length - 1];
  if (last === undefined) {
    return trendWithoutWholePeriod(repository, enablement, TREND_PERIOD_DAYS);
  }
  const baseline = baselineWindow(enablement, span);
  const organization = configuration.organization;
  const [walked, pullRequests, directCommits] = await Promise.all([
    // ONE READ SPANNING THE BASELINE AND EVERY PERIOD, sliced per window by `builtRepositoryTrend`.
    loadCachedMerges(organization, repository, reportingWindow(baseline.startsAt, last.endsAt)),
    getSourceCoverage({ organization, repository, source: EvidenceSource.PullRequests, queryHash: sourceSignature(EvidenceSource.PullRequests) }),
    getSourceCoverage({ organization, repository, source: EvidenceSource.DirectCommits, queryHash: sourceSignature(EvidenceSource.DirectCommits) })
  ]);
  // The coverage INTERVALS rather than the front edge `measuredSources` reads, for the reason `covers` in
  // `./trend.ts` gives: a window this series reaches may sit entirely behind what any collection filled.
  return builtRepositoryTrend(configuration, {
    repository,
    enablement,
    baseline,
    periods: windows,
    walked,
    coverage: { pullRequests, directCommits }
  });
}

/**
 * Every report one span produces, built from ONE read of the fact cache and held as one entry.
 *
 * ONE LOAD FOR ALL OF THEM, and that is the whole point of this function. They were four builds each calling
 * `loadCachedFactsForOrganisation` for itself, which read the window's facts four times over — at 26 weeks that is
 * four passes over 23,000 pull-request payloads. Worse, only the repositories report was warmed, so the first
 * reader of `/contributors` or any team page paid for a fresh load on a cold pod; measured on a staging install,
 * `page.goto` did not finish inside 30 seconds and the regression suite timed out.
 *
 * The facts are deserialised once here and DROPPED when this returns. What is held is the reports, which are
 * counts, labels and small rows — the facts themselves are far larger than everything derived from them, and
 * holding those per span is how a 2Gi pod runs out of heap.
 *
 * Warming the repositories report now warms all of them, because there is only one build to warm.
 */
async function estateReports(configuration: Configuration, weeks: number, reference: Date, read?: Estate): Promise<EstateReports> {
  // Wrapped in a one-element array because `builtReport` holds `unknown[]`. The alternative is widening the cache
  // to `unknown`, which buys nothing: every reader of it goes through the accessors above.
  const held = await builtReport<EstateReports>(configuration.organization, weeks, async () => [
    await buildEstateReports(configuration, weeks, reference, read)
  ]);
  // `builtReport` holds a list and this build produces one entry, so the element is present by construction —
  // `noUncheckedIndexedAccess` cannot see that, and the alternative is widening the cache to a single value, which
  // buys nothing: every reader of it goes through the accessors above.
  return held[0] as EstateReports;
}

async function buildEstateReports(configuration: Configuration, weeks: number, reference: Date, shared?: Estate): Promise<EstateReports> {
  const { window, collectedThrough } = await resolveReportWindow(configuration, weeks, reference);
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
  // ONE POLICY FOR THE WHOLE ESTATE. It closes over the assessment and triviality blocks and holds no per-row
  // state, and building one inside `repositoryRow` was roughly 1,880 constructions per span against five spans a
  // warm — in the path this file's own header records a 7.89s to 0.71s tuning of.
  const policy = readinessPolicy(configuration);
  // The measured-ness comes off the shared read like everything else the row is handed: it is a fact about which
  // sources a collection reached, so it is settled once for the estate rather than asked per row or per span.
  const rows = stripAbsent(
    read.cohort.map((entry) =>
      repositoryRow(
        policy,
        entry,
        read.states.get(entry.repository),
        facts.get(entry.repository) ?? NO_MERGES,
        production,
        {
          pullRequests: read.measured.pullRequests.has(entry.repository),
          directCommits: read.measured.directCommits.has(entry.repository)
        },
        // FOLDED, because the stored key is casefolded and the cohort's spelling is whatever the graph answered
        // — the same correction `reportedProduction` makes, and for the same reason: the name here was parsed
        // out of a git URL that spells the owner `HMCTS`. Without the fold a repository the graph spells
        // `PCS-API` would read as never scanned.
        read.cves.get(entry.repository.toLowerCase())
      )
    )
  );
  // The graph's names, read once per span build and held with the reports rather than per page. It is 778 rows on
  // this estate and it does not vary by span — but the reports are what the cache holds, so a name that rode
  // its own entry would be a second thing to invalidate when a collection lands.
  const names = await contributorNames(configuration.organization);

  return {
    rows,
    actors: builtActorRows(rows, facts, names, botAccounts(configuration.cohort.bot_accounts)),
    merges: builtMergeRows(facts),
    directPushes: builtDirectPushRows(facts),
    // Off the shared read, so the membership behind all five spans is one query — and named through the same map
    // the contributor rows above are, which is the point of building the two here rather than a layer up.
    members: builtTeamMemberRows(read.memberships, names),
    // Resolved ONCE, off the cohort the rows were built from, so the summary's team count and the cards it counts
    // are the same list rather than two reads of the graph that could disagree.
    teams: cohortTeams(read.cohort),
    window: { startsAt: window.startsAt, endsAt: window.endsAt },
    collectedThrough
  };
}
