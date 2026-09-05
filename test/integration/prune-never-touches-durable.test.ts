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

async function wipe(): Promise<void> {
  await prisma.pullRequestFact.deleteMany();
  await prisma.directCommitFact.deleteMany();
  await prisma.sourceCoverage.deleteMany();
  await prisma.alertObservation.deleteMany();
  await prisma.sonarProjectMap.deleteMany();
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
