import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { CohortUncollectedError } from "../evidence/org/cohort.ts";
import { EXIT_COMPLETE, EXIT_FAILED, EXIT_INCOMPLETE, EXIT_USAGE } from "./exit-status.ts";

const migrate = vi.hoisted(() => vi.fn<() => Promise<string[]>>());
const loadConfiguration = vi.hoisted(() => vi.fn());
const cohortRepositories = vi.hoisted(() => vi.fn());
const collectionState = vi.hoisted(() => vi.fn());
const resolveCredentials = vi.hoisted(() => vi.fn());
const createGitHubClient = vi.hoisted(() => vi.fn());
const stampRevision = vi.hoisted(() => vi.fn());

const collectOrgTeams = vi.hoisted(() => vi.fn());
const collectOrgRepositories = vi.hoisted(() => vi.fn());
const collectOrgPeople = vi.hoisted(() => vi.fn());
const collectCodeowners = vi.hoisted(() => vi.fn());
const collectDirectAdmins = vi.hoisted(() => vi.fn());

const recordOrgTeams = vi.hoisted(() => vi.fn());
const recordOrgTeamMemberships = vi.hoisted(() => vi.fn());
const recordOrgTeamRepositories = vi.hoisted(() => vi.fn());
const recordOrgRepositories = vi.hoisted(() => vi.fn());
const recordOrgPeople = vi.hoisted(() => vi.fn());
const recordRepositoryOwnership = vi.hoisted(() => vi.fn());

vi.mock("../evidence/store/migrate.ts", () => ({ migrate }));
vi.mock("../evidence/store/prisma.ts", () => ({ prisma: { $disconnect: vi.fn().mockResolvedValue(undefined) } }));
vi.mock("../evidence/policy/load.ts", () => ({ loadConfiguration }));
vi.mock("../evidence/policy/repositories.ts", () => ({
  configuredTeamSlugs: () => new Map(),
  sonarOrganizationName: () => "hmcts"
}));
// The cohort comes from the graph now, so this is where the estate is stubbed. `CohortUncollectedError` is
// re-exported real rather than faked: `doctor` branches on `instanceof`, and a stubbed class would make that
// branch untestable.
vi.mock("../evidence/org/cohort.ts", async () => ({
  ...(await vi.importActual<typeof import("../evidence/org/cohort.ts")>("../evidence/org/cohort.ts")),
  cohortRepositories,
  cohortOwners: async () => new Map(),
  readCohort: async () => [{ repository: "repo-a", owners: ["team"], archived: false, visibility: "public" }]
}));
vi.mock("../evidence/store/collection-state.ts", () => ({ collectionState, stampCollection: vi.fn(), stampRevision }));
vi.mock("../evidence/github/credentials.ts", () => ({ resolveCredentials }));
vi.mock("../evidence/github/client.ts", () => ({ createGitHubClient }));
// The walks and the writers are the two seams `collect-org` is tested at: the walks say what the organisation
// answered and how completely, and the writers are where a run that saw less than the whole thing does its damage.
// The resolution ladder in between is deliberately REAL, so these tests exercise the attribution the writers are
// handed rather than a restatement of it.
vi.mock("../evidence/org/collect.ts", () => ({ collectOrgTeams, collectOrgRepositories, collectOrgPeople, collectCodeowners, collectDirectAdmins }));
vi.mock("../evidence/store/org-graph.ts", () => ({
  recordOrgTeams,
  recordOrgTeamMemberships,
  recordOrgTeamRepositories,
  recordOrgRepositories,
  recordOrgPeople,
  recordRepositoryOwnership
}));

const { main } = await import("./index.ts");

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
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

  /** Inside the operational window whenever this test runs, rather than a date that ages out of it. */
  function recently(): string {
    return new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  }

  function withMergeCounts(perRepository: number[]) {
    loadConfiguration.mockResolvedValue(CONFIG);
    cohortRepositories.mockResolvedValue(["repo-a", "repo-b"]);
    collectionState.mockResolvedValue(undefined);
    resolveCredentials.mockResolvedValue({ token: async () => "t", describe: () => "a personal access token" });

    const counts = [...perRepository];
    createGitHubClient.mockReturnValue({
      get: vi.fn().mockResolvedValue({ default_branch: "master" }),
      graphql: vi.fn().mockImplementation(() => {
        const count = counts.shift() ?? 0;
        return Promise.resolve({
          repository: { pullRequests: { nodes: Array.from({ length: count }, () => ({ mergedAt: recently() })) } }
        });
      }),
      requestsIssued: () => 0,
      callOutcomes: () => []
    });
  }

  it("should diagnose an uncollected graph rather than crashing on it", async () => {
    // The one state `doctor` must survive: it is the command somebody runs against a database they are unsure
    // about, so an empty graph is a finding to report, not an exception to raise.
    withMergeCounts([12, 30]);
    cohortRepositories.mockRejectedValue(new CohortUncollectedError("no organisation graph has been collected for hmcts"));

    await main(["doctor", "--config", "m.yaml"]);

    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("no organisation graph has been collected"));
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining("0 of 0 cohort repositories are readable"));
  });

  it("should pass when the credential can see merged pull requests", async () => {
    withMergeCounts([12, 30]);

    expect(await main(["doctor", "--config", "m.yaml"])).toBe(EXIT_COMPLETE);
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining("GitHub shows 42 merged pull requests"));
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

  it("should not count a merge from outside the operational window", async () => {
    loadConfiguration.mockResolvedValue(CONFIG);
    cohortRepositories.mockResolvedValue(["repo-a"]);
    collectionState.mockResolvedValue(undefined);
    resolveCredentials.mockResolvedValue({ token: async () => "t", describe: () => "a token" });
    createGitHubClient.mockReturnValue({
      get: vi.fn().mockResolvedValue({ default_branch: "master" }),
      graphql: vi.fn().mockResolvedValue({ repository: { pullRequests: { nodes: [{ mergedAt: "2020-01-01T00:00:00Z" }] } } }),
      requestsIssued: () => 0,
      callOutcomes: () => []
    });

    // A repository with history but none of it recent reads as nothing to report, not as a broken credential.
    expect(await main(["doctor", "--config", "m.yaml"])).toBe(EXIT_FAILED);
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining("GitHub shows 0 merged pull requests"));
  });

  it("should treat a query that throws as zero rather than crashing the command", async () => {
    loadConfiguration.mockResolvedValue(CONFIG);
    cohortRepositories.mockResolvedValue(["repo-a"]);
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
      unresolved_repository_limit: 500
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
    } = {}
  ): void {
    loadConfiguration.mockResolvedValue(CONFIG);
    resolveCredentials.mockResolvedValue({ token: async () => "t", describe: () => "a token" });
    createGitHubClient.mockReturnValue({ requestsIssued: () => 0 });

    collectOrgTeams.mockResolvedValue(walks.teams ?? wholeTeamPicture());
    collectOrgRepositories.mockResolvedValue({
      facts: (walks.repositories ?? ["repo-a", "repo-b"]).map(repositoryFact),
      complete: walks.repositoriesComplete ?? true
    });
    collectOrgPeople.mockResolvedValue({ facts: [{ login: "alice", role: "MEMBER" }], complete: walks.peopleComplete ?? true });
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
