import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deserialiseMerges,
  directCommitCacheWriter,
  fillCachedSource,
  loadCachedMerges,
  pullRequestCacheWriter,
  requestedCoverage
} from "../../src/evidence/behaviour/fill.ts";
import { EvidenceSource } from "../../src/evidence/domain/coverage.ts";
import { type DirectCommitFact, type PullRequestFact, ReviewState } from "../../src/evidence/domain/facts.ts";
import { getSourceCoverage } from "../../src/evidence/store/coverage.ts";
import { prisma } from "../../src/evidence/store/prisma.ts";

/**
 * The cache half of a behaviour collection against Postgres: what the stable side records, what the mutable edge
 * does not, and that a fact read back is the fact that was written.
 */

const ORGANIZATION = "fill-test";
const REPOSITORY = "alpha";

const day = (date: number) => new Date(Date.UTC(2026, 7, date));

const WINDOW = { startsAt: day(1), endsAt: day(29) };
const MUTABLE_FROM = day(22);

async function clear(): Promise<void> {
  await prisma.pullRequestFact.deleteMany({ where: { organization: ORGANIZATION } });
  await prisma.directCommitFact.deleteMany({ where: { organization: ORGANIZATION } });
  await prisma.sourceCoverage.deleteMany({ where: { organization: ORGANIZATION } });
}

beforeEach(clear);

afterAll(async () => {
  await clear();
  await prisma.$disconnect();
});

function pullRequest(identifier: number, mergedAt: Date, authorLogin?: string): PullRequestFact {
  return {
    identifier,
    repository: REPOSITORY,
    number: identifier,
    createdAt: day(1),
    mergedAt,
    readyForReviewAt: undefined,
    draft: false,
    ...(authorLogin === undefined ? {} : { authorLogin, authorType: "User" }),
    reviews: [{ identifier: identifier * 10, submittedAt: mergedAt, state: ReviewState.Approved, authorLogin: "reviewer", commentCount: 0 }],
    checks: [{ name: "build", completedAt: mergedAt }]
  };
}

function directCommit(sha: string, committedAt: Date): DirectCommitFact {
  return { sha, repository: REPOSITORY, committedAt, authorName: "Ada" };
}

describe("fillCachedSource", () => {
  it("should collect the missing stable history once and the mutable edge every run", async () => {
    const requested = requestedCoverage(ORGANIZATION, REPOSITORY, EvidenceSource.PullRequests, WINDOW);
    const collect = vi.fn(async (startsAt: Date) =>
      startsAt.getTime() < MUTABLE_FROM.getTime() ? [pullRequest(1, day(10), "ada")] : [pullRequest(2, day(25))]
    );

    const first = await fillCachedSource(requested, MUTABLE_FROM, collect, pullRequestCacheWriter());

    expect(first).toEqual([{ ...requested, endsAt: MUTABLE_FROM }]);
    expect(collect.mock.calls).toEqual([
      [WINDOW.startsAt, MUTABLE_FROM],
      [MUTABLE_FROM, WINDOW.endsAt]
    ]);
    expect(await getSourceCoverage(requested)).toEqual([{ startsAt: WINDOW.startsAt, endsAt: MUTABLE_FROM }]);

    collect.mockClear();
    const second = await fillCachedSource(requested, MUTABLE_FROM, collect, pullRequestCacheWriter());

    expect(second).toEqual([]);
    expect(collect.mock.calls).toEqual([[MUTABLE_FROM, WINDOW.endsAt]]);
  });

  it("should collect no stable history for a window lying wholly inside the mutable edge", async () => {
    const window = { startsAt: MUTABLE_FROM, endsAt: WINDOW.endsAt };
    const requested = requestedCoverage(ORGANIZATION, REPOSITORY, EvidenceSource.DirectCommits, window);
    const collect = vi.fn(async () => [directCommit("abc", day(23))]);

    const fetched = await fillCachedSource(requested, MUTABLE_FROM, collect, directCommitCacheWriter());

    expect(fetched).toEqual([]);
    expect(collect.mock.calls).toEqual([[MUTABLE_FROM, WINDOW.endsAt]]);
    expect(await getSourceCoverage(requested)).toEqual([]);
  });

  it("should leave the mutable edge alone for a window ending before it", async () => {
    const window = { startsAt: WINDOW.startsAt, endsAt: MUTABLE_FROM };
    const requested = requestedCoverage(ORGANIZATION, REPOSITORY, EvidenceSource.DirectCommits, window);
    const collect = vi.fn(async () => [] as DirectCommitFact[]);

    await fillCachedSource(requested, MUTABLE_FROM, collect, directCommitCacheWriter());

    expect(collect.mock.calls).toEqual([[WINDOW.startsAt, MUTABLE_FROM]]);
  });
});

describe("loadCachedMerges", () => {
  it("should read back the facts that were written, with their instants as dates and no absent field made null", async () => {
    const pullRequests = [pullRequest(1, day(10), "ada"), pullRequest(2, day(11))];
    const commits = [directCommit("abc", day(12))];
    const pullRequestKey = requestedCoverage(ORGANIZATION, REPOSITORY, EvidenceSource.PullRequests, WINDOW);
    const commitKey = requestedCoverage(ORGANIZATION, REPOSITORY, EvidenceSource.DirectCommits, WINDOW);
    await pullRequestCacheWriter()(pullRequestKey, pullRequests, true);
    await directCommitCacheWriter()(commitKey, commits, true);

    const merges = await loadCachedMerges(ORGANIZATION, REPOSITORY, WINDOW);

    const { readyForReviewAt: _absent, ...stored } = pullRequests[1] as PullRequestFact;
    expect(merges.pullRequests).toEqual([pullRequests[0], stored]);
    expect(merges.pullRequests[1]).not.toHaveProperty("readyForReviewAt");
    expect(merges.pullRequests[0]?.reviews[0]?.submittedAt).toBeInstanceOf(Date);
    expect(merges.directCommits).toEqual(commits);
    const row = await prisma.pullRequestFact.findFirstOrThrow({ where: { organization: ORGANIZATION, identifier: 1n } });
    expect(row.authorLogin).toBe("ada");
  });

  it("should keep a null inside a stored list rather than reviving it", async () => {
    const fact = { ...directCommit("def", day(12)), labels: ["one", null] };
    const key = requestedCoverage(ORGANIZATION, REPOSITORY, EvidenceSource.DirectCommits, WINDOW);
    await directCommitCacheWriter()(key, [fact], true);

    const merges = await loadCachedMerges(ORGANIZATION, REPOSITORY, WINDOW);

    expect(merges.directCommits).toEqual([fact]);
  });
});

describe("deserialiseMerges", () => {
  it("should answer a repository the window holds no facts for with empty lists", () => {
    expect(deserialiseMerges(undefined)).toEqual({ pullRequests: [], directCommits: [] });
  });
});
