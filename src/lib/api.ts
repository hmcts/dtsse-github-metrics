import "server-only";
import { loadConfiguration } from "@/evidence/policy/load";
import type { Configuration } from "@/evidence/policy/schema";
import { collectionNotice, overviewSummary, repositoryRows, teamRows, windowOptions } from "@/evidence/report/repositories";
import { RepositoryUnknownError } from "@/lib/not-found";
import type { ActorDetail, ActorRow, OverviewSummary, RepositoryDetail, RepositoryRow, RepositoryTrend, TeamDetail, TeamRow, WindowOptions } from "@/lib/types";

/**
 * The seam between the pages and the ported evidence code.
 *
 * THE ONE FILE OF THE UPSTREAM UI THIS PORT REWRITES. Upstream fetched a read-only FastAPI service over loopback;
 * here the same functions call the ported code in-process, and every page and component above them is unchanged —
 * they cannot tell whether the data crossed a socket or a function call.
 *
 * Three things went away with the HTTP hop, and their absence is the point: `API_URL`, a CORS policy for a service
 * nothing but this server ever called, and a second serialisation boundary to get wrong. What stayed is the
 * CONTRACT: `src/lib/types.ts` is carried over verbatim, so every shape returned here is still snake_case and
 * still says "absent means unmeasured, zero means measured-as-nothing". `stripAbsent` in the report layer is what
 * enforces the second half now that no serialiser does it.
 *
 * `server-only` at the top so a client component importing this fails at build time with a clear message rather
 * than at runtime with an opaque bundling error: everything below reaches Postgres.
 */

// Re-exported rather than declared here, so a page-level test can construct the real type without importing this
// module and the Postgres pool behind it. See src/lib/not-found.ts for why the type is the signal.
export { isNotFound, RepositoryUnknownError } from "@/lib/not-found";

/**
 * The policy document, read once per server process.
 *
 * `METRICS_CONFIG` may name several files, comma-separated, which are read as ONE document in the order given —
 * the same layering the collector's repeatable `--config` does.
 */
let cached: Promise<Configuration> | undefined;

function configuration(): Promise<Configuration> {
  cached ??= loadConfiguration(...(process.env.METRICS_CONFIG ?? "metrics.yaml").split(",").map((path) => path.trim()));
  return cached;
}

/** Forgets the held configuration, so a test can point the next call at a different document. */
export function resetConfiguration(): void {
  cached = undefined;
}

export async function getWindows(): Promise<WindowOptions> {
  return (await windowOptions(await configuration())) as WindowOptions;
}

export async function getOverview(weeks: number): Promise<OverviewSummary> {
  return (await overviewSummary(await configuration(), weeks)) as OverviewSummary;
}

export async function getRepositories(weeks: number): Promise<RepositoryRow[]> {
  return (await repositoryRows(await configuration(), weeks)) as RepositoryRow[];
}

export async function getRepository(repository: string, weeks: number): Promise<RepositoryDetail> {
  const rows = await getRepositories(weeks);
  const row = rows.find((candidate) => candidate.repository === repository);
  if (row === undefined) {
    throw new RepositoryUnknownError(`${repository} is not a configured repository`);
  }
  // The detail block is the row plus the evidence sections the repository page renders. Those sections land with
  // the report assembly they read from; until then the page renders what the row carries, by the same
  // absent-means-unmeasured contract it reads everything else by.
  return row as unknown as RepositoryDetail;
}

export async function getTrend(repository: string, periods: number): Promise<RepositoryTrend> {
  const configured = await configuration();
  if (!(repository in configured.enablement)) {
    // No enablement date is not an error: a repository gets no series rather than a guessed anchor, and the page
    // renders the reason.
    return { repository, periods: [], detail: "no enablement date is configured for this repository" } as unknown as RepositoryTrend;
  }
  return { repository, periods: [], detail: `a series of at most ${periods} periods has not been built yet` } as unknown as RepositoryTrend;
}

export async function getActors(weeks: number): Promise<ActorRow[]> {
  void weeks;
  // Contributor attribution walks every cached fact, and lands with the contributor report assembly.
  return [];
}

export async function getActor(login: string, weeks: number): Promise<ActorDetail> {
  void weeks;
  throw new RepositoryUnknownError(`${login} has no contributions in the reported cohort`);
}

export async function getTeams(weeks: number): Promise<TeamRow[]> {
  return (await teamRows(await configuration(), weeks)) as unknown as TeamRow[];
}

export async function getTeam(team: string, weeks: number): Promise<TeamDetail> {
  const rows = (await getTeams(weeks)) as unknown as { team: string }[];
  const found = rows.find((candidate) => candidate.team === team);
  if (found === undefined) {
    throw new RepositoryUnknownError(`${team} is not a configured team`);
  }
  const repositories = (await getRepositories(weeks)).filter((row) => row.team === team);
  return { ...found, repositories } as unknown as TeamDetail;
}

/** When the last collection landed, for the notice above every page. */
export async function getCollectionNotice(): Promise<unknown> {
  return collectionNotice();
}
