import { readinessPolicy } from "../evidence/assessment/assessment.ts";
import { collectDirectCommits, collectMergedPullRequests, mutableEdge } from "../evidence/behaviour/collect.ts";
import { directCommitCacheWriter, fillCachedSource, loadCachedMerges, pullRequestCacheWriter, requestedCoverage } from "../evidence/behaviour/fill.ts";
import { mergedPullRequestQuery, sourceSignature } from "../evidence/behaviour/queries.ts";
import { CollectionStatus } from "../evidence/domain/availability.ts";
import { EvidenceSource } from "../evidence/domain/coverage.ts";
import type { MergeGateEvidence, MergeGateReport } from "../evidence/domain/merge-gate.ts";
import { createGitHubClient } from "../evidence/github/client.ts";
import { resolveCredentials } from "../evidence/github/credentials.ts";
import { collectMergeGate } from "../evidence/inventory/merge-gate.ts";
import { deploysToProduction, fetchProductionRepositories } from "../evidence/inventory/production.ts";
import { collectSecurityAlerts } from "../evidence/inventory/security-alerts.ts";
import { collectCodeowners, collectDirectAdmins, collectOrgPeople, collectOrgRepositories, collectOrgTeams } from "../evidence/org/collect.ts";
import { byCodePoint, canonical, type OrgFacts, OwnerKind, type OwnershipOptions, type ResolvedOwnership } from "../evidence/org/graph.ts";
import { attributeOwnership, ownershipEvidence, rungCounts, unresolvedRepositories } from "../evidence/org/ownership.ts";
import { loadConfiguration } from "../evidence/policy/load.ts";
import { configuredRepositories, configuredTeamSlugs, repositoryOwners, sonarOrganizationName } from "../evidence/policy/repositories.ts";
import type { Configuration } from "../evidence/policy/schema.ts";
import { collectionState, stampCollection, stampRevision } from "../evidence/store/collection-state.ts";
import { prevailingCachedCoverage } from "../evidence/store/coverage.ts";
import { migrate } from "../evidence/store/migrate.ts";
import {
  recordOrgPeople,
  recordOrgRepositories,
  recordOrgTeamMemberships,
  recordOrgTeamRepositories,
  recordOrgTeams,
  recordRepositoryOwnership
} from "../evidence/store/org-graph.ts";
import { prisma } from "../evidence/store/prisma.ts";
import { pruneCache } from "../evidence/store/prune.ts";
import { recordRepositoryState, storedRepositoryState } from "../evidence/store/repository-state.ts";
import { collectedAnchor, days, resolveWindow } from "../evidence/window/window.ts";
import { collectionStatus, EXIT_COMPLETE, EXIT_FAILED, EXIT_USAGE, runStatus } from "./exit-status.ts";
import { type Arguments, COHORT_COMMANDS, parseArguments, UsageError } from "./parse-arguments.ts";

/**
 * One line of human progress, on STDERR.
 *
 * `collect-org --propose-teams` puts a YAML document on stdout for somebody to redirect into a file and
 * review, so every line that is not that document has to go somewhere else. `console.info` writes to stdout,
 * which would land the walk's commentary in the middle of the file. Upstream stated this rule — "writes the
 * report to stdout and progress to stderr, so stdout can be redirected into a file" — and the port lost it.
 */
function progress(line: string): void {
  process.stderr.write(`${line}\n`);
}

async function loadPolicy(argv: Arguments): Promise<Configuration> {
  const configuration = await loadConfiguration(...argv.config);
  if (COHORT_COMMANDS.has(argv.command) && configuration.teams.length === 0) {
    throw new UsageError(
      `${argv.command} reports the configured cohort, so at least one team must be configured; layer in the team file with a second --config`
    );
  }
  return configuration;
}

async function collectRepository(
  configuration: Configuration,
  client: ReturnType<typeof createGitHubClient>,
  repository: string,
  window: { startsAt: Date; endsAt: Date },
  reference: Date,
  production: Set<string> | undefined
): Promise<{ observed: boolean; failures: number }> {
  const organization = configuration.organization;
  let failures = 0;

  const metadata = await client.get<{ default_branch?: string }>(`/repos/${organization}/${repository}`).catch(() => undefined);
  if (metadata === undefined) {
    console.warn(`${repository}: could not be read at all, so nothing was collected for it`);
    return { observed: false, failures: 1 };
  }
  const defaultBranch = metadata.default_branch;
  if (defaultBranch === undefined || defaultBranch === "") {
    console.warn(`${repository}: GitHub named no default branch, so nothing was collected for it`);
    return { observed: false, failures: 1 };
  }

  const edge = mutableEdge(window, configuration.lookback.mutable_hours, reference);

  await fillCachedSource(
    requestedCoverage(organization, repository, EvidenceSource.PullRequests, window),
    edge,
    (startsAt, endsAt) => collectMergedPullRequests(client, organization, repository, startsAt, endsAt),
    pullRequestCacheWriter()
  ).catch((error: unknown) => {
    failures += 1;
    console.warn(`${repository}: merged pull requests were not collected: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  });

  await fillCachedSource(
    requestedCoverage(organization, repository, EvidenceSource.DirectCommits, window),
    edge,
    (startsAt, endsAt) => collectDirectCommits(client, organization, repository, startsAt, endsAt),
    directCommitCacheWriter()
  ).catch((error: unknown) => {
    failures += 1;
    console.warn(`${repository}: direct commits were not collected: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  });

  const gate = await collectMergeGate(client, organization, repository, defaultBranch);
  const alerts = await collectSecurityAlerts(client, organization, repository);
  failures += alerts.failures.length;
  for (const failure of alerts.failures) {
    console.warn(`${repository}: ${failure.detail}`);
  }

  await recordRepositoryState(organization, repository, {
    defaultBranch,
    fetchedAt: reference,
    mergeGate: gate,
    securityAlerts: alerts.evidence,
    deploysToProduction: deploysToProduction(production, organization, repository)
  });

  return { observed: true, failures };
}

async function runCollect(configuration: Configuration, argv: Arguments): Promise<number> {
  const credentials = await resolveCredentials();
  console.info(`authenticating as ${credentials.describe()}`);
  const client = createGitHubClient({ credentials });

  const reference = new Date();
  const window = resolveWindow({
    ...(argv.startsAt === undefined ? {} : { startsAt: argv.startsAt }),
    ...(argv.endsAt === undefined ? {} : { endsAt: argv.endsAt }),
    ...(argv.days === undefined ? {} : { days: argv.days }),
    defaultDays: configuration.lookback.operational_days,
    reference
  });

  const production = configuration.production_list_url === null ? undefined : await fetchProductionRepositories(configuration.production_list_url);

  const repositories = argv.repository === undefined ? configuredRepositories(configuration) : [argv.repository];
  let observed = 0;
  let failures = 0;

  for (const repository of repositories) {
    const result = await collectRepository(configuration, client, repository, window, reference, production);
    observed += result.observed ? 1 : 0;
    failures += result.failures;
  }

  await stampCollection(reference);
  console.info(`collected ${observed} of ${repositories.length} repositories in ${client.requestsIssued()} GitHub calls`);
  for (const { outcome, count } of client.callOutcomes()) {
    console.info(`  ${outcome.status} ${outcome.outcome} ${outcome.method} ${outcome.endpoint} (x${count})`);
  }

  if (observed === 0) {
    return runStatus(CollectionStatus.Failed);
  }
  const status = observed === repositories.length && failures === 0 ? CollectionStatus.Complete : CollectionStatus.Partial;
  if (status === CollectionStatus.Partial && argv.toleratePartial) {
    console.info("some repositories refused, which a scheduled run reports as success; see collector.exit_status");
  }
  return collectionStatus(status, argv.toleratePartial);
}

/**
 * Whether this credential may list the organisation's teams at all.
 *
 * READABILITY ONLY, and the request is `per_page=1` because that is all the question needs. It deliberately does
 * NOT report how many teams there are: counting them means paging 336 of them, which is what `collect-org` is for,
 * and `doctor` is meant to be the cheap check somebody runs first.
 *
 * Reported by `doctor` because it is exactly the kind of invisible failure `doctor` exists for: a token that
 * reads every repository perfectly well can still be refused the team list, and `collect-org` would then fall
 * back to CODEOWNERS and names and produce a plausible-looking graph missing its strongest evidence. Checked
 * rather than assumed, and never fatal — `collect` does not need it.
 */
async function describeTeamAccess(client: ReturnType<typeof createGitHubClient>, organization: string): Promise<string> {
  try {
    const teams = await client.get<unknown[]>(`/orgs/${organization}/teams`, { per_page: "1" });
    return Array.isArray(teams)
      ? `the organisation's teams are readable, so collect-org can use team access as evidence`
      : `the teams endpoint answered something unexpected, so collect-org would rest on CODEOWNERS and names`;
  } catch (error) {
    return `the organisation's teams are NOT readable (${error instanceof Error ? error.message : String(error)}), so collect-org would rest on CODEOWNERS and names alone`;
  }
}

async function runDoctor(configuration: Configuration): Promise<number> {
  const credentials = await resolveCredentials();
  console.info(`authenticating as ${credentials.describe()}`);
  const client = createGitHubClient({ credentials });

  const repositories = configuredRepositories(configuration);
  let unreadable = 0;
  for (const repository of repositories) {
    try {
      await client.get(`/repos/${configuration.organization}/${repository}`);
    } catch (error) {
      unreadable += 1;
      console.warn(`${repository}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const visible = await countVisibleMerges(client, configuration, repositories);

  const state = await collectionState();
  console.info(
    state === undefined ? "no collection has run yet" : `the last collection landed at ${state.collectedAt.toISOString()} (revision ${state.revision})`
  );
  console.info(`${repositories.length - unreadable} of ${repositories.length} configured repositories are readable`);
  console.info(`GitHub shows ${visible} merged pull requests across them in the operational window`);
  console.info(await describeTeamAccess(client, configuration.organization));

  if (unreadable > 0) {
    return EXIT_FAILED;
  }
  if (visible === 0) {
    console.warn(
      "GitHub returned no merged pull requests for any configured repository, so a collection would record none. " +
        "Reading a repository does not prove the credential can read its pull requests, and one that cannot is " +
        "answered with an empty result rather than a refusal — which a report shows as zeroes rather than as a " +
        "failure. Check the token, and for a GitHub App check that the INSTALLATION still holds every permission " +
        "the App declares: adding one to the App puts the installation into pending approval and it silently " +
        "loses the rest until an organisation administrator accepts."
    );
    return EXIT_FAILED;
  }
  return EXIT_COMPLETE;
}

/**
 * How many merged pull requests the credential can actually see, asked the way the collection asks.
 *
 * Deliberately NOT through search. Search is what an App installation token cannot do — it is answered with an
 * empty result over repositories it reads perfectly well — and checking a capability the collector no longer
 * depends on would report a fault that does not matter while missing one that does.
 */
async function countVisibleMerges(
  client: ReturnType<typeof createGitHubClient>,
  configuration: Configuration,
  repositories: readonly string[]
): Promise<number> {
  const window = resolveWindow({ defaultDays: configuration.lookback.operational_days, reference: new Date() });
  let total = 0;

  for (const repository of repositories) {
    try {
      const data = await client.graphql<{ repository?: { pullRequests?: { nodes?: ({ mergedAt?: string } | null)[] } } | null }>(mergedPullRequestQuery(), {
        organization: configuration.organization,
        repository,
        cursor: null
      });
      const nodes = data.repository?.pullRequests?.nodes ?? [];
      if (nodes.length === 0) {
        console.warn(`${repository}: GitHub returned no merged pull requests at all`);
      }
      total += nodes.filter((node) => {
        if (node?.mergedAt === undefined) {
          return false;
        }
        const mergedAt = new Date(node.mergedAt);
        return mergedAt >= window.startsAt && mergedAt < window.endsAt;
      }).length;
    } catch (error) {
      console.warn(`${repository}: reading merged pull requests failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return total;
}

/**
 * Collects the organisation graph: its teams, who is in them, and who owns what.
 *
 * Its own command rather than a step inside `collect`, because the two have different units of failure.
 * `collect` catches per repository, counts, and carries on — one repository refusing says nothing about the
 * next. This writes ONE organisation-wide graph, and a partial write must not be mistaken for a complete
 * one, which is what the `complete` flag threaded into every store call is for: a run that could not list
 * the teams writes what it saw and supersedes nothing.
 *
 * The expensive rungs are scoped, and that is the whole cost control. Team access and the configured
 * override are free — the data is already in hand after the team walk — so CODEOWNERS and direct
 * collaborators are read only for the repositories those rungs left unresolved. At 3,277 repositories the
 * residue is not knowable in advance, so `unresolved_repository_limit` caps it and a run that hits the cap
 * exits INCOMPLETE rather than pretending it walked the estate.
 */
async function runCollectOrg(configuration: Configuration, argv: Arguments): Promise<number> {
  const graph = configuration.org_graph;
  const organization = configuration.organization;

  // Refused rather than quietly skipped, and named so the reason is in the CronJob's log. A run that did
  // nothing and exited 0 is the failure mode this check exists to avoid: the graph would go stale for weeks
  // while every dashboard kept serving the last good one, and nothing anywhere would say why.
  if (!graph.enabled) {
    throw new UsageError("collect-org is turned off: set org_graph.enabled to true in the configuration to walk the organisation");
  }

  const credentials = await resolveCredentials();
  progress(`authenticating as ${credentials.describe()}`);
  const client = createGitHubClient({ credentials });
  const observedAt = new Date();

  const teamFacts = await collectOrgTeams(client, organization);
  if (!teamFacts.teamsRead && teamFacts.teams.length === 0) {
    progress("the teams could not be listed, so ownership will rest on CODEOWNERS and names alone");
  }
  const repositoryWalk = await collectOrgRepositories(client, organization);
  const repositories = repositoryWalk.facts;
  if (repositories.length === 0) {
    console.error(`no repositories could be listed for ${organization}`);
    return runStatus(CollectionStatus.Failed);
  }
  const peopleWalk = await collectOrgPeople(client, organization);
  const people = peopleWalk.facts;

  const options: OwnershipOptions = {
    prefixSupport: graph.prefix_support,
    prefixDominance: graph.prefix_dominance,
    maximumTeamShare: graph.maximum_team_share,
    maximumTeamMembers: graph.maximum_team_members,
    excludedTeams: new Set(graph.excluded_teams.map(canonical)),
    // Slugs, not identifiers: this feeds the ladder, whose answer is stored in a column joined to `org_teams`.
    configured: configuredTeamSlugs(configuration)
  };

  // Resolved once from the free rungs to find the residue, then again once the paid rungs have answered.
  const free: OrgFacts = { organization, ...teamFacts, repositories, people, codeowners: new Map(), directAdmins: new Map() };
  const evidence = ownershipEvidence(free, options);

  // Named, not just counted. A filter that quietly stops a team being an owner is the one thing in this walk
  // that could turn a well-owned repository into an `unowned` row without anybody noticing, so each excluded
  // team is reported with the figure that excluded it and a reader can disagree with the threshold.
  for (const slug of [...evidence.populousTeams].sort(byCodePoint)) {
    progress(`  ${slug} has ${evidence.memberCounts.get(slug)} members, over the ${graph.maximum_team_members} ceiling, so is not read as an owner`);
  }
  for (const slug of [...evidence.broadTeams].sort(byCodePoint)) {
    progress(`  ${slug} holds ${evidence.teamSizes.get(slug)} repositories, over the ${graph.maximum_team_share * 100}% ceiling, so is not read as an owner`);
  }

  const unresolved = unresolvedRepositories(free, evidence, options.configured);
  const residue = new Set(unresolved);
  const limit = argv.unresolvedLimit ?? graph.unresolved_repository_limit;
  const scoped = unresolved.slice(0, limit);
  const truncated = unresolved.length - scoped.length;
  progress(`${unresolved.length} repositories unresolved by team access; reading CODEOWNERS for ${scoped.length}`);

  const requested = new Set(scoped);
  const codeowners = await collectCodeowners(client, organization, scoped);
  const stillOpen = scoped.filter((repository) => {
    const fact = codeowners.get(repository);
    return fact === undefined || (fact.teams.length === 0 && fact.people.length === 0);
  });
  const openAfterCodeowners = new Set(stillOpen);
  const directAdmins = await collectDirectAdmins(client, organization, stillOpen);

  const facts: OrgFacts = { ...free, codeowners, directAdmins };
  const resolved = attributeOwnership(facts, options);

  /**
   * Whether this run knows enough about one repository to rewrite its ownership.
   *
   * A repository the free rungs answered is always complete: the evidence was in hand before the walk started.
   * One in the residue is complete only if the paid rungs actually ran for it.
   *
   * THE THREE STATES ARE NOT TWO, and conflating them is a mistake worth naming because the first version of
   * this made it. `collectCodeowners` records a REFUSAL as a fact carrying `refusal`, but records an ABSENT file
   * as no map entry at all — "the map's own silence is what there is no CODEOWNERS file looks like", and it is
   * the commonest answer on this estate. So `fact === undefined` covers both "the file does not exist", which is
   * an answer, and "we never asked", which is not. Treating the pair as incomplete meant no residue repository
   * ever got an ownership row — including the `unowned` remembered negative the whole "how many does nobody own"
   * count depends on — and made `attributed.size === resolved.length` unreachable, so the command could never
   * exit 0 on this organisation.
   *
   * `requested` is therefore tracked separately, and `directAdmins` is read the same way round: an entry means
   * the collaborator listing was read, possibly to an empty result, and no entry after being asked means it was
   * refused — in which case `unowned` is not established either.
   *
   * Getting this wrong the OTHER way is what produced a repository that was simultaneously owned and unowned:
   * the ladder always answers something, so an unread repository resolved to `unowned`, and because
   * `(repository, kind, owner)` is the key, that row was INSERTED BESIDE the live team row rather than replacing
   * it.
   */
  function evidenceComplete(repository: string): boolean {
    if (!residue.has(repository)) {
      return true;
    }
    if (!requested.has(repository)) {
      return false;
    }
    const fact = codeowners.get(repository);
    if (fact !== undefined && fact.refusal !== undefined) {
      return false;
    }
    return !openAfterCodeowners.has(repository) || directAdmins.has(repository);
  }

  for (const [rung, count] of rungCounts(resolved)) {
    progress(`  ${rung}: ${count}`);
  }

  if (argv.proposeTeams) {
    // Printed for review rather than written, because `metrics.yaml` is tracked so that adding a team is a
    // reviewed change. The graph is evidence about ownership; it does not get to redefine the cohort behind
    // somebody's back.
    process.stdout.write(`${proposeTeamsBlock(resolved)}\n`);
    return truncated === 0 ? EXIT_COMPLETE : collectionStatus(CollectionStatus.Partial, argv.toleratePartial);
  }

  // WHAT THIS RUN SAW IN FULL, per table, and per team or repository where the walk degrades that finely. One
  // boolean used to stand for all of it, and it was wrong in the direction that loses data: a single refused
  // membership left it `true`, so every one of that team's live rows was closed as a departure that never
  // happened. Each writer now gets only the scopes it may infer a deletion inside.
  //
  // ATTRIBUTION IS ALL-OR-NOTHING ON THE TEAM PICTURE, unlike the rest. A missing team→repository edge does not
  // merely omit a claim, it silently changes what every remaining rung concludes — a repository whose owning
  // team was not read looks unowned. So unless the team walk and every team's repository list came back whole,
  // the ownership table is left entirely alone rather than rewritten from a picture known to be short.
  const teamPictureWhole = teamFacts.teamsRead && teamFacts.teamsComplete && teamFacts.teamRepositoriesObserved.size === teamFacts.teams.length;
  const attributed = teamPictureWhole
    ? new Set(resolved.filter((entry) => evidenceComplete(entry.repository)).map((entry) => entry.repository))
    : new Set<string>();
  if (!teamPictureWhole) {
    progress("the team picture came back short, so ownership was left as it stood rather than re-decided from it");
  }

  const written = [
    await recordOrgTeams(organization, observedAt, teamFacts.teams, teamFacts.teamsComplete),
    await recordOrgTeamMemberships(organization, observedAt, teamFacts.memberships, teamFacts.membershipsObserved),
    await recordOrgTeamRepositories(organization, observedAt, teamFacts.teamRepositories, teamFacts.teamRepositoriesObserved),
    await recordOrgRepositories(organization, observedAt, repositories, repositoryWalk.complete),
    await recordOrgPeople(organization, observedAt, people, peopleWalk.complete),
    // Only the repositories actually attributed with complete evidence, so a repository the cap skipped keeps the
    // owners it had instead of gaining a contradicting `unowned` row beside them.
    await recordRepositoryOwnership(
      organization,
      observedAt,
      resolved.filter((entry) => attributed.has(entry.repository)),
      attributed
    )
  ];
  await stampRevision();

  const totals = written.reduce(
    (sum, one) => ({
      inserted: sum.inserted + one.inserted,
      unchanged: sum.unchanged + one.unchanged,
      changed: sum.changed + one.changed,
      superseded: sum.superseded + one.superseded
    }),
    { inserted: 0, unchanged: 0, changed: 0, superseded: 0 }
  );
  progress(
    `walked ${teamFacts.teams.length} teams, ${repositories.length} repositories and ${people.length} people in ${client.requestsIssued()} GitHub calls`
  );
  progress(`  ${totals.inserted} new, ${totals.changed} changed, ${totals.superseded} ended, ${totals.unchanged} unchanged`);
  if (truncated > 0) {
    progress(`${truncated} repositories were left unresolved by --unresolved-limit, so nothing was superseded`);
  }

  // `--tolerate-partial` for the same reason `collect` takes it, and the reason applies harder here: this walk
  // touches every team in the organisation, so something always refuses — a team whose membership is not
  // visible, a repository the App is not installed on. Exiting 3 daily would make the CronJob Failed every day
  // and the alert would mean nothing. The true status still reaches Application Insights.
  // Complete means every walk reached its end AND the ladder answered every repository — the same conditions the
  // writers were handed, restated as one exit status rather than derived a second way that could disagree.
  const complete =
    truncated === 0 &&
    teamPictureWhole &&
    repositoryWalk.complete &&
    peopleWalk.complete &&
    teamFacts.membershipsObserved.size === teamFacts.teams.length &&
    attributed.size === resolved.length;
  if (!complete && argv.toleratePartial) {
    progress("part of the organisation would not answer, which a scheduled run reports as success; see collector.exit_status");
  }
  return complete ? EXIT_COMPLETE : collectionStatus(CollectionStatus.Partial, argv.toleratePartial);
}

/** The bucket a repository nothing owns is grouped under. Not a GitHub team, and never given a slug. */
const UnknownIdentifier = "unknown";

/**
 * A reviewable `teams:` block, one team per owning slug with the repositories it was attributed.
 *
 * ONLY A GITHUB TEAM GETS `github_team_slugs`, and getting that wrong was a bug: the grouping key special-cased
 * `none` alone, so a repository attributed by `codeowners-person` or `direct-collaborator-admin` emitted
 * `identifier: <login>` with that login as a team slug — declaring a person to be a team in a file whose whole
 * purpose is to be read as a reviewed answer. A CODEOWNERS handle from another organisation is kept as
 * `other-org/team` by `parseCodeowners`, which is not a slug of THIS organisation either.
 *
 * So people and foreign handles are reported in their own comment section. They are still owners and still worth
 * seeing — an individual-owned repository is exactly the outlier a reader is looking for — but they are not
 * something to paste under `teams:`.
 *
 * The rung behind each team is written as a comment so a reviewer can weigh a `name-prefix` guess differently
 * from a `teams-api-admin` fact.
 */
function proposeTeamsBlock(resolved: readonly ResolvedOwnership[]): string {
  const grouped = new Map<string, { repositories: string[]; rungs: Set<string> }>();
  const individuals = new Map<string, string[]>();
  for (const entry of resolved) {
    for (const owner of entry.owners) {
      // A person, or a team belonging to another organisation, is not a slug this file may claim.
      if (owner.kind === OwnerKind.Person || (owner.kind === OwnerKind.Team && owner.owner.includes("/"))) {
        const held = individuals.get(owner.owner) ?? [];
        held.push(entry.repository);
        individuals.set(owner.owner, held);
        continue;
      }
      const key = owner.kind === OwnerKind.None ? UnknownIdentifier : owner.owner;
      const group = grouped.get(key) ?? { repositories: [], rungs: new Set<string>() };
      group.repositories.push(entry.repository);
      group.rungs.add(owner.rung);
      grouped.set(key, group);
    }
  }

  const lines = ["teams:"];
  for (const key of [...grouped.keys()].sort((left, right) => (left === UnknownIdentifier ? 1 : right === UnknownIdentifier ? -1 : byCodePoint(left, right)))) {
    const group = grouped.get(key) as { repositories: string[]; rungs: Set<string> };
    lines.push(`  # attributed by ${[...group.rungs].sort(byCodePoint).join(", ")}`);
    lines.push(`  - identifier: ${key}`);
    lines.push(`    display_name: ${key === UnknownIdentifier ? "Unknown (team not established)" : key}`);
    if (key !== UnknownIdentifier) {
      lines.push("    github_team_slugs:");
      lines.push(`      - ${key}`);
    }
    lines.push("    repositories:");
    for (const repository of [...new Set(group.repositories)].sort(byCodePoint)) {
      lines.push(`      - ${repository}`);
    }
  }

  // Commented out rather than omitted: these repositories DO have an owner, and a reader scanning for the
  // individually-owned outliers wants them named. Commented rather than emitted, because nothing here is a team
  // and `teams:` is the wrong shape for it.
  if (individuals.size > 0) {
    lines.push("# Owned by an individual, or by a team in another organisation. NOT teams, so not listed above.");
    for (const owner of [...individuals.keys()].sort(byCodePoint)) {
      const held = individuals.get(owner) as string[];
      lines.push(`#   ${owner}: ${[...new Set(held)].sort(byCodePoint).join(", ")}`);
    }
  }
  return lines.join("\n");
}

async function runPrune(argv: Arguments): Promise<number> {
  const unusedSince = new Date(Date.now() - days(argv.days ?? 30));
  const deleted = await pruneCache(unusedSince);
  console.info(`pruned ${deleted} cached intervals unused since ${unusedSince.toISOString()}`);
  return EXIT_COMPLETE;
}

async function runMigrate(): Promise<number> {
  const applied = await migrate();
  console.info(applied.length === 0 ? "the database schema is already up to date" : `applied ${applied.length} migrations: ${applied.join(", ")}`);
  return EXIT_COMPLETE;
}

async function runEvidence(configuration: Configuration, argv: Arguments): Promise<number> {
  const organization = configuration.organization;
  const reference = new Date();
  const collectedThrough = await prevailingCachedCoverage(organization, EvidenceSource.PullRequests, sourceSignature(EvidenceSource.PullRequests));
  const anchor = collectedAnchor(collectedThrough, reference);
  const window = resolveWindow({
    ...(argv.startsAt === undefined ? {} : { startsAt: argv.startsAt }),
    ...(argv.endsAt === undefined ? {} : { endsAt: argv.endsAt }),
    ...(argv.days === undefined ? {} : { days: argv.days }),
    defaultDays: configuration.lookback.operational_days,
    reference: anchor
  });

  const policy = readinessPolicy(configuration);
  const owners = repositoryOwners(configuration);
  const repositories = argv.repository === undefined ? configuredRepositories(configuration) : [argv.repository];

  const rows = [];
  for (const repository of repositories) {
    const merges = await loadCachedMerges(organization, repository, window);
    const state = await storedRepositoryState(organization, repository);
    const gate = readStoredGate(state?.payload);
    const assessment = policy.enabled ? policy.assess(merges, gate) : undefined;

    rows.push({
      repository,
      // The first owner in the reporting order, with the rest beside it: a shared repository must not be
      // reported as belonging to whichever team sorted first and to nobody else.
      team: owners.get(repository)?.[0],
      teams: (owners.get(repository)?.length ?? 0) > 1 ? owners.get(repository) : undefined,
      merged_pull_requests: merges.pullRequests.length,
      direct_commits: merges.directCommits.length,
      readiness: assessment?.label,
      blocking: assessment?.blocking.map((condition) => condition.condition),
      unreviewed_substantial: policy.unreviewedSubstantialOutcome(merges)
    });
  }

  process.stdout.write(
    `${JSON.stringify({ organization, window: { starts_at: window.startsAt, ends_at: window.endsAt }, repositories: rows }, undefined, 2)}\n`
  );
  return EXIT_COMPLETE;
}

function readStoredGate(payload: unknown): MergeGateReport {
  if (typeof payload !== "object" || payload === null) {
    return { detail: "the merge gate has not been collected" };
  }
  const stored = (payload as { mergeGate?: unknown }).mergeGate;
  if (typeof stored !== "object" || stored === null) {
    return { detail: "the merge gate has not been collected" };
  }
  const report = stored as { gate?: MergeGateEvidence; detail?: string; fetchedAt?: string };
  if (report.gate === undefined) {
    return { detail: report.detail ?? "the merge gate has not been collected" };
  }
  return { gate: report.gate, ...(report.fetchedAt === undefined ? {} : { fetchedAt: new Date(report.fetchedAt) }) };
}

async function runMapSonar(configuration: Configuration): Promise<number> {
  console.info(`resolving SonarCloud projects for the ${sonarOrganizationName(configuration)} organisation`);
  console.warn("map-sonar is not yet wired to the resolution ladder in this build");
  return EXIT_FAILED;
}

async function runTrend(configuration: Configuration): Promise<number> {
  console.info(`reporting trends for the ${configuration.organization} organisation`);
  console.warn("trend is not yet wired to the period walk in this build");
  return EXIT_FAILED;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  let parsed: Arguments;
  try {
    parsed = parseArguments(argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_USAGE;
  }

  try {
    if (parsed.command === "migrate") {
      return await runMigrate();
    }

    const configuration = await loadPolicy(parsed);
    switch (parsed.command) {
      case "collect":
        return await runCollect(configuration, parsed);
      case "collect-org":
        return await runCollectOrg(configuration, parsed);
      case "doctor":
        return await runDoctor(configuration);
      case "prune":
        return await runPrune(parsed);
      case "evidence":
        return await runEvidence(configuration, parsed);
      case "map-sonar":
        return await runMapSonar(configuration);
      case "trend":
        return await runTrend(configuration);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return error instanceof UsageError ? EXIT_USAGE : EXIT_FAILED;
  } finally {
    await prisma.$disconnect();
  }
}
