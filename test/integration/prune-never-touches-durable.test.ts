import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { EvidenceSource, type SourceCoverage } from "../../src/evidence/domain/coverage.ts";
import { cacheDirectCommitFacts, cachePullRequestFacts, loadCachedPullRequestFacts } from "../../src/evidence/store/facts.ts";
import { prisma } from "../../src/evidence/store/prisma.ts";
import { pruneCache } from "../../src/evidence/store/prune.ts";

/**
 * The invariant that replaced a file boundary.
 *
 * Upstream kept a disposable cache and durable observations in two SQLite files, and `prune` was safe
 * because it simply never opened the second one. One Postgres database has no such boundary, so this
 * asserts it directly: alert history GitHub cannot be asked for again, and a Sonar project map costing
 * tens of minutes of quota-paced calls, must both survive a prune that deletes everything else.
 *
 * The six organisation-graph tables joined the durable side by the same sentence about a different table:
 * GitHub serves only the present membership, so a pruned team edge is a hole in the drift history for ever
 * — nobody can ask GitHub who was in `civil-admins` last June, or which team held `admin` on a repository
 * before somebody moved it. `prune.ts` itself does not change to accommodate them, and that is the point:
 * what grows is this test, because the invariant is what has to hold and not the implementation of it.
 *
 * The last case here is not about `prune` at all. It asserts the partial unique index that makes every
 * `WHERE superseded_at IS NULL` read unambiguous — a guarantee Postgres gives and TypeScript cannot, so it
 * is proved against a real database rather than in the unit suite.
 */

const COVERAGE: SourceCoverage = {
  organization: "hmcts",
  repository: "cath-service",
  source: EvidenceSource.PullRequests,
  queryHash: "testhash",
  startsAt: new Date(Date.UTC(2026, 6, 1)),
  endsAt: new Date(Date.UTC(2026, 7, 1))
};

const FUTURE = new Date(Date.UTC(2027, 0, 1));

/** When the graph rows below were first observed. Everything here is older than the prune cut-off. */
const OBSERVED = new Date(Date.UTC(2026, 5, 1));

async function wipe(): Promise<void> {
  await prisma.pullRequestFact.deleteMany();
  await prisma.directCommitFact.deleteMany();
  await prisma.sourceCoverage.deleteMany();
  await prisma.alertObservation.deleteMany();
  await prisma.sonarProjectMap.deleteMany();
  await prisma.orgTeam.deleteMany();
  await prisma.orgTeamMembership.deleteMany();
  await prisma.orgTeamRepository.deleteMany();
  await prisma.orgRepository.deleteMany();
  await prisma.orgPerson.deleteMany();
  await prisma.repositoryOwnership.deleteMany();
}

beforeEach(wipe);

afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

describe("pruneCache", () => {
  it("should never delete alert observations, which GitHub cannot be asked for again", async () => {
    await prisma.alertObservation.create({
      data: {
        organization: "hmcts",
        repository: "cath-service",
        family: "dependabot",
        fetchedAt: new Date(Date.UTC(2026, 0, 1)),
        payload: { open: 3 }
      }
    });

    await pruneCache(FUTURE);

    expect(await prisma.alertObservation.count()).toBe(1);
  });

  it("should never delete the sonar project map, including its remembered negatives", async () => {
    await prisma.sonarProjectMap.createMany({
      data: [
        { sonarOrganization: "hmcts", projectKey: "hmcts.cath", repository: "cath-service", resolvedAt: new Date(Date.UTC(2026, 0, 1)), method: "configured" },
        // A remembered negative: somebody paid the quota to learn this cannot be attributed.
        { sonarOrganization: "hmcts", projectKey: "hmcts.unknown", detail: "no commit matched", resolvedAt: new Date(Date.UTC(2026, 0, 1)) }
      ]
    });

    await pruneCache(FUTURE);

    expect(await prisma.sonarProjectMap.count()).toBe(2);
  });

  it("should never delete teams, which GitHub cannot be asked for again", async () => {
    await prisma.orgTeam.create({
      data: {
        organization: "hmcts",
        teamSlug: "civil-admins",
        parentSlug: "civil",
        payload: { name: "Civil Admins" },
        observedAt: OBSERVED,
        lastObservedAt: OBSERVED,
        digest: "aaaaaaaaaaaaaaaa"
      }
    });

    await pruneCache(FUTURE);

    expect(await prisma.orgTeam.count()).toBe(1);
  });

  it("should never delete team memberships, which GitHub cannot be asked for again", async () => {
    // The whole reason this table is versioned: a membership deleted this morning is unrecoverable, so a
    // deleted row is the only copy of "this person was in this team in June" going with it.
    await prisma.orgTeamMembership.create({
      data: {
        organization: "hmcts",
        teamSlug: "civil-admins",
        login: "somebody",
        role: "MAINTAINER",
        observedAt: OBSERVED,
        lastObservedAt: OBSERVED,
        digest: "aaaaaaaaaaaaaaaa"
      }
    });

    await pruneCache(FUTURE);

    expect(await prisma.orgTeamMembership.count()).toBe(1);
  });

  it("should never delete team access edges, which GitHub cannot be asked for again", async () => {
    await prisma.orgTeamRepository.create({
      data: {
        organization: "hmcts",
        teamSlug: "civil-admins",
        repository: "civil-service",
        permission: "admin",
        observedAt: OBSERVED,
        lastObservedAt: OBSERVED,
        digest: "aaaaaaaaaaaaaaaa"
      }
    });

    await pruneCache(FUTURE);

    expect(await prisma.orgTeamRepository.count()).toBe(1);
  });

  it("should never delete the repository inventory, which GitHub cannot be asked for again", async () => {
    // Deleting this deletes the denominator: ownership resolved from team edges alone cannot report a
    // repository nobody holds, so "unowned" stops being answerable at all.
    await prisma.orgRepository.create({
      data: {
        organization: "hmcts",
        repository: "cath-service",
        archived: false,
        visibility: "public",
        payload: { isFork: false },
        observedAt: OBSERVED,
        lastObservedAt: OBSERVED,
        digest: "aaaaaaaaaaaaaaaa"
      }
    });

    await pruneCache(FUTURE);

    expect(await prisma.orgRepository.count()).toBe(1);
  });

  it("should never delete organisation members, which GitHub cannot be asked for again", async () => {
    await prisma.orgPerson.create({
      data: {
        organization: "hmcts",
        login: "somebody",
        role: "MEMBER",
        payload: {},
        observedAt: OBSERVED,
        lastObservedAt: OBSERVED,
        digest: "aaaaaaaaaaaaaaaa"
      }
    });

    await pruneCache(FUTURE);

    expect(await prisma.orgPerson.count()).toBe(1);
  });

  it("should never delete resolved ownership, including its remembered negatives", async () => {
    await prisma.repositoryOwnership.createMany({
      data: [
        {
          organization: "hmcts",
          repository: "civil-service",
          ownerKind: "team",
          owner: "civil-admins",
          rung: "teams-api-admin",
          payload: { detail: "admin", primary: true },
          observedAt: OBSERVED,
          lastObservedAt: OBSERVED,
          digest: "aaaaaaaaaaaaaaaa"
        },
        // A remembered negative: the ladder was walked and every rung declined. Deleting it makes "nothing
        // owns it" indistinguishable from "we never looked", and the next run re-walks every rung.
        {
          organization: "hmcts",
          repository: "orphan-service",
          ownerKind: "none",
          owner: "",
          rung: "unowned",
          payload: { detail: "no rung answered", primary: true },
          observedAt: OBSERVED,
          lastObservedAt: OBSERVED,
          digest: "bbbbbbbbbbbbbbbb"
        }
      ]
    });

    await pruneCache(FUTURE);

    expect(await prisma.repositoryOwnership.count()).toBe(2);
  });

  it("should keep coverage and facts a report still reads", async () => {
    await cachePullRequestFacts(COVERAGE, [{ identifier: BigInt(101), mergedAt: new Date(Date.UTC(2026, 6, 3)), payload: { number: 11 } }], true);

    // Nothing has gone unused since before the rows were written, so nothing is deleted.
    expect(await pruneCache(new Date(Date.UTC(2026, 0, 1)))).toBe(0);
    expect(await loadCachedPullRequestFacts(COVERAGE, COVERAGE.startsAt, COVERAGE.endsAt)).toHaveLength(1);
  });

  it("should delete unused coverage together with the facts it leaves unreachable", async () => {
    await cachePullRequestFacts(COVERAGE, [{ identifier: BigInt(101), mergedAt: new Date(Date.UTC(2026, 6, 3)), payload: { number: 11 } }], true);
    await cacheDirectCommitFacts(
      { ...COVERAGE, source: EvidenceSource.DirectCommits },
      [{ sha: "abc123", committedAt: new Date(Date.UTC(2026, 6, 4)), payload: {} }],
      true
    );

    expect(await pruneCache(FUTURE)).toBe(2);

    // A fact is reachable only through the coverage series that collected it, so once the series is gone
    // the rows are unreadable whatever their own dates say.
    expect(await prisma.sourceCoverage.count()).toBe(0);
    expect(await prisma.pullRequestFact.count()).toBe(0);
    expect(await prisma.directCommitFact.count()).toBe(0);
  });

  it("should keep facts whose coverage survives under a different signature", async () => {
    await cachePullRequestFacts(COVERAGE, [{ identifier: BigInt(101), mergedAt: new Date(Date.UTC(2026, 6, 3)), payload: { number: 11 } }], true);
    await cachePullRequestFacts(
      { ...COVERAGE, queryHash: "other" },
      [{ identifier: BigInt(202), mergedAt: new Date(Date.UTC(2026, 6, 5)), payload: { number: 22 } }],
      true
    );
    // Age only the first signature's coverage.
    await prisma.sourceCoverage.updateMany({ where: { queryHash: "testhash" }, data: { accessedAt: new Date(Date.UTC(2026, 0, 1)) } });

    expect(await pruneCache(new Date(Date.UTC(2026, 6, 1)))).toBe(1);

    const remaining = await prisma.pullRequestFact.findMany({ select: { identifier: true } });
    expect(remaining).toEqual([{ identifier: BigInt(202) }]);
  });
});

describe("cachePullRequestFacts", () => {
  it("should cache facts without claiming coverage when a collection was incomplete", async () => {
    // A partial collection must leave its facts for reuse but must not record the interval, or the next
    // run would skip the gap it left.
    await cachePullRequestFacts(COVERAGE, [{ identifier: BigInt(101), mergedAt: new Date(Date.UTC(2026, 6, 3)), payload: { number: 11 } }], false);

    expect(await prisma.pullRequestFact.count()).toBe(1);
    expect(await prisma.sourceCoverage.count()).toBe(0);
  });

  it("should replace a fact collected again rather than duplicating it", async () => {
    await cachePullRequestFacts(
      COVERAGE,
      [{ identifier: BigInt(101), mergedAt: new Date(Date.UTC(2026, 6, 3)), payload: { number: 11, title: "first" } }],
      true
    );
    await cachePullRequestFacts(
      COVERAGE,
      [{ identifier: BigInt(101), mergedAt: new Date(Date.UTC(2026, 6, 3)), payload: { number: 11, title: "second" } }],
      true
    );

    const facts = await loadCachedPullRequestFacts(COVERAGE, COVERAGE.startsAt, COVERAGE.endsAt);
    expect(facts).toEqual([{ number: 11, title: "second" }]);
  });

  it("should return facts within the window and exclude one merged at its exclusive end", async () => {
    await cachePullRequestFacts(
      COVERAGE,
      [
        { identifier: BigInt(1), mergedAt: new Date(Date.UTC(2026, 6, 1)), payload: { n: "at the inclusive start" } },
        { identifier: BigInt(2), mergedAt: new Date(Date.UTC(2026, 7, 1)), payload: { n: "at the exclusive end" } }
      ],
      true
    );

    expect(await loadCachedPullRequestFacts(COVERAGE, COVERAGE.startsAt, COVERAGE.endsAt)).toEqual([{ n: "at the inclusive start" }]);
  });

  it("should order facts stably when two merged at the same instant", async () => {
    // Shard boundaries can produce two merges at one instant; an unstable order would make two reports of
    // the same window differ.
    const mergedAt = new Date(Date.UTC(2026, 6, 3));
    await cachePullRequestFacts(
      COVERAGE,
      [
        { identifier: BigInt(20), mergedAt, payload: { id: 20 } },
        { identifier: BigInt(10), mergedAt, payload: { id: 10 } }
      ],
      true
    );

    expect(await loadCachedPullRequestFacts(COVERAGE, COVERAGE.startsAt, COVERAGE.endsAt)).toEqual([{ id: 10 }, { id: 20 }]);
  });
});

describe("the live unique index on a change-versioned table", () => {
  it("should refuse a second live row for one key, so no reader sees two currents", async () => {
    // Written against Prisma directly rather than through the writer, because it is the DATABASE being
    // asserted: the writer closes before it inserts, and the index is what holds when a writer crashes in
    // between or two collections of the same organisation overlap. Two live rows would not read as a
    // database inconsistency to anybody looking at the dashboard — they would read as this person being in
    // `civil-admins` twice, at two different roles.
    const membership = { organization: "hmcts", teamSlug: "civil-admins", login: "somebody" };
    await prisma.orgTeamMembership.create({
      data: { ...membership, role: "MEMBER", observedAt: OBSERVED, lastObservedAt: OBSERVED, digest: "aaaaaaaaaaaaaaaa" }
    });

    const secondLive = prisma.orgTeamMembership.create({
      data: { ...membership, role: "MAINTAINER", observedAt: FUTURE, lastObservedAt: FUTURE, digest: "bbbbbbbbbbbbbbbb" }
    });

    await expect(secondLive).rejects.toThrow();
    expect(await prisma.orgTeamMembership.count()).toBe(1);
  });

  it("should allow a second row once the first is superseded, because that is a history and not a duplicate", async () => {
    const membership = { organization: "hmcts", teamSlug: "civil-admins", login: "somebody" };
    await prisma.orgTeamMembership.create({
      data: { ...membership, role: "MEMBER", observedAt: OBSERVED, lastObservedAt: OBSERVED, supersededAt: FUTURE, digest: "aaaaaaaaaaaaaaaa" }
    });

    await prisma.orgTeamMembership.create({
      data: { ...membership, role: "MAINTAINER", observedAt: FUTURE, lastObservedAt: FUTURE, digest: "bbbbbbbbbbbbbbbb" }
    });

    expect(await prisma.orgTeamMembership.count({ where: { supersededAt: null } })).toBe(1);
    expect(await prisma.orgTeamMembership.count()).toBe(2);
  });

  it("should refuse an interval that ends at or before it began, which describes no span of time", async () => {
    // The rule `source_coverage_interval_ordered` states, applied to a versioned row: superseded at the
    // instant it was first observed satisfies "this was once true" while covering no moment at all.
    const closedAtOnce = prisma.orgTeam.create({
      data: {
        organization: "hmcts",
        teamSlug: "civil-admins",
        payload: {},
        observedAt: OBSERVED,
        lastObservedAt: OBSERVED,
        supersededAt: OBSERVED,
        digest: "aaaaaaaaaaaaaaaa"
      }
    });

    await expect(closedAtOnce).rejects.toThrow();
  });

  it("should refuse ownership that is both a remembered negative and names an owner", async () => {
    // `none` with a handle, or a team with a blank one, makes "the ladder found nothing" indistinguishable
    // from a row somebody half-wrote.
    const halfWritten = prisma.repositoryOwnership.create({
      data: {
        organization: "hmcts",
        repository: "orphan-service",
        ownerKind: "none",
        owner: "civil-admins",
        rung: "unowned",
        payload: {},
        observedAt: OBSERVED,
        lastObservedAt: OBSERVED,
        digest: "aaaaaaaaaaaaaaaa"
      }
    });

    await expect(halfWritten).rejects.toThrow();
  });
});
