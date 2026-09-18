import "server-only";
import type * as contract from "../../lib/types.ts";
import { botAccounts, excludedAuthors, inCohort, reportedDirectCommit } from "../behaviour/analysis.ts";
import { deserialise } from "../behaviour/fill.ts";
import { sourceSignature } from "../behaviour/queries.ts";
import { EvidenceSource } from "../domain/coverage.ts";
import type { CveEvidence } from "../domain/cves.ts";
import type { DirectCommitFact, Merges, PullRequestFact } from "../domain/facts.ts";
import { type CohortEntry, servedCohort } from "../org/cohort.ts";
import type { TeamMember } from "../org/people.ts";
import { teamMembers } from "../org/people.ts";
import type { Configuration } from "../policy/schema.ts";
import { cachedCoverageEdges, prevailingCachedCoverage } from "../store/coverage.ts";
import { storedCveEvidence } from "../store/cve.ts";
import { loadCachedFactsForOrganisation, storedRepositoryStates } from "../store/facts.ts";
import { productionOverrides } from "../store/production-override.ts";
import type { ReportingWindow } from "../window/window.ts";
import { type MeasuredSources, measuredSources } from "./measured.ts";
import { type ReportWindow, reportedWindowOptions, spanStartsAt, spanWindow, WIDEST_SPAN } from "./spans.ts";

/**
 * The one read of the database every report is derived from, and the two questions that need the coverage table.
 *
 * WHERE THE REPORT LAYER TOUCHES POSTGRES. Everything under `./contract/**`, `./rows/**`, `./overview.ts`,
 * `./teams.ts`, `./repository-evidence.ts`, `./measured.ts` and `./spans.ts` is a pure function of what this module
 * hands them, which is what lets the unit suite hold them to the same bar as the rest of `src/evidence/**`. This
 * module and `./reports.ts` are the two the integration run covers instead.
 */

/** The window one `?weeks=` selection resolves to, anchored where the caches end. */
export async function resolveReportWindow(configuration: Configuration, weeks: number, reference = new Date()): Promise<ReportWindow> {
  return spanWindow(await collectedEdge(configuration), weeks, reference);
}

/** The spans on offer, and what the collection behind them looks like. */
export async function windowOptions(configuration: Configuration, reference = new Date()): Promise<contract.WindowOptions> {
  return reportedWindowOptions(await collectedEdge(configuration), configuration.lookback.stale_collection_days, reference);
}

/** How far the prevailing collection of merged pull requests reached, which is what both answers above anchor on. */
async function collectedEdge(configuration: Configuration): Promise<Date | undefined> {
  return await prevailingCachedCoverage(configuration.organization, EvidenceSource.PullRequests, sourceSignature(EvidenceSource.PullRequests));
}

/** A repository the window holds no facts for. Whether that is a measured nothing is `measuredSources`' answer. */
export const NO_MERGES: Merges = { pullRequests: [], directCommits: [] };

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
  /**
   * Who GitHub says is in each team, keyed on the folded team slug.
   *
   * ON THE ESTATE READ AND NOT PER TEAM OR PER SPAN, which is the whole of why it is here. Membership is a fact
   * about a team rather than about a window, so one read answers for all five spans and all 154 teams; reading it
   * per team would be 154 queries a page, and reading it per span would repeat all of them five times over.
   *
   * A team absent from this map had no membership read, which is NOT the same answer as a team with nobody in it
   * — see `teamMembers`, which is where the distinction is made and why it cannot be made any later.
   */
  memberships: ReadonlyMap<string, readonly TeamMember[]>;
  /**
   * What the Jenkins security stage last found for each SCANNED repository, keyed on the casefolded name.
   *
   * ON THE ESTATE READ for the production flags' reason — it is a fact about a repository rather than about a
   * window, so one read answers for every offered span.
   *
   * A REPOSITORY ABSENT FROM THIS MAP HAS NEVER HAD A REPORT PUBLISHED, which is the majority of the estate:
   * only `YarnBuilder`, `GradleBuilder` and `PythonBuilder` publish one, so 361 repositories of roughly 1,890
   * appear here. That absence must reach the row as "unmeasured" and never as zero — see `cveReport`, which is
   * where the distinction is made and the only place it can be.
   */
  cves: ReadonlyMap<string, CveEvidence>;
}

/**
 * The estate over one window: the cohort, the collected states, the coverage edges, the hand-set production flags,
 * each team's membership, the published CVE reports, and the window's facts deserialised ONCE.
 *
 * The seven reads go together because none of them needs another's answer, and because the six that are not the
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
export async function readEstate(configuration: Configuration, window: ReportingWindow, reference: Date): Promise<Estate> {
  const organization = configuration.organization;
  const signatures = { pullRequests: sourceSignature(EvidenceSource.PullRequests), directCommits: sourceSignature(EvidenceSource.DirectCommits) };
  const excluded = excludedAuthors(configuration.cohort.excluded_authors);
  const bots = botAccounts(configuration.cohort.bot_accounts);
  const [cohort, states, stored, edges, production, memberships, cves] = await Promise.all([
    servedCohort(configuration, reference),
    storedRepositoryStates(organization),
    loadCachedFactsForOrganisation(organization, signatures, window.startsAt, window.endsAt),
    cachedCoverageEdges(organization, signatures),
    productionOverrides(organization),
    teamMembers(organization),
    storedCveEvidence(organization)
  ]);

  return {
    startsAt: window.startsAt,
    endsAt: window.endsAt,
    cohort,
    states,
    production,
    memberships,
    cves,
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

/** Whether one read reaches far enough back, and ends at the right instant, to answer for a span. */
export function covers(read: Estate, weeks: number, window: ReportingWindow): boolean {
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
export function mergesSince(read: Estate, startsAt: Date): Map<string, Merges> {
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
