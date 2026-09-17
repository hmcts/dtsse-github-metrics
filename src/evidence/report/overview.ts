import type * as contract from "../../lib/types.ts";
import type { ReportingWindow } from "../window/window.ts";
import { stripAbsent } from "./absent.ts";

/** Everything the estate's summary counts, which is every figure the four reports beside it already hold. */
export interface OverviewInput {
  organization: string;
  weeks: number;
  window: ReportingWindow;
  collectedThrough?: Date;
  rows: readonly contract.RepositoryRow[];
  /** The teams the cohort resolved to, which is what the cards below the summary are drawn for. */
  teams: readonly string[];
  /** The contributor rows this span holds, counted rather than rebuilt. */
  actors: number;
}

/**
 * The estate's summary for one window.
 *
 * COUNTED OFF THE REPORTS AND NOT OFF THE DATABASE, which is why this takes an input rather than a configuration.
 * Every figure below is a fold of rows the build already produced: `servedCohort` used to be called here for the
 * team count and again in `builtTeamRows` for the cards, which was two uncached queries against the
 * change-versioned graph on every `/teams` render. The resolved teams ride `EstateReports` now, so this reads them.
 */
export function builtOverviewSummary(input: OverviewInput, reference: Date): contract.OverviewSummary {
  const labels: Record<string, number> = {};
  for (const row of input.rows) {
    if (row.readiness !== undefined) {
      labels[row.readiness] = (labels[row.readiness] ?? 0) + 1;
    }
  }

  return stripAbsent<contract.OverviewSummary>({
    organization: input.organization,
    weeks: input.weeks,
    starts_at: input.window.startsAt.toISOString(),
    ends_at: input.window.endsAt.toISOString(),
    built_at: reference.toISOString(),
    collected_through: input.collectedThrough?.toISOString(),
    repositories: input.rows.length,
    unavailable: input.rows.filter((row) => row.detail !== undefined).length,
    // Counted off the rows rather than off `configuration.teams`, which no longer lists the estate's teams —
    // it lists the handful somebody has overridden. Includes the `unowned` bucket, because 360 repositories
    // are reported under it and a team count that omitted it would not add up against the cards below. It
    // excludes the individuals for the same reason: it is a count OF THE CARDS, so whatever `cohortTeams`
    // stops listing this figure has to stop counting.
    teams: input.teams.length,
    // The length of the contributor rows rather than a second walk of the facts, so the header and `/contributors`
    // cannot disagree about how many people the span holds.
    actors: input.actors,
    merged_pull_requests: input.rows.reduce((total, row) => total + (row.merged_pull_requests ?? 0), 0),
    direct_commits: input.rows.reduce((total, row) => total + (row.direct_commits ?? 0), 0),
    labels
  });
}
