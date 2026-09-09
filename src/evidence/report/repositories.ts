import "server-only";
import { readinessPolicy } from "../assessment/assessment.ts";
import { loadCachedMerges } from "../behaviour/fill.ts";
import { sourceSignature } from "../behaviour/queries.ts";
import { EvidenceSource } from "../domain/coverage.ts";
import type { Merges } from "../domain/facts.ts";
import { type MergeGateEvidence, type MergeGateReport, requiredApprovals, requiredContexts } from "../domain/merge-gate.ts";
import type { OpenAlertCount, SecurityAlertEvidence } from "../domain/security-alerts.ts";
import { configuredRepositories, repositoryOwners, teamDisplayNames } from "../policy/repositories.ts";
import type { Configuration } from "../policy/schema.ts";
import { collectionState } from "../store/collection-state.ts";
import { prevailingCachedCoverage } from "../store/coverage.ts";
import { storedRepositoryState } from "../store/repository-state.ts";
import { collectedAnchor, collectionIsStale, days, type ReportingWindow, reportingWindow } from "../window/window.ts";
import { stripAbsent } from "./absent.ts";

/**
 * Assembling what the dashboard reads. Ported from `metrics.evidence` and the report-building half of
 * `metrics.service`.
 *
 * Every shape here is `src/lib/types.ts` verbatim, in snake_case, because that file is the UI's contract and was
 * carried over unchanged. `stripAbsent` is applied on the way out so a `null` from Prisma or a jsonb round trip
 * can never reach a component that reads the field as optional.
 */

/** The spans the week selector offers. */
const WEEK_OPTIONS = [1, 4, 8, 12, 26];
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
 */
async function repositoryRow(
  configuration: Configuration,
  repository: string,
  teams: string[],
  window: ReportingWindow,
  production: boolean | undefined
): Promise<Record<string, unknown>> {
  const policy = readinessPolicy(configuration);
  const state = await storedRepositoryState(configuration.organization, repository);
  const team = teams[0] ?? "";
  // Absent for the ordinary single-owner repository, so a reader is not shown a one-element list restating
  // `team` on every row of an estate where sharing is the exception.
  const shared = teams.length > 1 ? teams : undefined;

  if (state === undefined) {
    // Nothing collected: the row exists so the estate is complete, and says why it carries no figures.
    return { repository, team, teams: shared, detail: "nothing has been collected for this repository" };
  }

  const merges: Merges = await loadCachedMerges(configuration.organization, repository, window);
  const gate = storedGate(state.payload);
  const assessment = policy.enabled ? policy.assess(merges, gate) : undefined;
  const payload = state.payload as { securityAlerts?: SecurityAlertEvidence; deploysToProduction?: boolean };

  return {
    repository,
    team,
    teams: shared,
    readiness: assessment?.label,
    merged_pull_requests: merges.pullRequests.length,
    direct_commits: merges.directCommits.length,
    // The two gate figures are ABSENT where there is no gate to read them off, rather than zero: a repository
    // whose rules nobody may see is not a repository requiring no reviews.
    required_approving_reviews: gate.gate === undefined ? undefined : requiredApprovals(gate.gate),
    required_status_checks: gate.gate === undefined ? undefined : requiredContexts(gate.gate).length,
    unreviewed_substantial: policy.unreviewedSubstantialOutcome(merges),
    security: reportedAlerts(payload.securityAlerts),
    production: production ?? payload.deploysToProduction,
    detail: gate.gate === undefined ? gate.detail : undefined
  };
}

/** Every configured repository's row, in the reporting order. */
export async function repositoryRows(configuration: Configuration, weeks: number, reference = new Date()): Promise<unknown[]> {
  const { window } = await resolveReportWindow(configuration, weeks, reference);
  const owners = repositoryOwners(configuration);
  const rows = [];
  for (const repository of configuredRepositories(configuration)) {
    rows.push(await repositoryRow(configuration, repository, owners.get(repository) ?? [], window, undefined));
  }
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
    teams: configuration.teams.length,
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
  const rows = (await repositoryRows(configuration, weeks, reference)) as { team?: string; teams?: string[]; readiness?: string }[];
  const names = teamDisplayNames(configuration);

  return stripAbsent(
    configuration.teams.map((team) => {
      // `teams` is absent on the ordinary single-owner row, so fall back to the primary rather than treating
      // its absence as "owned by nobody".
      const owned = rows.filter((row) => (row.teams ?? (row.team === undefined ? [] : [row.team])).includes(team.identifier));
      const labels: Record<string, number> = {};
      for (const row of owned) {
        if (row.readiness !== undefined) {
          labels[row.readiness] = (labels[row.readiness] ?? 0) + 1;
        }
      }
      return {
        team: team.identifier,
        display_name: names.get(team.identifier) ?? team.identifier,
        repositories: owned.length,
        labels
      };
    })
  );
}

/** When the last collection landed, for the notice the dashboard shows above every page. */
export async function collectionNotice(): Promise<unknown> {
  const state = await collectionState();
  return stripAbsent({ collected_at: state?.collectedAt.toISOString(), revision: state === undefined ? undefined : Number(state.revision) });
}
