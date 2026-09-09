import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { OwnerKind, OwnershipRung, type PersonFact, type RepositoryFact, type ResolvedOwnership, type TeamFact } from "../../src/evidence/org/graph.ts";
import { collectionState, stampCollection, stampRevision } from "../../src/evidence/store/collection-state.ts";
import {
  liveOrgPeople,
  liveOrgRepositories,
  liveOrgTeams,
  liveRepositoryOwnership,
  liveTeamMemberships,
  liveTeamRepositories,
  recordOrgPeople,
  recordOrgRepositories,
  recordOrgTeamMemberships,
  recordOrgTeamRepositories,
  recordOrgTeams,
  recordRepositoryOwnership
} from "../../src/evidence/store/org-graph.ts";
import { prisma } from "../../src/evidence/store/prisma.ts";

// The reconcile decision is pure and unit-tested through `planGraphWrite`. These cases prove the Postgres
// half: that an unchanged run writes no row and moves only `lastObservedAt`, that a changed one closes an
// interval instead of overwriting it, that an INCOMPLETE run supersedes nothing, and that the readers see
// the live row and not the history behind it.
//
// Every case uses two distinct instants. That is not decoration: closing a row at the instant it was
// observed would violate `<table>_interval_ordered`, so a run whose facts changed must carry a later one —
// which is also true of the collector, since two collections cannot happen at the same moment.

const ORGANIZATION = "hmcts";
const FIRST = new Date(Date.UTC(2026, 5, 1));
const SECOND = new Date(Date.UTC(2026, 6, 1));

function team(slug: string, overrides: Partial<TeamFact> = {}): TeamFact {
  return { slug, name: slug, ...overrides };
}

function repository(name: string, overrides: Partial<RepositoryFact> = {}): RepositoryFact {
  return { name, archived: false, visibility: "public", isFork: false, ...overrides };
}

function person(login: string, overrides: Partial<PersonFact> = {}): PersonFact {
  return { login, role: "MEMBER", ...overrides };
}

function ownedBy(name: string, owner: string, rung: OwnershipRung = OwnershipRung.TeamsApiAdmin): ResolvedOwnership {
  const resolved = { kind: OwnerKind.Team, owner, rung, detail: "admin" };
  return { repository: name, owners: [resolved], primary: resolved };
}

/**
 * Every team the given memberships or edges name, i.e. "this run read all of these teams in full".
 *
 * Stated per call rather than hardcoded, because the whole point of the scope set is that it is derived from
 * what a run actually observed — a test that passed a constant would not exercise the mechanism.
 */
function everyTeamIn<T extends { teamSlug: string }>(facts: readonly T[]): Set<string> {
  return new Set(facts.map((fact) => fact.teamSlug));
}

/** Every repository the given attributions name. */
function everyRepositoryIn<T extends { repository: string }>(resolved: readonly T[]): Set<string> {
  return new Set(resolved.map((entry) => entry.repository));
}

function ownedByNobody(name: string): ResolvedOwnership {
  const resolved = { kind: OwnerKind.None, owner: "", rung: OwnershipRung.Unowned, detail: "no rung answered" };
  return { repository: name, owners: [resolved], primary: resolved };
}

async function wipe(): Promise<void> {
  await prisma.orgTeam.deleteMany();
  await prisma.orgTeamMembership.deleteMany();
  await prisma.orgTeamRepository.deleteMany();
  await prisma.orgRepository.deleteMany();
  await prisma.orgPerson.deleteMany();
  await prisma.repositoryOwnership.deleteMany();
  await prisma.collectionState.deleteMany();
}

beforeEach(wipe);

afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

describe("recordOrgTeams", () => {
  it("should insert every team on a first write and report them as inserted", async () => {
    const summary = await recordOrgTeams(ORGANIZATION, FIRST, [team("civil"), team("civil-admins", { parentSlug: "civil" })], true);

    expect(summary).toEqual({ inserted: 2, unchanged: 0, changed: 0, superseded: 0 });
    expect(await liveOrgTeams(ORGANIZATION)).toMatchObject([
      { teamSlug: "civil", parentSlug: undefined, observedAt: FIRST, lastObservedAt: FIRST },
      { teamSlug: "civil-admins", parentSlug: "civil", observedAt: FIRST, lastObservedAt: FIRST }
    ]);
  });

  it("should leave observedAt alone and move lastObservedAt when nothing changed", async () => {
    // The affordability of keeping this for ever: an unchanged weekly run writes no rows at all.
    await recordOrgTeams(ORGANIZATION, FIRST, [team("civil")], true);

    const summary = await recordOrgTeams(ORGANIZATION, SECOND, [team("civil")], true);

    expect(summary).toEqual({ inserted: 0, unchanged: 1, changed: 0, superseded: 0 });
    expect(await prisma.orgTeam.count()).toBe(1);
    expect(await liveOrgTeams(ORGANIZATION)).toMatchObject([{ teamSlug: "civil", observedAt: FIRST, lastObservedAt: SECOND }]);
  });

  it("should close the old interval and open a new one when the content changed", async () => {
    await recordOrgTeams(ORGANIZATION, FIRST, [team("civil-admins")], true);

    // Moved under a parent, which is a different fact about ownership rollup rather than a detail of the old
    // one — so the old row is closed rather than edited.
    const summary = await recordOrgTeams(ORGANIZATION, SECOND, [team("civil-admins", { parentSlug: "civil" })], true);

    expect(summary).toEqual({ inserted: 0, unchanged: 0, changed: 1, superseded: 0 });
    const rows = await prisma.orgTeam.findMany({ orderBy: { observedAt: "asc" } });
    expect(rows.map((row) => [row.observedAt, row.supersededAt, row.parentSlug])).toEqual([
      [FIRST, SECOND, null],
      [SECOND, null, "civil"]
    ]);
  });

  it("should record a fact that came back as a second interval rather than reviving the first", async () => {
    // `observed_at` is in the primary key for exactly this: a team deleted and recreated held twice, over
    // two spans, and flattening that to one would claim it existed throughout the gap.
    const third = new Date(Date.UTC(2026, 7, 1));
    await recordOrgTeams(ORGANIZATION, FIRST, [team("civil")], true);
    await recordOrgTeams(ORGANIZATION, SECOND, [], true);

    await recordOrgTeams(ORGANIZATION, third, [team("civil")], true);

    const rows = await prisma.orgTeam.findMany({ orderBy: { observedAt: "asc" } });
    expect(rows.map((row) => [row.observedAt, row.supersededAt])).toEqual([
      [FIRST, SECOND],
      [third, null]
    ]);
  });
});

describe("ownership churn", () => {
  it("should not supersede a row because a count in its detail moved", async () => {
    // `detail` interpolates figures about the ESTATE, not about this repository: the deciding team's size for
    // `teams-api-write`, and agreeing/total for `name-prefix`. Hashing it meant adding one repository to a team
    // re-versioned every row that team had decided — measured, 167 of 2,347 live rows on a run where no ownership
    // had changed at all. That contradicts the property versioning was chosen for.
    const before = {
      kind: OwnerKind.Team,
      owner: "platform",
      rung: OwnershipRung.TeamsApiWrite,
      detail: "holds push among 3 claiming teams, and holds 40 repositories"
    };
    await recordRepositoryOwnership(ORGANIZATION, FIRST, [{ repository: "civil-service", owners: [before], primary: before }], new Set(["civil-service"]));

    const after = { ...before, detail: "holds push among 3 claiming teams, and holds 41 repositories" };
    const summary = await recordRepositoryOwnership(
      ORGANIZATION,
      SECOND,
      [{ repository: "civil-service", owners: [after], primary: after }],
      new Set(["civil-service"])
    );

    expect(summary).toEqual({ inserted: 0, unchanged: 1, changed: 0, superseded: 0 });
    const live = await liveRepositoryOwnership(ORGANIZATION);
    expect(live).toHaveLength(1);
    // Still the original interval — the fact never stopped being true.
    expect(live[0]?.observedAt.toISOString()).toBe(FIRST.toISOString());
  });

  it("should still supersede when the RUNG changes, which is a real change of answer", async () => {
    const before = { kind: OwnerKind.Team, owner: "platform", rung: OwnershipRung.TeamsApiWrite, detail: "d" };
    await recordRepositoryOwnership(ORGANIZATION, FIRST, [{ repository: "civil-service", owners: [before], primary: before }], new Set(["civil-service"]));

    const after = { ...before, rung: OwnershipRung.CodeownersSole };
    const summary = await recordRepositoryOwnership(
      ORGANIZATION,
      SECOND,
      [{ repository: "civil-service", owners: [after], primary: after }],
      new Set(["civil-service"])
    );

    expect(summary).toMatchObject({ changed: 1, unchanged: 0 });
  });
});

describe("statement chunking", () => {
  it("should write more rows than one statement's parameter budget allows", async () => {
    // PostgreSQL counts bind parameters in an int16, so 65,535 is a hard ceiling and Prisma builds ONE statement
    // per `createMany`. At seven columns the real estate's 6,647 owning team→repository edges already spend
    // 46,529 of them in a single statement — 71% — so this is a limit the estate grows into rather than one a
    // handful of fixture rows would ever have found. 5,000 rows here exceeds the 4,000-row chunk, so it fails
    // outright if chunking is removed.
    const edges = Array.from({ length: 5000 }, (_unused, at) => ({
      teamSlug: "platform-operations",
      repository: `repository-${String(at).padStart(5, "0")}`,
      access: "admin" as const
    }));

    const summary = await recordOrgTeamRepositories(ORGANIZATION, FIRST, edges, new Set(["platform-operations"]));

    expect(summary.inserted).toBe(5000);
    expect(await prisma.orgTeamRepository.count({ where: { organization: ORGANIZATION, supersededAt: null } })).toBe(5000);
  });

  it("should supersede more rows than one statement's parameter budget allows", async () => {
    const edges = Array.from({ length: 5000 }, (_unused, at) => ({
      teamSlug: "platform-operations",
      repository: `repository-${String(at).padStart(5, "0")}`,
      access: "admin" as const
    }));
    await recordOrgTeamRepositories(ORGANIZATION, FIRST, edges, new Set(["platform-operations"]));

    // The team still exists and was read in full; it just holds nothing now. Every one of the 5,000 closes.
    const summary = await recordOrgTeamRepositories(ORGANIZATION, SECOND, [], new Set(["platform-operations"]));

    expect(summary.superseded).toBe(5000);
    expect(await liveTeamRepositories(ORGANIZATION)).toEqual([]);
  });
});

describe("scoped supersession", () => {
  // THE REGRESSION NET FOR THE BUG SCOPES EXIST TO FIX. A single boolean used to stand for six independent
  // walks, so one refused membership read as "complete" and closed every one of that team's live rows as a
  // departure. GitHub serves only the present, so re-running cannot restore an interval wrongly ended — it
  // opens a new one. Each case below is one degradation path the old flag was blind to.

  it("should keep a refused team's members while still recording departures from the teams it read", async () => {
    await recordOrgTeamMemberships(
      ORGANIZATION,
      FIRST,
      [
        { teamSlug: "civil-admins", login: "stayed", role: "MEMBER" },
        { teamSlug: "civil-admins", login: "left", role: "MEMBER" },
        { teamSlug: "refused-team", login: "still-there", role: "MEMBER" }
      ],
      new Set(["civil-admins", "refused-team"])
    );

    // This run read `civil-admins` in full and was refused `refused-team`, which therefore contributes no facts.
    const summary = await recordOrgTeamMemberships(
      ORGANIZATION,
      SECOND,
      [{ teamSlug: "civil-admins", login: "stayed", role: "MEMBER" }],
      new Set(["civil-admins"])
    );

    // One departure recorded, from the team that was actually read. The refused team is untouched — not
    // superseded, and not counted as a change either.
    expect(summary).toEqual({ inserted: 0, unchanged: 1, changed: 0, superseded: 1 });
    expect((await liveTeamMemberships(ORGANIZATION)).map((row) => `${row.teamSlug}/${row.login}`).sort()).toEqual([
      "civil-admins/stayed",
      "refused-team/still-there"
    ]);
  });

  it("should keep every team's repositories when the team list stopped paging", async () => {
    await recordOrgTeamRepositories(
      ORGANIZATION,
      FIRST,
      [
        { teamSlug: "reached", repository: "a", access: "admin" },
        { teamSlug: "never-reached", repository: "b", access: "admin" }
      ],
      new Set(["reached", "never-reached"])
    );

    // Pagination stopped after the first team, so only that team was observed.
    await recordOrgTeamRepositories(ORGANIZATION, SECOND, [{ teamSlug: "reached", repository: "a", access: "admin" }], new Set(["reached"]));

    expect((await liveTeamRepositories(ORGANIZATION)).map((row) => row.teamSlug).sort()).toEqual(["never-reached", "reached"]);
  });

  it("should supersede nothing when a flat walk returned the prefix it reached", async () => {
    // A rate limit at page 5 of 33 returns ~500 of 1,878 repositories. Read as complete, that closes some 1,500
    // live rows as deleted repositories.
    await recordOrgRepositories(ORGANIZATION, FIRST, [repository("page-one"), repository("page-thirty")], true);

    const summary = await recordOrgRepositories(ORGANIZATION, SECOND, [repository("page-one")], false);

    expect(summary.superseded).toBe(0);
    expect((await liveOrgRepositories(ORGANIZATION)).map((row) => row.repository)).toEqual(["page-one", "page-thirty"]);
  });

  it("should never leave a repository both owned and unowned", async () => {
    // The second HIGH finding. `(repository, ownerKind, owner)` is the key, so a `none` row does not replace a
    // `team` row — it lands beside it. A repository the run could not re-attribute must therefore be left out of
    // the write entirely rather than resolved to `unowned`.
    await recordRepositoryOwnership(ORGANIZATION, FIRST, [ownedBy("foo-api", "team-a", OwnershipRung.CodeownersSole)], new Set(["foo-api"]));

    // Run two skipped `foo-api` past the cap, so it is neither in the attributions nor in the observed set.
    await recordRepositoryOwnership(ORGANIZATION, SECOND, [], new Set<string>());

    const live = await liveRepositoryOwnership(ORGANIZATION);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ repository: "foo-api", ownerKind: "team", owner: "team-a" });
    expect(await prisma.repositoryOwnership.count({ where: { ownerKind: OwnerKind.None, supersededAt: null } })).toBe(0);
  });

  it("should replace a repository's owners when it WAS re-attributed, even on an otherwise partial run", async () => {
    // The other half of per-repository scoping: a repository that was read must still have its stale rows closed,
    // or an ownership change would never be recorded on an estate where something always refuses.
    await recordRepositoryOwnership(ORGANIZATION, FIRST, [ownedBy("foo-api", "team-a"), ownedBy("bar-api", "team-b")], new Set(["foo-api", "bar-api"]));

    await recordRepositoryOwnership(ORGANIZATION, SECOND, [ownedBy("foo-api", "team-c")], new Set(["foo-api"]));

    expect((await liveRepositoryOwnership(ORGANIZATION)).map((row) => `${row.repository}/${row.owner}`).sort()).toEqual(["bar-api/team-b", "foo-api/team-c"]);
  });
});

describe("recordOrgTeamMemberships", () => {
  it("should supersede a membership absent from a complete run", async () => {
    await recordOrgTeamMemberships(
      ORGANIZATION,
      FIRST,
      [
        { teamSlug: "civil-admins", login: "stayed", role: "MEMBER" },
        { teamSlug: "civil-admins", login: "left", role: "MEMBER" }
      ],
      new Set(["civil-admins"])
    );

    const summary = await recordOrgTeamMemberships(
      ORGANIZATION,
      SECOND,
      [{ teamSlug: "civil-admins", login: "stayed", role: "MEMBER" }],
      everyTeamIn([{ teamSlug: "civil-admins", login: "stayed", role: "MEMBER" }])
    );

    expect(summary).toEqual({ inserted: 0, unchanged: 1, changed: 0, superseded: 1 });
    expect((await liveTeamMemberships(ORGANIZATION)).map((row) => row.login)).toEqual(["stayed"]);
    // The interval is closed, not deleted: "who was in `civil-admins` in June" is still answerable.
    const departed = await prisma.orgTeamMembership.findFirst({ where: { login: "left" } });
    expect(departed?.supersededAt).toEqual(SECOND);
  });

  it("should supersede nothing when the write is incomplete, so a failed run cannot wipe the graph", async () => {
    // The same reasoning `facts.ts` gives for why writing facts and recording coverage are one operation. A
    // collection that was rate-limited half way through saw an absence it has no authority to report.
    await recordOrgTeamMemberships(
      ORGANIZATION,
      FIRST,
      [
        { teamSlug: "civil-admins", login: "fetched", role: "MEMBER" },
        { teamSlug: "civil-admins", login: "never-reached", role: "MEMBER" }
      ],
      new Set(["civil-admins"])
    );

    const summary = await recordOrgTeamMemberships(ORGANIZATION, SECOND, [{ teamSlug: "civil-admins", login: "fetched", role: "MEMBER" }], new Set<string>());

    expect(summary).toEqual({ inserted: 0, unchanged: 1, changed: 0, superseded: 0 });
    expect((await liveTeamMemberships(ORGANIZATION)).map((row) => row.login)).toEqual(["fetched", "never-reached"]);
  });

  it("should write what an incomplete run did see", async () => {
    await recordOrgTeamMemberships(ORGANIZATION, FIRST, [{ teamSlug: "civil-admins", login: "joined", role: "MEMBER" }], new Set<string>());

    expect((await liveTeamMemberships(ORGANIZATION)).map((row) => row.login)).toEqual(["joined"]);
  });

  it("should version a role change rather than overwrite it", async () => {
    await recordOrgTeamMemberships(
      ORGANIZATION,
      FIRST,
      [{ teamSlug: "civil-admins", login: "somebody", role: "MEMBER" }],
      everyTeamIn([{ teamSlug: "civil-admins", login: "somebody", role: "MEMBER" }])
    );

    await recordOrgTeamMemberships(
      ORGANIZATION,
      SECOND,
      [{ teamSlug: "civil-admins", login: "somebody", role: "MAINTAINER" }],
      everyTeamIn([{ teamSlug: "civil-admins", login: "somebody", role: "MAINTAINER" }])
    );

    expect(await liveTeamMemberships(ORGANIZATION)).toMatchObject([{ login: "somebody", role: "MAINTAINER", observedAt: SECOND }]);
    expect(await prisma.orgTeamMembership.count()).toBe(2);
  });

  it("should keep each organisation's memberships separate", async () => {
    await recordOrgTeamMemberships(
      ORGANIZATION,
      FIRST,
      [{ teamSlug: "civil-admins", login: "somebody", role: "MEMBER" }],
      everyTeamIn([{ teamSlug: "civil-admins", login: "somebody", role: "MEMBER" }])
    );

    // A complete run for one organisation says nothing about another's, so nothing is superseded here.
    await recordOrgTeamMemberships("hmcts-sandbox", SECOND, [], new Set(["civil-admins"]));

    expect(await liveTeamMemberships(ORGANIZATION)).toHaveLength(1);
  });
});

describe("recordOrgTeamRepositories", () => {
  it("should version an access level change, which is the drift the ownership ladder reads", async () => {
    await recordOrgTeamRepositories(
      ORGANIZATION,
      FIRST,
      [{ teamSlug: "civil-admins", repository: "civil-service", access: "admin" }],
      everyTeamIn([{ teamSlug: "civil-admins", repository: "civil-service", access: "admin" }])
    );

    const summary = await recordOrgTeamRepositories(
      ORGANIZATION,
      SECOND,
      [{ teamSlug: "civil-admins", repository: "civil-service", access: "pull" }],
      everyTeamIn([{ teamSlug: "civil-admins", repository: "civil-service", access: "pull" }])
    );

    expect(summary).toEqual({ inserted: 0, unchanged: 0, changed: 1, superseded: 0 });
    expect(await liveTeamRepositories(ORGANIZATION)).toMatchObject([{ teamSlug: "civil-admins", repository: "civil-service", permission: "pull" }]);
  });
});

describe("recordOrgRepositories", () => {
  it("should record the estate as the denominator that makes unowned answerable", async () => {
    const summary = await recordOrgRepositories(ORGANIZATION, FIRST, [repository("cath-service"), repository("old-thing", { archived: true })], true);

    expect(summary.inserted).toBe(2);
    expect(await liveOrgRepositories(ORGANIZATION)).toMatchObject([
      { repository: "cath-service", archived: false, visibility: "public" },
      { repository: "old-thing", archived: true, visibility: "public" }
    ]);
  });

  it("should version archival, because an archived unowned repository is a different finding", async () => {
    await recordOrgRepositories(ORGANIZATION, FIRST, [repository("cath-service")], true);

    await recordOrgRepositories(ORGANIZATION, SECOND, [repository("cath-service", { archived: true })], true);

    expect(await liveOrgRepositories(ORGANIZATION)).toMatchObject([{ repository: "cath-service", archived: true, observedAt: SECOND }]);
  });

  it("should not version a repository whose only movement was a push", async () => {
    // `pushedAt` moves on every push and is deliberately not stored. Versioning on it would supersede and
    // re-insert the whole active estate weekly, for a value `repository_state` already holds as current.
    await recordOrgRepositories(ORGANIZATION, FIRST, [repository("cath-service", { pushedAt: FIRST })], true);

    const summary = await recordOrgRepositories(ORGANIZATION, SECOND, [repository("cath-service", { pushedAt: SECOND })], true);

    expect(summary).toEqual({ inserted: 0, unchanged: 1, changed: 0, superseded: 0 });
    expect(await prisma.orgRepository.count()).toBe(1);
  });
});

describe("recordOrgPeople", () => {
  it("should keep self-reported detail in the payload and version a change to it", async () => {
    await recordOrgPeople(ORGANIZATION, FIRST, [person("somebody", { name: "Some Body" })], true);

    await recordOrgPeople(ORGANIZATION, SECOND, [person("somebody", { name: "Some Body", company: "HMCTS" })], true);

    expect(await liveOrgPeople(ORGANIZATION)).toMatchObject([{ login: "somebody", role: "MEMBER", payload: { name: "Some Body", company: "HMCTS" } }]);
  });

  it("should omit a field GitHub never sent rather than storing it as empty", async () => {
    // `email` is the account's PUBLIC email and is absent for most HMCTS members. An empty string would say
    // somebody has no email, which is a claim nobody made.
    await recordOrgPeople(ORGANIZATION, FIRST, [person("somebody")], true);

    expect((await liveOrgPeople(ORGANIZATION))[0]?.payload).toEqual({});
  });

  it("should close the interval of a person who left the organisation", async () => {
    await recordOrgPeople(ORGANIZATION, FIRST, [person("stayed"), person("left")], true);

    await recordOrgPeople(ORGANIZATION, SECOND, [person("stayed")], true);

    expect((await liveOrgPeople(ORGANIZATION)).map((row) => row.login)).toEqual(["stayed"]);
  });
});

describe("recordRepositoryOwnership", () => {
  it("should store a remembered negative for a repository nobody owns", async () => {
    await recordRepositoryOwnership(
      ORGANIZATION,
      FIRST,
      [ownedBy("civil-service", "civil-admins"), ownedByNobody("orphan-service")],
      everyRepositoryIn([ownedBy("civil-service", "civil-admins"), ownedByNobody("orphan-service")])
    );

    // One COUNT rather than a set difference somebody has to remember to compute.
    expect(await prisma.repositoryOwnership.count({ where: { ownerKind: OwnerKind.None, supersededAt: null } })).toBe(1);
    expect(await liveRepositoryOwnership(ORGANIZATION)).toMatchObject([
      { repository: "civil-service", ownerKind: "team", owner: "civil-admins", rung: "teams-api-admin", payload: { primary: true } },
      { repository: "orphan-service", ownerKind: "none", owner: "", rung: "unowned" }
    ]);
  });

  it("should store every owner of a repository, because several is the normal case", async () => {
    const first = { kind: OwnerKind.Team, owner: "civil-admins", rung: OwnershipRung.TeamsApiWrite, detail: "admin" };
    const second = { kind: OwnerKind.Team, owner: "platform", rung: OwnershipRung.TeamsApiWrite, detail: "admin" };

    await recordRepositoryOwnership(
      ORGANIZATION,
      FIRST,
      [{ repository: "civil-service", owners: [first, second], primary: first }],
      new Set(["civil-service"])
    );

    expect((await liveRepositoryOwnership(ORGANIZATION)).map((row) => [row.owner, row.payload])).toEqual([
      ["civil-admins", { detail: "admin", primary: true }],
      ["platform", { detail: "admin", primary: false }]
    ]);
  });

  it("should supersede a remembered negative once a rung finally answers", async () => {
    await recordRepositoryOwnership(ORGANIZATION, FIRST, [ownedByNobody("orphan-service")], everyRepositoryIn([ownedByNobody("orphan-service")]));

    const summary = await recordRepositoryOwnership(
      ORGANIZATION,
      SECOND,
      [ownedBy("orphan-service", "civil-admins")],
      everyRepositoryIn([ownedBy("orphan-service", "civil-admins")])
    );

    // The owner is part of the key, so this is one arrival and one departure rather than a changed row.
    expect(summary).toEqual({ inserted: 1, unchanged: 0, changed: 0, superseded: 1 });
    expect(await liveRepositoryOwnership(ORGANIZATION)).toMatchObject([{ repository: "orphan-service", ownerKind: "team", owner: "civil-admins" }]);
  });

  it("should version the rung when the same owner is attributed more confidently", async () => {
    await recordRepositoryOwnership(
      ORGANIZATION,
      FIRST,
      [ownedBy("civil-service", "civil-admins", OwnershipRung.NamePrefix)],
      everyRepositoryIn([ownedBy("civil-service", "civil-admins", OwnershipRung.NamePrefix)])
    );

    const summary = await recordRepositoryOwnership(
      ORGANIZATION,
      SECOND,
      [ownedBy("civil-service", "civil-admins", OwnershipRung.TeamsApiAdmin)],
      everyRepositoryIn([ownedBy("civil-service", "civil-admins", OwnershipRung.TeamsApiAdmin)])
    );

    expect(summary).toEqual({ inserted: 0, unchanged: 0, changed: 1, superseded: 0 });
    expect(await liveRepositoryOwnership(ORGANIZATION)).toMatchObject([{ owner: "civil-admins", rung: "teams-api-admin" }]);
  });
});

describe("stampRevision", () => {
  it("should invalidate a built report without claiming a collection landed", async () => {
    const collectedAt = new Date(Date.UTC(2026, 5, 15));
    await stampCollection(collectedAt);

    const revision = await stampRevision();

    const state = await collectionState();
    expect(state?.revision).toBe(revision);
    // Stamping `collected_at` here would report the merge figures as freshly collected on a week when only
    // the graph half of the collection ran — the one lie the staleness notice exists to prevent.
    expect(state?.collectedAt).toEqual(collectedAt);
  });

  it("should leave a cold database alone rather than inventing an instant nobody observed", async () => {
    expect(await stampRevision()).toBeUndefined();
    expect(await collectionState()).toBeUndefined();
  });
});
