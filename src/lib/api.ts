import "server-only";
import { loadConfiguration } from "@/evidence/policy/load";
import type { Configuration } from "@/evidence/policy/schema";
import {
  actorRows,
  directPushRows,
  mergeRows,
  overviewSummary,
  repositoryEvidence,
  repositoryRows,
  teamRows,
  windowOptions
} from "@/evidence/report/repositories";
import { RepositoryUnknownError } from "@/lib/not-found";
import { ownedByIndividual, owners } from "@/lib/rows";
import type {
  ActorDetail,
  ActorRow,
  Contributor,
  ContributorRow,
  OverviewSummary,
  RepositoryDetail,
  RepositoryRow,
  RepositoryTrend,
  TeamActorRow,
  TeamDetail,
  TeamDirectPushRow,
  TeamMergeRow,
  TeamRow,
  WindowOptions
} from "@/lib/types";

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
  // The row plus the evidence block the page's sections read. `repositoryEvidence` returns nothing for a
  // repository no collection has touched, which leaves `evidence` absent and the page showing its own empty state
  // with the row's `detail` as the reason — the same branch it took for every repository before this was wired.
  const configured = await configuration();
  // WHICH SOURCES WERE READ, off the row rather than a coverage query of its own. The row's two counts are absent
  // exactly where a source went unread — `behaviourFigures` gates them on the estate's single read of the coverage
  // table — so the answer is already here, and asking Postgres again would put a query on a per-page path.
  const evidence = await repositoryEvidence(configured, repository, weeks, {
    pullRequests: row.merged_pull_requests !== undefined,
    directCommits: row.direct_commits !== undefined
  });
  return {
    ...row,
    // Built from the configured organisation rather than stored: the collector never records an `html_url`, and it
    // would be the same two path segments for every repository on the estate.
    url: `https://github.com/${configured.organization}/${repository}`,
    ...(evidence === undefined ? {} : { evidence }),
    contributors: await repositoryContributors(configured, repository, weeks)
  } as unknown as RepositoryDetail;
}

/**
 * Who authored merges in one repository over the window.
 *
 * `RepositoryDetail.contributors` is a REQUIRED list on the contract and was never populated, so the page's
 * contributor section has been rendering empty since the port. The counts are of things somebody did in this
 * repository — the same scope rule `TeamActorsTable` follows — and `blocking` is 0 with `metrics` empty for
 * `getActor`'s reason: nothing evaluates the metric set over one person's subset of a repository's merges.
 */
async function repositoryContributors(configured: Configuration, repository: string, weeks: number): Promise<ContributorRow[]> {
  const [merges, pushes, names] = await Promise.all([
    mergeRows(configured, weeks) as Promise<TeamMergeRow[]>,
    directPushRows(configured, weeks) as Promise<TeamDirectPushRow[]>,
    contributorNames(weeks)
  ]);
  const landed = new Map<string, { login: string; contributions: number }>();
  for (const change of [...merges, ...pushes]) {
    if (change.repository !== repository || change.author === undefined) {
      continue;
    }
    const folded = change.author.toLowerCase();
    const entry = landed.get(folded) ?? { login: change.author, contributions: 0 };
    entry.contributions += 1;
    landed.set(folded, entry);
  }
  return [...landed.values()]
    .map((entry) => ({ ...named(entry.login, names), contributions: entry.contributions, blocking: 0, metrics: [] }))
    .sort((left, right) => right.contributions - left.contributions || left.login.toLowerCase().localeCompare(right.login.toLowerCase()));
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
  return (await actorRows(await configuration(), weeks)) as unknown as ActorRow[];
}

/**
 * Every contributor's profile name in this window, keyed on their folded login.
 *
 * OFF THE ESTATE'S OWN CONTRIBUTOR LIST rather than a second read of the organisation graph, which is the same
 * argument `teamActors` makes for folding the tables' own rows: the name on `/contributors` and the name on a team
 * page have to be one derivation, or two of them will eventually disagree about who somebody is. `actorRows` is
 * built with the other three reports and held per span, so every caller below shares one build and adds no query.
 *
 * Folded, for `contributorNames` in the report layer's reason: the logins on either side of this join are spelled
 * by different walks and a case difference would read exactly like an unset name.
 */
async function contributorNames(weeks: number): Promise<Map<string, string>> {
  const rows = await getActors(weeks);
  const names = new Map<string, string>();
  for (const row of rows) {
    if (row.name !== undefined) {
      names.set(row.login.toLowerCase(), row.name);
    }
  }
  return names;
}

/**
 * One person as the pages name them: the login the caller holds, and a profile name where there is one.
 *
 * `stripAbsent` does not run over what this builds — these rows are assembled here rather than in the report
 * layer — so the absent case is written as a missing key rather than as `undefined`, which is the same rule stated
 * one layer down. A `name: undefined` surviving to a component would render nothing, which is the failure the
 * whole absent-versus-empty contract exists to prevent.
 */
function named(login: string, names: ReadonlyMap<string, string>): Contributor {
  const name = names.get(login.toLowerCase());
  return name === undefined ? { login } : { login, name };
}

/**
 * One person's page: which repositories they landed changes in over the window, and how many.
 *
 * WITHOUT PER-ACTOR BEHAVIOUR METRICS, which is a real gap and is stated rather than papered over. `metrics` is
 * `[]` on every row, so `MetricsGrid` renders its own "no behaviour metric could be measured" line — the honest
 * shape while nothing evaluates the metric set over one person's subset of a repository's merges. `blocking` is 0
 * for the same reason: nothing has graded them, so nothing of theirs is blocking.
 *
 * What the page does answer is the question the list links here to ask: where does this person work, and how much.
 * Ordered weightiest first, which is the order the page's own caption states.
 */
export async function getActor(login: string, weeks: number): Promise<ActorDetail> {
  const configured = await configuration();
  const [rows, merges, pushes, names] = await Promise.all([
    getRepositories(weeks),
    mergeRows(configured, weeks) as Promise<TeamMergeRow[]>,
    directPushRows(configured, weeks) as Promise<TeamDirectPushRow[]>,
    contributorNames(weeks)
  ]);

  const folded = login.toLowerCase();
  const contributions = new Map<string, number>();
  let spelling: string | undefined;
  for (const change of [...merges, ...pushes]) {
    if (change.author === undefined || change.author.toLowerCase() !== folded) {
      continue;
    }
    spelling ??= change.author;
    contributions.set(change.repository, (contributions.get(change.repository) ?? 0) + 1);
  }

  // The same refusal an unknown repository gets, and by the same rule: a login that landed nothing in the window
  // has no page, which is what makes `/contributors/nobody` the not-found page rather than an empty one.
  if (contributions.size === 0) {
    throw new RepositoryUnknownError(`${login} has no contributions in the reported cohort`);
  }

  const theirs = rows.filter((row) => contributions.has(row.repository));
  return {
    // Keyed on the folded login rather than on the spelling a merge happened to carry, which is what the name map
    // is built on. Absent where GitHub holds no name, so the page heads itself with the login.
    ...(names.has(folded) ? { name: names.get(folded) } : {}),
    actor: {
      actor_login: spelling ?? login,
      repositories: [...contributions.entries()]
        .map(([repository, landed]) => {
          const row = theirs.find((candidate) => candidate.repository === repository);
          return {
            repository,
            contributions: landed,
            blocking: 0,
            metrics: [],
            ...(row?.readiness === undefined ? {} : { readiness: row.readiness })
          };
        })
        .sort((left, right) => right.contributions - left.contributions || left.repository.localeCompare(right.repository))
    },
    teams: Object.fromEntries(theirs.filter((row) => row.team !== undefined).map((row) => [row.repository, row.team as string])),
    // ABSENT WHERE NO LIST WAS READ, an empty array where it was read and names none of theirs — the tri-state
    // `RepositoryRow.production` keeps, lifted to a list. Every row absent means the production list itself could
    // not be read, which is a different answer from this person having nothing in production.
    ...(theirs.every((row) => row.production === undefined) ? {} : { production: theirs.filter((row) => row.production === true).map((row) => row.repository) })
  } as unknown as ActorDetail;
}

export async function getTeams(weeks: number): Promise<TeamRow[]> {
  return (await teamRows(await configuration(), weeks)) as unknown as TeamRow[];
}

/**
 * One team's page, or a refusal for a name no card was drawn for.
 *
 * A PERSON'S LOGIN REFUSES HERE, and by the existing rule rather than a new one: `teamRows` lists teams only
 * from 2026-09-11, so an individual owner is not among them and the lookup below misses — which is what makes
 * `/teams/a1i-hussain` the not-found page it should be, since a page headed `team` for one person was never
 * true. Nothing else was needed for it, and stating it here is what stops somebody "fixing" the miss.
 */
export async function getTeam(team: string, weeks: number): Promise<TeamDetail> {
  const rows = (await getTeams(weeks)) as unknown as { team: string }[];
  const found = rows.find((candidate) => candidate.team === team);
  if (found === undefined) {
    throw new RepositoryUnknownError(`${team} is not a reported team`);
  }
  // EVERY OWNER, NOT JUST THE PRIMARY. 390 repositories on the estate are shared, and `teamRows` counts each of
  // them for every team that owns it — so filtering on `team` alone here listed one repository beside a card that
  // said two, and left the page's readiness legend (which comes from `teamRows`) able to filter to an empty table.
  // `owners` is the same fold the report layer reads ownership by, so the count and the list cannot drift apart.
  //
  // A person-owned row is dropped for `teamRows`' reason: nothing stops a login matching a team slug, and one
  // that did would list somebody's repository under that team beside a count that never included it.
  const repositories = (await getRepositories(weeks)).filter((row) => !ownedByIndividual(row) && owners(row).includes(team));

  // The estate's two activity reports, narrowed to what this team owns. Held per span, so the filter is the only
  // work a team page does for them — see `mergeRows` for why they are not built per team.
  const held = new Set(repositories.map((row) => row.repository));
  const configured = await configuration();
  const [merges, directPushes] = await Promise.all([
    mergeRows(configured, weeks) as Promise<TeamMergeRow[]>,
    directPushRows(configured, weeks) as Promise<TeamDirectPushRow[]>
  ]);
  const ours = merges.filter((row) => held.has(row.repository));
  const pushes = directPushes.filter((row) => held.has(row.repository));

  return {
    ...found,
    repositories,
    merges: ours,
    direct_pushes: pushes,
    actors: teamActors(ours, pushes, await contributorNames(weeks))
  } as unknown as TeamDetail;
}

/**
 * Who contributed to each team's repositories in this window, named, for the estate table's export.
 *
 * THE SAME FOLD EVERY TEAM PAGE MAKES, run once over the whole estate rather than per team: `teamActors` off the
 * team's own merges and direct pushes, so the people the CSV lists under `civil` are exactly the people
 * `/teams/civil` lists and neither can drift from the other. Both read one cached span build, so this costs the
 * ownership walk below and no query.
 *
 * A PERSON-OWNED REPOSITORY CONTRIBUTES TO NO TEAM, for `getTeam`'s reason: nothing stops a login matching a team
 * slug, and one that did would file somebody's own repository's authors under that team. `owners` is the fold the
 * report layer counts ownership by, so a shared repository's authors count for every team that owns it — which is
 * what the team cards already claim.
 */
export async function getTeamContributors(weeks: number): Promise<Record<string, Contributor[]>> {
  const configured = await configuration();
  const [repositories, merges, directPushes, names] = await Promise.all([
    getRepositories(weeks),
    mergeRows(configured, weeks) as Promise<TeamMergeRow[]>,
    directPushRows(configured, weeks) as Promise<TeamDirectPushRow[]>,
    contributorNames(weeks)
  ]);

  const teamsOf = new Map<string, readonly string[]>(repositories.filter((row) => !ownedByIndividual(row)).map((row) => [row.repository, owners(row)]));
  const changesOf = new Map<string, { merges: TeamMergeRow[]; pushes: TeamDirectPushRow[] }>();
  for (const change of merges) {
    for (const team of teamsOf.get(change.repository) ?? []) {
      held(changesOf, team).merges.push(change);
    }
  }
  for (const change of directPushes) {
    for (const team of teamsOf.get(change.repository) ?? []) {
      held(changesOf, team).pushes.push(change);
    }
  }

  return Object.fromEntries([...changesOf].map(([team, changes]) => [team, teamActors(changes.merges, changes.pushes, names)]));
}

/** One team's accumulating changes, created on first sight so the two loops above can share the map. */
function held(
  changes: Map<string, { merges: TeamMergeRow[]; pushes: TeamDirectPushRow[] }>,
  team: string
): { merges: TeamMergeRow[]; pushes: TeamDirectPushRow[] } {
  const entry = changes.get(team) ?? { merges: [], pushes: [] };
  changes.set(team, entry);
  return entry;
}

/**
 * Who worked in this team's repositories over the window.
 *
 * OFF THE SAME ROWS THE TABLES BELOW SHOW, rather than a third walk of the fact cache: a reader who counts the
 * authors in the merges table has to arrive at this list, and two derivations would eventually disagree.
 *
 * `contributions` is every change they landed by either route, which is what makes the direct-push table's authors
 * appear here too — somebody who only ever pushes straight to the default branch is a contributor to the team.
 */
function teamActors(merges: readonly TeamMergeRow[], pushes: readonly TeamDirectPushRow[], names: ReadonlyMap<string, string>): TeamActorRow[] {
  const found = new Map<string, { login: string; repositories: Set<string>; contributions: number }>();
  for (const row of [...merges, ...pushes]) {
    if (row.author === undefined) {
      continue;
    }
    const folded = row.author.toLowerCase();
    const entry = found.get(folded) ?? { login: row.author, repositories: new Set<string>(), contributions: 0 };
    entry.repositories.add(row.repository);
    entry.contributions += 1;
    found.set(folded, entry);
  }
  return (
    [...found.values()]
      .map((entry) => ({ ...named(entry.login, names), repositories: entry.repositories.size, contributions: entry.contributions }))
      // ALPHABETICAL BY LOGIN AND NOT BY NAME, unlike the `/contributors` column that a reader can re-sort. This
      // list has no sortable header, so its order is the one the page states in its own caption — and a name-led
      // order would put 58% of a team under whatever letter their login starts with, interleaved with the rest.
      .sort((left, right) => left.login.toLowerCase().localeCompare(right.login.toLowerCase()))
  );
}
