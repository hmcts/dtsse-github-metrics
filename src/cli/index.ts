import { readinessPolicy } from "../evidence/assessment/assessment.ts";
import { collectDirectCommits, collectMergedPullRequests, mutableEdge } from "../evidence/behaviour/collect.ts";
import { directCommitCacheWriter, fillCachedSource, loadCachedMerges, pullRequestCacheWriter, requestedCoverage } from "../evidence/behaviour/fill.ts";
import { sourceSignature } from "../evidence/behaviour/queries.ts";
import { CollectionStatus } from "../evidence/domain/availability.ts";
import { EvidenceSource } from "../evidence/domain/coverage.ts";
import type { MergeGateEvidence, MergeGateReport } from "../evidence/domain/merge-gate.ts";
import { createGitHubClient } from "../evidence/github/client.ts";
import { resolveCredentials } from "../evidence/github/credentials.ts";
import { collectMergeGate } from "../evidence/inventory/merge-gate.ts";
import { deploysToProduction, fetchProductionRepositories } from "../evidence/inventory/production.ts";
import { collectSecurityAlerts } from "../evidence/inventory/security-alerts.ts";
import { loadConfiguration } from "../evidence/policy/load.ts";
import { configuredRepositories, repositoryOwners, sonarOrganizationName } from "../evidence/policy/repositories.ts";
import type { Configuration } from "../evidence/policy/schema.ts";
import { collectionState, stampCollection } from "../evidence/store/collection-state.ts";
import { prevailingCachedCoverage } from "../evidence/store/coverage.ts";
import { migrate } from "../evidence/store/migrate.ts";
import { prisma } from "../evidence/store/prisma.ts";
import { pruneCache } from "../evidence/store/prune.ts";
import { recordRepositoryState, storedRepositoryState } from "../evidence/store/repository-state.ts";
import { collectedAnchor, days, resolveWindow } from "../evidence/window/window.ts";
import { EXIT_COMPLETE, EXIT_FAILED, EXIT_USAGE, runStatus } from "./exit-status.ts";
import { type Arguments, COHORT_COMMANDS, parseArguments, UsageError } from "./parse-arguments.ts";

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
  return runStatus(observed === repositories.length && failures === 0 ? CollectionStatus.Complete : CollectionStatus.Partial);
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

  const state = await collectionState();
  console.info(
    state === undefined ? "no collection has run yet" : `the last collection landed at ${state.collectedAt.toISOString()} (revision ${state.revision})`
  );
  console.info(`${repositories.length - unreadable} of ${repositories.length} configured repositories are readable`);
  return unreadable === 0 ? EXIT_COMPLETE : EXIT_FAILED;
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
      team: owners.get(repository),
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
