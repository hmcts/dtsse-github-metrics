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

describe("recordOrgTeamMemberships", () => {
  it("should supersede a membership absent from a complete run", async () => {
    await recordOrgTeamMemberships(
      ORGANIZATION,
      FIRST,
      [
        { teamSlug: "civil-admins", login: "stayed", role: "MEMBER" },
        { teamSlug: "civil-admins", login: "left", role: "MEMBER" }
      ],
      true
    );

    const summary = await recordOrgTeamMemberships(ORGANIZATION, SECOND, [{ teamSlug: "civil-admins", login: "stayed", role: "MEMBER" }], true);

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
      true
    );

    const summary = await recordOrgTeamMemberships(ORGANIZATION, SECOND, [{ teamSlug: "civil-admins", login: "fetched", role: "MEMBER" }], false);

    expect(summary).toEqual({ inserted: 0, unchanged: 1, changed: 0, superseded: 0 });
    expect((await liveTeamMemberships(ORGANIZATION)).map((row) => row.login)).toEqual(["fetched", "never-reached"]);
  });

  it("should write what an incomplete run did see", async () => {
    await recordOrgTeamMemberships(ORGANIZATION, FIRST, [{ teamSlug: "civil-admins", login: "joined", role: "MEMBER" }], false);

    expect((await liveTeamMemberships(ORGANIZATION)).map((row) => row.login)).toEqual(["joined"]);
  });

  it("should version a role change rather than overwrite it", async () => {
    await recordOrgTeamMemberships(ORGANIZATION, FIRST, [{ teamSlug: "civil-admins", login: "somebody", role: "MEMBER" }], true);

    await recordOrgTeamMemberships(ORGANIZATION, SECOND, [{ teamSlug: "civil-admins", login: "somebody", role: "MAINTAINER" }], true);

    expect(await liveTeamMemberships(ORGANIZATION)).toMatchObject([{ login: "somebody", role: "MAINTAINER", observedAt: SECOND }]);
    expect(await prisma.orgTeamMembership.count()).toBe(2);
  });

  it("should keep each organisation's memberships separate", async () => {
    await recordOrgTeamMemberships(ORGANIZATION, FIRST, [{ teamSlug: "civil-admins", login: "somebody", role: "MEMBER" }], true);

    // A complete run for one organisation says nothing about another's, so nothing is superseded here.
    await recordOrgTeamMemberships("hmcts-sandbox", SECOND, [], true);

    expect(await liveTeamMemberships(ORGANIZATION)).toHaveLength(1);
  });
});

describe("recordOrgTeamRepositories", () => {
  it("should version an access level change, which is the drift the ownership ladder reads", async () => {
    await recordOrgTeamRepositories(ORGANIZATION, FIRST, [{ teamSlug: "civil-admins", repository: "civil-service", access: "admin" }], true);

    const summary = await recordOrgTeamRepositories(ORGANIZATION, SECOND, [{ teamSlug: "civil-admins", repository: "civil-service", access: "pull" }], true);

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

  it("should store pushed_at, which the cohort's activity window is read from", async () => {
    const pushed = new Date(Date.UTC(2026, 4, 20));

    await recordOrgRepositories(ORGANIZATION, FIRST, [repository("cath-service", { pushedAt: pushed })], true);

    expect((await liveOrgRepositories(ORGANIZATION))[0]?.pushedAt?.toISOString()).toBe(pushed.toISOString());
  });

  it("should leave pushed_at absent where GitHub named no last push", async () => {
    // Absent is not the same answer as very old, and the window treats it as not active — so it must round-trip
    // as absent rather than as an epoch or a zero.
    await recordOrgRepositories(ORGANIZATION, FIRST, [repository("never-pushed")], true);

    expect((await liveOrgRepositories(ORGANIZATION))[0]?.pushedAt).toBeUndefined();
  });

  it("should move pushed_at WITHOUT superseding the row, which is the whole reason it is not in the digest", async () => {
    // THE LOAD-BEARING CASE. `pushedAt` moves on every push, so if it were versioned every active repository in
    // the estate would supersede and re-insert on every run — turning a change history into a weekly snapshot.
    // The row must be updated in place, exactly as `lastObservedAt` is.
    const first = new Date(Date.UTC(2026, 4, 20));
    const later = new Date(Date.UTC(2026, 5, 20));
    await recordOrgRepositories(ORGANIZATION, FIRST, [repository("cath-service", { pushedAt: first })], true);

    const summary = await recordOrgRepositories(ORGANIZATION, SECOND, [repository("cath-service", { pushedAt: later })], true);

    expect(summary).toMatchObject({ inserted: 0, changed: 0, unchanged: 1, superseded: 0 });
    const live = await liveOrgRepositories(ORGANIZATION);
    expect(live).toHaveLength(1);
    expect(live[0]?.pushedAt?.toISOString()).toBe(later.toISOString());
    // Still the original interval: the fact never stopped being true, so nothing opened a second row.
    expect(live[0]?.observedAt.toISOString()).toBe(FIRST.toISOString());
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
    await recordRepositoryOwnership(ORGANIZATION, FIRST, [ownedBy("civil-service", "civil-admins"), ownedByNobody("orphan-service")], true);

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

    await recordRepositoryOwnership(ORGANIZATION, FIRST, [{ repository: "civil-service", owners: [first, second], primary: first }], true);

    expect((await liveRepositoryOwnership(ORGANIZATION)).map((row) => [row.owner, row.payload])).toEqual([
      ["civil-admins", { detail: "admin", primary: true }],
      ["platform", { detail: "admin", primary: false }]
    ]);
  });

  it("should supersede a remembered negative once a rung finally answers", async () => {
    await recordRepositoryOwnership(ORGANIZATION, FIRST, [ownedByNobody("orphan-service")], true);

    const summary = await recordRepositoryOwnership(ORGANIZATION, SECOND, [ownedBy("orphan-service", "civil-admins")], true);

    // The owner is part of the key, so this is one arrival and one departure rather than a changed row.
    expect(summary).toEqual({ inserted: 1, unchanged: 0, changed: 0, superseded: 1 });
    expect(await liveRepositoryOwnership(ORGANIZATION)).toMatchObject([{ repository: "orphan-service", ownerKind: "team", owner: "civil-admins" }]);
  });

  it("should version the rung when the same owner is attributed more confidently", async () => {
    await recordRepositoryOwnership(ORGANIZATION, FIRST, [ownedBy("civil-service", "civil-admins", OwnershipRung.NamePrefix)], true);

    const summary = await recordRepositoryOwnership(ORGANIZATION, SECOND, [ownedBy("civil-service", "civil-admins", OwnershipRung.TeamsApiAdmin)], true);

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
