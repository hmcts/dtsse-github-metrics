import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { AvailabilityReason, GitHubError } from "../evidence/domain/availability.ts";
import { CohortUncollectedError } from "../evidence/org/cohort.ts";
import { SonarError } from "../evidence/sonar/client.ts";
import { EXIT_COMPLETE, EXIT_FAILED, EXIT_INCOMPLETE, EXIT_USAGE } from "./exit-status.ts";

const migrate = vi.hoisted(() => vi.fn<() => Promise<string[]>>());
const loadConfiguration = vi.hoisted(() => vi.fn());
const cohortRepositories = vi.hoisted(() => vi.fn());
// What `collect` walks, as the entries carrying `behaviourCollectable`. Stubbed here rather than derived, so a
// case can state a stale repository beside a fresh one without also stating a `pushedAt` and a policy.
const readCohort = vi.hoisted(() => vi.fn());
// The `authoring-team` rung's input. Stubbed EMPTY by default, which is the honest default for these cases: an
// empty fact cache means the rung declines and the access rungs decide, so a fixture that says nothing about
// authorship is attributed exactly as it was before the rung existed. The cases that are about the rung live in
// `org/ownership.test.ts`, against the real ladder.
const authorshipForOrganisation = vi.hoisted(() => vi.fn(async () => new Map<string, Map<string, number>>()));
// What `evidence` reports the estate from: one read of every repository's cached facts, and one of their stored
// states. Empty by default, so a case that is not about `evidence` states neither.
const loadCachedFactsForOrganisation = vi.hoisted(() => vi.fn(async () => new Map<string, { pullRequests: unknown[]; directCommits: unknown[] }>()));
const storedRepositoryStates = vi.hoisted(() => vi.fn(async () => new Map<string, { fetchedAt: Date; payload: unknown }>()));
const prevailingCachedCoverage = vi.hoisted(() => vi.fn(async (): Promise<Date | undefined> => undefined));
// Stubbed because it reaches Postgres, and a `vi.fn()` rather than an arrow so one case can let the merge walk it
// wraps actually run — which is the only way to see what the collector was handed.
const fillCachedSource = vi.hoisted(() => vi.fn(async (..._unused: unknown[]) => []));
const collectionState = vi.hoisted(() => vi.fn());
// Named rather than an anonymous `vi.fn()` in the mock factory, so a case can assert that a collection was
// STAMPED. Reports are held per `collection_state.revision` and invalidated by nothing else, so a run that writes
// rows without stamping has collected evidence no reader sees until the next day's `collect`.
const stampCollection = vi.hoisted(() => vi.fn());
// The CVE collection's Cosmos seam. `undefined` credentials by default is not a convenience: it is the shape a
// pod with no secret mounted has, and the case that asserts nothing is written depends on it.
const cveCredentials = vi.hoisted(() => vi.fn<() => { endpoint: string; key: string } | undefined>(() => undefined));
const readCveDocuments = vi.hoisted(() => vi.fn());
const cveWatermarks = vi.hoisted(() => vi.fn(async () => new Map<string, Date>()));
const recordCveScans = vi.hoisted(() => vi.fn(async (_scans: { findings: unknown[] }[]) => ({ written: 0, superseded: 0, findings: 0 })));
const resolveCredentials = vi.hoisted(() => vi.fn());
const createGitHubClient = vi.hoisted(() => vi.fn());
const stampRevision = vi.hoisted(() => vi.fn());
// Granted by default so the collect cases test orchestration, and overridable so the stand-down branch — the
// one that fires on whichever cluster loses the lock, every day — is reachable without a database.
const asSoleCollector = vi.hoisted(() => vi.fn(async (run: () => Promise<unknown>) => run()));
// The delete itself, stubbed so the cases below are about WHETHER it is reached. It is the only destructive
// thing this CLI does, and the whole question about it is whether a collector holding the lock stops it.
const pruneCache = vi.hoisted(() => vi.fn(async () => 0));

// The one-off backfill's two store calls, stubbed at the AAT numbers so the cases below are about what the
// command does with them. What the SQL itself does to a real table is asserted in
// `test/integration/reduce-descriptions.test.ts`.
const censusOfDescriptions = vi.hoisted(() => vi.fn(async () => ({ rows: 24_249, carryingDescription: 23_854, derived: 395, unmeasurable: 0 })));
const reduceStoredDescriptions = vi.hoisted(() => vi.fn(async () => ({ scanned: 23_854, changed: 23_854 })));

const collectOrgTeams = vi.hoisted(() => vi.fn());
const collectOrgRepositories = vi.hoisted(() => vi.fn());
const collectOrgPeople = vi.hoisted(() => vi.fn());
const collectCodeowners = vi.hoisted(() => vi.fn());
const collectDirectAdmins = vi.hoisted(() => vi.fn());
const collectSsoIdentities = vi.hoisted(() => vi.fn());
const storedDisplayNames = vi.hoisted(() => vi.fn());

const recordOrgTeams = vi.hoisted(() => vi.fn());
const recordOrgTeamMemberships = vi.hoisted(() => vi.fn());
const recordOrgTeamRepositories = vi.hoisted(() => vi.fn());
const recordOrgRepositories = vi.hoisted(() => vi.fn());
const recordOrgPeople = vi.hoisted(() => vi.fn());
const recordRepositoryOwnership = vi.hoisted(() => vi.fn());
const recordRepositoryState = vi.hoisted(() => vi.fn());
// The one statement that gives each live repository a row somebody can tick. Stubbed because it is raw SQL against
// Postgres and `prisma` here is a bare `$disconnect`; what these cases can still say is that `collect-org` reaches
// it. Whether the statement itself leaves a person's flag alone is asserted against a real database, in
// `test/integration/production-override.test.ts`.
const seedProduction = vi.hoisted(() => vi.fn(async () => 0));

// The durable SonarCloud map: what `collect` reads and what `map-sonar` writes. Stubbed because it reaches
// Postgres, and EMPTY by default — which is the honest default for a case that says nothing about SonarCloud,
// since an empty map is a deployment where `map-sonar` has not run. Whether the writer honours the table's
// attribution-or-negative constraint is asserted against a real database, in test/integration/sonar-map.test.ts.
const storedSonarMappings = vi.hoisted(() => vi.fn(async (): Promise<unknown[]> => []));
const recordSonarMapping = vi.hoisted(() => vi.fn(async (_organization: string, _answer: { mapping?: unknown; detail?: string }) => true));
// SonarCloud itself. Stubbed at the module rather than at `fetch`, because these cases are about what the
// commands do with a project listing and a measures read; what the client makes of a real response is asserted in
// `evidence/sonar/sonar.test.ts` against fetch.
const createSonarClient = vi.hoisted(() => vi.fn());

vi.mock("../evidence/store/migrate.ts", () => ({ migrate }));
vi.mock("../evidence/store/prisma.ts", () => ({ prisma: { $disconnect: vi.fn().mockResolvedValue(undefined) } }));
// Stubbed to ALWAYS grant, so these cases test the orchestration rather than the lock. `collector-lock.ts` opens
// its own `pg.Client` — it has to, because a session-scoped advisory lock lives on the connection that took it —
// so leaving it real would make the unit suite need a database. It briefly did: these tests passed locally with
// Postgres running and failed every one of them in CI, which is the whole reason the lock is exercised against a
// real database in `test/integration/collector-lock.test.ts` and mocked out here.
vi.mock("../evidence/store/collector-lock.ts", () => ({
  asSoleCollector,
  takeCollectorLock: async () => ({ held: true, release: async () => undefined })
}));
vi.mock("../evidence/policy/load.ts", () => ({ loadConfiguration }));
// Only `configuredTeamSlugs` is stubbed; the rest is real, `sonarOrganizationName` included — it is the fallback
// from the GitHub organisation to the SonarCloud one, and a faked one would make the cases that read the map's
// organisation key assert a restatement of the fixture.
vi.mock("../evidence/policy/repositories.ts", async () => ({
  ...(await vi.importActual<typeof import("../evidence/policy/repositories.ts")>("../evidence/policy/repositories.ts")),
  configuredTeamSlugs: () => new Map()
}));
// The cohort comes from the graph now, so this is where the estate is stubbed. `CohortUncollectedError` is
// re-exported real rather than faked: `doctor` branches on `instanceof`, and a stubbed class would make that
// branch untestable.
vi.mock("../evidence/org/cohort.ts", async () => ({
  ...(await vi.importActual<typeof import("../evidence/org/cohort.ts")>("../evidence/org/cohort.ts")),
  cohortRepositories,
  cohortOwners: async () => new Map(),
  readCohort
}));
// The two batched readers `evidence` reports the estate through, and the seam its cases are written at: they are
// what a repository's figures come FROM, so stubbing them is how a cohort with known merges is stated without a
// database. One call each per run is part of what the cases assert, which is why they are `vi.fn()`s.
vi.mock("../evidence/store/facts.ts", () => ({
  authorshipForOrganisation,
  loadCachedFactsForOrganisation,
  storedRepositoryStates
}));
// Only `prevailingCachedCoverage` is stubbed, and only because it is what `evidence` anchors its window on and it
// reaches Postgres. The rest of the module is re-exported real: `fillCachedSource` is stubbed below, so nothing
// else here calls into it, and a wholesale fake would be three more exports to keep in step for no reader.
vi.mock("../evidence/store/coverage.ts", async () => ({
  ...(await vi.importActual<typeof import("../evidence/store/coverage.ts")>("../evidence/store/coverage.ts")),
  prevailingCachedCoverage
}));
vi.mock("../evidence/store/prune.ts", () => ({ pruneCache }));
vi.mock("../evidence/store/descriptions.ts", () => ({ censusOfDescriptions, reduceStoredDescriptions, DEFAULT_BATCH_SIZE: 500 }));
// The per-repository writers `collect` ends each repository with. Stubbed because they reach Postgres and
// `prisma` here is a bare `$disconnect` — left real, the FIRST repository throws a TypeError out of the walk and
// the run ends, which silently makes any assertion about which repositories were walked true of a loop that
// only ever ran once. Found exactly that way.
vi.mock("../evidence/store/repository-state.ts", () => ({ recordRepositoryState, storedRepositoryState: async () => undefined }));
// `fillCachedSource` and the two writers are stubbed because they reach Postgres. `deserialiseMerges` is
// re-exported REAL for the reason the ownership ladder is: it is the step that turns a stored payload into the
// fact `evidence` counts, so a faked one would leave "the batched read reports the same merges the dashboard
// does" asserted against a restatement of itself.
vi.mock("../evidence/behaviour/fill.ts", async () => ({
  ...(await vi.importActual<typeof import("../evidence/behaviour/fill.ts")>("../evidence/behaviour/fill.ts")),
  fillCachedSource,
  requestedCoverage: () => ({}),
  pullRequestCacheWriter: () => undefined,
  directCommitCacheWriter: () => undefined
}));
vi.mock("../evidence/store/collection-state.ts", () => ({ collectionState, stampCollection, stampRevision }));
// The CVE collection's two seams: what Cosmos answered, and what was written. `cve/collect.ts` is deliberately
// NOT mocked — the fold is pure, so these cases exercise the real one and say what the command does with it.
vi.mock("../evidence/cve/cosmos.ts", () => ({ readCveDocuments }));
vi.mock("../evidence/cve/credentials.ts", async () => ({
  ...(await vi.importActual<typeof import("../evidence/cve/credentials.ts")>("../evidence/cve/credentials.ts")),
  cveCredentials
}));
vi.mock("../evidence/store/cve.ts", () => ({ cveWatermarks, recordCveScans }));
vi.mock("../evidence/github/credentials.ts", () => ({ resolveCredentials }));
vi.mock("../evidence/github/client.ts", () => ({ createGitHubClient }));
// The walks and the writers are the two seams `collect-org` is tested at: the walks say what the organisation
// answered and how completely, and the writers are where a run that saw less than the whole thing does its damage.
// The resolution ladder in between is deliberately REAL, so these tests exercise the attribution the writers are
// handed rather than a restatement of it.
vi.mock("../evidence/org/collect.ts", () => ({ collectOrgTeams, collectOrgRepositories, collectOrgPeople, collectCodeowners, collectDirectAdmins }));
// `namedPeople` is re-exported real for the reason the ladder is: it is the join whose result the writer acts on, so
// a faked one would leave "the resolved name reached the store" asserted against a restatement of itself.
vi.mock("../evidence/org/identities.ts", async () => ({
  ...(await vi.importActual<typeof import("../evidence/org/identities.ts")>("../evidence/org/identities.ts")),
  collectSsoIdentities
}));
vi.mock("../evidence/org/people.ts", () => ({ storedDisplayNames }));
vi.mock("../evidence/store/org-graph.ts", () => ({
  recordOrgTeams,
  recordOrgTeamMemberships,
  recordOrgTeamRepositories,
  recordOrgRepositories,
  recordOrgPeople,
  recordRepositoryOwnership
}));
vi.mock("../evidence/store/production-override.ts", () => ({ seedProduction }));
vi.mock("../evidence/store/sonar-map.ts", () => ({ storedSonarMappings, recordSonarMapping }));
// Only the PACER is replaced, and only because it is the one piece of this layer that spends wall-clock time:
// spacing the commit search to a per-minute quota is what makes a real run take 10 to 30 minutes, and a suite
// that honoured it would sleep two seconds between the searches these cases make. What the pacer itself does is
// asserted against an injected clock in `evidence/sonar/sonar.test.ts`; the rest of `attribute.ts` is real here,
// because which projects a run pays for is exactly what these cases are about.
vi.mock("../evidence/sonar/attribute.ts", async () => ({
  ...(await vi.importActual<typeof import("../evidence/sonar/attribute.ts")>("../evidence/sonar/attribute.ts")),
  searchPacer: () => ({ spacing: () => 0, wait: async () => undefined })
}));
// `SonarError` and `sonarToken` are re-exported REAL: the first is what the command branches on to tell a project
// that is not there from a read that was refused, and a faked class would make that branch untestable.
vi.mock("../evidence/sonar/client.ts", async () => ({
  ...(await vi.importActual<typeof import("../evidence/sonar/client.ts")>("../evidence/sonar/client.ts")),
  createSonarClient
}));

const { DOCTOR_SAMPLE_SIZE, doctorSample, main } = await import("./index.ts");

/** One cohort entry, defaulting to a repository behaviour IS collected for — the ordinary case. */
function cohortEntry(repository: string, overrides: Record<string, unknown> = {}) {
  return {
    repository,
    owners: ["team"],
    ownerKind: "team",
    archived: false,
    visibility: "public",
    behaviourCollectable: true,
    unmaintained: false,
    ...overrides
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // `clearAllMocks` clears the CALLS and not the implementations, so anything a case replaces has to be put back
  // here or it leaks into every case after it. Two below do: one lets `fillCachedSource` run the merge walk it
  // wraps, and the `evidence` cases state a cached estate.
  fillCachedSource.mockImplementation(async () => []);
  loadCachedFactsForOrganisation.mockResolvedValue(new Map());
  storedRepositoryStates.mockResolvedValue(new Map());
  prevailingCachedCoverage.mockResolvedValue(undefined);
  // A one-repository estate by default, so the cases that are not about the cohort do not have to state one.
  // `assertCohortCollected` calls this too, so it must always resolve.
  readCohort.mockResolvedValue([cohortEntry("repo-a")]);
  storedSonarMappings.mockResolvedValue([]);
  recordSonarMapping.mockResolvedValue(true);
  censusOfDescriptions.mockResolvedValue({ rows: 24_249, carryingDescription: 23_854, derived: 395, unmeasurable: 0 });
  reduceStoredDescriptions.mockResolvedValue({ scanned: 23_854, changed: 23_854 });
  // Put back for the reason above: `clearAllMocks` keeps the implementations, but several CVE cases replace these.
  cveCredentials.mockReturnValue(undefined);
  cveWatermarks.mockResolvedValue(new Map());
  recordCveScans.mockResolvedValue({ written: 0, superseded: 0, findings: 0 });
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  // `map-sonar` reports a project it could not put the question for at error level, which is the level a refusal
  // belongs at and not one the suite should print.
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "debug").mockImplementation(() => undefined);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

describe("main", () => {
  it("should apply pending migrations and report which ones it applied", async () => {
    migrate.mockResolvedValue(["20260905062029_init"]);

    expect(await main(["migrate"])).toBe(EXIT_COMPLETE);
    expect(migrate).toHaveBeenCalledOnce();
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining("20260905062029_init"));
  });

  it("should say the schema is up to date when there was nothing to apply", async () => {
    migrate.mockResolvedValue([]);

    expect(await main(["migrate"])).toBe(EXIT_COMPLETE);
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining("already up to date"));
  });

  it("should migrate without reading a policy", async () => {
    migrate.mockResolvedValue([]);

    await main(["migrate"]);

    expect(loadConfiguration).not.toHaveBeenCalled();
  });

  it("should fail with the migration's own message when one does not apply", async () => {
    migrate.mockRejectedValue(new Error("migration 20260905062029_init failed: relation already exists"));

    expect(await main(["migrate"])).toBe(EXIT_FAILED);
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining("relation already exists"));
  });

  it("should refuse an unknown command before it reaches any of them", async () => {
    expect(await main(["invent"])).toBe(EXIT_USAGE);
    expect(migrate).not.toHaveBeenCalled();
  });

  it("should refuse a command that needs a configuration without one", async () => {
    expect(await main(["collect"])).toBe(EXIT_USAGE);
    expect(loadConfiguration).not.toHaveBeenCalled();
  });
});

describe("doctor", () => {
  const CONFIG = {
    organization: "hmcts",
    lookback: { operational_days: 90 },
    teams: [{ identifier: "team", repositories: ["repo-a", "repo-b"] }]
  };

  /** The client `doctor` drives, reporting how many merged pull requests each repository answered with. */
  let graphql: MockInstance;

  function withMergeCounts(perRepository: number[], repositories = ["repo-a", "repo-b"]) {
    loadConfiguration.mockResolvedValue(CONFIG);
    readCohort.mockResolvedValue(repositories.map((repository) => cohortEntry(repository)));
    collectionState.mockResolvedValue(undefined);
    resolveCredentials.mockResolvedValue({ token: async () => "t", describe: () => "a personal access token" });

    const counts = [...perRepository];
    graphql = vi.fn().mockImplementation(() => Promise.resolve({ repository: { pullRequests: { totalCount: counts.shift() ?? 0 } } }));
    createGitHubClient.mockReturnValue({
      get: vi.fn().mockResolvedValue({ default_branch: "master" }),
      graphql,
      requestsIssued: () => 0,
      callOutcomes: () => []
    });
  }

  it("should diagnose an uncollected graph rather than crashing on it", async () => {
    // The one state `doctor` must survive: it is the command somebody runs against a database they are unsure
    // about, so an empty graph is a finding to report, not an exception to raise.
    withMergeCounts([12, 30]);
    readCohort.mockRejectedValue(new CohortUncollectedError("no organisation graph has been collected for hmcts"));

    await main(["doctor", "--config", "m.yaml"]);

    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("no organisation graph has been collected"));
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining("0 of 0 readable"));
  });

  it("should pass when the credential can see merged pull requests", async () => {
    withMergeCounts([12, 30]);

    expect(await main(["doctor", "--config", "m.yaml"])).toBe(EXIT_COMPLETE);
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining("merged pull requests in 2 of the 2 read"));
  });

  it("should read a SAMPLE of the cohort rather than all of it", async () => {
    // The whole point of the change. Reading the entire cohort cost one metadata call and one full merge walk —
    // the heaviest document here — per repository, roughly 3,800 calls, for two questions about the credential.
    withMergeCounts(
      Array.from({ length: 200 }, () => 3),
      Array.from({ length: 200 }, (_unused, at) => `repo-${at}`)
    );

    expect(await main(["doctor", "--config", "m.yaml"])).toBe(EXIT_COMPLETE);
    expect(graphql).toHaveBeenCalledTimes(DOCTOR_SAMPLE_SIZE);
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining(`${DOCTOR_SAMPLE_SIZE} of 200 cohort repositories, sampled across owners`));
  });

  it("should say it sampled, and how to widen it, rather than implying a sweep", async () => {
    withMergeCounts(
      Array.from({ length: 50 }, () => 3),
      Array.from({ length: 50 }, (_unused, at) => `repo-${at}`)
    );

    await main(["doctor", "--config", "m.yaml"]);

    expect(console.info).toHaveBeenCalledWith(expect.stringContaining("--all reads every cohort repository"));
  });

  it("should read every cohort repository on --all", async () => {
    withMergeCounts(
      Array.from({ length: 40 }, () => 3),
      Array.from({ length: 40 }, (_unused, at) => `repo-${at}`)
    );

    expect(await main(["doctor", "--config", "m.yaml", "--all"])).toBe(EXIT_COMPLETE);
    expect(graphql).toHaveBeenCalledTimes(40);
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining("all 40 cohort repositories"));
  });

  it("should ask the cheap count query rather than the merge walk", async () => {
    // `MergedPullRequests` is 25 pull requests with up to 50 reviews and 50 rollup contexts each. The question is
    // whether the credential can see any at all, and `totalCount` answers it in one node.
    withMergeCounts([3]);

    await main(["doctor", "--config", "m.yaml"]);

    expect(String(graphql.mock.calls[0]?.[0])).toContain("MergedPullRequestCount");
    expect(String(graphql.mock.calls[0]?.[0])).toContain("totalCount");
  });

  it("should fail when every repository is readable but none yields a merge", async () => {
    // The exact shape of the AAT failure: metadata reads fine, pull requests come back empty, and a collection
    // would record zero merges without anything reporting an error.
    withMergeCounts([0, 0]);

    expect(await main(["doctor", "--config", "m.yaml"])).toBe(EXIT_FAILED);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("would record none"));
  });

  it("should name the installation when it fails, since that is the usual cause", async () => {
    withMergeCounts([0, 0]);

    await main(["doctor", "--config", "m.yaml"]);

    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("pending approval"));
  });

  it("should still pass when only one repository has merges", async () => {
    withMergeCounts([0, 5]);

    expect(await main(["doctor", "--config", "m.yaml"])).toBe(EXIT_COMPLETE);
  });

  it("should read a repository GitHub reported no count for as having none", async () => {
    // An answer with no `totalCount` is not a repository with merges, and reading it as one would hide exactly
    // the fault this check exists for.
    loadConfiguration.mockResolvedValue(CONFIG);
    readCohort.mockResolvedValue([cohortEntry("repo-a")]);
    collectionState.mockResolvedValue(undefined);
    resolveCredentials.mockResolvedValue({ token: async () => "t", describe: () => "a token" });
    createGitHubClient.mockReturnValue({
      get: vi.fn().mockResolvedValue({ default_branch: "master" }),
      graphql: vi.fn().mockResolvedValue({ repository: { pullRequests: {} } }),
      requestsIssued: () => 0,
      callOutcomes: () => []
    });

    expect(await main(["doctor", "--config", "m.yaml"])).toBe(EXIT_FAILED);
  });

  it("should read a repository with no merged pull requests at all as a finding", async () => {
    // Every repository readable and none answering with a merge is the exact shape of the AAT failure: a
    // collection would record zero merges without anything reporting an error.
    withMergeCounts([0], ["repo-a"]);

    expect(await main(["doctor", "--config", "m.yaml"])).toBe(EXIT_FAILED);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("no merged pull requests at all"));
  });

  it("should treat a query that throws as no merges rather than crashing the command", async () => {
    loadConfiguration.mockResolvedValue(CONFIG);
    readCohort.mockResolvedValue([cohortEntry("repo-a")]);
    collectionState.mockResolvedValue(undefined);
    resolveCredentials.mockResolvedValue({ token: async () => "t", describe: () => "a token" });
    createGitHubClient.mockReturnValue({
      get: vi.fn().mockResolvedValue({ default_branch: "master" }),
      graphql: vi.fn().mockRejectedValue(new Error("GraphQL refused")),
      requestsIssued: () => 0,
      callOutcomes: () => []
    });

    expect(await main(["doctor", "--config", "m.yaml"])).toBe(EXIT_FAILED);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("reading merged pull requests failed: GraphQL refused"));
  });
});

describe("doctorSample", () => {
  /** Owners for repositories named `<owner>-<n>`, so a case can state a lopsided estate in one line. */
  function estate(perOwner: Record<string, number>): { repositories: string[]; owners: Map<string, string[]> } {
    const repositories: string[] = [];
    const owners = new Map<string, string[]>();
    for (const [owner, held] of Object.entries(perOwner)) {
      for (let at = 0; at < held; at += 1) {
        const repository = `${owner}-${String(at).padStart(3, "0")}`;
        repositories.push(repository);
        owners.set(repository, [owner]);
      }
    }
    return { repositories, owners };
  }

  it("should take at most the size it was asked for", () => {
    const { repositories, owners } = estate({ alpha: 100, beta: 100 });

    expect(doctorSample(repositories, owners, 30)).toHaveLength(30);
  });

  it("should spread across owners rather than taking one owner's first thirty", () => {
    // The interesting permission faults follow ownership: an installation that lost a permission, or a team whose
    // repositories are internal where the rest are public, shows up in one owner's repositories and not another's.
    const { repositories, owners } = estate({ alpha: 100, beta: 100, gamma: 100 });

    const sampled = doctorSample(repositories, owners, 30);

    expect(new Set(sampled.map((repository) => repository.split("-")[0])).size).toBe(3);
  });

  it("should give the same answer twice, so a fault that comes and goes is a fault", () => {
    const { repositories, owners } = estate({ alpha: 40, beta: 40 });

    expect(doctorSample(repositories, owners, 30)).toEqual(doctorSample(repositories, owners, 30));
  });

  it("should return the whole cohort when it is smaller than the sample", () => {
    const { repositories, owners } = estate({ alpha: 4 });

    expect(doctorSample(repositories, owners, 30)).toHaveLength(4);
  });

  it("should sample a repository nobody owns, which is a normal outcome here", () => {
    // `unowned` is a real bucket rather than a gap, and a permission fault does not care who is on the hook.
    const sampled = doctorSample(["orphan"], new Map([["orphan", []]]), 30);

    expect(sampled).toEqual(["orphan"]);
  });

  it("should name a repository once even where several owners hold it", () => {
    const sampled = doctorSample(["shared"], new Map([["shared", ["alpha", "beta"]]]), 30);

    expect(sampled).toEqual(["shared"]);
  });

  it("should ask for nothing from an empty cohort", () => {
    expect(doctorSample([], new Map(), 30)).toEqual([]);
  });
});

/**
 * What `collect` walks, which from 2026-09-14 is NOT the whole estate.
 *
 * The activity window stopped deciding cohort membership so that stale repositories could be reported against
 * the assurance criteria — see `CohortPolicy`. That widened the estate from roughly 1,230 repositories to 1,880,
 * and the merge walks are the largest remaining share of a run's calls, so this is the seam where that either
 * costs nothing or costs 50%.
 */
describe("what collect walks", () => {
  const CONFIG = {
    organization: "hmcts",
    lookback: { operational_days: 90, mutable_hours: 6 },
    teams: [],
    cohort: { excluded_authors: [] },
    production_list_url: null,
    assessment: { enabled: false },
    org_graph: { enabled: true },
    sonar_projects: {}
  };

  /**
   * A collect run over one fresh and one stale repository, reporting every REST path it asked for.
   *
   * `listed` is what the organisation's own repository listing names, because that is where the estate's
   * metadata now comes from: a repository in it costs no call of its own, and one absent from it falls back to
   * the per-repository read. Both are named by default, which is the ordinary case.
   */
  async function pathsAskedFor(options: { listed?: string[]; argv?: string[]; refusing?: string[] } = {}): Promise<string[]> {
    loadConfiguration.mockResolvedValue(CONFIG);
    readCohort.mockResolvedValue([cohortEntry("fresh"), cohortEntry("stale", { behaviourCollectable: false, unmaintained: true })]);
    resolveCredentials.mockResolvedValue({ token: async () => "t", describe: () => "a token" });
    const get = vi.fn().mockResolvedValue({ default_branch: "main" });
    const paths: string[] = [];
    const listed = (options.listed ?? ["fresh", "stale"]).map((name) => ({ name, default_branch: "main" }));
    createGitHubClient.mockReturnValue({
      get,
      graphql: vi.fn().mockResolvedValue({}),
      paginate: function paginate(path: string) {
        paths.push(String(path));
        return (async function* pages() {
          if (options.refusing?.includes(path) === true) {
            throw new Error("Resource not accessible by integration");
          }
          yield path === "/orgs/hmcts/repos" ? listed : [];
        })();
      },
      requestsIssued: () => 1,
      callOutcomes: () => [],
      rateLimitWaits: () => []
    });

    await main(options.argv ?? ["collect", "--config", "m.yaml", "--tolerate-partial"]);
    return [...get.mock.calls.map(([path]) => String(path)), ...paths];
  }

  it("should read every repository in the estate, stale ones included, so the assurance columns are populated", async () => {
    // The other half of the change: a stale repository must still be COLLECTED, or the criteria it exists to be
    // judged against have nothing to read. 148 unarchived repositories on AAT are two or more years stale, and
    // not one of them had a `repository_state` row before this. Asserted on the stored state rather than on a
    // call, because every per-repository read either depth used to make is now an estate-wide one.
    await pathsAskedFor();

    expect(recordRepositoryState.mock.calls.map(([, repository]) => repository)).toEqual(["fresh", "stale"]);
  });

  it("should read the estate's metadata as ONE org listing rather than one call per repository", async () => {
    // 1,889 `GET /repos/{o}/{r}` calls against about 19 pages. `collect-org` already stores the default branch,
    // so `security_and_analysis` was the only thing that read still bought — and the org listing carries it.
    const asked = await pathsAskedFor();

    expect(asked).toContain("/orgs/hmcts/repos");
    expect(asked.filter((path) => /^\/repos\/hmcts\/[^/]+$/.test(path))).toEqual([]);
  });

  it("should fall back to a repository's own metadata when the organisation does not list it", async () => {
    // A repository in the collected graph that the organisation no longer lists has been renamed, transferred or
    // deleted since `collect-org` ran. It still gets collected, at the cost it always had, and it is named.
    const asked = await pathsAskedFor({ listed: ["fresh"] });

    expect(asked.filter((path) => /^\/repos\/hmcts\/[^/]+$/.test(path))).toEqual(["/repos/hmcts/stale"]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("1 collected repository is not in the organisation's listing"));
  });

  it("should read one repository directly when it was asked for by name", async () => {
    // Paging 19 pages of an organisation to find one repository costs more than reading it, so `--repository`
    // keeps the read it always had.
    const asked = await pathsAskedFor({ argv: ["collect", "--config", "m.yaml", "--repository", "fresh", "--tolerate-partial"] });

    expect(asked).not.toContain("/orgs/hmcts/repos");
    expect(asked.filter((path) => /^\/repos\/hmcts\/[^/]+$/.test(path))).toEqual(["/repos/hmcts/fresh"]);
  });

  it("should not read a stale repository's merge gate, which is ways-of-working rather than assurance", async () => {
    // THE QUOTA GUARANTEE, read at a seam that actually costs: the gate is several requests per repository, and a
    // repository nobody has pushed to in two years has no current practice to report. Asserted here rather than
    // on the merge walk because `fillCachedSource` is stubbed in this file, so the gate is the deep-path call
    // this test can see.
    const asked = await pathsAskedFor();

    expect(asked.filter((path) => path.includes("/branches/") || path.includes("/rules/"))).toEqual([
      "/repos/hmcts/fresh/branches/main/protection",
      "/repos/hmcts/fresh/rules/branches/main"
    ]);
  });

  it("should hand the merge walk the traceability policy the configuration states", async () => {
    // THE WIRE THIS COMMAND IS THE ONLY OWNER OF. A pull request's description is no longer stored: the walk
    // reduces it to `bodyLength` and `hasTicketReference` as the fact is built, and `reference_patterns` reaches
    // that reduction from here and nowhere else. Passed an empty policy the walk would still succeed and every
    // merge in the estate would read as referencing nothing — a plausible zero, and invisible.
    //
    // Asserted by letting the stubbed `fillCachedSource` RUN the collect callback it is handed, which is the only
    // way to see what the collector was given: the callback is where the policy is applied.
    loadConfiguration.mockResolvedValue({ ...CONFIG, traceability: { minimum_description: 30, reference_patterns: ["GH-\\d+"] } });
    readCohort.mockResolvedValue([cohortEntry("fresh")]);
    resolveCredentials.mockResolvedValue({ token: async () => "t", describe: () => "a token" });
    createGitHubClient.mockReturnValue({
      get: vi.fn().mockResolvedValue({ default_branch: "main" }),
      graphql: vi.fn().mockResolvedValue({
        repository: {
          pullRequests: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                databaseId: 101,
                number: 11,
                title: "closes GH-91",
                body: "a description long enough to count",
                createdAt: "2026-08-01T00:00:00Z",
                mergedAt: "2026-08-02T00:00:00Z",
                updatedAt: "2026-08-02T00:00:00Z",
                isDraft: false,
                timelineItems: { nodes: [] },
                author: { login: "alice", __typename: "User" },
                reviews: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
                commits: { nodes: [{ commit: { statusCheckRollup: null } }] }
              }
            ]
          }
        }
      }),
      paginate: () =>
        (async function* pages() {
          yield [];
        })(),
      requestsIssued: () => 1,
      callOutcomes: () => []
    });

    const walked: unknown[] = [];
    fillCachedSource.mockImplementation(async (...args: unknown[]) => {
      const collect = args[2] as (startsAt: Date, endsAt: Date) => Promise<unknown[]>;
      walked.push(...(await collect(new Date("2026-08-01T00:00:00Z"), new Date("2026-08-31T00:00:00Z"))));
      return [];
    });

    await main(["collect", "--config", "m.yaml", "--tolerate-partial"]);

    // The pull-request walk built a fact carrying the two derived answers and neither the title nor the body, and
    // `GH-91` only matches because the configured pattern reached it — the shipped defaults do not match it.
    expect(walked.filter((fact) => typeof fact === "object" && fact !== null && "identifier" in fact)).toEqual([
      expect.objectContaining({ identifier: 101, bodyLength: 34, hasTicketReference: true })
    ]);
    expect(walked[0]).not.toHaveProperty("body");
  });

  it("should read the estate's Dependabot alerts ONCE for the whole organisation, and never per repository", async () => {
    // Item 3 of the cost review: 1,889 per-repository reads become a few dozen pages. The read serves BOTH
    // purposes it always did — the patching age needs each alert's `created_at` and the security block needs the
    // family counted by severity — so this must not reintroduce a second read for either.
    const asked = await pathsAskedFor();

    expect(asked.filter((path) => path.includes("dependabot/alerts"))).toEqual(["/orgs/hmcts/dependabot/alerts"]);
  });

  it("should never read secret-scanning alerts per repository, which duplicated the estate-wide read", async () => {
    // Item 4, and a contradiction the codebase already carried: `assurance.ts` states the per-repository endpoint
    // "is deliberately not used: 1,880 calls against one" while `security-alerts.ts` called it once per walked
    // repository. Two readings of one fact at 1,240 times the cost, which could disagree.
    const asked = await pathsAskedFor();

    expect(asked.filter((path) => path.includes("secret-scanning/alerts"))).toEqual(["/orgs/hmcts/secret-scanning/alerts"]);
  });

  it("should still read code scanning per repository, and only for the ones it walks", async () => {
    // Kept per-repository deliberately: the organisation endpoint names only repositories the feature is on for,
    // and nothing collected says whether code scanning is enabled — so an absence could not be told from a
    // repository that never turned it on. Those calls buy that distinction.
    const asked = await pathsAskedFor();

    expect(asked.filter((path) => path.includes("code-scanning/alerts"))).toEqual(["/repos/hmcts/fresh/code-scanning/alerts"]);
  });

  it("should count a refused estate-wide alert read ONCE, and report every repository as unmeasured", async () => {
    // One call for the whole estate, so one failure. Inflating it to 1,889 would swamp the exit status with one
    // refusal — and every repository's Dependabot answer must read as unmeasured rather than as clean.
    await pathsAskedFor({ refusing: ["/orgs/hmcts/dependabot/alerts"] });

    const alerts = recordRepositoryState.mock.calls.map(
      ([, , state]) => (state as { securityAlerts?: { dependabot?: { open?: number; detail?: string } } }).securityAlerts
    );

    expect(alerts.every((block) => block?.dependabot?.open === undefined)).toBe(true);
    expect(alerts[0]?.dependabot?.detail).toContain("could not be read for the organisation");
  });

  it("should read one repository's own alerts when it was asked for by name", async () => {
    // Paging the organisation's alerts to find one repository costs far more than asking for it, so
    // `--repository` keeps the per-repository read exactly as `--repository` keeps the metadata read.
    const asked = await pathsAskedFor({ argv: ["collect", "--config", "m.yaml", "--repository", "fresh", "--tolerate-partial"] });

    expect(asked).toContain("/repos/hmcts/fresh/dependabot/alerts");
    expect(asked).not.toContain("/orgs/hmcts/dependabot/alerts");
  });

  /** What one repository's stored state says about SonarCloud after a run. */
  function storedSonar(repository: string): { mapping?: { projectKey?: string }; measures?: { coverage?: number }; detail?: string } | undefined {
    const call = recordRepositoryState.mock.calls.find(([, named]) => named === repository);
    return (call?.[2] as { sonar?: { mapping?: { projectKey?: string }; measures?: { coverage?: number }; detail?: string } } | undefined)?.sonar;
  }

  it("should say the map has not been built rather than that a repository has no project, when nothing has mapped", async () => {
    // The wording this ticket exists for. An empty map means `map-sonar` has never run, which is a fact about the
    // deployment; the sentence every page carried before said it was a fact about the repository.
    await pathsAskedFor();

    expect(storedSonar("fresh")?.detail).toContain("has not been built");
    expect(createSonarClient).not.toHaveBeenCalled();
  });

  it("should measure a repository the map attributes a project to, and spend no call resolving it", async () => {
    storedSonarMappings.mockResolvedValue([
      { projectKey: "hmcts.fresh", repository: "fresh", method: "analysis_revision", analysisAt: new Date(Date.UTC(2026, 8, 16)), resolvedAt: new Date() }
    ]);
    const measures = vi.fn().mockResolvedValue({ projectKey: "hmcts.fresh", coverage: 92.5 });
    createSonarClient.mockReturnValue({
      projects: async () => [{ key: "hmcts.fresh", analysisAt: new Date(Date.UTC(2026, 8, 16)) }],
      measures
    });

    await pathsAskedFor();

    expect(storedSonar("fresh")).toMatchObject({ mapping: { projectKey: "hmcts.fresh" }, measures: { coverage: 92.5 } });
    // ONE listing for the estate and one measures read for the one mapped repository: the resolution itself is a
    // lookup in the map, so the repository the map says nothing about costs nothing.
    expect(measures).toHaveBeenCalledOnce();
    expect(storedSonar("stale")?.detail).toContain("no SonarCloud project in hmcts analyses this repository");
  });

  it("should keep a mapped project's name beside the reason SonarCloud would not show it", async () => {
    // A project deleted, renamed or made private since the map was built. An observation and not a failure: no
    // operator action fixes it on this run, and the project name is what somebody needs to chase it.
    storedSonarMappings.mockResolvedValue([{ projectKey: "hmcts.gone", repository: "fresh", method: "stored_map", resolvedAt: new Date() }]);
    createSonarClient.mockReturnValue({ projects: async () => [{ key: "hmcts.other" }], measures: vi.fn() });

    await pathsAskedFor();

    expect(storedSonar("fresh")).toMatchObject({ mapping: { projectKey: "hmcts.gone" } });
    expect(storedSonar("fresh")?.detail).toContain("no longer lists project hmcts.gone");
  });

  it("should count a refused SonarCloud listing ONCE and state it on every repository", async () => {
    storedSonarMappings.mockResolvedValue([{ projectKey: "hmcts.fresh", repository: "fresh", method: "stored_map", resolvedAt: new Date() }]);
    createSonarClient.mockReturnValue({
      projects: async () => {
        throw new SonarError("SonarCloud refused the projects read", AvailabilityReason.PermissionDenied);
      },
      measures: vi.fn()
    });

    await pathsAskedFor();

    expect(storedSonar("fresh")?.detail).toContain("could not be read");
    // Stated rather than absent: an absent block means nobody looked, and somebody did look and was refused.
    expect(storedSonar("fresh")?.mapping).toBeUndefined();
  });
});

/**
 * `evidence`, which is documented as printing "the same figures" the dashboard shows.
 *
 * That sentence is the whole of what these cases are about, and it is the one this command can break silently:
 * it reads the fact cache through its own code path, so a narrowing the pages apply and it does not shows up as
 * a number somebody quotes in a report rather than as a failure.
 *
 * It reads that cache in TWO calls for the estate, not five per repository. It used to walk the cohort calling
 * `loadCachedMerges` and `storedRepositoryState` — a state lookup, two fact queries and two `accessed_at` WRITES
 * each, so roughly 9,455 round trips and 3,782 indexed row rewrites to print one document. The web path was
 * batched for exactly that, and `deserialiseMerges` was split out of `loadCachedMerges` so both halves turn a
 * payload into a fact the same way.
 */
describe("evidence", () => {
  const CONFIG = {
    organization: "hmcts",
    lookback: { operational_days: 90, mutable_hours: 24 },
    teams: [],
    cohort: { excluded_authors: ["renovate"], bot_accounts: [] },
    triviality: { maximum_lines: 10, maximum_files: 1 },
    assessment: { enabled: false, minimum_merges: 1, "unreviewed-substantial-merges": { maximum_count: 0, maximum_percentage: 1 } },
    org_graph: { enabled: true }
  };

  /** One stored pull-request payload, as `serialise` writes it: instants as ISO strings, absent fields omitted. */
  function merge(overrides: Record<string, unknown> = {}) {
    return {
      identifier: 101,
      repository: "repo-a",
      number: 11,
      createdAt: "2026-08-01T00:00:00Z",
      mergedAt: "2026-08-03T00:00:00Z",
      draft: false,
      authorLogin: "alice",
      authorType: "User",
      bodyLength: 120,
      hasTicketReference: true,
      reviews: [],
      checks: [],
      ...overrides
    };
  }

  /** One stored direct-commit payload — a change that reached the default branch with no pull request. */
  function commit(overrides: Record<string, unknown> = {}) {
    return {
      sha: "abc123",
      repository: "repo-a",
      committedAt: "2026-08-03T00:00:00Z",
      authorLogin: "alice",
      authorType: "User",
      ...overrides
    };
  }

  /** Runs `evidence` over a cohort whose cached facts are stated per repository, and parses what it printed. */
  async function reported(
    repositories: string[],
    cached: Record<string, { pullRequests?: unknown[]; directCommits?: unknown[] }>,
    states: Record<string, unknown> = {}
  ): Promise<{ status: number; repositories: Record<string, unknown>[] }> {
    loadConfiguration.mockResolvedValue(CONFIG);
    cohortRepositories.mockResolvedValue(repositories);
    prevailingCachedCoverage.mockResolvedValue(new Date("2026-08-31T00:00:00Z"));
    // `DatedFact`s, which is what the batched reader answers with: the instant the window SELECTED the row on,
    // beside the payload. Stated in that shape rather than as bare payloads because the shape is the contract —
    // written the other way the command reads `fact.payload` as undefined and every merge deserialises to nothing.
    const dated = (payloads: unknown[] = []) => payloads.map((payload) => ({ at: new Date("2026-08-03T00:00:00Z"), payload }));
    loadCachedFactsForOrganisation.mockResolvedValue(
      new Map(
        Object.entries(cached).map(([repository, facts]) => [
          repository,
          { pullRequests: dated(facts.pullRequests), directCommits: dated(facts.directCommits) }
        ])
      )
    );
    storedRepositoryStates.mockResolvedValue(
      new Map(Object.entries(states).map(([repository, payload]) => [repository, { fetchedAt: new Date("2026-08-31T00:00:00Z"), payload }]))
    );

    let printed = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      printed += String(chunk);
      return true;
    });
    // Re-spied over the global no-op, so a run that refuses reports WHY here instead of failing as a JSON parse
    // error on an empty string.
    let complained = "";
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      complained += String(chunk);
      return true;
    });

    const status = await main(["evidence", "--config", "m.yaml"]);
    if (printed === "") {
      throw new Error(`evidence printed no document and exited ${status}: ${complained.trim()}`);
    }
    return { status, ...(JSON.parse(printed) as { repositories: Record<string, unknown>[] }) };
  }

  it("should read the whole estate's facts and states in one call each, whatever the cohort size", async () => {
    // THE POINT OF THE BATCHED READERS. Asserted as a call COUNT rather than as a duration, because the cost this
    // removes is round trips: the per-repository shape issued five per repository, and the figure it prints is
    // identical either way — which is exactly why it could regress unnoticed.
    const { repositories } = await reported(["repo-a", "repo-b", "repo-c"], {
      "repo-a": { pullRequests: [merge()] },
      "repo-b": { pullRequests: [merge({ identifier: 202, repository: "repo-b" })] }
    });

    expect(loadCachedFactsForOrganisation).toHaveBeenCalledOnce();
    expect(storedRepositoryStates).toHaveBeenCalledOnce();
    expect(repositories.map((row) => [row.repository, row.merged_pull_requests])).toEqual([
      ["repo-a", 1],
      ["repo-b", 1],
      // Read, and holding no merges in the window — a row with zero rather than a repository left out.
      ["repo-c", 0]
    ]);
  });

  it("should narrow the cohort the way a rendered page does, so the two report one figure", async () => {
    // `excluded_authors` is applied when a report is BUILT, and this command builds one. Reporting Renovate's
    // merges here while the dashboard drops them would make "the same figures" false of the document somebody
    // quotes, and neither number would be visibly wrong.
    const { repositories } = await reported(["repo-a"], {
      "repo-a": { pullRequests: [merge(), merge({ identifier: 202, authorLogin: "renovate", authorType: "Bot" })] }
    });

    expect(repositories[0]?.merged_pull_requests).toBe(1);
  });

  it("should count the direct commits that reached a default branch beside the merges", async () => {
    // BOTH ROUTES, and read out of the same batched call. A direct commit is a change that arrived unreviewed, so
    // a command reporting only pull requests would describe a repository whose work bypasses them as quiet.
    const { repositories } = await reported(["repo-a"], {
      "repo-a": { pullRequests: [merge()], directCommits: [commit(), commit({ sha: "def456" })] }
    });

    expect(repositories[0]).toMatchObject({ merged_pull_requests: 1, direct_commits: 2 });
  });

  it("should read each repository's merge gate from the batched states", async () => {
    // The other half of what the loop used to fetch per repository. A gate reaches the assessment through this
    // map now, so a repository whose state was never collected reports no gate rather than a stale one.
    const { repositories } = await reported(
      ["repo-a", "repo-b"],
      { "repo-a": { pullRequests: [merge()] } },
      { "repo-a": { mergeGate: { gate: { branch: "main", requiredApprovals: 2 }, fetchedAt: "2026-08-31T00:00:00Z" } } }
    );

    expect(repositories).toHaveLength(2);
    expect(repositories[0]?.repository).toBe("repo-a");
  });

  it("should report the window it anchored on rather than one ending now", async () => {
    // An offline report ends where collection reached, not at the wall clock: `prevailingCachedCoverage` is the
    // anchor, and a window running past it would report days nothing has walked as having no merges.
    const document = await reported(["repo-a"], { "repo-a": { pullRequests: [merge()] } });

    expect(document.status).toBe(EXIT_COMPLETE);
    expect(prevailingCachedCoverage).toHaveBeenCalledOnce();
  });
});

/**
 * `map-sonar`, which builds the durable project map and collects no evidence.
 *
 * THE SEAM IS THE COMMIT SEARCH AND THE WRITER. SonarCloud's listing and analyses are stubbed because what the
 * client makes of a real response is asserted in `evidence/sonar/sonar.test.ts`; what these cases are about is
 * which projects a run pays the scarce quota for, and what it writes for the ones it cannot resolve.
 */
describe("map-sonar", () => {
  const CONFIG = { organization: "hmcts", lookback: { operational_days: 90 }, teams: [], sonar_projects: {}, org_graph: { enabled: true } };
  const REVISION = "671d77770bda9760854fcf0bc5e086eed92bfb3a";

  /**
   * One `map-sonar` run over a stubbed SonarCloud and a stubbed commit search.
   *
   * `searching` answers `/search/commits`; anything else is a repository read, which this command never makes.
   */
  async function mapping(options: {
    projects?: { key: string; analysisAt?: Date }[];
    analyses?: { revision?: string; analysisAt?: Date }[];
    searching?: (revision: string) => unknown;
    argv?: string[];
  }): Promise<{ status: number; searches: string[] }> {
    loadConfiguration.mockResolvedValue(CONFIG);
    resolveCredentials.mockResolvedValue({ token: async () => "t", describe: () => "a token" });
    const searches: string[] = [];
    createGitHubClient.mockReturnValue({
      get: vi.fn((path: string, parameters: Record<string, string>) => {
        searches.push(`${path}?q=${parameters.q}`);
        const revision = String(parameters.q).split("hash:")[1] ?? "";
        return Promise.resolve(options.searching?.(revision) ?? { items: [] });
      }),
      budget: () => undefined,
      requestsIssued: () => searches.length,
      callOutcomes: () => [],
      rateLimitWaits: () => []
    });
    createSonarClient.mockReturnValue({
      projects: async () => options.projects ?? [],
      projectAnalyses: async () => options.analyses ?? []
    });

    const status = await main(options.argv ?? ["map-sonar", "--config", "m.yaml"]);
    return { status, searches };
  }

  it("should store the repository that holds a project's analysed commit", async () => {
    const { status, searches } = await mapping({
      projects: [{ key: "hmcts.cath", analysisAt: new Date(Date.UTC(2026, 8, 16)) }],
      analyses: [{ revision: REVISION, analysisAt: new Date(Date.UTC(2026, 8, 16)) }],
      searching: () => ({ items: [{ repository: { full_name: "hmcts/cath-service" } }] })
    });

    expect(status).toBe(EXIT_COMPLETE);
    // The `org:` qualifier is what makes the answer usable: an unqualified hash search reaches every public
    // repository on GitHub, and a commit found in somebody else's fork says nothing about who owns the project.
    expect(searches).toEqual([`/search/commits?q=org:hmcts hash:${REVISION}`]);
    expect(recordSonarMapping).toHaveBeenCalledWith("hmcts", expect.objectContaining({ mapping: expect.objectContaining({ repository: "cath-service" }) }));
  });

  it("should store a remembered negative for a project no commit in the organisation matches", async () => {
    // The whole point of storing it: the next run reads the answer instead of re-paying the quota to learn it.
    const { status } = await mapping({
      projects: [{ key: "hmcts.orphan", analysisAt: new Date(Date.UTC(2026, 8, 16)) }],
      analyses: [{ revision: REVISION, analysisAt: new Date(Date.UTC(2026, 8, 16)) }]
    });

    expect(status).toBe(EXIT_COMPLETE);
    const answer = recordSonarMapping.mock.calls[0]?.[1];
    expect(answer?.mapping).toBeUndefined();
    expect(answer?.detail).toContain("no commit in hmcts matches");
  });

  it("should store a project SonarCloud has never analysed without spending a search on it", async () => {
    const { status, searches } = await mapping({ projects: [{ key: "hmcts.new", analysisAt: new Date(Date.UTC(2026, 8, 16)) }], analyses: [] });

    expect(status).toBe(EXIT_COMPLETE);
    expect(searches).toEqual([]);
    expect(recordSonarMapping.mock.calls[0]?.[1].detail).toContain("records no analysis");
  });

  it("should pay nothing for a project nothing has been analysed since it was resolved", async () => {
    // The watermark is when the row was WRITTEN, so a project whose latest analysis predates it is settled.
    storedSonarMappings.mockResolvedValue([
      { projectKey: "hmcts.cath", repository: "cath-service", method: "analysis_revision", resolvedAt: new Date(Date.UTC(2026, 8, 17)) }
    ]);

    const { status, searches } = await mapping({ projects: [{ key: "hmcts.cath", analysisAt: new Date(Date.UTC(2026, 8, 16)) }] });

    expect(status).toBe(EXIT_COMPLETE);
    expect(searches).toEqual([]);
    expect(recordSonarMapping).not.toHaveBeenCalled();
  });

  it("should re-resolve a project analysed since the map was written, which is the only thing that can change the answer", async () => {
    storedSonarMappings.mockResolvedValue([
      { projectKey: "hmcts.cath", repository: "old-name", method: "analysis_revision", resolvedAt: new Date(Date.UTC(2026, 8, 1)) }
    ]);

    const { searches } = await mapping({
      projects: [{ key: "hmcts.cath", analysisAt: new Date(Date.UTC(2026, 8, 16)) }],
      analyses: [{ revision: REVISION, analysisAt: new Date(Date.UTC(2026, 8, 16)) }],
      searching: () => ({ items: [{ repository: { full_name: "hmcts/cath-service" } }] })
    });

    expect(searches).toHaveLength(1);
    expect(recordSonarMapping).toHaveBeenCalledWith("hmcts", expect.objectContaining({ mapping: expect.objectContaining({ repository: "cath-service" }) }));
  });

  it("should refuse an organisation SonarCloud lists no project for, rather than report an empty success", async () => {
    // Reporting 0 would leave `collect` reading an empty map as "no repository has a SonarCloud project".
    expect((await mapping({ projects: [] })).status).toBe(EXIT_FAILED);
    expect(recordSonarMapping).not.toHaveBeenCalled();
  });

  it("should stop on a spent search quota and keep every project it had already answered", async () => {
    // The limit applies to every project still to come exactly as it applied to this one, so continuing would
    // write this run's exhaustion into the map as each remaining project's own dead end.
    const analysed = new Date(Date.UTC(2026, 8, 16));
    let searched = 0;
    const { status } = await mapping({
      projects: [
        { key: "hmcts.one", analysisAt: analysed },
        { key: "hmcts.two", analysisAt: analysed }
      ],
      analyses: [{ revision: REVISION, analysisAt: analysed }],
      searching: () => {
        searched += 1;
        if (searched === 1) {
          return { items: [{ repository: { full_name: "hmcts/one-service" } }] };
        }
        throw new GitHubError("GitHub rate limit exceeded after 3 attempts", AvailabilityReason.RateLimited, 403);
      }
    });

    expect(status).toBe(EXIT_INCOMPLETE);
    expect(recordSonarMapping).toHaveBeenCalledOnce();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("stopping and keeping the 1 projects already answered"));
  });

  it("should report a partial run as success for a scheduled one, as a collection does", async () => {
    // A CronJob has no third state, and across 315 projects something always refuses: a weekly job reporting
    // failure every week is an alert nobody reads. The true status still reaches `collector.exit_status`.
    const analysed = new Date(Date.UTC(2026, 8, 16));
    let searched = 0;
    const { status } = await mapping({
      projects: [
        { key: "hmcts.one", analysisAt: analysed },
        { key: "hmcts.two", analysisAt: analysed }
      ],
      analyses: [{ revision: REVISION, analysisAt: analysed }],
      searching: () => {
        searched += 1;
        if (searched === 1) {
          return { items: [{ repository: { full_name: "hmcts/one-service" } }] };
        }
        throw new GitHubError("GitHub refused the search", AvailabilityReason.PermissionDenied, 403);
      },
      argv: ["map-sonar", "--config", "m.yaml", "--tolerate-partial"]
    });

    expect(status).toBe(EXIT_COMPLETE);
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining("some projects refused"));
  });

  it("should fail a run that could answer for nothing at all", async () => {
    const analysed = new Date(Date.UTC(2026, 8, 16));
    const { status } = await mapping({
      projects: [{ key: "hmcts.one", analysisAt: analysed }],
      analyses: [{ revision: REVISION, analysisAt: analysed }],
      searching: () => {
        throw new GitHubError("GitHub refused the search", AvailabilityReason.PermissionDenied, 403);
      },
      argv: ["map-sonar", "--config", "m.yaml", "--tolerate-partial"]
    });

    // Nothing tolerates `Failed`: no project was answered for, so the map is exactly as it was and somebody
    // should be woken.
    expect(status).toBe(EXIT_FAILED);
    expect(recordSonarMapping).not.toHaveBeenCalled();
  });

  it("should warn with both keys where two projects claim one repository", async () => {
    const analysed = new Date(Date.UTC(2026, 8, 16));
    await mapping({
      projects: [
        { key: "hmcts.cath", analysisAt: analysed },
        { key: "hmcts.cath.old", analysisAt: analysed }
      ],
      analyses: [{ revision: REVISION, analysisAt: analysed }],
      searching: () => ({ items: [{ repository: { full_name: "hmcts/cath-service" } }] })
    });

    // Legitimate — SonarCloud has no rename, so a re-created project leaves its twin behind — and the reverse
    // lookup settles it by analysis recency. Surfaced because the alternative is a page quietly showing one of two.
    expect(console.warn).toHaveBeenCalledWith("cath-service is claimed by 2 projects: hmcts.cath, hmcts.cath.old");
  });
});

describe("the collector lock", () => {
  it.each([["collect"], ["collect-org"], ["map-sonar"]])("should stand %s down as SUCCESS when another run holds the lock", async (command) => {
    // Both AAT clusters run the same schedule against one database, so one of them loses the lock EVERY DAY.
    // Reporting that as failure would make a CronJob show Failed daily for a system behaving exactly as designed,
    // and an alert that always fires is one nobody reads. The estate was collected — by the peer.
    loadConfiguration.mockResolvedValue({ organization: "hmcts", lookback: { operational_days: 90 }, teams: [], org_graph: { enabled: true } });
    asSoleCollector.mockResolvedValueOnce(undefined);

    expect(await main([command, "--config", "m.yaml"])).toBe(EXIT_COMPLETE);
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining("stood down"));
    // Nothing was collected by THIS run: no credential resolved, so no GitHub call was made either.
    expect(resolveCredentials).not.toHaveBeenCalled();
  });

  it("should DELETE NOTHING when prune runs while a collector holds the lock", async () => {
    // THE ONE THAT COST DATA. `prune` is the only command that deletes, and it used to be the only one dispatched
    // outside the lock — so a hand-run prune could land in the middle of a collection and delete rows the run was
    // partway through writing. Under the lock it stands down instead, and stands down as SUCCESS for the same
    // reason the collectors do: losing the lock is the system working.
    loadConfiguration.mockResolvedValue({ organization: "hmcts", lookback: { operational_days: 90 }, teams: [], org_graph: { enabled: true } });
    asSoleCollector.mockResolvedValueOnce(undefined);

    expect(await main(["prune", "--config", "m.yaml"])).toBe(EXIT_COMPLETE);

    // Not "returned 0 rows deleted" — never asked. A stand-down that still opened a delete transaction would
    // satisfy an exit-status assertion and none of the point of this.
    expect(pruneCache).not.toHaveBeenCalled();
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining("stood down"));
  });

  it("should prune under the lock when it holds it, from the cut-off the operator asked for", async () => {
    // The other half: taking the lock must not turn `prune` into a no-op. `asSoleCollector` grants by default, so
    // this asserts the command reached the delete THROUGH the lock rather than around it, with `--days` honoured.
    loadConfiguration.mockResolvedValue({ organization: "hmcts", lookback: { operational_days: 90 }, teams: [], org_graph: { enabled: true } });
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 8, 15, 12)));

    try {
      expect(await main(["prune", "--config", "m.yaml", "--days", "7"])).toBe(EXIT_COMPLETE);
    } finally {
      vi.useRealTimers();
    }

    expect(asSoleCollector).toHaveBeenCalledOnce();
    expect(pruneCache).toHaveBeenCalledWith(new Date(Date.UTC(2026, 8, 8, 12)));
  });
});

describe("collect-org", () => {
  /**
   * `maximum_team_share` is 1 rather than the configured quarter of the estate.
   *
   * These fixtures hold two or three repositories, and at the real 0.25 a team holding one of them holds more than
   * its share — so the breadth filter would suppress every claim in the fixture and each case would be asserting
   * against an organisation nobody owns anything in.
   */
  const CONFIG = {
    organization: "hmcts",
    lookback: { operational_days: 90 },
    teams: [],
    org_graph: {
      enabled: true,
      prefix_support: 3,
      prefix_dominance: 0.8,
      maximum_team_share: 1,
      maximum_team_members: 100,
      excluded_teams: ["all-org-members"],
      unresolved_repository_limit: 500,
      minimum_authored_merges: 2,
      authorship_days: 90
    }
  };

  const NOTHING_WRITTEN = { inserted: 0, unchanged: 0, changed: 0, superseded: 0 };
  const WRITERS = [recordOrgTeams, recordOrgTeamMemberships, recordOrgTeamRepositories, recordOrgRepositories, recordOrgPeople, recordRepositoryOwnership];

  let stdout: MockInstance;

  beforeEach(() => {
    // `--propose-teams` puts its document on stdout, so the assertions read it back from here.
    stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    // Restored rather than left in place like the other spies in this file: `process.stdout` belongs to the worker
    // process, and a stub surviving this describe would silence the reporter for whatever runs next in it.
    stdout.mockRestore();
  });

  /** What the proposal wrote, as one document rather than as the chunks it was written in. */
  function proposed(): string {
    return stdout.mock.calls.map((call) => String(call[0])).join("");
  }

  /**
   * The lines belonging to one proposed entry.
   *
   * Per entry rather than per document, because "the unknown bucket carries no slugs" is only a claim about that
   * entry — a document where a real team beside it carries them is exactly the case worth asserting in.
   */
  function entryOf(block: string, identifier: string): string[] {
    const lines = block.split("\n");
    const rest = lines.slice(lines.indexOf(`  - identifier: ${identifier}`) + 1);
    const end = rest.findIndex((line) => !line.startsWith("    "));
    return end === -1 ? rest : rest.slice(0, end);
  }

  function repositoryFact(name: string) {
    return { name, archived: false, visibility: "private", isFork: false };
  }

  /** Two teams, each holding admin on one repository, every list read in full: the undegraded case. */
  function wholeTeamPicture(overrides: Record<string, unknown> = {}) {
    return {
      teamsRead: true,
      teamsComplete: true,
      knownTeams: new Set(["team-a", "team-b"]),
      teams: [
        { slug: "team-a", name: "Team A" },
        { slug: "team-b", name: "Team B" }
      ],
      memberships: [
        { teamSlug: "team-a", login: "alice", role: "MEMBER" },
        { teamSlug: "team-b", login: "bob", role: "MEMBER" }
      ],
      teamRepositories: [
        { teamSlug: "team-a", repository: "repo-a", access: "admin" },
        { teamSlug: "team-b", repository: "repo-b", access: "admin" }
      ],
      membershipsObserved: new Set(["team-a", "team-b"]),
      teamRepositoriesObserved: new Set(["team-a", "team-b"]),
      ...overrides
    };
  }

  /** One repository's CODEOWNERS as the walk answers it: read, and naming whoever is passed. */
  function codeownersFact(repository: string, owners: { teams?: string[]; people?: string[] }) {
    return { repository, teams: owners.teams ?? [], people: owners.people ?? [], paths: [".github/CODEOWNERS"] };
  }

  function withWalks(
    walks: {
      teams?: unknown;
      repositories?: string[];
      repositoriesComplete?: boolean;
      peopleComplete?: boolean;
      codeowners?: Map<string, unknown>;
      /** An entry means the collaborator listing was read, possibly to an empty result; no entry means refused. */
      directAdmins?: Map<string, string[]>;
      /** The SSO names this run resolved. Absent means the mapping was unmeasured — a PAT, or a refusal. */
      ssoNames?: Map<string, string>;
      /** The names an earlier collection had already stored, which an unmeasured run carries forward. */
      storedNames?: Map<string, string>;
    } = {}
  ): void {
    loadConfiguration.mockResolvedValue(CONFIG);
    resolveCredentials.mockResolvedValue({ token: async () => "t", describe: () => "a token" });
    // The counters the run summary is printed from. Stubbed empty rather than omitted: `collect-org` prints the
    // same breakdown `collect` does, so a client missing them is not one this command could run against.
    createGitHubClient.mockReturnValue({ requestsIssued: () => 0, callOutcomes: () => [], rateLimitWaits: () => [] });

    collectOrgTeams.mockResolvedValue(walks.teams ?? wholeTeamPicture());
    collectOrgRepositories.mockResolvedValue({
      facts: (walks.repositories ?? ["repo-a", "repo-b"]).map(repositoryFact),
      complete: walks.repositoriesComplete ?? true
    });
    collectOrgPeople.mockResolvedValue({ facts: [{ login: "alice", role: "MEMBER" }], complete: walks.peopleComplete ?? true });
    collectSsoIdentities.mockResolvedValue(walks.ssoNames === undefined ? { names: new Map(), measured: false } : { names: walks.ssoNames, measured: true });
    storedDisplayNames.mockResolvedValue(walks.storedNames ?? new Map());
    collectCodeowners.mockResolvedValue(walks.codeowners ?? new Map());
    // Defaults to "every repository asked was read and named nobody", which is the ordinary case and the one that
    // must not read as a refusal.
    collectDirectAdmins.mockResolvedValue(walks.directAdmins ?? new Map((walks.repositories ?? []).map((name) => [name, []])));
    for (const writer of WRITERS) {
      writer.mockResolvedValue(NOTHING_WRITTEN);
    }
    stampRevision.mockResolvedValue(undefined);
  }

  it("should refuse to walk the organisation when org_graph.enabled is false", async () => {
    withWalks();
    loadConfiguration.mockResolvedValue({ ...CONFIG, org_graph: { ...CONFIG.org_graph, enabled: false } });

    // Named in the message because this refusal reaches somebody as a line in a CronJob's log, where "turned off"
    // without the key to turn on is indistinguishable from a fault.
    expect(await main(["collect-org", "--config", "m.yaml"])).toBe(EXIT_USAGE);
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining("org_graph.enabled"));
    expect(collectOrgTeams).not.toHaveBeenCalled();
  });

  it("should walk the organisation and report complete when every walk came back whole", async () => {
    withWalks();

    expect(await main(["collect-org", "--config", "m.yaml"])).toBe(EXIT_COMPLETE);
    expect(recordOrgTeams).toHaveBeenCalledWith("hmcts", expect.any(Date), expect.anything(), true);
    expect(recordOrgTeamMemberships).toHaveBeenCalledWith("hmcts", expect.any(Date), expect.anything(), new Set(["team-a", "team-b"]));
    expect(recordOrgTeamRepositories).toHaveBeenCalledWith("hmcts", expect.any(Date), expect.anything(), new Set(["team-a", "team-b"]));
    expect(recordRepositoryOwnership).toHaveBeenCalledWith("hmcts", expect.any(Date), expect.anything(), new Set(["repo-a", "repo-b"]));
    expect(stampRevision).toHaveBeenCalledOnce();
  });

  it("should seed a production row for the organisation it walked when the graph writers have landed", async () => {
    // Without this, `repository_production` holds a row only for the repositories somebody has already marked —
    // and the whole point of the reshaping is that the row is ALREADY THERE when a person goes looking for it.
    withWalks();

    expect(await main(["collect-org", "--config", "m.yaml"])).toBe(EXIT_COMPLETE);
    expect(seedProduction).toHaveBeenCalledWith("hmcts");
  });

  it("should exclude a team whose members were refused from the memberships it may supersede", async () => {
    // The HIGH finding: one refused membership used to leave the whole write scoped as complete, so every live row
    // of that team was closed as a departure that never happened. Only the teams READ IN FULL may be superseded in.
    withWalks({ teams: wholeTeamPicture({ membershipsObserved: new Set(["team-a"]) }) });

    await main(["collect-org", "--config", "m.yaml"]);

    expect(recordOrgTeamMemberships).toHaveBeenCalledWith("hmcts", expect.any(Date), expect.anything(), new Set(["team-a"]));
  });

  it("should not supersede repositories when the repository walk stopped short", async () => {
    // A rate limit part way through the paging returns the prefix it managed, which is worth storing and is NOT
    // the estate: read as whole it would end every repository the walk never reached.
    withWalks({ repositoriesComplete: false });

    await main(["collect-org", "--config", "m.yaml"]);

    expect(recordOrgRepositories).toHaveBeenCalledWith("hmcts", expect.any(Date), expect.anything(), false);
  });

  it("should not supersede people when the people walk stopped short", async () => {
    withWalks({ peopleComplete: false });

    await main(["collect-org", "--config", "m.yaml"]);

    expect(recordOrgPeople).toHaveBeenCalledWith("hmcts", expect.any(Date), expect.anything(), false);
  });

  it("should store the name the SSO mapping resolved for each member", async () => {
    // The web pod holds no GitHub credential, so this run is the only place the mapping can be read and the store
    // is the only way the answer reaches a page.
    withWalks({ ssoNames: new Map([["alice", "Alice Smith"]]) });

    await main(["collect-org", "--config", "m.yaml"]);

    expect(recordOrgPeople).toHaveBeenCalledWith("hmcts", expect.any(Date), [{ login: "alice", role: "MEMBER", displayName: "Alice Smith" }], true);
  });

  it("should carry the stored names forward when the SSO mapping could not be read", async () => {
    // A PAT gets `samlIdentityProvider: null` beside an HTTP 200. Handing the writer facts with no name would end
    // the interval of every named person in the graph, and re-running opens new intervals rather than restoring
    // the ones wrongly closed.
    withWalks({ storedNames: new Map([["alice", "Alice Smith"]]) });

    await main(["collect-org", "--config", "m.yaml"]);

    expect(storedDisplayNames).toHaveBeenCalledWith("hmcts");
    expect(recordOrgPeople).toHaveBeenCalledWith("hmcts", expect.any(Date), [{ login: "alice", role: "MEMBER", displayName: "Alice Smith" }], true);
  });

  it("should not ask the graph for names it has just resolved", async () => {
    withWalks({ ssoNames: new Map([["alice", "Alice Smith"]]) });

    await main(["collect-org", "--config", "m.yaml"]);

    expect(storedDisplayNames).not.toHaveBeenCalled();
  });

  it("should leave a member nothing named without a name rather than with an empty one", async () => {
    withWalks({ ssoNames: new Map([["nobody-here", "Nobody Here"]]) });

    await main(["collect-org", "--config", "m.yaml"]);

    expect(recordOrgPeople).toHaveBeenCalledWith("hmcts", expect.any(Date), [{ login: "alice", role: "MEMBER" }], true);
  });

  it("should leave ownership alone when the team list came back short", async () => {
    // ATTRIBUTION IS ALL-OR-NOTHING ON THE TEAM PICTURE: a team nobody listed does not merely omit a claim, it
    // makes the repositories that team owns look unowned to every remaining rung. So nothing is written at all.
    withWalks({ teams: wholeTeamPicture({ teamsComplete: false }) });

    await main(["collect-org", "--config", "m.yaml"]);

    expect(recordRepositoryOwnership).toHaveBeenCalledWith("hmcts", expect.any(Date), [], new Set());
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining("team picture came back short"));
  });

  it("should leave ownership alone when one team's repositories were refused", async () => {
    // The other half of the same invariant: the team list was whole, but one team's holdings were not read, and a
    // repository whose owning team was not read is the one that would gain a contradicting `unowned` row.
    withWalks({ teams: wholeTeamPicture({ teamRepositoriesObserved: new Set(["team-a"]) }) });

    await main(["collect-org", "--config", "m.yaml"]);

    expect(recordRepositoryOwnership).toHaveBeenCalledWith("hmcts", expect.any(Date), [], new Set());
  });

  it("should not attribute a repository the unresolved limit never read", async () => {
    // The other HIGH finding. The ladder always answers something, so a repository whose CODEOWNERS was never
    // requested resolved to `unowned` — and since `(repository, kind, owner)` is the key, that row was inserted
    // BESIDE the live team row rather than replacing it, leaving a repository simultaneously owned and unowned.
    withWalks({
      repositories: ["repo-a", "orphan-one", "orphan-two"],
      codeowners: new Map([["orphan-one", codeownersFact("orphan-one", { teams: ["team-b"] })]])
    });

    await main(["collect-org", "--config", "m.yaml", "--unresolved-limit", "1"]);

    expect(collectCodeowners).toHaveBeenCalledWith(expect.anything(), "hmcts", ["orphan-one"]);
    const [, , attributions, observed] = recordRepositoryOwnership.mock.calls[0] as [string, Date, { repository: string }[], Set<string>];
    expect(attributions.map((entry) => entry.repository)).toStrictEqual(["orphan-one", "repo-a"]);
    expect(observed).toStrictEqual(new Set(["orphan-one", "repo-a"]));
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining("left unresolved by --unresolved-limit"));
  });

  it("should attribute a residue repository whose CODEOWNERS simply does not exist", async () => {
    // THREE STATES, NOT TWO, and the first version of this fix collapsed them. `collectCodeowners` records a
    // refusal as a fact carrying `refusal` but records an ABSENT file as no map entry at all — the commonest
    // answer on this estate. Treating that silence as "we never asked" meant no residue repository ever got an
    // ownership row, including the `unowned` remembered negative the "how many does nobody own" count needs, and
    // made a complete run impossible to reach.
    withWalks({ repositories: ["repo-a", "no-codeowners"], codeowners: new Map(), directAdmins: new Map([["no-codeowners", []]]) });

    expect(await main(["collect-org", "--config", "m.yaml"])).toBe(EXIT_COMPLETE);
    const [, , attributions, observed] = recordRepositoryOwnership.mock.calls[0] as [string, Date, { repository: string }[], Set<string>];
    expect(observed.has("no-codeowners")).toBe(true);
    expect(attributions.some((entry) => entry.repository === "no-codeowners")).toBe(true);
  });

  it("should not attribute a residue repository whose collaborator listing was refused", async () => {
    // The mirror case: `collectDirectAdmins` omits an entry on refusal and records an empty array on success, so
    // an absent entry after being asked means nobody could look — and `unowned` is then not established either.
    withWalks({ repositories: ["repo-a", "refused-admins"], codeowners: new Map(), directAdmins: new Map() });

    await main(["collect-org", "--config", "m.yaml"]);

    const [, , , observed] = recordRepositoryOwnership.mock.calls[0] as [string, Date, unknown, Set<string>];
    expect(observed.has("refused-admins")).toBe(false);
  });

  it("should not report complete when part of the organisation would not answer", async () => {
    withWalks({ teams: wholeTeamPicture({ membershipsObserved: new Set(["team-a"]) }) });

    // The graph was still written, and the caller must be able to tell that from a run that covered the estate.
    expect(await main(["collect-org", "--config", "m.yaml"])).toBe(EXIT_INCOMPLETE);
    expect(recordOrgTeamMemberships).toHaveBeenCalledOnce();
  });

  it("should propose a teams block on stdout without writing anything", async () => {
    withWalks();

    expect(await main(["collect-org", "--config", "m.yaml", "--propose-teams"])).toBe(EXIT_COMPLETE);
    expect(proposed()).toContain("teams:");
    expect(entryOf(proposed(), "team-a")).toContain("      - repo-a");
    // `metrics.yaml` is tracked so that adding a team is a reviewed change; the graph is evidence about ownership
    // and does not get to redefine the cohort, so a proposal writes nothing at all.
    for (const writer of WRITERS) {
      expect(writer).not.toHaveBeenCalled();
    }
  });

  it("should not propose a person as a team", async () => {
    // A real bug: only the `none` bucket was special-cased, so a repository attributed by `codeowners-person`
    // emitted the login as an identifier AND as a `github_team_slugs` entry — declaring a person to be a GitHub
    // team in a file whose whole purpose is to be read as a reviewed answer.
    withWalks({
      repositories: ["solo-repo"],
      codeowners: new Map([["solo-repo", codeownersFact("solo-repo", { people: ["someone"] })]])
    });

    await main(["collect-org", "--config", "m.yaml", "--propose-teams"]);

    expect(proposed()).toContain("#   someone: solo-repo");
    expect(proposed()).not.toContain("- identifier: someone");
    expect(proposed()).not.toContain("github_team_slugs");
  });

  it("should not propose another organisation's team as a slug of this one", async () => {
    // `parseCodeowners` keeps a foreign handle in its `owner/team` form precisely because it is not a slug here.
    withWalks({
      repositories: ["shared-repo"],
      codeowners: new Map([["shared-repo", codeownersFact("shared-repo", { teams: ["other-org/platform"] })]])
    });

    await main(["collect-org", "--config", "m.yaml", "--propose-teams"]);

    expect(proposed()).toContain("#   other-org/platform: shared-repo");
    expect(proposed()).not.toContain("- identifier: other-org/platform");
    expect(proposed()).not.toContain("github_team_slugs");
  });

  it("should propose the unknown bucket without a team slug", async () => {
    // `unknown` is the grouping a repository nothing owns is reported under, and there is no such GitHub team.
    withWalks({ repositories: ["repo-a", "mystery-repo"] });

    await main(["collect-org", "--config", "m.yaml", "--propose-teams"]);

    expect(entryOf(proposed(), "team-a")).toContain("    github_team_slugs:");
    expect(entryOf(proposed(), "unknown")).not.toContain("    github_team_slugs:");
    expect(entryOf(proposed(), "unknown")).toContain("      - mystery-repo");
  });
});

/**
 * The one-off that reduces descriptions cached before the two answers existed.
 *
 * Its SQL is asserted against a real table in `test/integration/reduce-descriptions.test.ts`. What these cases are
 * about is the two decisions an operator's fingers depend on: that nothing is written without `--write`, and that
 * the patterns the estate is graded by come out of the reviewed configuration.
 */
describe("reduce-descriptions", () => {
  const CONFIG = {
    organization: "hmcts",
    lookback: { operational_days: 90 },
    teams: [],
    org_graph: { enabled: true },
    traceability: { minimum_description: 30, reference_patterns: ["#\\d+", "[A-Z][A-Z0-9]+-\\d+"] }
  };

  beforeEach(() => {
    loadConfiguration.mockResolvedValue(CONFIG);
  });

  /** Everything the command said, as one block rather than as the lines it said it in. */
  function reported(): string {
    return (process.stderr.write as unknown as MockInstance).mock.calls.map((call) => String(call[0])).join("");
  }

  it("should count what it would change and write nothing at all", async () => {
    expect(await main(["reduce-descriptions", "--config", "m.yaml"])).toBe(EXIT_COMPLETE);

    expect(reduceStoredDescriptions).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ dryRun: true }));
    expect(reported()).toContain("DRY RUN");
    expect(reported()).toContain("23854 rows would be reduced");
  });

  it("should print the two commands the operation is finished with, rather than filing them somewhere", async () => {
    await main(["reduce-descriptions", "--config", "metrics.yaml"]);

    // The apply, with the configuration the count was taken against rather than a placeholder somebody has to
    // remember to substitute.
    expect(reported()).toContain("yarn cli reduce-descriptions --config metrics.yaml --write");
    // And the VACUUM, which is where the space the descriptions held becomes reusable. `VACUUM FULL` would return
    // it to the operating system and take an ACCESS EXCLUSIVE lock the web pod's every read would block on, so
    // the instruction printed is deliberately the plain one.
    expect(reported()).toContain("VACUUM (VERBOSE, ANALYZE) pull_request_facts");
    expect(reported()).not.toContain("VACUUM FULL");
  });

  it("should name the database it resolved, because this one rewrites every row", async () => {
    await main(["reduce-descriptions", "--config", "m.yaml"]);

    expect(reported()).toContain("localhost:5432/github_metrics");
  });

  it("should apply the change when asked to, and report the table before and after", async () => {
    censusOfDescriptions.mockResolvedValueOnce({ rows: 24_249, carryingDescription: 23_854, derived: 395, unmeasurable: 0 });
    censusOfDescriptions.mockResolvedValueOnce({ rows: 24_249, carryingDescription: 0, derived: 24_249, unmeasurable: 0 });

    expect(await main(["reduce-descriptions", "--config", "m.yaml", "--write"])).toBe(EXIT_COMPLETE);

    expect(reduceStoredDescriptions).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ dryRun: false }));
    expect(reported()).toContain("before: 24249 cached pull requests, 23854 carrying a description, 395 measurable");
    expect(reported()).toContain("after: 24249 cached pull requests, 0 carrying a description, 24249 measurable");
    expect(reported()).toContain("reduced 23854 of 23854 rows read");
  });

  it("should grade with the patterns the configuration states and no others", async () => {
    // THE POINT OF READING THEM FROM CONFIG. A hardcoded pair would keep working here and would stop being what
    // `traceabilityReference` means the moment somebody edited the reviewed file.
    loadConfiguration.mockResolvedValue({ ...CONFIG, traceability: { minimum_description: 30, reference_patterns: ["WIBBLE-\\d+"] } });

    await main(["reduce-descriptions", "--config", "m.yaml", "--write"]);

    expect(reduceStoredDescriptions).toHaveBeenCalledWith([/WIBBLE-\d+/], expect.anything());
  });

  it("should do nothing when no row still carries a description", async () => {
    censusOfDescriptions.mockResolvedValue({ rows: 24_249, carryingDescription: 0, derived: 24_249, unmeasurable: 0 });

    expect(await main(["reduce-descriptions", "--config", "m.yaml", "--write"])).toBe(EXIT_COMPLETE);

    expect(reduceStoredDescriptions).not.toHaveBeenCalled();
    expect(reported()).toContain("nothing to do");
  });

  it("should batch at the size the operator asked for", async () => {
    await main(["reduce-descriptions", "--config", "m.yaml", "--batch-size", "25"]);

    expect(reduceStoredDescriptions).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ batchSize: 25 }));
  });

  it("should fail loudly if a row ended up with neither a description nor a derivation", async () => {
    // The invariant the single-statement update exists to hold. It cannot be broken by any ordering of the
    // batches — which is exactly why a run that observes it broken has to stop rather than carry on reporting.
    censusOfDescriptions.mockResolvedValueOnce({ rows: 24_249, carryingDescription: 23_854, derived: 395, unmeasurable: 0 });
    censusOfDescriptions.mockResolvedValueOnce({ rows: 24_249, carryingDescription: 0, derived: 24_246, unmeasurable: 3 });

    expect(await main(["reduce-descriptions", "--config", "m.yaml", "--write"])).toBe(EXIT_FAILED);
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining("neither a description nor a derivation"));
  });

  it("should report rows a concurrent prune deleted under the read without failing", async () => {
    reduceStoredDescriptions.mockResolvedValue({ scanned: 23_854, changed: 23_850 });

    expect(await main(["reduce-descriptions", "--config", "m.yaml", "--write"])).toBe(EXIT_COMPLETE);

    expect(reported()).toContain("4 rows were read but not written");
  });

  it("should not take the collector lock", async () => {
    // Deliberate, and the opposite of `prune`. Each row's update derives from that row's CURRENT payload, so a
    // collection writing the same row concurrently keeps everything it wrote — and standing down would leave a
    // hand-run one-off exiting 0 having done nothing at all.
    await main(["reduce-descriptions", "--config", "m.yaml", "--write"]);

    expect(asSoleCollector).not.toHaveBeenCalled();
    expect(reduceStoredDescriptions).toHaveBeenCalledOnce();
  });
});

describe("collect-cve", () => {
  const CONFIG = { organization: "hmcts", lookback: { operational_days: 90 }, teams: [] };
  const CREDENTIALS = { endpoint: "https://pipeline-metrics.documents.azure.com:443/", key: "a-key" };

  /** One published report, as `readCveDocuments` yields it. `java`, whose parser is the one with suppressions. */
  function document(overrides: Record<string, unknown> = {}) {
    return {
      database: "jenkins",
      ts: 1_789_726_965,
      gitUrl: "https://github.com/HMCTS/pcs-api.git",
      codebaseType: "java",
      buildTag: "jenkins-HMCTS-pcs-api-master-1",
      report: { dependencies: [] },
      ...overrides
    };
  }

  /** Makes the reader answer per database, so a case can let one refuse and the other succeed. */
  function reading(perDatabase: Record<string, unknown[] | Error>) {
    readCveDocuments.mockImplementation((_credentials: unknown, database: string) => {
      const answer = perDatabase[database] ?? [];
      // ONE GENERATOR FOR BOTH ANSWERS, throwing on first pull rather than when constructed, which is where a
      // refused container actually fails: the query is issued lazily, so `readCveDocuments` returns fine and the
      // rejection arrives inside the caller's `for await`.
      return (async function* () {
        if (answer instanceof Error) {
          throw answer;
        }
        for (const entry of answer) {
          yield entry;
        }
      })();
    });
  }

  beforeEach(() => {
    loadConfiguration.mockResolvedValue(CONFIG);
    cveCredentials.mockReturnValue(CREDENTIALS);
    reading({});
  });

  it("should collect nothing and fail when no Cosmos credential is mounted", async () => {
    // A missing secret must not be able to look like a clean estate. Nothing read, nothing written, so every
    // repository reads exactly as it did — which for most of the estate is unmeasured.
    cveCredentials.mockReturnValue(undefined);

    expect(await main(["collect-cve", "--config", "m.yaml"])).toBe(EXIT_FAILED);
    expect(readCveDocuments).not.toHaveBeenCalled();
    expect(recordCveScans).not.toHaveBeenCalled();
    expect(stampCollection).not.toHaveBeenCalled();
  });

  it("should name the two variables a pod is missing when it has no credential", async () => {
    cveCredentials.mockReturnValue(undefined);

    await main(["collect-cve", "--config", "m.yaml"]);

    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining("CVE_COSMOS_ACCOUNT"));
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining("CVE_COSMOS_KEY"));
  });

  it("should read BOTH databases, because reading one reports the other's estate as unmeasured", async () => {
    // `CosmosDbTargetResolver` routes by GitHub topic, and 45 repositories exist only in `sds-jenkins`.
    expect(await main(["collect-cve", "--config", "m.yaml"])).toBe(EXIT_COMPLETE);

    expect(readCveDocuments).toHaveBeenCalledTimes(2);
    expect(readCveDocuments).toHaveBeenCalledWith(CREDENTIALS, "jenkins", undefined);
    expect(readCveDocuments).toHaveBeenCalledWith(CREDENTIALS, "sds-jenkins", undefined);
  });

  it("should fold the documents it read and write the scans they describe", async () => {
    reading({ jenkins: [document()] });

    expect(await main(["collect-cve", "--config", "m.yaml"])).toBe(EXIT_COMPLETE);

    expect(recordCveScans).toHaveBeenCalledWith(
      [expect.objectContaining({ organization: "hmcts", repository: "pcs-api", codebaseType: "java", sourceDatabase: "jenkins" })],
      expect.any(Date)
    );
  });

  it("should start each database where its own watermark left off, because the two fill independently", async () => {
    const watermark = new Date(Date.UTC(2026, 8, 18, 10, 59, 33));
    cveWatermarks.mockResolvedValue(new Map([["jenkins", watermark]]));

    await main(["collect-cve", "--config", "m.yaml"]);

    // Seconds, and the watermark's own second re-read: `_ts` is second-granular, so `>` would skip a document
    // written in the boundary second for ever.
    expect(readCveDocuments).toHaveBeenCalledWith(CREDENTIALS, "jenkins", Math.floor(watermark.getTime() / 1000));
    expect(readCveDocuments).toHaveBeenCalledWith(CREDENTIALS, "sds-jenkins", undefined);
  });

  it("should stamp the collection, or the figures it wrote reach no reader until tomorrow", async () => {
    reading({ jenkins: [document()] });

    await main(["collect-cve", "--config", "m.yaml"]);

    expect(stampCollection).toHaveBeenCalledOnce();
  });

  it("should keep the first database's work and report partial when the second refuses", async () => {
    reading({ jenkins: [document()], "sds-jenkins": new Error("Cosmos refused: 403 Forbidden") });

    expect(await main(["collect-cve", "--config", "m.yaml"])).toBe(EXIT_INCOMPLETE);
    expect(recordCveScans).toHaveBeenCalledOnce();
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining("403 Forbidden"));
  });

  it("should report a partial run as success when a scheduled run asked it to tolerate one", async () => {
    reading({ jenkins: [document()], "sds-jenkins": new Error("Cosmos refused") });

    expect(await main(["collect-cve", "--config", "m.yaml", "--tolerate-partial"])).toBe(EXIT_COMPLETE);
  });

  it("should fail and stamp nothing when BOTH databases refuse", async () => {
    // Nothing was read, so nothing is known — and a run that stamped here would invalidate every held report to
    // replace it with the same figures, claiming a collection that did not happen.
    reading({ jenkins: new Error("refused"), "sds-jenkins": new Error("refused") });

    expect(await main(["collect-cve", "--config", "m.yaml", "--tolerate-partial"])).toBe(EXIT_FAILED);
    expect(stampCollection).not.toHaveBeenCalled();
  });

  it("should say how many reports it could not attribute to a repository", async () => {
    reading({ jenkins: [document({ gitUrl: "https://gitlab.com/hmcts/pcs-api.git" })] });

    await main(["collect-cve", "--config", "m.yaml"]);

    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining("no GitHub repository"));
    expect(recordCveScans).toHaveBeenCalledWith([], expect.any(Date));
  });

  it("should name a codebase type it has no parser for, so a new publishing builder is noticed", async () => {
    // Those repositories stay UNMEASURED until somebody writes the parser, which is the right answer and one
    // nobody would find out about without this line.
    reading({ jenkins: [document({ codebaseType: "dotnet" })] });

    await main(["collect-cve", "--config", "m.yaml"]);

    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining("dotnet"));
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining("unmeasured"));
  });

  it("should report what it wrote, counting scans and findings separately", async () => {
    reading({
      jenkins: [document({ report: { dependencies: [{ fileName: "a.jar", vulnerabilities: [{ name: "CVE-1" }], suppressedVulnerabilities: [] }] } })]
    });
    // Answering from what it was handed rather than a fixed pair, because the totals are ACCUMULATED across the
    // two databases — a constant would make the case pass whether or not the run added them up.
    recordCveScans.mockImplementation(async (scans: { findings: unknown[] }[]) => ({
      written: scans.length,
      superseded: 0,
      findings: scans.reduce((total, scan) => total + scan.findings.length, 0)
    }));

    await main(["collect-cve", "--config", "m.yaml"]);

    expect(console.info).toHaveBeenCalledWith(expect.stringContaining("wrote 1 scans and 1 findings"));
  });

  it("should not take the collector lock, because it makes no GitHub call to compete for", async () => {
    await main(["collect-cve", "--config", "m.yaml"]);

    expect(asSoleCollector).not.toHaveBeenCalled();
  });

  it("should not require the cohort to have been collected, because its subject is not the cohort", async () => {
    // The published reports describe whatever the pipeline built, which does not depend on the organisation graph.
    readCohort.mockRejectedValue(new CohortUncollectedError("the organisation graph is empty"));

    expect(await main(["collect-cve", "--config", "m.yaml"])).toBe(EXIT_COMPLETE);
  });
});
