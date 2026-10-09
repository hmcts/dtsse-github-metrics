/**
 * What the getters in `api.ts` do with what the report layer hands them.
 *
 * `api.test.ts` asserts the module's shape from its source. This file imports it with the report layer, the notes
 * store and the policy loader stubbed, so the joins written here — contributors folded by login, a team's
 * repositories by every owner, the tri-state production list — are exercised without a database. The module is
 * re-imported per case because it holds the policy document for the life of the process.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepositoryRow, TeamDirectPushRow, TeamMergeRow, TeamRow } from "@/lib/types";

const mocks = vi.hoisted(() => ({
  loadConfiguration: vi.fn(),
  actorRows: vi.fn(),
  directPushRows: vi.fn(),
  mergeRows: vi.fn(),
  overviewSummary: vi.fn(),
  repositoryReport: vi.fn(),
  repositoryRows: vi.fn(),
  repositoryTrend: vi.fn(),
  teamMemberRows: vi.fn(),
  teamRows: vi.fn(),
  windowOptions: vi.fn(),
  addRepositoryNote: vi.fn(),
  deleteRepositoryNote: vi.fn(),
  editRepositoryNote: vi.fn(),
  repositoryNotes: vi.fn()
}));

vi.mock("server-only", () => ({}));
vi.mock("@/evidence/policy/load", () => ({ loadConfiguration: mocks.loadConfiguration }));
vi.mock("@/evidence/report/reports", () => ({
  actorRows: mocks.actorRows,
  directPushRows: mocks.directPushRows,
  mergeRows: mocks.mergeRows,
  overviewSummary: mocks.overviewSummary,
  repositoryReport: mocks.repositoryReport,
  repositoryRows: mocks.repositoryRows,
  repositoryTrend: mocks.repositoryTrend,
  teamMemberRows: mocks.teamMemberRows,
  teamRows: mocks.teamRows,
  windowOptions: mocks.windowOptions
}));
vi.mock("@/evidence/store/notes", () => ({
  addRepositoryNote: mocks.addRepositoryNote,
  deleteRepositoryNote: mocks.deleteRepositoryNote,
  editRepositoryNote: mocks.editRepositoryNote,
  repositoryNotes: mocks.repositoryNotes
}));

const CONFIGURATION = { organization: "hmcts" };

const REPOSITORIES: RepositoryRow[] = [
  { repository: "api", team: "platform", readiness: "green", merged_pull_requests: 3, direct_commits: 1, production: true },
  { repository: "web", team: "platform", teams: ["platform", "civil"], production: false },
  { repository: "own", team: "ada", owner_kind: "person" }
];

function merge(repository: string, number: number, author?: string): TeamMergeRow {
  return { repository, number, merged_at: "2026-10-01T00:00:00Z", ...(author === undefined ? {} : { author }) };
}

function push(repository: string, sha: string, author?: string): TeamDirectPushRow {
  return { repository, sha, committed_at: "2026-10-01T00:00:00Z", ...(author === undefined ? {} : { author }) };
}

const MERGES: TeamMergeRow[] = [
  merge("api", 1, "Ada"),
  merge("api", 2, "ada"),
  merge("api", 3, "bob"),
  merge("web", 4, "carol"),
  merge("api", 5),
  merge("gone", 6, "dan")
];
const PUSHES: TeamDirectPushRow[] = [push("api", "a1", "bob"), push("web", "b2"), push("gone", "c3", "dan")];

async function api(): Promise<typeof import("@/lib/api")> {
  return await import("@/lib/api");
}

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  mocks.loadConfiguration.mockResolvedValue(CONFIGURATION);
  mocks.repositoryRows.mockResolvedValue(REPOSITORIES);
  mocks.mergeRows.mockResolvedValue(MERGES);
  mocks.directPushRows.mockResolvedValue(PUSHES);
  mocks.actorRows.mockResolvedValue([
    { login: "ada", name: "Ada Lovelace", repositories: 1 },
    { login: "bob", repositories: 1 }
  ]);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("the policy document", () => {
  it("should read metrics.yaml when METRICS_CONFIG is unset, and only once", async () => {
    vi.stubEnv("METRICS_CONFIG", undefined);
    mocks.windowOptions.mockResolvedValue({ options: [4] });
    const { getWindows } = await api();

    expect(await getWindows()).toEqual({ options: [4] });
    await getWindows();

    expect(mocks.loadConfiguration).toHaveBeenCalledTimes(1);
    expect(mocks.loadConfiguration).toHaveBeenCalledWith("metrics.yaml");
    expect(mocks.windowOptions).toHaveBeenCalledWith(CONFIGURATION);
  });

  it("should layer every file METRICS_CONFIG names, in order and trimmed", async () => {
    vi.stubEnv("METRICS_CONFIG", "base.yaml, override.yaml");
    mocks.overviewSummary.mockResolvedValue({ weeks: 4 });

    expect(await (await api()).getOverview(4)).toEqual({ weeks: 4 });
    expect(mocks.loadConfiguration).toHaveBeenCalledWith("base.yaml", "override.yaml");
    expect(mocks.overviewSummary).toHaveBeenCalledWith(CONFIGURATION, 4);
  });
});

describe("the pass-through getters", () => {
  it("should hand each its span and the policy document", async () => {
    const { getActors, getRepositories, getTeams, getTrend } = await api();
    mocks.teamRows.mockResolvedValue([]);
    mocks.repositoryTrend.mockResolvedValue({ periods: [] });

    expect(await getRepositories(12)).toBe(REPOSITORIES);
    expect(await getActors(12)).toHaveLength(2);
    expect(await getTeams(12)).toEqual([]);
    expect(await getTrend("api", 6)).toEqual({ periods: [] });
    expect(mocks.repositoryRows).toHaveBeenCalledWith(CONFIGURATION, 12);
    expect(mocks.actorRows).toHaveBeenCalledWith(CONFIGURATION, 12);
    expect(mocks.teamRows).toHaveBeenCalledWith(CONFIGURATION, 12);
    expect(mocks.repositoryTrend).toHaveBeenCalledWith(CONFIGURATION, "api", 6);
  });
});

describe("getRepository", () => {
  it("should refuse a repository no row was built for", async () => {
    const { getRepository, isNotFound } = await api();

    const failure = await getRepository("missing", 4).catch((error: unknown) => error);

    expect(isNotFound(failure)).toBe(true);
    expect(mocks.repositoryReport).not.toHaveBeenCalled();
  });

  it("should attach the evidence block and every contributor, folded by login and weightiest first", async () => {
    mocks.repositoryReport.mockResolvedValue({ evidence: { merge_gate: {} }, contributors: new Map([["ada", [{ key: "size" }]]]) });

    const detail = await (await api()).getRepository("api", 4);

    expect(mocks.repositoryReport).toHaveBeenCalledWith(CONFIGURATION, "api", 4, { pullRequests: true, directCommits: true });
    expect(detail.url).toBe("https://github.com/hmcts/api");
    expect(detail.evidence).toEqual({ merge_gate: {} });
    expect(detail.contributors).toEqual([
      { login: "Ada", name: "Ada Lovelace", contributions: 2, blocking: 0, metrics: [{ key: "size" }] },
      { login: "bob", contributions: 2, blocking: 0, metrics: [] }
    ]);
  });

  it("should leave the evidence absent and say which sources went unread", async () => {
    mocks.repositoryReport.mockResolvedValue({ contributors: new Map() });

    const detail = await (await api()).getRepository("web", 4);

    expect(mocks.repositoryReport).toHaveBeenCalledWith(CONFIGURATION, "web", 4, { pullRequests: false, directCommits: false });
    expect(detail).not.toHaveProperty("evidence");
    expect(detail.contributors).toEqual([{ login: "carol", contributions: 1, blocking: 0, metrics: [] }]);
  });
});

describe("getActor", () => {
  it("should refuse a login that landed nothing", async () => {
    const { getActor, isNotFound } = await api();

    expect(isNotFound(await getActor("nobody", 4).catch((error: unknown) => error))).toBe(true);
  });

  it("should list where they worked, by the first spelling seen, with readiness and production where read", async () => {
    const detail = await (await api()).getActor("ADA", 4);

    expect(detail).toEqual({
      name: "Ada Lovelace",
      actor: {
        actor_login: "Ada",
        repositories: [{ repository: "api", contributions: 2, blocking: 0, metrics: [], readiness: "green" }]
      },
      teams: { api: "platform" },
      production: ["api"]
    });
  });

  it("should order by contributions then name, and leave production absent where no list was read", async () => {
    mocks.repositoryRows.mockResolvedValue([{ repository: "web", team: "platform" }]);
    mocks.mergeRows.mockResolvedValue([merge("web", 1, "dan"), merge("gone", 2, "dan"), merge("api", 3, "dan"), merge("api", 4, "dan")]);
    mocks.directPushRows.mockResolvedValue([]);

    const detail = await (await api()).getActor("dan", 4);

    expect(detail).not.toHaveProperty("name");
    expect(detail).not.toHaveProperty("production");
    expect(detail.actor.repositories.map((row) => row.repository)).toEqual(["api", "gone", "web"]);
    expect(detail.actor.repositories[2]).not.toHaveProperty("readiness");
  });
});

describe("the notes", () => {
  it("should read a repository's notes with their instants as ISO strings", async () => {
    mocks.repositoryNotes.mockResolvedValue([
      {
        id: "n1",
        body: "hello",
        authorName: "Ada",
        authorSubject: "sub",
        createdAt: new Date("2026-10-01T09:00:00Z"),
        updatedAt: new Date("2026-10-02T09:00:00Z")
      }
    ]);

    expect(await (await api()).getRepositoryNotes("api")).toEqual([
      { id: "n1", body: "hello", author_name: "Ada", author_subject: "sub", created_at: "2026-10-01T09:00:00.000Z", updated_at: "2026-10-02T09:00:00.000Z" }
    ]);
    expect(mocks.repositoryNotes).toHaveBeenCalledWith("hmcts", "api");
  });

  it("should add, edit and delete through the store", async () => {
    const { addNote, removeNote, updateNote } = await api();
    mocks.editRepositoryNote.mockResolvedValue(true);
    mocks.deleteRepositoryNote.mockResolvedValue(false);

    await addNote("api", "hello", { subject: "sub", name: "Ada" });

    expect(mocks.addRepositoryNote).toHaveBeenCalledWith({ organization: "hmcts", repository: "api", body: "hello", authorSubject: "sub", authorName: "Ada" });
    expect(await updateNote("n1", "edited")).toBe(true);
    expect(mocks.editRepositoryNote).toHaveBeenCalledWith("n1", "edited");
    expect(await removeNote("n1")).toBe(false);
    expect(mocks.deleteRepositoryNote).toHaveBeenCalledWith("n1");
  });
});

describe("getTeam", () => {
  const TEAMS: TeamRow[] = [
    { team: "platform", repositories: 2, unavailable: 0, actors: 3, labels: {} },
    { team: "civil", repositories: 1, unavailable: 0, actors: 1, labels: {} }
  ];

  it("should refuse a name no card was drawn for", async () => {
    mocks.teamRows.mockResolvedValue(TEAMS);
    const { getTeam, isNotFound } = await api();

    expect(isNotFound(await getTeam("ada", 4).catch((error: unknown) => error))).toBe(true);
  });

  it("should list every repository the team owns, its changes, members and contributors", async () => {
    mocks.teamRows.mockResolvedValue(TEAMS);
    mocks.teamMemberRows.mockResolvedValue(new Map([["platform", [{ login: "ada", role: "MEMBER" }]]]));

    const detail = await (await api()).getTeam("platform", 4);

    expect(detail.repositories.map((row) => row.repository)).toEqual(["api", "web"]);
    expect(detail.merges?.map((row) => row.number)).toEqual([1, 2, 3, 4, 5]);
    expect(detail.direct_pushes?.map((row) => row.sha)).toEqual(["a1", "b2"]);
    expect(detail.members).toEqual([{ login: "ada", role: "MEMBER" }]);
    expect(detail.actors).toEqual([
      { login: "Ada", name: "Ada Lovelace", repositories: 1, contributions: 2 },
      { login: "bob", repositories: 1, contributions: 2 },
      { login: "carol", repositories: 1, contributions: 1 }
    ]);
  });

  it("should leave the members absent where the membership was never read", async () => {
    mocks.teamRows.mockResolvedValue(TEAMS);
    mocks.teamMemberRows.mockResolvedValue(new Map());

    const detail = await (await api()).getTeam("civil", 4);

    expect(detail).not.toHaveProperty("members");
    expect(detail.repositories.map((row) => row.repository)).toEqual(["web"]);
  });
});

describe("getTeamContributors", () => {
  it("should file each change's author under every team owning its repository, and nobody's own repository under none", async () => {
    mocks.mergeRows.mockResolvedValue([...MERGES, merge("own", 7, "ada")]);

    expect(await (await api()).getTeamContributors(4)).toEqual({
      platform: [
        { login: "Ada", name: "Ada Lovelace", repositories: 1, contributions: 2 },
        { login: "bob", repositories: 1, contributions: 2 },
        { login: "carol", repositories: 1, contributions: 1 }
      ],
      civil: [{ login: "carol", repositories: 1, contributions: 1 }]
    });
  });
});
