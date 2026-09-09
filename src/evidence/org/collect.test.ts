import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGitHubClient } from "../github/client.ts";
import { personalAccessToken } from "../github/credentials.ts";
import { collectCodeowners, collectDirectAdmins, collectOrgPeople, collectOrgRepositories, collectOrgTeams } from "./collect.ts";
import { CodeownersPaths } from "./graph.ts";
import {
  DefaultOwnershipBatchSize,
  orgPeopleQuery,
  orgQuerySignature,
  orgRepositoriesQuery,
  orgTeamsQuery,
  ownershipFilesQuery,
  teamMembersQuery,
  teamRepositoriesQuery
} from "./queries.ts";

// Every case drives a stubbed `fetch`, so nothing here reaches GitHub, and the injected clock and pause mean
// nothing sleeps. Same helpers as `behaviour/collect.test.ts` and `github/client.test.ts`, extended to record
// the URL as well as the document, because this collector issues REST calls too.

interface Reply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

function replying(...replies: Reply[]): { fetch: typeof globalThis.fetch; sent: { url: string; query: string; variables: Record<string, unknown> }[] } {
  const queue = [...replies];
  const sent: { url: string; query: string; variables: Record<string, unknown> }[] = [];
  const fetch = vi.fn((url: string | URL, init?: RequestInit) => {
    const parsed =
      init?.body === undefined ? { query: "", variables: {} } : (JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> });
    sent.push({ url: String(url), query: parsed.query, variables: parsed.variables });
    const next = queue.shift() ?? { status: 200, body: {} };
    const body = typeof next.body === "string" ? next.body : JSON.stringify(next.body ?? {});
    return Promise.resolve(new Response(body, { status: next.status ?? 200, headers: { "content-type": "application/json", ...next.headers } }));
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, sent };
}

/** One successful GraphQL reply carrying `data`. */
function graphql(data: unknown): Reply {
  return { status: 200, body: { data } };
}

/** GitHub's answer to a token that may not look: a refusal, not a rate limit, so it is not retried. */
const REFUSED: Reply = { status: 403, body: { message: "Forbidden" } };

function client(fetch: typeof globalThis.fetch) {
  return createGitHubClient({ credentials: personalAccessToken("ghp_test"), fetch, pause: () => Promise.resolve(), clock: () => 1000 });
}

const PAGE_END = { hasNextPage: false, endCursor: null };
const PAGE_MORE = { hasNextPage: true, endCursor: "MORE" };

function memberEdge(login: string, role: string | null = "MEMBER") {
  return { role, node: { login } };
}

function repositoryEdge(name: string, permission: string | null) {
  return { permission, node: { name, isArchived: false } };
}

function teamNode(overrides: Record<string, unknown> = {}) {
  return {
    slug: "appreg",
    name: "AppReg",
    description: "Application registration",
    privacy: "VISIBLE",
    parentTeam: null,
    members: { totalCount: 1, pageInfo: PAGE_END, edges: [memberEdge("alice", "MAINTAINER")] },
    repositories: { totalCount: 1, pageInfo: PAGE_END, edges: [repositoryEdge("rd-professional-api", "WRITE")] },
    ...overrides
  };
}

function teams(nodes: unknown[], overrides: Record<string, unknown> = {}) {
  return { organization: { teams: { totalCount: nodes.length, pageInfo: PAGE_END, nodes, ...overrides } } };
}

function repositoryNode(overrides: Record<string, unknown> = {}) {
  return {
    name: "pcs-api",
    isArchived: false,
    isFork: false,
    visibility: "PUBLIC",
    pushedAt: "2026-08-30T09:00:00Z",
    defaultBranchRef: { name: "main" },
    ...overrides
  };
}

function repositories(nodes: unknown[], overrides: Record<string, unknown> = {}) {
  return { organization: { repositories: { totalCount: nodes.length, pageInfo: PAGE_END, nodes, ...overrides } } };
}

function people(edges: unknown[], overrides: Record<string, unknown> = {}) {
  return { organization: { membersWithRole: { totalCount: edges.length, pageInfo: PAGE_END, edges, ...overrides } } };
}

/** One blob, at whichever `CodeownersPaths` position the caller puts it. */
function blob(text: string, overrides: Record<string, unknown> = {}) {
  return { text, byteSize: text.length, isTruncated: false, ...overrides };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "debug").mockImplementation(() => undefined);
  // The client writes its per-call progress to stderr rather than through `console`, so that a command whose
  // product is a document can have stdout redirected. Silenced the same way, and here rather than globally:
  // a test that means to assert on stderr should have to say so.
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

describe("documents", () => {
  it("should ask for immediate team membership only, on the bulk walk and its continuation alike", () => {
    // The single most consequential parameter in the file: GitHub's default `ALL` folds every descendant team's
    // people into the parent, and both documents have to say so or the continuation undoes the bulk walk.
    expect(orgTeamsQuery()).toContain("membership: IMMEDIATE");
    expect(teamMembersQuery()).toContain("membership: IMMEDIATE");
  });

  it("should state rootTeamsOnly rather than rely on the default, because the estate's teams nest", () => {
    expect(orgTeamsQuery()).toContain("rootTeamsOnly: false");
  });

  it("should order both nested connections, so a paged walk cannot re-serve one member as two", () => {
    expect(orgTeamsQuery()).toContain("orderBy: { field: LOGIN, direction: ASC }");
    expect(orgTeamsQuery()).toContain("orderBy: { field: NAME, direction: ASC }");
  });

  it.each([
    ["organisation teams", orgTeamsQuery()],
    ["team members", teamMembersQuery()],
    ["team repositories", teamRepositoriesQuery()],
    ["organisation repositories", orgRepositoriesQuery()],
    ["organisation people", orgPeopleQuery()],
    ["ownership files", ownershipFilesQuery(2)]
  ])("should report what the %s document cost", (_what, document) => {
    expect(document).toContain("rateLimit { cost limit remaining resetAt }");
  });

  it("should keep the repository walk flat, with no connection multiplying its node count", () => {
    // One node per repository is what earns `first: 100`; topics, blobs and collaborators are each a connection.
    expect(orgRepositoriesQuery()).not.toContain("repositoryTopics");
    expect(orgRepositoriesQuery()).not.toContain("object(expression");
    expect(orgRepositoriesQuery()).not.toContain("collaborators");
  });

  it("should carry repository names as variables and aliases, never as document text", () => {
    const document = ownershipFilesQuery(2);

    expect(document).toContain("$r0: String!");
    expect(document).toContain("$r1: String!");
    expect(document).toContain("f0: repository(owner: $organization, name: $r0)");
    expect(document).toContain("f1: repository(owner: $organization, name: $r1)");
  });

  it("should read every path GitHub resolves CODEOWNERS from", () => {
    const document = ownershipFilesQuery(1);

    for (const path of CodeownersPaths) {
      expect(document).toContain(`object(expression: "HEAD:${path}")`);
    }
  });

  it("should build one document per batch size and reuse it", () => {
    expect(ownershipFilesQuery(4)).toBe(ownershipFilesQuery(4));
    expect(ownershipFilesQuery(4)).not.toBe(ownershipFilesQuery(5));
  });

  it("should default to a batch of 25 repositories", () => {
    expect(ownershipFilesQuery()).toBe(ownershipFilesQuery(DefaultOwnershipBatchSize));
  });

  it("should read whether a blob was truncated, since a truncated one is refused rather than parsed", () => {
    expect(ownershipFilesQuery(1)).toContain("isTruncated");
  });
});

describe("orgQuerySignature", () => {
  it("should be sixteen hex characters", () => {
    expect(orgQuerySignature()).toMatch(/^[0-9a-f]{16}$/);
  });

  it("should be stable across calls, so a reader and a writer agree", () => {
    expect(orgQuerySignature()).toBe(orgQuerySignature());
  });
});

describe("collectOrgTeams", () => {
  it("should convert a page of teams into facts", async () => {
    const { fetch } = replying(graphql(teams([teamNode({ parentTeam: { slug: "rd" } })])));

    const facts = await collectOrgTeams(client(fetch), "hmcts");

    expect(facts.teamsRead).toBe(true);
    expect(facts.knownTeams).toEqual(new Set(["appreg"]));
    expect(facts.teams).toEqual([{ slug: "appreg", name: "AppReg", description: "Application registration", privacy: "VISIBLE", parentSlug: "rd" }]);
    expect(facts.memberships).toEqual([{ teamSlug: "appreg", login: "alice", role: "MAINTAINER" }]);
  });

  it("should map GitHub's WRITE onto the ladder's push, so the teams-api-write rung is not emptied", async () => {
    // GraphQL words the level WRITE; `AccessLevels`, the REST API and the Python original all word it `push`.
    // Lower-casing alone yields `write`, which `isOwningAccess` rejects — silently dropping every ordinary
    // write-access claim in the organisation.
    const { fetch } = replying(graphql(teams([teamNode()])));

    const facts = await collectOrgTeams(client(fetch), "hmcts");

    expect(facts.teamRepositories).toEqual([{ teamSlug: "appreg", repository: "rd-professional-api", access: "push" }]);
  });

  it.each([
    ["ADMIN", "admin"],
    ["MAINTAIN", "maintain"],
    ["WRITE", "push"],
    ["push", "push"]
  ])("should read %s as %s", async (permission, access) => {
    const { fetch } = replying(
      graphql(teams([teamNode({ repositories: { totalCount: 1, pageInfo: PAGE_END, edges: [repositoryEdge("pcs-api", permission)] } })]))
    );

    const facts = await collectOrgTeams(client(fetch), "hmcts");

    expect(facts.teamRepositories).toEqual([{ teamSlug: "appreg", repository: "pcs-api", access }]);
  });

  it.each(["READ", "TRIAGE"])("should drop %s, which is permission to look rather than ownership", async (permission) => {
    const { fetch } = replying(
      graphql(teams([teamNode({ repositories: { totalCount: 1, pageInfo: PAGE_END, edges: [repositoryEdge("pcs-api", permission)] } })]))
    );

    expect((await collectOrgTeams(client(fetch), "hmcts")).teamRepositories).toEqual([]);
  });

  it("should ignore a permission it cannot place rather than demoting it to pull", async () => {
    const { fetch } = replying(
      graphql(teams([teamNode({ repositories: { totalCount: 1, pageInfo: PAGE_END, edges: [repositoryEdge("pcs-api", "SUPERUSER")] } })]))
    );

    expect((await collectOrgTeams(client(fetch), "hmcts")).teamRepositories).toEqual([]);
  });

  it("should fold one repository held twice under different case, keeping the most permissive access", async () => {
    const { fetch } = replying(
      graphql(
        teams([
          teamNode({
            repositories: { totalCount: 2, pageInfo: PAGE_END, edges: [repositoryEdge("PCS-api", "WRITE"), repositoryEdge("pcs-api", "ADMIN")] }
          })
        ])
      )
    );

    expect((await collectOrgTeams(client(fetch), "hmcts")).teamRepositories).toEqual([{ teamSlug: "appreg", repository: "PCS-api", access: "admin" }]);
  });

  it("should report a refusal to list teams at all and return teamsRead false", async () => {
    // Not thrown: CODEOWNERS files and repository names can still attribute most of the estate, and a graph
    // covering every repository on weaker evidence beats an exit covering none.
    const { fetch } = replying(REFUSED);

    const facts = await collectOrgTeams(client(fetch), "hmcts");

    expect(facts).toEqual({
      teamsRead: false,
      // NOT complete: a refused team list is the case where an absence must not be read as a deletion, so the
      // writer is told it observed nothing rather than told the organisation has no teams.
      teamsComplete: false,
      knownTeams: new Set(),
      teams: [],
      memberships: [],
      teamRepositories: [],
      membershipsObserved: new Set(),
      teamRepositoriesObserved: new Set()
    });
  });

  it("should return teamsRead false when GitHub names no organisation", async () => {
    const { fetch } = replying(graphql({ organization: null }));

    expect((await collectOrgTeams(client(fetch), "hmcts")).teamsRead).toBe(false);
  });

  it("should keep a team whose repositories were refused in knownTeams", async () => {
    // A team whose repositories nobody was allowed to list is a team that EXISTS, and `knownTeams` is what a
    // CODEOWNERS handle is checked against: dropping it would make every mention of it unrecognised.
    const { fetch } = replying(
      graphql(teams([teamNode({ repositories: { totalCount: 900, pageInfo: PAGE_MORE, edges: [repositoryEdge("pcs-api", "ADMIN")] } })])),
      REFUSED
    );

    const facts = await collectOrgTeams(client(fetch), "hmcts");

    expect(facts.teamsRead).toBe(true);
    expect(facts.knownTeams).toEqual(new Set(["appreg"]));
    expect(facts.teams).toHaveLength(1);
    expect(facts.teamRepositories).toEqual([]);
  });

  it("should keep a team whose members were refused in knownTeams", async () => {
    const { fetch } = replying(graphql(teams([teamNode({ members: { totalCount: 200, pageInfo: PAGE_MORE, edges: [memberEdge("alice")] } })])), REFUSED);

    const facts = await collectOrgTeams(client(fetch), "hmcts");

    expect(facts.knownTeams).toEqual(new Set(["appreg"]));
    expect(facts.memberships).toEqual([]);
  });

  it("should issue exactly one continuation for an overflowing member connection", async () => {
    const { fetch, sent } = replying(
      graphql(teams([teamNode({ members: { totalCount: 51, pageInfo: PAGE_MORE, edges: [memberEdge("alice")] } })])),
      graphql({ organization: { team: { members: { pageInfo: PAGE_END, edges: [memberEdge("bob", "MAINTAINER")] } } } })
    );

    const facts = await collectOrgTeams(client(fetch), "hmcts");

    expect(facts.memberships.map((membership) => membership.login)).toEqual(["alice", "bob"]);
    expect(sent).toHaveLength(2);
    expect(sent[1]?.query).toContain("query TeamMembers");
    expect(sent[1]?.variables).toEqual({ organization: "hmcts", slug: "appreg", cursor: "MORE" });
  });

  it("should issue exactly one continuation for an overflowing repository connection", async () => {
    const { fetch, sent } = replying(
      graphql(teams([teamNode({ repositories: { totalCount: 51, pageInfo: PAGE_MORE, edges: [repositoryEdge("pcs-api", "ADMIN")] } })])),
      graphql({ organization: { team: { repositories: { pageInfo: PAGE_END, edges: [repositoryEdge("pcs-frontend", "WRITE")] } } } })
    );

    const facts = await collectOrgTeams(client(fetch), "hmcts");

    expect(facts.teamRepositories.map((held) => held.repository)).toEqual(["pcs-api", "pcs-frontend"]);
    expect(sent).toHaveLength(2);
    expect(sent[1]?.query).toContain("query TeamRepositories");
  });

  it("should not re-serve a member the first page already held", async () => {
    const { fetch } = replying(
      graphql(teams([teamNode({ members: { totalCount: 2, pageInfo: PAGE_MORE, edges: [memberEdge("Alice")] } })])),
      graphql({ organization: { team: { members: { pageInfo: PAGE_END, edges: [memberEdge("alice")] } } } })
    );

    expect((await collectOrgTeams(client(fetch), "hmcts")).memberships).toHaveLength(1);
  });

  it("should stop continuing when GitHub omits the team, keeping the members already read", async () => {
    const { fetch, sent } = replying(
      graphql(teams([teamNode({ members: { totalCount: 51, pageInfo: PAGE_MORE, edges: [memberEdge("alice")] } })])),
      graphql({ organization: { team: null } })
    );

    const facts = await collectOrgTeams(client(fetch), "hmcts");

    expect(facts.memberships.map((membership) => membership.login)).toEqual(["alice"]);
    expect(sent).toHaveLength(2);
  });

  it("should stop continuing when GitHub omits the team's repositories, keeping what was read", async () => {
    const { fetch } = replying(
      graphql(teams([teamNode({ repositories: { totalCount: 101, pageInfo: PAGE_MORE, edges: [repositoryEdge("pcs-api", "ADMIN")] } })])),
      graphql({ organization: null })
    );

    expect((await collectOrgTeams(client(fetch), "hmcts")).teamRepositories).toEqual([{ teamSlug: "appreg", repository: "pcs-api", access: "admin" }]);
  });

  it("should walk every page of teams", async () => {
    const { fetch, sent } = replying(
      graphql(teams([teamNode()], { pageInfo: PAGE_MORE })),
      graphql(teams([teamNode({ slug: "dtsse", name: "DTSSE", members: { totalCount: 0, pageInfo: PAGE_END, edges: [] } })]))
    );

    const facts = await collectOrgTeams(client(fetch), "hmcts");

    expect(facts.teams.map((team) => team.slug)).toEqual(["appreg", "dtsse"]);
    expect(sent[1]?.variables).toEqual({ organization: "hmcts", cursor: "MORE" });
  });

  it("should keep the teams already read when a later page fails, and still report teamsRead", async () => {
    // `teamsRead` answers "was this token allowed to list teams", which the first successful page settles.
    const { fetch } = replying(graphql(teams([teamNode()], { pageInfo: PAGE_MORE })), REFUSED);

    const facts = await collectOrgTeams(client(fetch), "hmcts");

    expect(facts.teamsRead).toBe(true);
    expect(facts.teams.map((team) => team.slug)).toEqual(["appreg"]);
  });

  it("should skip a team GitHub returned as null, and an edge it would not name a node for", async () => {
    const { fetch } = replying(
      graphql(
        teams([
          null,
          teamNode({
            members: { totalCount: 2, pageInfo: PAGE_END, edges: [null, { role: "MEMBER", node: null }, memberEdge("alice")] },
            repositories: { totalCount: 2, pageInfo: PAGE_END, edges: [null, { permission: "ADMIN", node: null }] }
          })
        ])
      )
    );

    const facts = await collectOrgTeams(client(fetch), "hmcts");

    expect(facts.teams).toHaveLength(1);
    expect(facts.memberships).toEqual([{ teamSlug: "appreg", login: "alice", role: "MEMBER" }]);
    expect(facts.teamRepositories).toEqual([]);
  });

  it("should default a role GitHub did not name to MEMBER, never inventing a maintainer", async () => {
    const { fetch } = replying(graphql(teams([teamNode({ members: { totalCount: 1, pageInfo: PAGE_END, edges: [memberEdge("alice", null)] } })])));

    expect((await collectOrgTeams(client(fetch), "hmcts")).memberships).toEqual([{ teamSlug: "appreg", login: "alice", role: "MEMBER" }]);
  });

  it("should stand the slug in for a team with no display name", async () => {
    const { fetch } = replying(graphql(teams([teamNode({ name: null, description: "", privacy: null })])));

    expect((await collectOrgTeams(client(fetch), "hmcts")).teams).toEqual([{ slug: "appreg", name: "appreg" }]);
  });

  it("should report a body it cannot parse as a refusal rather than crashing the walk", async () => {
    const { fetch } = replying(graphql({ organization: { teams: { nodes: [{ slug: 7 }] } } }));

    expect((await collectOrgTeams(client(fetch), "hmcts")).teamsRead).toBe(false);
  });
});

describe("collectOrgRepositories", () => {
  it("should convert nodes into facts", async () => {
    const { fetch } = replying(graphql(repositories([repositoryNode()])));

    expect((await collectOrgRepositories(client(fetch), "hmcts")).facts).toEqual([
      { name: "pcs-api", archived: false, isFork: false, visibility: "PUBLIC", defaultBranch: "main", pushedAt: new Date("2026-08-30T09:00:00Z") }
    ]);
  });

  it("should refuse a body carrying an instant it cannot read, rather than storing a broken date", async () => {
    const { fetch } = replying(graphql(repositories([repositoryNode({ pushedAt: "the day before yesterday" })])));

    expect((await collectOrgRepositories(client(fetch), "hmcts")).facts).toEqual([]);
  });

  it("should read an absent flag as the answer that excludes nothing", async () => {
    const { fetch } = replying(
      graphql(repositories([{ name: "empty-repo", isArchived: null, isFork: null, visibility: null, pushedAt: null, defaultBranchRef: null }]))
    );

    expect((await collectOrgRepositories(client(fetch), "hmcts")).facts).toEqual([{ name: "empty-repo", archived: false, isFork: false, visibility: "" }]);
  });

  it("should walk every page", async () => {
    const { fetch, sent } = replying(
      graphql(repositories([repositoryNode()], { pageInfo: PAGE_MORE })),
      graphql(repositories([repositoryNode({ name: "pcs-frontend" })]))
    );

    expect((await collectOrgRepositories(client(fetch), "hmcts")).facts.map((repository) => repository.name)).toEqual(["pcs-api", "pcs-frontend"]);
    expect(sent[1]?.variables).toEqual({ organization: "hmcts", cursor: "MORE" });
  });

  it("should keep the repositories already read when a page fails", async () => {
    const { fetch } = replying(graphql(repositories([repositoryNode()], { pageInfo: PAGE_MORE })), REFUSED);

    expect((await collectOrgRepositories(client(fetch), "hmcts")).facts.map((repository) => repository.name)).toEqual(["pcs-api"]);
  });

  it("should report an organisation GitHub named no repositories connection for", async () => {
    const { fetch } = replying(graphql({ organization: null }));

    expect((await collectOrgRepositories(client(fetch), "hmcts")).facts).toEqual([]);
  });

  it("should skip a node GitHub returned as null", async () => {
    const { fetch } = replying(graphql(repositories([null, repositoryNode()])));

    expect((await collectOrgRepositories(client(fetch), "hmcts")).facts).toHaveLength(1);
  });
});

describe("collectOrgPeople", () => {
  it("should convert edges into facts", async () => {
    const { fetch } = replying(
      graphql(people([{ role: "ADMIN", node: { login: "alice", name: "Alice Smith", email: "alice@example.com", company: "HMCTS" } }]))
    );

    expect((await collectOrgPeople(client(fetch), "hmcts")).facts).toEqual([
      { login: "alice", role: "ADMIN", name: "Alice Smith", email: "alice@example.com", company: "HMCTS" }
    ]);
  });

  it("should omit the self-reported fields when they are blank", async () => {
    const { fetch } = replying(graphql(people([{ role: "MEMBER", node: { login: "bob", name: "", email: null, company: "   " } }])));

    expect((await collectOrgPeople(client(fetch), "hmcts")).facts).toEqual([{ login: "bob", role: "MEMBER" }]);
  });

  it("should default a role GitHub did not name to MEMBER", async () => {
    const { fetch } = replying(graphql(people([{ role: null, node: { login: "bob" } }])));

    expect((await collectOrgPeople(client(fetch), "hmcts")).facts).toEqual([{ login: "bob", role: "MEMBER" }]);
  });

  it("should count one login written two ways as one person", async () => {
    const { fetch } = replying(
      graphql(people([{ role: "MEMBER", node: { login: "Alice" } }, { role: "ADMIN", node: { login: "alice" } }, null, { role: "MEMBER", node: null }]))
    );

    expect((await collectOrgPeople(client(fetch), "hmcts")).facts).toEqual([{ login: "alice", role: "ADMIN" }]);
  });

  it("should walk every page and keep what was read when one fails", async () => {
    const { fetch } = replying(graphql(people([{ role: "MEMBER", node: { login: "alice" } }], { pageInfo: PAGE_MORE })), REFUSED);

    expect((await collectOrgPeople(client(fetch), "hmcts")).facts).toHaveLength(1);
  });

  it("should report an organisation GitHub named no membership connection for", async () => {
    const { fetch } = replying(graphql({ organization: {} }));

    expect((await collectOrgPeople(client(fetch), "hmcts")).facts).toEqual([]);
  });
});

describe("collectCodeowners", () => {
  it("should read the owners one repository's CODEOWNERS names", async () => {
    const { fetch, sent } = replying(graphql({ f0: { name: "pcs-api", p0: blob("* @hmcts/dtsse @alice\n"), p1: null, p2: null } }));

    const facts = await collectCodeowners(client(fetch), "hmcts", ["pcs-api"]);

    expect(facts.get("pcs-api")).toEqual({ repository: "pcs-api", teams: ["dtsse"], people: ["alice"], paths: [".github/CODEOWNERS"] });
    expect(sent[0]?.variables).toEqual({ organization: "hmcts", r0: "pcs-api" });
  });

  it("should record no entry for a repository with no CODEOWNERS file, keeping absent apart from refused", async () => {
    const { fetch } = replying(graphql({ f0: { name: "pcs-api", p0: null, p1: null, p2: null } }));

    const facts = await collectCodeowners(client(fetch), "hmcts", ["pcs-api"]);

    expect(facts.has("pcs-api")).toBe(false);
  });

  it("should record a file that was read and names nobody as read, not as absent", async () => {
    const { fetch } = replying(graphql({ f0: { name: "pcs-api", p0: blob("# nobody owns this yet\n"), p1: null, p2: null } }));

    expect(await collectCodeowners(client(fetch), "hmcts", ["pcs-api"]).then((facts) => facts.get("pcs-api"))).toEqual({
      repository: "pcs-api",
      teams: [],
      people: [],
      paths: [".github/CODEOWNERS"]
    });
  });

  it("should refuse a truncated blob rather than parsing half a CODEOWNERS file", async () => {
    // Half a file parses perfectly and resolves to the owners in its first half: a confident wrong answer, and
    // a subset naming one team would fire the sole-owner rung for a repository whose file names four.
    const { fetch } = replying(
      graphql({ f0: { name: "big-repo", p0: blob("* @hmcts/dtsse\n", { isTruncated: true, byteSize: 1_048_576 }), p1: null, p2: null } })
    );

    const fact = (await collectCodeowners(client(fetch), "hmcts", ["big-repo"])).get("big-repo");

    expect(fact?.refusal).toContain("truncated");
    expect(fact).toMatchObject({ teams: [], people: [], paths: [] });
  });

  it("should refuse a truncated blob even when another path read cleanly", async () => {
    const { fetch } = replying(
      graphql({ f0: { name: "big-repo", p0: blob("* @hmcts/dtsse\n"), p1: blob("* @hmcts/appreg\n", { isTruncated: true, byteSize: null }), p2: null } })
    );

    const fact = (await collectCodeowners(client(fetch), "hmcts", ["big-repo"])).get("big-repo");

    expect(fact?.refusal).toContain("an unreported size");
    expect(fact?.teams).toEqual([]);
  });

  it("should merge the owners of every path a repository carries", async () => {
    const { fetch } = replying(graphql({ f0: { name: "pcs-api", p0: blob("* @hmcts/dtsse\n"), p1: blob("* @hmcts/appreg\n"), p2: null } }));

    expect((await collectCodeowners(client(fetch), "hmcts", ["pcs-api"])).get("pcs-api")).toEqual({
      repository: "pcs-api",
      teams: ["appreg", "dtsse"],
      people: [],
      paths: [".github/CODEOWNERS", "CODEOWNERS"]
    });
  });

  it("should record a refusal when GitHub names no repository for an alias", async () => {
    const { fetch } = replying(graphql({ f0: null }));

    expect((await collectCodeowners(client(fetch), "hmcts", ["gone-repo"])).get("gone-repo")?.refusal).toContain("named no repository");
  });

  it("should refuse an answer whose repository is not the one that was asked for", async () => {
    // The one check guarding the aliasing scheme: read off by one, every owner in a batch belongs to the wrong
    // repository, and nothing else in the response would say so.
    const { fetch } = replying(graphql({ f0: { name: "another-repo", p0: blob("* @hmcts/dtsse\n") } }));

    const fact = (await collectCodeowners(client(fetch), "hmcts", ["pcs-api"])).get("pcs-api");

    expect(fact?.refusal).toContain("another-repo");
    expect(fact?.teams).toEqual([]);
  });

  it("should accept GitHub's own spelling of the name it echoes back", async () => {
    const { fetch } = replying(graphql({ f0: { name: "PCS-Api", p0: blob("* @hmcts/dtsse\n") } }));

    expect((await collectCodeowners(client(fetch), "hmcts", ["pcs-api"])).get("pcs-api")?.teams).toEqual(["dtsse"]);
  });

  it("should batch through the repositories it was given", async () => {
    const { fetch, sent } = replying(
      graphql({ f0: { name: "a", p0: blob("* @hmcts/dtsse\n") }, f1: { name: "b", p0: null } }),
      graphql({ f0: { name: "c", p0: blob("* @hmcts/appreg\n") } })
    );

    const facts = await collectCodeowners(client(fetch), "hmcts", ["a", "b", "c"], 2);

    expect(sent).toHaveLength(2);
    expect(sent[0]?.variables).toEqual({ organization: "hmcts", r0: "a", r1: "b" });
    expect(sent[1]?.variables).toEqual({ organization: "hmcts", r0: "c" });
    expect([...facts.keys()]).toEqual(["a", "c"]);
  });

  it("should re-read a failing batch one at a time, so one unreadable repository does not refuse the others", async () => {
    const { fetch, sent } = replying(REFUSED, graphql({ f0: { name: "a", p0: blob("* @hmcts/dtsse\n") } }), REFUSED);

    const facts = await collectCodeowners(client(fetch), "hmcts", ["a", "b"], 2);

    expect(sent).toHaveLength(3);
    expect(facts.get("a")).toMatchObject({ teams: ["dtsse"] });
    expect(facts.get("b")?.refusal).toBeDefined();
  });

  it("should not split a batch of one, so a failing repository costs exactly one retry pass", async () => {
    const { fetch, sent } = replying(REFUSED);

    const facts = await collectCodeowners(client(fetch), "hmcts", ["a"], 1);

    expect(sent).toHaveLength(1);
    expect(facts.get("a")?.refusal).toBeDefined();
  });

  it("should read a batch size below one as a batch of one rather than looping forever", async () => {
    const { fetch, sent } = replying(graphql({ f0: { name: "a", p0: null } }));

    await collectCodeowners(client(fetch), "hmcts", ["a"], 0);

    expect(sent).toHaveLength(1);
  });

  it("should ask GitHub nothing when it was given no repositories", async () => {
    const { fetch, sent } = replying();

    expect((await collectCodeowners(client(fetch), "hmcts", [])).size).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it("should record a refusal for a blob body it cannot read", async () => {
    const { fetch } = replying(graphql({ f0: { name: "pcs-api", p0: { text: 7 } } }));

    expect((await collectCodeowners(client(fetch), "hmcts", ["pcs-api"])).get("pcs-api")?.refusal).toBeDefined();
  });
});

describe("collectDirectAdmins", () => {
  it("should list the people holding admin directly", async () => {
    const { fetch, sent } = replying({
      body: [
        { login: "Alice", type: "User" },
        { login: "bob", type: "User" }
      ]
    });

    const admins = await collectDirectAdmins(client(fetch), "hmcts", ["pcs-api"]);

    expect(admins.get("pcs-api")).toEqual(["alice", "bob"]);
    expect(sent[0]?.url).toContain("/repos/hmcts/pcs-api/collaborators");
    expect(sent[0]?.url).toContain("affiliation=direct");
    expect(sent[0]?.url).toContain("permission=admin");
  });

  it("should exclude bot accounts, however GitHub types them", async () => {
    // `dependabot[bot]` holds admin on a fair number of repositories and owns none of them.
    const { fetch } = replying({
      body: [
        { login: "dependabot[bot]", type: "Bot" },
        { login: "renovate[bot]", type: "User" },
        { login: "alice", type: "User" }
      ]
    });

    expect((await collectDirectAdmins(client(fetch), "hmcts", ["pcs-api"])).get("pcs-api")).toEqual(["alice"]);
  });

  it("should record an empty list for a repository whose only direct admins are bots", async () => {
    // An entry, not an absence: "read, and nobody" is a different answer from "nobody could look".
    const { fetch } = replying({ body: [{ login: "dependabot[bot]", type: "Bot" }] });

    expect((await collectDirectAdmins(client(fetch), "hmcts", ["pcs-api"])).get("pcs-api")).toEqual([]);
  });

  it("should record no entry for a repository whose collaborators could not be listed", async () => {
    const { fetch } = replying(REFUSED);

    expect((await collectDirectAdmins(client(fetch), "hmcts", ["pcs-api"])).has("pcs-api")).toBe(false);
  });

  it("should follow GitHub's pagination", async () => {
    const { fetch, sent } = replying(
      {
        body: [{ login: "alice", type: "User" }],
        headers: { link: '<https://api.github.com/repos/hmcts/pcs-api/collaborators?page=2>; rel="next"' }
      },
      { body: [{ login: "bob", type: "User" }] }
    );

    expect((await collectDirectAdmins(client(fetch), "hmcts", ["pcs-api"])).get("pcs-api")).toEqual(["alice", "bob"]);
    expect(sent).toHaveLength(2);
  });

  it("should skip an entry GitHub returned as null", async () => {
    const { fetch } = replying({ body: [null, { login: "alice", type: null }] });

    expect((await collectDirectAdmins(client(fetch), "hmcts", ["pcs-api"])).get("pcs-api")).toEqual(["alice"]);
  });

  it("should read every repository it was given", async () => {
    const { fetch, sent } = replying({ body: [{ login: "alice", type: "User" }] }, { body: [] });

    const admins = await collectDirectAdmins(client(fetch), "hmcts", ["pcs-api", "pcs-frontend"]);

    expect([...admins.keys()]).toEqual(["pcs-api", "pcs-frontend"]);
    expect(sent).toHaveLength(2);
  });
});
