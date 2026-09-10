import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sourceSignature } from "../../src/evidence/behaviour/queries.ts";
import { EvidenceSource } from "../../src/evidence/domain/coverage.ts";
import { parseConfiguration } from "../../src/evidence/policy/load.ts";
import { forgetBuiltRows, repositoryRows } from "../../src/evidence/report/repositories.ts";
import { loadCachedFactsForOrganisation, storedRepositoryStates } from "../../src/evidence/store/facts.ts";
import { prisma } from "../../src/evidence/store/prisma.ts";

/**
 * That batching the report's reads did not change what the report says.
 *
 * `repositoryRows` had no test at all while it fetched per repository, which is how a five-call-per-repository
 * loop reached AAT and made a page render take 20 to 28 seconds. These cases pin the two things the batching
 * could plausibly have broken: which repositories appear, and in what order their facts are counted.
 */

const ORGANIZATION = "hmcts";
const PULL_REQUESTS = sourceSignature(EvidenceSource.PullRequests);
const DIRECT_COMMITS = sourceSignature(EvidenceSource.DirectCommits);

const CONFIGURATION = parseConfiguration(`
version: 1
organization: hmcts
cohort:
  visibilities:
    - public
  include_archived: false
`);

const WINDOW = { startsAt: new Date(Date.UTC(2026, 7, 1)), endsAt: new Date(Date.UTC(2026, 8, 1)) };

async function graphRepository(repository: string, pushedAt: Date): Promise<void> {
  await prisma.orgRepository.create({
    data: {
      organization: ORGANIZATION,
      repository,
      archived: false,
      visibility: "PUBLIC",
      // A real column, not a payload field — `liveOrgRepositories` reads it typed, and the cohort's
      // `active_within_days` filter is applied to it.
      pushedAt,
      payload: { defaultBranch: "main", isFork: false },
      observedAt: new Date(Date.UTC(2026, 7, 15)),
      lastObservedAt: new Date(Date.UTC(2026, 7, 15)),
      digest: `${repository}-digest`
    }
  });
  await prisma.repositoryOwnership.create({
    data: {
      organization: ORGANIZATION,
      repository,
      ownerKind: "team",
      owner: "dtsse",
      rung: "teams-api-admin",
      payload: {},
      observedAt: new Date(Date.UTC(2026, 7, 15)),
      lastObservedAt: new Date(Date.UTC(2026, 7, 15)),
      digest: `${repository}-owner-digest`
    }
  });
}

async function mergedPullRequest(repository: string, identifier: bigint, mergedAt: Date): Promise<void> {
  await prisma.pullRequestFact.create({
    data: {
      organization: ORGANIZATION,
      repository,
      queryHash: PULL_REQUESTS,
      identifier,
      mergedAt,
      payload: { identifier: Number(identifier), merged_at: mergedAt.toISOString(), additions: 10, deletions: 1, changed_files: 1 }
    }
  });
}

beforeEach(async () => {
  forgetBuiltRows();
  await prisma.pullRequestFact.deleteMany();
  await prisma.directCommitFact.deleteMany();
  await prisma.repositoryState.deleteMany();
  await prisma.repositoryOwnership.deleteMany();
  await prisma.orgRepository.deleteMany();
  await prisma.sourceCoverage.deleteMany();
});

afterAll(async () => {
  await prisma.pullRequestFact.deleteMany();
  await prisma.directCommitFact.deleteMany();
  await prisma.repositoryState.deleteMany();
  await prisma.repositoryOwnership.deleteMany();
  await prisma.orgRepository.deleteMany();
  await prisma.sourceCoverage.deleteMany();
  await prisma.$disconnect();
});

describe("the batched readers", () => {
  it("should group each repository's facts under its own name, never another's", async () => {
    // The failure the batching could introduce: one query returns every repository's rows, so a grouping mistake
    // would silently credit one repository's merges to another and every figure on the page would still look
    // plausible.
    await graphRepository("alpha", new Date(Date.UTC(2026, 7, 20)));
    await graphRepository("beta", new Date(Date.UTC(2026, 7, 20)));
    await mergedPullRequest("alpha", 1n, new Date(Date.UTC(2026, 7, 10)));
    await mergedPullRequest("alpha", 2n, new Date(Date.UTC(2026, 7, 11)));
    await mergedPullRequest("beta", 3n, new Date(Date.UTC(2026, 7, 12)));

    const facts = await loadCachedFactsForOrganisation(
      ORGANIZATION,
      { pullRequests: PULL_REQUESTS, directCommits: DIRECT_COMMITS },
      WINDOW.startsAt,
      WINDOW.endsAt
    );

    expect(facts.get("alpha")?.pullRequests).toHaveLength(2);
    expect(facts.get("beta")?.pullRequests).toHaveLength(1);
  });

  it("should keep each repository's facts in merge order, so two reports of one window agree", async () => {
    await graphRepository("alpha", new Date(Date.UTC(2026, 7, 20)));
    await mergedPullRequest("alpha", 3n, new Date(Date.UTC(2026, 7, 20)));
    await mergedPullRequest("alpha", 1n, new Date(Date.UTC(2026, 7, 5)));
    await mergedPullRequest("alpha", 2n, new Date(Date.UTC(2026, 7, 12)));

    const facts = await loadCachedFactsForOrganisation(
      ORGANIZATION,
      { pullRequests: PULL_REQUESTS, directCommits: DIRECT_COMMITS },
      WINDOW.startsAt,
      WINDOW.endsAt
    );

    const identifiers = (facts.get("alpha")?.pullRequests ?? []).map((payload) => (payload as { identifier: number }).identifier);
    expect(identifiers).toEqual([1, 2, 3]);
  });

  it("should exclude facts outside the window, on the same half-open rule as the per-repository reader", async () => {
    await graphRepository("alpha", new Date(Date.UTC(2026, 7, 20)));
    await mergedPullRequest("alpha", 1n, new Date(Date.UTC(2026, 6, 31)));
    await mergedPullRequest("alpha", 2n, new Date(Date.UTC(2026, 7, 1)));
    await mergedPullRequest("alpha", 3n, new Date(Date.UTC(2026, 8, 1)));

    const facts = await loadCachedFactsForOrganisation(
      ORGANIZATION,
      { pullRequests: PULL_REQUESTS, directCommits: DIRECT_COMMITS },
      WINDOW.startsAt,
      WINDOW.endsAt
    );

    // Only the merge at startsAt: the one a day before and the one at endsAt both belong to other windows.
    const identifiers = (facts.get("alpha")?.pullRequests ?? []).map((payload) => (payload as { identifier: number }).identifier);
    expect(identifiers).toEqual([2]);
  });

  it("should return a map keyed by repository for stored state", async () => {
    await prisma.repositoryState.create({
      data: { organization: ORGANIZATION, repository: "alpha", fetchedAt: new Date(), payload: { defaultBranch: "main" } }
    });

    const states = await storedRepositoryStates(ORGANIZATION);

    expect(states.get("alpha")?.payload).toEqual({ defaultBranch: "main" });
    expect(states.get("absent")).toBeUndefined();
  });
});

describe("repositoryRows", () => {
  it("should carry every cohort repository, including one with nothing collected", async () => {
    await graphRepository("alpha", new Date(Date.UTC(2026, 7, 20)));
    await graphRepository("beta", new Date(Date.UTC(2026, 7, 20)));
    await mergedPullRequest("alpha", 1n, new Date(Date.UTC(2026, 7, 10)));

    const rows = (await repositoryRows(CONFIGURATION, 26, new Date(Date.UTC(2026, 8, 1)))) as { repository: string; detail?: string }[];

    expect(rows.map((row) => row.repository).sort()).toEqual(["alpha", "beta"]);
  });

  it("should count a repository's own merges, not the estate's", async () => {
    await graphRepository("alpha", new Date(Date.UTC(2026, 7, 20)));
    await graphRepository("beta", new Date(Date.UTC(2026, 7, 20)));
    await prisma.repositoryState.createMany({
      data: [
        { organization: ORGANIZATION, repository: "alpha", fetchedAt: new Date(), payload: { defaultBranch: "main" } },
        { organization: ORGANIZATION, repository: "beta", fetchedAt: new Date(), payload: { defaultBranch: "main" } }
      ]
    });
    await mergedPullRequest("alpha", 1n, new Date(Date.UTC(2026, 7, 10)));
    await mergedPullRequest("alpha", 2n, new Date(Date.UTC(2026, 7, 11)));
    await mergedPullRequest("beta", 3n, new Date(Date.UTC(2026, 7, 12)));

    const rows = (await repositoryRows(CONFIGURATION, 26, new Date(Date.UTC(2026, 8, 1)))) as {
      repository: string;
      merged_pull_requests?: number;
    }[];

    const counts = new Map(rows.map((row) => [row.repository, row.merged_pull_requests]));
    expect(counts.get("alpha")).toBe(2);
    expect(counts.get("beta")).toBe(1);
  });

  it("should stamp coverage as used, so a window a report reads is not pruned", async () => {
    // The batched stamp replaced two writes per repository with one per source. It still has to happen: prune
    // deletes series unused since a cutoff, and an unstamped series a report reads would be deleted under it.
    await graphRepository("alpha", new Date(Date.UTC(2026, 7, 20)));
    const stale = new Date(Date.UTC(2026, 0, 1));
    await prisma.sourceCoverage.create({
      data: {
        organization: ORGANIZATION,
        repository: "alpha",
        source: EvidenceSource.PullRequests,
        queryHash: PULL_REQUESTS,
        startsAt: WINDOW.startsAt,
        endsAt: WINDOW.endsAt,
        accessedAt: stale
      }
    });

    await repositoryRows(CONFIGURATION, 26, new Date(Date.UTC(2026, 8, 1)));

    const row = await prisma.sourceCoverage.findFirst({ where: { organization: ORGANIZATION, repository: "alpha" } });
    expect(row?.accessedAt.getTime()).toBeGreaterThan(stale.getTime());
  });
});

describe("the held rows", () => {
  it("should serve a second call from the first build, which is what halves a render", async () => {
    await graphRepository("alpha", new Date(Date.UTC(2026, 7, 20)));
    await mergedPullRequest("alpha", 1n, new Date(Date.UTC(2026, 7, 10)));
    const reference = new Date(Date.UTC(2026, 8, 1));

    const first = await repositoryRows(CONFIGURATION, 26, reference);
    const second = await repositoryRows(CONFIGURATION, 26, reference);

    expect(second).toBe(first);
  });

  it("should not serve one span's rows for another", async () => {
    await graphRepository("alpha", new Date(Date.UTC(2026, 7, 20)));
    const reference = new Date(Date.UTC(2026, 8, 1));

    const wide = await repositoryRows(CONFIGURATION, 26, reference);
    const narrow = await repositoryRows(CONFIGURATION, 1, reference);

    expect(narrow).not.toBe(wide);
  });

  it("should rebuild once a collection lands, rather than serving the previous revision's figures", async () => {
    await graphRepository("alpha", new Date(Date.UTC(2026, 7, 20)));
    const reference = new Date(Date.UTC(2026, 8, 1));
    const before = await repositoryRows(CONFIGURATION, 26, reference);

    await prisma.collectionState.upsert({
      where: { id: 1 },
      create: { id: 1, revision: 99n, collectedAt: new Date() },
      update: { revision: 99n, collectedAt: new Date() }
    });

    expect(await repositoryRows(CONFIGURATION, 26, reference)).not.toBe(before);
    await prisma.collectionState.deleteMany();
  });
});
