import { readinessPolicy } from "../evidence/assessment/assessment.ts";
import { botAccounts, excludedAuthors, reportedCohort } from "../evidence/behaviour/analysis.ts";
import { collectDirectCommits, collectMergedPullRequests, mutableEdge, referencePatterns } from "../evidence/behaviour/collect.ts";
import { deserialiseMerges, directCommitCacheWriter, fillCachedSource, pullRequestCacheWriter, requestedCoverage } from "../evidence/behaviour/fill.ts";
import { mergedPullRequestCountQuery, sourceSignature } from "../evidence/behaviour/queries.ts";
import type { SecretAlertSummary } from "../evidence/domain/assurance.ts";
import { AvailabilityReason, CollectionStatus } from "../evidence/domain/availability.ts";
import { EvidenceSource } from "../evidence/domain/coverage.ts";
import type { MergeGateEvidence, MergeGateReport } from "../evidence/domain/merge-gate.ts";
import type { SecurityAlertEvidence } from "../evidence/domain/security-alerts.ts";
import { isSonarObservation, SonarMappingOutcome, type SonarResolutionAttempt, type SonarState, type StoredSonarMapping } from "../evidence/domain/sonar.ts";
import { createGitHubClient } from "../evidence/github/client.ts";
import { resolveCredentials } from "../evidence/github/credentials.ts";
import { runSummaryLines } from "../evidence/github/summary.ts";
import {
  assuranceEvidence,
  collectAssuranceSignals,
  collectOrganisationSecretAlerts,
  type GraphAssurance,
  hygieneFromMetadata,
  readDependabotAlerts
} from "../evidence/inventory/assurance.ts";
import { type EstateRepository, readEstateMetadata } from "../evidence/inventory/estate-metadata.ts";
import { collectMergeGate } from "../evidence/inventory/merge-gate.ts";
import { deploysToProduction, fetchProductionRepositories } from "../evidence/inventory/production.ts";
import {
  type AlertSource,
  collectOrganisationDependabotAlerts,
  collectSecurityAlerts,
  countedAlertsFromOrganisation,
  countFromSource,
  dependabotSeverity,
  type OrganisationPlace,
  organisationRecords
} from "../evidence/inventory/security-alerts.ts";
import { CohortUncollectedError, cohortOwners, cohortRepositories, readCohort } from "../evidence/org/cohort.ts";
import { collectCodeowners, collectDirectAdmins, collectOrgPeople, collectOrgRepositories, collectOrgTeams } from "../evidence/org/collect.ts";
import {
  byCodePoint,
  canonical,
  type OrgFacts,
  OwnerKind,
  type OwnershipOptions,
  type RepositoryAuthorship,
  type ResolvedOwnership
} from "../evidence/org/graph.ts";
import { collectSsoIdentities, namedPeople } from "../evidence/org/identities.ts";
import { attributeOwnership, ownershipEvidence, rungCounts, unresolvedRepositories } from "../evidence/org/ownership.ts";
import { storedDisplayNames } from "../evidence/org/people.ts";
import { loadConfiguration } from "../evidence/policy/load.ts";
import { configuredTeamSlugs, sonarOrganizationName } from "../evidence/policy/repositories.ts";
import type { Configuration } from "../evidence/policy/schema.ts";
import { alreadyAnswered, attributeProject, searchPacer } from "../evidence/sonar/attribute.ts";
import { createSonarClient, type SonarClient, SonarError, sonarToken } from "../evidence/sonar/client.ts";
import { sonarProjectMap } from "../evidence/sonar/map.ts";
import { resolveRepositoryProject } from "../evidence/sonar/resolve.ts";
import { collectionState, stampCollection, stampRevision } from "../evidence/store/collection-state.ts";
import { asSoleCollector } from "../evidence/store/collector-lock.ts";
import { prevailingCachedCoverage } from "../evidence/store/coverage.ts";
import { censusOfDescriptions, DEFAULT_BATCH_SIZE, type DescriptionCensus, reduceStoredDescriptions } from "../evidence/store/descriptions.ts";
import { authorshipForOrganisation, loadCachedFactsForOrganisation, storedRepositoryStates } from "../evidence/store/facts.ts";
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
import { seedProduction } from "../evidence/store/production-override.ts";
import { pruneCache } from "../evidence/store/prune.ts";
import { recordRepositoryState } from "../evidence/store/repository-state.ts";
import { recordSonarMapping, storedSonarMappings } from "../evidence/store/sonar-map.ts";
import { collectedAnchor, days, resolveWindow } from "../evidence/window/window.ts";
import { describeDatabase } from "../platform/database-target.ts";
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

/**
 * Runs a collection only if this process is the one collector, and reports a stand-down as success.
 *
 * SUCCESS, not failure, and that is the load-bearing decision. Both AAT clusters run the same schedule against
 * one database, so one of them loses the lock every single day. Exiting non-zero would make a CronJob report
 * Failed daily for a system behaving exactly as designed, and an alert that always fires is one nobody reads.
 * The estate was collected — by the peer — which is the outcome anybody watching actually cares about.
 */
async function onlyCollector(command: string, run: () => Promise<number>): Promise<number> {
  const status = await asSoleCollector(run);
  if (status === undefined) {
    progress(`another ${command} run holds the collector lock, so this one stood down; the estate is being collected elsewhere`);
    return EXIT_COMPLETE;
  }
  return status;
}

async function loadPolicy(argv: Arguments): Promise<Configuration> {
  return await loadConfiguration(...argv.config);
}

/**
 * Refuses a cohort command before it does any work, when the graph it would report has not been collected.
 *
 * THIS CHECK MOVED FROM THE FILE TO THE GRAPH. It used to refuse an empty `teams:`, which was the right question
 * while the file listed the estate. Now the estate comes from `collect-org`, so the thing that can be missing is
 * the graph — and `collect` genuinely depends on `collect-org` having run, which the chart sequences at 14:00 and
 * 15:00.
 *
 * Checked HERE rather than left to the first read so the refusal lands before credentials are resolved and the
 * first GitHub call is made. `readCohort` raises the same error either way; this only makes it early.
 *
 * `collect-org` is deliberately not a cohort command: it is what fills the graph, so requiring one would make it
 * unable to bootstrap an empty database.
 */
async function assertCohortCollected(configuration: Configuration, command: string): Promise<void> {
  try {
    await readCohort(configuration);
  } catch (error) {
    if (error instanceof CohortUncollectedError) {
      throw new UsageError(`${command} reports the collected cohort, but ${error.message}`);
    }
    throw error;
  }
}

/**
 * Collects one repository.
 *
 * TWO DEPTHS, and the shallow one is what makes the wider estate affordable. A repository inside
 * `cohort.active_within_days` gets everything: the two merge walks, the gate, all three alert families. A STALE
 * one — admitted to the estate from 2026-09-14 so the assurance criteria can report on it — gets only what those
 * criteria read, which is its metadata and its Dependabot alerts, two REST calls against roughly six.
 *
 * That split is a judgement rather than only a saving. A merge gate and a code-scanning posture are
 * ways-of-working material, reported per team, and a repository nobody has pushed to in two years HAS no ways of
 * working to report — the honest answer for it is the assurance one: who owns it, whether its tooling is on, how
 * old its alerts are, and that it should probably be archived.
 */
async function collectRepository(
  configuration: Configuration,
  client: ReturnType<typeof createGitHubClient>,
  repository: string,
  window: { startsAt: Date; endsAt: Date },
  reference: Date,
  production: Set<string> | undefined,
  options: {
    behaviour: boolean;
    assurance: GraphAssurance | undefined;
    secrets: { read: boolean; summary?: SecretAlertSummary };
    /** This repository's row from the organisation listing, where the run read one. */
    metadata?: EstateRepository;
    /**
     * The estate-wide Dependabot alert read, present only where this run MADE one.
     *
     * THREE STATES, and the third is why this is not simply a map. Absent means no estate-wide read was made —
     * a `--repository` run, which reads that one repository's alerts instead, because paging the organisation's
     * alerts to find one repository costs far more than asking for it. Present with a map is the read that
     * worked. Present with `dependabot: undefined` is the read that was REFUSED, and that must not fall back to
     * 1,889 per-repository reads: the same permission answers both endpoints, so every one of them would be
     * refused too. Every repository reads unmeasured instead.
     */
    estateAlerts?: { dependabot: Map<string, unknown[]> | undefined };
    /**
     * What the stored SonarCloud map says about this repository, and the measures where it named a project.
     *
     * ASKED ON BOTH DEPTHS, unlike every other signal the shallow path drops. A stale repository's quality gate
     * is assurance material rather than ways-of-working material — it is exactly the kind of thing an assurance
     * report on a repository nobody has pushed to wants — and it costs a call only where the map attributes a
     * project, which is 315 projects against 1,889 repositories.
     */
    sonar: SonarSource;
  }
): Promise<{ observed: boolean; failures: number }> {
  const organization = configuration.organization;
  let failures = 0;

  // The default branch and `security_and_analysis`, off the ORG LISTING the run already read — one paginated
  // call for the estate against one per repository. Read here only for a repository that listing did not name,
  // which on a full run is none of them and on `--repository` is the one that was asked for.
  const metadata = options.metadata ?? (await client.get<{ default_branch?: string }>(`/repos/${organization}/${repository}`).catch(() => undefined));
  if (metadata === undefined) {
    console.warn(`${repository}: could not be read at all, so nothing was collected for it`);
    return { observed: false, failures: 1 };
  }
  const defaultBranch = metadata.default_branch;
  if (defaultBranch === undefined || defaultBranch === "") {
    console.warn(`${repository}: GitHub named no default branch, so nothing was collected for it`);
    return { observed: false, failures: 1 };
  }

  // ONE ESTATE-WIDE READ, NOT ONE PER REPOSITORY, and read once and used twice within that. The patching
  // criterion needs each alert's `created_at` and the security block needs the same family counted by severity,
  // so both are served from the organisation's own alert response — which is a few dozen pages against 1,889
  // per-repository calls. A `--repository` run has no such response and asks for that repository alone.
  //
  // WHAT AN ABSENCE FROM THAT RESPONSE MEANS is the part that had to be right: it names only repositories the
  // feature is on for, so `hasVulnerabilityAlertsEnabled` is what turns an absence into "clean" rather than the
  // absence turning itself into a zero. See `organisationAnswer`.
  const estate = options.estateAlerts;
  const dependabotSource: AlertSource =
    estate === undefined
      ? { from: "repository", records: await readDependabotAlerts(client, organization, repository) }
      : {
          from: "organisation",
          place: {
            read: estate.dependabot !== undefined,
            named: estate.dependabot?.has(repository) === true,
            enabled: options.assurance?.vulnerabilityAlerts
          },
          records: estate.dependabot?.get(repository) ?? []
        };
  const dependabot = dependabotSource.from === "repository" ? dependabotSource.records : organisationRecords(dependabotSource);
  const assurance = assuranceEvidence(metadata, options.assurance, dependabot, reference, options.secrets);

  // The estate-wide secret-scanning read's place for this repository. `hygiene.secretScanning` is the signal
  // that says whether anything was scanning, so an absence from that response reads as clean only where it is on.
  const secretScanning = {
    place: { read: options.secrets.read, named: options.secrets.summary !== undefined, enabled: hygieneFromMetadata(metadata).secretScanning },
    open: options.secrets.summary?.open ?? 0
  };

  const sonar = await options.sonar.answer(repository);
  failures += sonar.failures;

  if (!options.behaviour) {
    // The shallow path. No gate, no other alert family, and above all no merge walk — which is what keeps
    // admitting roughly 650 stale repositories from adding a behaviour call. The row they produce carries the
    // assurance answers and, by the absent-means-unmeasured rule, no behaviour figures at all.
    await recordRepositoryState(organization, repository, {
      defaultBranch,
      fetchedAt: reference,
      sonar: sonar.state,
      // The two families this path has answers for, counted rather than thrown away — both come off estate-wide
      // reads, so a stale repository costs nothing to report them for. Code scanning stays absent, which reads
      // as unmeasured: this path never looked at it, and saying so is the honest answer rather than nothing open.
      securityAlerts: withoutCodeScanning(dependabotSource, secretScanning),
      deploysToProduction: deploysToProduction(production, organization, repository),
      assurance
    });
    return { observed: true, failures };
  }

  const edge = mutableEdge(window, configuration.lookback.mutable_hours, reference);

  await fillCachedSource(
    requestedCoverage(organization, repository, EvidenceSource.PullRequests, window),
    edge,
    // The traceability policy reaches the WALK, because the two answers a description is reduced to are
    // derived where the fact is built rather than stored as 61 MB of prose for a later regex — see
    // `describedBy` in `behaviour/collect.ts`.
    (startsAt, endsAt) => collectMergedPullRequests(client, organization, repository, startsAt, endsAt, configuration.traceability),
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
  // Handed both estate-wide families, so this pays for code scanning alone.
  const alerts = await collectSecurityAlerts(client, organization, repository, { dependabot: dependabotSource, secretScanning });
  failures += alerts.failures.length;
  for (const failure of alerts.failures) {
    console.warn(`${repository}: ${failure.detail}`);
  }

  await recordRepositoryState(organization, repository, {
    defaultBranch,
    fetchedAt: reference,
    mergeGate: gate,
    securityAlerts: alerts.evidence,
    deploysToProduction: deploysToProduction(production, organization, repository),
    assurance,
    sonar: sonar.state
  });

  return { observed: true, failures };
}

/**
 * The alert block for the shallow path: the two families read for the whole estate, and one stated absence.
 *
 * The shallow path never calls `collectSecurityAlerts`, so this is what keeps its answers from being thrown
 * away — both families are in hand from estate-wide reads, and counting them costs nothing. It reports secret
 * scanning for a stale repository where it used to report nothing, which is a gain the org-wide read paid for
 * already.
 *
 * CODE SCANNING IS AN EMPTY OBJECT, which is the block's own way of saying nobody looked: `open` absent rather
 * than zero, on the rule `OpenAlertCount` states. This path never reads it, and reporting it as clean would be
 * the one thing this codebase refuses to do with an absence.
 */
function withoutCodeScanning(dependabot: AlertSource, secretScanning: { place: OrganisationPlace; open: number }): SecurityAlertEvidence {
  return {
    dependabot: countFromSource(dependabot, "dependabot/alerts", dependabotSeverity).count,
    codeScanning: {},
    secretScanning: countedAlertsFromOrganisation(secretScanning.place, secretScanning.open, "secret-scanning/alerts").count
  };
}

/** What one repository's SonarCloud answer cost, beside the answer itself. */
interface SonarAnswer {
  state: SonarState;
  failures: number;
}

/** What `collect` asks about each repository's SonarCloud project, once the map has been read. */
interface SonarSource {
  answer(repository: string): Promise<SonarAnswer>;
  /**
   * What the two whole-run reads cost the exit status: one, when the map or the project listing was refused.
   *
   * COUNTED ONCE FOR THE RUN and not once per repository, exactly as the estate-wide alert reads are: each is a
   * single call, and inflating it to 1,889 would swamp the exit status with one refusal.
   */
  failures: number;
}

/**
 * Every repository's SonarCloud answer will be this one, because nothing repository-specific was learned.
 *
 * Used for the three whole-run conditions — no map, an unreadable map, an unreadable project listing — and
 * stated in each repository's own block rather than left absent, because an absent block means NOBODY LOOKED
 * and each of these means somebody looked and could not see.
 */
function statedSonarAbsence(detail: string, failures = 0): SonarSource {
  return { answer: async () => ({ state: { detail }, failures: 0 }), failures };
}

/**
 * What a collection asks the stored map, and the one SonarCloud read it pays per mapped repository.
 *
 * THE MAP IS READ ONCE AND THE PROJECT LISTING ONCE, both before the estate walk. Together they cost two calls
 * for the whole run, and what they buy is that resolution itself spends NOTHING: `resolveRepositoryProject`
 * without a declaration is a lookup in the map this already holds. Only a repository the map attributes a
 * project to costs a call, and that is the measures read.
 *
 * THE LISTING IS WHERE THE ANALYSIS INSTANT COMES FROM, and asking for it there is why it is affordable at all.
 * `/api/measures/component` does not report when the project was last analysed, and the card that renders the
 * gate says "never analysed" for a measure set that carries no instant — a claim about the project rather than
 * about the measurement. Reading each project's own analyses would answer it in one call per mapped repository;
 * the organisation's listing answers it for all 315 in one.
 *
 * A DECLARATION IS NOT READ HERE, so two rungs of the ladder in `sonar/resolve.ts` are unreachable from
 * `collect`: `sonar-project.properties` is not among the files this collection fetches, and adding a content
 * read for it would be one call per repository across the estate to obtain a hypothesis the map answers for
 * anyway. Upstream got the declaration free inside a GraphQL document it already sent; this port sends no such
 * document. The rungs stay, reached by the map's own evidence and by an override.
 */
async function sonarSource(configuration: Configuration, githubClient: ReturnType<typeof createGitHubClient>, now: Date): Promise<SonarSource> {
  const organization = configuration.organization;
  const sonarOrganization = sonarOrganizationName(configuration);

  let rows: Awaited<ReturnType<typeof storedSonarMappings>>;
  try {
    rows = await storedSonarMappings(sonarOrganization);
  } catch (error) {
    console.warn(`the SonarCloud project map could not be read: ${error instanceof Error ? error.message : String(error)}`);
    return statedSonarAbsence("the stored SonarCloud project map could not be read", 1);
  }

  const map = sonarProjectMap(rows);
  if (map.answered === 0) {
    // NOT A FAILURE, and the wording is the whole point of this branch: an empty map means `map-sonar` has never
    // run for this organisation, which is a fact about this deployment and not about any repository in it.
    console.info(`the SonarCloud project map holds nothing for ${sonarOrganization}, so no repository can be attributed a project; run map-sonar`);
    return statedSonarAbsence(`the SonarCloud project map has not been built for ${sonarOrganization}, so no project has been looked for`);
  }

  const client = createSonarClient({ organization: sonarOrganization, ...tokenOptions() });
  let listed: Map<string, Date | undefined>;
  try {
    const projects = await client.projects();
    listed = new Map(projects.map((project) => [project.key, project.analysisAt]));
    console.info(`SonarCloud lists ${projects.length} projects for ${sonarOrganization}; the map attributes ${map.attributed} repositories`);
  } catch (error) {
    console.warn(`SonarCloud's project listing could not be read: ${error instanceof Error ? error.message : String(error)}`);
    return statedSonarAbsence(`SonarCloud's ${sonarOrganization} project listing could not be read, so no project was measured`, 1);
  }

  return {
    failures: 0,
    async answer(repository: string): Promise<SonarAnswer> {
      const resolved = await resolveRepositoryProject({
        sonarClient: client,
        githubClient,
        organization,
        sonarOrganization,
        repository,
        ...(configuration.sonar_projects[repository] === undefined ? {} : { configuredKey: configuration.sonar_projects[repository] }),
        storedByProject: map.byProject,
        storedByRepository: map.byRepository,
        now
      });
      const mapping = resolved.mapping;
      if (mapping === undefined) {
        return {
          state: { detail: resolved.note ?? `no SonarCloud project in ${sonarOrganization} analyses this repository` },
          failures: resolved.reason === undefined ? 0 : 1
        };
      }
      if (!listed.has(mapping.projectKey)) {
        // AN OBSERVATION AND NOT A FAILURE. A mapped project can be deleted, renamed or made private after the
        // map was built, and `map-sonar` walks only what SonarCloud still lists, so it never clears the row. The
        // method is named because it is what a human needs to fix it: a stale map row is cleared by re-running
        // `map-sonar`, a wrong `sonar_projects` override by editing it.
        return {
          state: { mapping, detail: `SonarCloud no longer lists project ${mapping.projectKey}, resolved for ${repository} by ${mapping.method}` },
          failures: 0
        };
      }
      try {
        return { state: { mapping, measures: await client.measures(mapping.projectKey, listed.get(mapping.projectKey)) }, failures: 0 };
      } catch (error) {
        if (!(error instanceof SonarError)) {
          throw error;
        }
        const gone = error.reason === AvailabilityReason.NotFoundOrInaccessible;
        return {
          state: { mapping, detail: gone ? `SonarCloud lists no project ${mapping.projectKey} to measure` : error.message },
          // A refused read keeps its reason and fails the run; a project that is simply not there does not.
          failures: gone ? 0 : 1
        };
      }
    }
  };
}

/** The SonarCloud token, where the environment sets one. Anonymous otherwise, which is what AAT runs. */
function tokenOptions(): { token?: string } {
  const token = sonarToken(process.env);
  return token === undefined ? {} : { token };
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

  // THE WHOLE ESTATE, at two depths. Every repository gets its assurance answers; only the ones inside
  // `cohort.active_within_days` get their merge history walked, which is where the calls are. `behaviourCollectable`
  // rides on the entry so this call site reads the cohort's own decision rather than recomputing the window.
  //
  // A named `--repository` is collected in FULL whatever its last push, because somebody asking for one repository
  // has said which and wants everything about it.
  const cohort = argv.repository === undefined ? await readCohort(configuration, reference) : undefined;
  const walk =
    cohort === undefined
      ? [{ repository: argv.repository as string, behaviour: true }]
      : cohort.map((entry) => ({ repository: entry.repository, behaviour: entry.behaviourCollectable }));

  // Batched 50 to a document AHEAD of the per-repository loop, because these two signals are GraphQL-only and
  // aliasing them is the difference between 38 documents and 1,880 requests. A repository the batch could not read
  // is simply absent from the map, which the domain grades as unknown rather than as tooling switched off.
  const assurance = await collectAssuranceSignals(
    client,
    configuration.organization,
    walk.map((entry) => entry.repository)
  );

  // ONE PAGINATED LISTING FOR THE WHOLE ESTATE'S METADATA, which is about 19 pages against 1,889
  // per-repository reads. Only for a run collecting the estate: paging the organisation to find one repository
  // asked for by name would cost more than reading it, so `--repository` keeps the read it always had.
  const estate = argv.repository === undefined ? await readEstateMetadata(client, configuration.organization) : undefined;
  const unlisted = estate === undefined ? [] : walk.filter((entry) => !estate.has(entry.repository));
  if (unlisted.length > 0) {
    // Named rather than silent: a repository in the collected graph that the organisation no longer lists has
    // been renamed, transferred or deleted since `collect-org` ran, and that is worth seeing.
    console.warn(
      `${unlisted.length} collected ${unlisted.length === 1 ? "repository is" : "repositories are"} not in the organisation's listing, so each one's metadata is read on its own`
    );
  }

  let observed = 0;
  let failures = 0;

  // ONE CALL FOR THE WHOLE ESTATE, which is what makes the committed-secrets criterion affordable — and what makes
  // "this repository has none" a real answer rather than an untested assumption, since the response covers every
  // repository. `undefined` on failure, so every repository reads unknown rather than clean.
  //
  // COUNTED AS ONE FAILURE when it fails, not one per repository: it is a single call, and inflating it to 1,889
  // would swamp the exit status with one refusal. `--tolerate-partial` still reports the run as success, which is
  // right — the rest of the estate was collected.
  const secretAlerts = await collectOrganisationSecretAlerts(client, configuration.organization, reference);
  if (secretAlerts === undefined) {
    failures += 1;
  } else {
    const open = [...secretAlerts.values()].reduce((total, summary) => total + summary.open, 0);
    console.info(`${open} open secret-scanning alerts across ${secretAlerts.size} repositories`);
  }

  // THE SAME SHAPE FOR DEPENDABOT, and the largest single saving in the run: a few dozen pages against one call
  // per repository for all 1,889 of them. Counted as ONE failure when it fails, for the reason above — it is a
  // single call, and inflating it to 1,889 would swamp the exit status with one refusal.
  //
  // Skipped for `--repository`, which reads that one repository's alerts instead: paging the organisation to
  // find one repository costs more than asking for it, exactly as the estate metadata listing is skipped.
  const dependabotAlerts = argv.repository === undefined ? await collectOrganisationDependabotAlerts(client, configuration.organization) : undefined;
  if (argv.repository === undefined && dependabotAlerts === undefined) {
    failures += 1;
  } else if (dependabotAlerts !== undefined) {
    const open = [...dependabotAlerts.values()].reduce((total, records) => total + records.length, 0);
    console.info(`${open} open Dependabot alerts across ${dependabotAlerts.size} repositories`);
  }

  // The map and the project listing, read once each before the walk. See `sonarSource`: resolution itself spends
  // nothing after this, and only a repository the map attributes a project to pays for its measures.
  const sonar = await sonarSource(configuration, client, reference);
  failures += sonar.failures;

  for (const entry of walk) {
    const result = await collectRepository(configuration, client, entry.repository, window, reference, production, {
      behaviour: entry.behaviour,
      sonar,
      assurance: assurance.get(entry.repository),
      // Absent from the map is CLEAN rather than unread, because the org-wide read covers every repository — which
      // is why `read` is carried separately from the summary rather than inferred from its absence.
      secrets: {
        read: secretAlerts !== undefined,
        ...(secretAlerts?.get(entry.repository) === undefined ? {} : { summary: secretAlerts.get(entry.repository) })
      },
      ...(estate?.get(entry.repository) === undefined ? {} : { metadata: estate.get(entry.repository) }),
      // Present whenever this run made the estate-wide read at all, whether or not it succeeded — see
      // `estateAlerts`, where the refused case is what must NOT fall back to a read per repository.
      ...(argv.repository === undefined ? { estateAlerts: { dependabot: dependabotAlerts } } : {})
    });
    observed += result.observed ? 1 : 0;
    failures += result.failures;
  }

  await stampCollection(reference);
  const repositories = walk;
  const walked = walk.filter((entry) => entry.behaviour).length;
  console.info(`collected ${observed} of ${repositories.length} repositories (${walked} walked for behaviour) in ${client.requestsIssued()} GitHub calls`);
  for (const line of runSummaryLines(client)) {
    console.info(line);
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

/**
 * How many repositories `doctor` reads by default.
 *
 * A SAMPLE, because `doctor` answers questions about the CREDENTIAL rather than about the estate: whether it
 * can read repositories and whether it can see their merged pull requests. Neither answer needs 1,889
 * repositories, and asking for all of them made the cheap check somebody runs first cost ~3,800 calls — more
 * than a collection. Thirty is enough for a credential-wide fault to appear in it, and `--all` is there for the
 * exhaustive sweep when somebody wants to name every unreadable repository.
 */
export const DOCTOR_SAMPLE_SIZE = 30;

/**
 * A sample of the cohort SPREAD ACROSS OWNERS, largest owner first, rather than the first N alphabetically.
 *
 * Ownership is what the interesting permission faults follow: an App installation that lost a permission, or a
 * team whose repositories are internal where the rest are public, shows up in one owner's repositories and not
 * in another's. Thirty names off the top of a sorted list are mostly one or two owners' — so the sample takes
 * one repository from each owner in turn, and only comes back round for a second once every owner has had one.
 *
 * DETERMINISTIC, not random: two runs against the same cohort read the same repositories, so a fault that
 * appears and disappears is a fault rather than a different sample. Repositories are ordered within an owner,
 * and owners by how many they hold, so the largest estates are represented first.
 *
 * A repository nobody owns is still in the cohort and still sampled — `unowned` is a normal outcome here, and
 * a permission fault does not care who is on the hook for it.
 */
export function doctorSample(repositories: readonly string[], owners: ReadonlyMap<string, readonly string[]>, size: number): string[] {
  const byOwner = new Map<string, string[]>();
  for (const repository of [...repositories].sort(byCodePoint)) {
    for (const owner of owners.get(repository)?.length === 0 || owners.get(repository) === undefined ? ["unowned"] : (owners.get(repository) as string[])) {
      byOwner.set(owner, [...(byOwner.get(owner) ?? []), repository]);
    }
  }
  // Largest holding first, then by name so two owners holding the same number keep a stable order.
  const queues = [...byOwner.entries()]
    .sort(([left, leftHeld], [right, rightHeld]) => rightHeld.length - leftHeld.length || byCodePoint(left, right))
    .map(([, held]) => held);

  const sampled: string[] = [];
  const seen = new Set<string>();
  for (let round = 0; sampled.length < size && queues.some((queue) => round < queue.length); round += 1) {
    for (const queue of queues) {
      const repository = queue[round];
      if (sampled.length >= size || repository === undefined || seen.has(repository)) {
        continue;
      }
      seen.add(repository);
      sampled.push(repository);
    }
  }
  return sampled;
}

async function runDoctor(configuration: Configuration, argv: Arguments): Promise<number> {
  const credentials = await resolveCredentials();
  console.info(`authenticating as ${credentials.describe()}`);
  const client = createGitHubClient({ credentials });

  // DIAGNOSES AN UNCOLLECTED GRAPH RATHER THAN FAILING ON ONE. `doctor` is the command somebody runs against a
  // database they are unsure about, so the one state it must not crash on is the empty one — it reports that the
  // cohort has not been collected, checks everything that does not need it, and leaves the exit status to the
  // findings. This is why it is not a cohort command: those refuse up front, and this one is the tool for
  // finding out why they would.
  const cohort = await readCohort(configuration).catch((error: unknown) => {
    if (error instanceof CohortUncollectedError) {
      console.warn(error.message);
      return undefined;
    }
    throw error;
  });
  const owners = new Map((cohort ?? []).map((entry) => [entry.repository, entry.owners]));
  const collected = (cohort ?? []).map((entry) => entry.repository);
  // A SAMPLE BY DEFAULT AND THE WHOLE COHORT ON `--all`. The two checks below answer questions about the
  // credential, and thirty repositories spread across owners answer them for about 61 calls where the whole
  // cohort cost roughly 3,800 — most of it on the heaviest document in the codebase, asked for a boolean.
  const repositories = argv.all ? collected : doctorSample(collected, owners, DOCTOR_SAMPLE_SIZE);
  let unreadable = 0;
  for (const repository of repositories) {
    try {
      await client.get(`/repos/${configuration.organization}/${repository}`);
    } catch (error) {
      unreadable += 1;
      console.warn(`${repository}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const visible = await countRepositoriesWithMerges(client, configuration, repositories);

  const state = await collectionState();
  console.info(
    state === undefined ? "no collection has run yet" : `the last collection landed at ${state.collectedAt.toISOString()} (revision ${state.revision})`
  );
  // SAYS WHAT WAS ACTUALLY READ. A sampled run reporting "1889 of 1889 are readable" would claim a sweep it did
  // not make, so the figures name the sample and the line says how to widen it.
  const scope = argv.all
    ? `all ${collected.length} cohort repositories`
    : `${repositories.length} of ${collected.length} cohort repositories, sampled across owners`;
  console.info(`${repositories.length - unreadable} of ${repositories.length} readable, from ${scope}`);
  console.info(`GitHub shows merged pull requests in ${visible} of the ${repositories.length} read`);
  if (!argv.all) {
    console.info("this is a sample; --all reads every cohort repository and names each unreadable one");
  }
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
 * How many of these repositories the credential can see ANY merged pull request in.
 *
 * Deliberately NOT through search. Search is what an App installation token cannot do — it is answered with an
 * empty result over repositories it reads perfectly well — and checking a capability the collector no longer
 * depends on would report a fault that does not matter while missing one that does.
 *
 * COUNTS REPOSITORIES RATHER THAN PULL REQUESTS, which is what the check was always about: it fails when the
 * answer is zero everywhere, and a total was only ever a proxy for that. Asking `totalCount` instead of walking
 * 25 pull requests with their reviews and rollups is the difference between one node and the heaviest document
 * here, per repository.
 */
async function countRepositoriesWithMerges(
  client: ReturnType<typeof createGitHubClient>,
  configuration: Configuration,
  repositories: readonly string[]
): Promise<number> {
  let withMerges = 0;

  for (const repository of repositories) {
    try {
      const data = await client.graphql<{ repository?: { pullRequests?: { totalCount?: number } | null } | null }>(mergedPullRequestCountQuery(), {
        organization: configuration.organization,
        repository
      });
      const total = data.repository?.pullRequests?.totalCount ?? 0;
      if (total === 0) {
        console.warn(`${repository}: GitHub returned no merged pull requests at all`);
        continue;
      }
      withMerges += 1;
    } catch (error) {
      console.warn(`${repository}: reading merged pull requests failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return withMerges;
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

  // The one place the SSO identity mapping can be read: the web pod holds no GitHub credential, so a name the
  // dashboard shows has to be resolved here and stored. See `evidence/org/identities.ts`.
  //
  // AN UNMEASURED PASS CARRIES THE STORED NAMES FORWARD RATHER THAN OMITTING THEM. A credential that cannot see
  // the mapping — a PAT, which GitHub answers with `samlIdentityProvider: null` and an HTTP 200 — would otherwise
  // hand the writer facts with no name, and because the graph is change-versioned that ends the interval of every
  // named person and opens a new one without their name. Blanking the estate is not a value to put back; it is
  // 778 intervals to reopen, which nothing can do.
  const identities = await collectSsoIdentities(client, organization);
  const resolvedNames = identities.measured ? identities.names : await storedDisplayNames(organization);
  progress(
    identities.measured
      ? `resolved ${resolvedNames.size} contributor names from the SSO identity mapping`
      : `the SSO identity mapping could not be read, so the ${resolvedNames.size} stored contributor names were left as they stand`
  );
  const people = namedPeople(peopleWalk.facts, resolvedNames);

  const options: OwnershipOptions = {
    prefixSupport: graph.prefix_support,
    prefixDominance: graph.prefix_dominance,
    maximumTeamShare: graph.maximum_team_share,
    maximumTeamMembers: graph.maximum_team_members,
    excludedTeams: new Set(graph.excluded_teams.map(canonical)),
    // Slugs, not identifiers: this feeds the ladder, whose answer is stored in a column joined to `org_teams`.
    configured: configuredTeamSlugs(configuration),
    minimumAuthoredMerges: graph.minimum_authored_merges
  };

  // Read from the fact cache `collect` fills rather than fetched, so the top rung of the ladder costs no
  // GitHub call. An EMPTY MAP is a legitimate outcome and not a failure — on a database where `collect` has
  // never run there is no authorship, the rung declines for every repository, and the rungs below answer
  // exactly as they did before it existed. That is why `collect-org` does not refuse on it.
  const authorship = await authoredMerges(organization, graph.authorship_days, observedAt);
  progress(`read authorship for ${authorship.size} repositories from the ${graph.authorship_days}-day fact cache`);

  // Resolved once from the free rungs to find the residue, then again once the paid rungs have answered.
  const free: OrgFacts = { organization, ...teamFacts, repositories, people, codeowners: new Map(), directAdmins: new Map(), authorship };
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
  // A ROW PER LIVE REPOSITORY FOR SOMEBODY TO TICK, in one statement rather than one per repository. It is
  // `INSERT … ON CONFLICT DO NOTHING`, so the only thing a collection can do to this table is add keys — which is
  // what makes "the import never overrides what a person said" a property of the statement rather than a rule
  // somebody has to remember. Run after the graph writers, because it seeds from what they just left live.
  //
  // Reported unconditionally, including the zero every steady-state run prints: a line that appears only when
  // something changed is a line whose absence says nothing.
  progress(`${await seedProduction(organization)} repositories gained a repository_production row to be marked on`);
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
  // The same breakdown `collect` prints. This walk spends a quota too, and a single total could not say whether
  // an hour went on the team walk, the CODEOWNERS ladder or waiting for a window to reset.
  for (const line of runSummaryLines(client)) {
    progress(line);
  }
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

/**
 * Who authored merges in each repository, in the shape the ownership ladder reads.
 *
 * The store returns login→count maps and the ladder wants `RepositoryAuthorship`; the reshaping is here
 * rather than in the store so that `facts.ts` stays a reader of its own tables and knows nothing about the
 * ownership rungs that happen to consume it.
 */
async function authoredMerges(organization: string, days: number, reference: Date): Promise<Map<string, RepositoryAuthorship>> {
  const since = new Date(reference.getTime() - days * 24 * 60 * 60 * 1000);
  const counted = await authorshipForOrganisation(organization, since);
  return new Map([...counted].map(([repository, merges]) => [repository, { repository, merges }]));
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

/**
 * What one `map-sonar` run learned and what it spent, tallied as it goes.
 *
 * ACCUMULATED RATHER THAN ASSEMBLED AT THE END, because the run is INTERRUPTIBLE: it is paced against the
 * scarcest quota this project spends, and a rate limit or a human can stop it part way through an organisation.
 * The summary must then describe the projects it did answer, which is the whole reason each row is written as it
 * is resolved rather than in one batch.
 */
interface MappingProgress {
  listed: number;
  unchanged: number;
  searches: number;
  stopped: boolean;
  outcomes: Map<SonarMappingOutcome, number>;
  /** Every project key that named each repository, so the many-to-one case is visible rather than counted. */
  claims: Map<string, string[]>;
}

function countOutcome(progress: MappingProgress, attempt: SonarResolutionAttempt): void {
  progress.outcomes.set(attempt.outcome, (progress.outcomes.get(attempt.outcome) ?? 0) + 1);
  progress.searches += attempt.analysesTried;
  const repository = attempt.mapping?.repository;
  if (repository !== undefined) {
    progress.claims.set(repository, [...(progress.claims.get(repository) ?? []), attempt.projectKey]);
  }
}

function outcomesCounted(progress: MappingProgress, ...outcomes: SonarMappingOutcome[]): number {
  return outcomes.reduce((total, outcome) => total + (progress.outcomes.get(outcome) ?? 0), 0);
}

/**
 * How many projects the run has an answer for, whether it resolved one or read one back.
 *
 * A NEVER-ANALYSED OR UNRESOLVABLE PROJECT IS ANSWERED: there is nothing more to learn about it until it is
 * analysed again, which is why it is stored with its reason. Only a failed call leaves a project unanswered.
 */
function answeredProjects(progress: MappingProgress): number {
  return progress.unchanged + [...progress.outcomes.entries()].reduce((total, [outcome, count]) => total + (isSonarObservation(outcome) ? count : 0), 0);
}

function mappingStatus(progress: MappingProgress): CollectionStatus {
  if (answeredProjects(progress) === 0) {
    return CollectionStatus.Failed;
  }
  return progress.stopped || outcomesCounted(progress, SonarMappingOutcome.Failed) > 0 ? CollectionStatus.Partial : CollectionStatus.Complete;
}

/**
 * Resolves every project the SonarCloud organisation lists, storing each answer as it is arrived at.
 *
 * BOTH ORGANISATION NAMES ARE CARRIED, because they are allowed to differ: `organization` is the GitHub one the
 * commit search is qualified by and the owner an answer must belong to, and `sonarOrganization` is the
 * SonarCloud one the map is keyed under. Collapsing them would search GitHub for an organisation that need not
 * exist there.
 *
 * STOPPED RATHER THAN FAILED BY A RATE LIMIT that survived the client's own retries: the limit applies to every
 * project still to come exactly as it applied to this one, so continuing would write this run's exhaustion into
 * the map as each remaining project's own dead end.
 */
async function resolveListedProjects(
  sonarClient: SonarClient,
  githubClient: ReturnType<typeof createGitHubClient>,
  organization: string,
  sonarOrganization: string,
  projects: readonly { key: string; analysisAt?: Date }[],
  reference: Date
): Promise<MappingProgress> {
  const stored = sonarProjectMap(await storedSonarMappings(sonarOrganization));
  const pacer = searchPacer(githubClient);
  const progress: MappingProgress = { listed: projects.length, unchanged: 0, searches: 0, stopped: false, outcomes: new Map(), claims: new Map() };

  let position = 0;
  for (const project of projects) {
    position += 1;
    const known = stored.byProject(project.key);
    if (known !== undefined && alreadyAnswered(project.analysisAt, known)) {
      countUnchanged(progress, known);
      console.debug(`SKIP   ${project.key} (${position}/${projects.length}): nothing analysed since it was resolved`);
      continue;
    }

    let attempt: SonarResolutionAttempt;
    try {
      attempt = await attributeProject({ sonarClient, githubClient, organization, projectKey: project.key, pacer, now: new Date() });
    } catch (error) {
      // The one error `attributeProject` raises rather than classifying is an exhausted search quota, which is
      // why this is a stop and not one project's failure.
      console.error(
        `ERROR  ${project.key} (${position}/${projects.length}): ${error instanceof Error ? error.message : String(error)}; stopping and keeping the ${answeredProjects(progress)} projects already answered`
      );
      progress.stopped = true;
      return progress;
    }

    countOutcome(progress, attempt);
    reportAttempt(attempt, position, projects.length);
    await storeAttempt(sonarOrganization, attempt, reference);
  }
  return progress;
}

/** Counts a project the map already answers for, keeping the repository it claims in the run's tally. */
function countUnchanged(progress: MappingProgress, known: StoredSonarMapping): void {
  progress.unchanged += 1;
  if (known.repository !== undefined) {
    progress.claims.set(known.repository, [...(progress.claims.get(known.repository) ?? []), known.projectKey]);
  }
}

/**
 * Stores one answered project, saying when a newer stored answer was left in place.
 *
 * ONLY AN ANSWER IS STORED, NEVER A FAILED CALL. `recordSonarMapping` refuses anything whose analysis does not
 * supersede the stored row's, so a resolution taken from an older analysis — and every unresolved reason, which
 * has no analysis instant at all — leaves an existing mapping alone rather than overwriting it with less.
 */
async function storeAttempt(sonarOrganization: string, attempt: SonarResolutionAttempt, resolvedAt: Date): Promise<void> {
  if (!isSonarObservation(attempt.outcome)) {
    return;
  }
  const written = await recordSonarMapping(sonarOrganization, {
    projectKey: attempt.projectKey,
    resolvedAt,
    ...(attempt.mapping === undefined ? {} : { mapping: attempt.mapping }),
    ...(attempt.detail === undefined ? {} : { detail: attempt.detail })
  });
  if (!written) {
    console.debug(`kept the stored mapping for ${attempt.projectKey}: it was resolved from a newer analysis`);
  }
}

/** Says what became of one project, as `doctor` says what became of one repository. */
function reportAttempt(attempt: SonarResolutionAttempt, position: number, listed: number): void {
  const where = `(${position}/${listed})`;
  if (attempt.mapping !== undefined) {
    console.info(`OK     ${attempt.projectKey} ${where}: ${attempt.mapping.repository}`);
    return;
  }
  if (attempt.outcome === SonarMappingOutcome.Failed) {
    console.error(`ERROR  ${attempt.projectKey} ${where}: ${attempt.detail}`);
    return;
  }
  // An observation, not a failure: the project has been answered for, and the answer is that nothing on either
  // side names a repository for it.
  console.info(`NONE   ${attempt.projectKey} ${where}: ${attempt.detail}`);
}

/** Reports what the run cost and what the map now holds, including the repositories two projects claim. */
function reportMapping(sonarOrganization: string, progress: MappingProgress): void {
  console.info(
    `mapped ${answeredProjects(progress)} of ${progress.listed} projects listed for ${sonarOrganization}: ` +
      `${outcomesCounted(progress, SonarMappingOutcome.Resolved)} resolved, ${progress.unchanged} unchanged, ` +
      `${outcomesCounted(progress, SonarMappingOutcome.NoAnalysis)} never analysed, ` +
      `${outcomesCounted(progress, SonarMappingOutcome.NoRevision, SonarMappingOutcome.UnknownCommit, SonarMappingOutcome.OutsideOrganization)} unresolvable, ` +
      `${outcomesCounted(progress, SonarMappingOutcome.Failed)} failed; ${progress.claims.size} repositories mapped in ${progress.searches} commit searches`
  );
  for (const [repository, projects] of progress.claims) {
    if (projects.length > 1) {
      // A WARNING RATHER THAN AN ERROR: it is legitimate — SonarCloud has no rename, so a re-created project
      // leaves its abandoned twin behind — and the reverse lookup settles it by analysis recency. It is surfaced
      // because the alternative to a human seeing both keys is a report quietly showing one project's gate for a
      // repository that has two.
      console.warn(`${repository} is claimed by ${projects.length} projects: ${projects.join(", ")}`);
    }
  }
}

/**
 * Resolves every project the configured SonarCloud organisation lists, and stores the map.
 *
 * A COMMAND OF ITS OWN, AND NOT A STEP OF `collect`, because of what it spends: one commit search per project
 * against a quota of 30 a minute documented and 10 observed, which is 10 to 30 minutes for an organisation of
 * 315 projects. `collect` runs daily inside a window it shares with everything else; this only needs to run
 * when the projects change.
 *
 * AN ORGANISATION THAT LISTS NOTHING IS A REFUSAL rather than an empty success: the configured organisation
 * names nothing readable, and reporting `0` would leave `collect` reading an empty map as "no repository has a
 * SonarCloud project".
 */
async function runMapSonar(configuration: Configuration, argv: Arguments): Promise<number> {
  const sonarOrganization = sonarOrganizationName(configuration);
  const credentials = await resolveCredentials();
  console.info(`authenticating as ${credentials.describe()}`);
  const githubClient = createGitHubClient({ credentials });
  const token = tokenOptions();
  console.info(`resolving SonarCloud projects for ${sonarOrganization} ${token.token === undefined ? "anonymously" : "with a token"}`);

  const sonarClient = createSonarClient({ organization: sonarOrganization, ...token });
  let projects: { key: string; analysisAt?: Date }[];
  try {
    projects = await sonarClient.projects();
  } catch (error) {
    console.error(`SonarCloud's project listing failed for ${sonarOrganization}: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT_FAILED;
  }
  if (projects.length === 0) {
    console.error(`SonarCloud lists no project for organisation ${sonarOrganization}`);
    return EXIT_FAILED;
  }
  console.info(`SonarCloud lists ${projects.length} projects for ${sonarOrganization}`);

  const progress = await resolveListedProjects(sonarClient, githubClient, configuration.organization, sonarOrganization, projects, new Date());
  reportMapping(sonarOrganization, progress);
  for (const line of runSummaryLines(githubClient)) {
    console.info(line);
  }
  const status = mappingStatus(progress);
  if (status === CollectionStatus.Partial && argv.toleratePartial) {
    console.info("some projects refused, which a scheduled run reports as success; see collector.exit_status");
  }
  return collectionStatus(status, argv.toleratePartial);
}

async function runPrune(argv: Arguments): Promise<number> {
  const unusedSince = new Date(Date.now() - days(argv.days ?? 30));
  const deleted = await pruneCache(unusedSince);
  console.info(`pruned ${deleted} cached intervals unused since ${unusedSince.toISOString()}`);
  return EXIT_COMPLETE;
}

/**
 * Replaces the stored descriptions of rows cached before they were reduced, or counts what it would replace.
 *
 * A ONE-OFF, and the reason it is a command rather than a script: it needs `traceability.reference_patterns` out
 * of the reviewed configuration and the same `describedBy` a collection derives with, both of which this
 * process already resolves. `store/descriptions.ts` states why waiting for a collection to rewrite the rows
 * never works.
 *
 * DRY BY DEFAULT. Everything except the write happens without `--write` — the connection, the census, the walk
 * and the derivation of every row — so the count an operator sees is produced by the code that would do the
 * work, not by a description of it. The instructions for the rest of the operation are printed here rather than
 * written down somewhere that can go stale.
 *
 * The database is named on the way in. This is the one command that rewrites stored payloads across the whole
 * estate, and `az login` against the wrong subscription is not otherwise visible until afterwards.
 */
async function runReduceDescriptions(configuration: Configuration, argv: Arguments): Promise<number> {
  const batchSize = argv.batchSize ?? DEFAULT_BATCH_SIZE;
  progress(`reduce-descriptions ${argv.write ? "WRITING TO" : "reading"} ${describeDatabase()}, ${batchSize} rows a batch`);

  const before = await censusOfDescriptions();
  progress(describeCensus("before", before));
  if (before.carryingDescription === 0) {
    progress("nothing to do: no cached pull request still carries a description");
    return EXIT_COMPLETE;
  }

  const reduction = await reduceStoredDescriptions(referencePatterns(configuration.traceability), {
    dryRun: !argv.write,
    batchSize,
    onBatch: ({ scanned, changed }) => progress(`  derived ${scanned} of ${before.carryingDescription}${argv.write ? `, ${changed} written` : ""}`)
  });

  if (!argv.write) {
    progress(`DRY RUN: nothing was written. ${reduction.scanned} rows would be reduced.`);
    progress("to apply it, and then to make the space the descriptions held reusable:");
    progress(`  yarn cli reduce-descriptions ${argv.config.map((path) => `--config ${path}`).join(" ")} --write`);
    // Plain VACUUM, and the reason is in the flag that is absent: VACUUM FULL rewrites the table under an ACCESS
    // EXCLUSIVE lock, which every read the web pod makes would block on.
    progress("  psql \"$DATABASE_URL\" -c 'VACUUM (VERBOSE, ANALYZE) pull_request_facts'");
    return EXIT_COMPLETE;
  }

  const after = await censusOfDescriptions();
  progress(`reduced ${reduction.changed} of ${reduction.scanned} rows read`);
  progress(describeCensus("after", after));
  if (reduction.changed !== reduction.scanned) {
    // Fewer written than read means a row was deleted between the read and the update, which `prune` does. The
    // row is gone rather than damaged, so this reports the discrepancy instead of failing a run that did its job.
    progress(`${reduction.scanned - reduction.changed} rows were read but not written, which is what a concurrent prune looks like`);
  }
  if (after.unmeasurable > before.unmeasurable) {
    throw new Error(`${after.unmeasurable - before.unmeasurable} rows now hold neither a description nor a derivation, which must never happen`);
  }
  return EXIT_COMPLETE;
}

function describeCensus(when: string, census: DescriptionCensus): string {
  return `${when}: ${census.rows} cached pull requests, ${census.carryingDescription} carrying a description, ${census.derived} measurable, ${census.unmeasurable} neither`;
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
  const owners = await cohortOwners(configuration, reference);
  const repositories = argv.repository === undefined ? await cohortRepositories(configuration, reference) : [argv.repository];

  // The same seam the dashboard narrows at, so `evidence` and the pages report one cohort. `evidence` is
  // documented as printing "the same figures" the dashboard shows, and it would not be if this counted
  // Renovate's merges or Flux's commits.
  const excluded = excludedAuthors(configuration.cohort.excluded_authors);
  const bots = botAccounts(configuration.cohort.bot_accounts);

  // TWO READS FOR THE COHORT, not five per repository. This loop used to call `loadCachedMerges` and
  // `storedRepositoryState` per repository — a state lookup, two fact queries and two `accessed_at` WRITES each,
  // so printing one JSON document over 1,891 repositories cost roughly 9,455 round trips and rewrote 3,782
  // indexed coverage rows. The web path was batched for exactly this at `loadCachedFactsForOrganisation`, and
  // `deserialiseMerges` was split out of `loadCachedMerges` so both halves turn a payload into a fact the same
  // way; `evidence` is documented as reporting "the same figures" the dashboard shows, and reading them through
  // a different path is how that stops being true.
  const signatures = {
    pullRequests: sourceSignature(EvidenceSource.PullRequests),
    directCommits: sourceSignature(EvidenceSource.DirectCommits)
  };
  const [cached, states] = await Promise.all([
    loadCachedFactsForOrganisation(organization, signatures, window.startsAt, window.endsAt),
    storedRepositoryStates(organization)
  ]);

  const rows = [];
  for (const repository of repositories) {
    const facts = cached.get(repository);
    const payloads = {
      pullRequests: (facts?.pullRequests ?? []).map((fact) => fact.payload),
      directCommits: (facts?.directCommits ?? []).map((fact) => fact.payload)
    };
    const merges = reportedCohort(deserialiseMerges(payloads), excluded, bots).merges;
    const gate = readStoredGate(states.get(repository)?.payload);
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
    if (COHORT_COMMANDS.has(parsed.command)) {
      await assertCohortCollected(configuration, parsed.command);
    }
    switch (parsed.command) {
      // BOTH COLLECTORS TAKE THE SAME LOCK, so exactly one of them writes the database whatever the deployment
      // topology is. AAT runs this application on two clusters against one database and one App installation;
      // see `collector-lock.ts` for what two concurrent collectors do to each other. `--propose-teams` is not
      // excluded from the lock even though it writes nothing: it makes the same GitHub calls, so it would still
      // be competing for the rate-limit budget a real run needs.
      //
      // `prune` TAKES IT TOO, for a different reason: it is the only command that DELETES, and a hand-run prune
      // interleaved with a collection is what turns a cache eviction into data loss. Under the lock it stands
      // down instead of deleting rows a collection is midway through writing, and the operator is told so.
      case "collect":
        return await onlyCollector(parsed.command, () => runCollect(configuration, parsed));
      case "collect-org":
        return await onlyCollector(parsed.command, () => runCollectOrg(configuration, parsed));
      // UNDER THE LOCK for a reason neither collector's applies: this is the one command whose cost is a
      // per-minute quota rather than an hourly one. Both AAT clusters run the same schedule, so without the lock
      // both would resolve the same 315 projects at once, each pacing off a budget the other is also spending —
      // which is slower than one run and writes the same rows twice.
      case "map-sonar":
        return await onlyCollector(parsed.command, () => runMapSonar(configuration, parsed));
      case "doctor":
        return await runDoctor(configuration, parsed);
      case "prune":
        return await onlyCollector(parsed.command, () => runPrune(parsed));
      case "evidence":
        return await runEvidence(configuration, parsed);
      // NOT under the collector lock, unlike `prune`, and `store/descriptions.ts` sets out why: each row's update
      // derives from that row's current payload, so a collection writing the same row concurrently keeps
      // everything it wrote. Standing down would also be the wrong answer for a hand-run one-off — it would exit
      // 0 having done nothing, which reads as "already reduced".
      case "reduce-descriptions":
        return await runReduceDescriptions(configuration, parsed);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return error instanceof UsageError ? EXIT_USAGE : EXIT_FAILED;
  } finally {
    await prisma.$disconnect();
  }
}
