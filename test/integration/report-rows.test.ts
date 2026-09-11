import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sourceSignature } from "../../src/evidence/behaviour/queries.ts";
import { EvidenceSource } from "../../src/evidence/domain/coverage.ts";
import { parseConfiguration } from "../../src/evidence/policy/load.ts";
import { forgetBuiltRows, repositoryRows, teamRows } from "../../src/evidence/report/repositories.ts";
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

/** One owner of one repository, as the ladder resolved it: a team slug, a login, or the unowned negative. */
async function graphOwnership(repository: string, ownerKind: string, owner: string, rung: string): Promise<void> {
  await prisma.repositoryOwnership.create({
    data: {
      organization: ORGANIZATION,
      repository,
      ownerKind,
      owner,
      rung,
      payload: {},
      observedAt: new Date(Date.UTC(2026, 7, 15)),
      lastObservedAt: new Date(Date.UTC(2026, 7, 15)),
      digest: `${repository}-${ownerKind}-${owner}-digest`
    }
  });
}

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
  await graphOwnership(repository, "team", "dtsse", "teams-api-admin");
}

/** A repository one person owns, which is how 242 rows of AAT's ownership table read. */
async function personOwnedRepository(repository: string, login: string): Promise<void> {
  await prisma.orgRepository.create({
    data: {
      organization: ORGANIZATION,
      repository,
      archived: false,
      visibility: "PUBLIC",
      pushedAt: new Date(Date.UTC(2026, 7, 20)),
      payload: { defaultBranch: "main", isFork: false },
      observedAt: new Date(Date.UTC(2026, 7, 15)),
      lastObservedAt: new Date(Date.UTC(2026, 7, 15)),
      digest: `${repository}-digest`
    }
  });
  await graphOwnership(repository, "person", login, "direct-collaborator-admin");
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

/**
 * Who each row says owns it, and which of those owners gets a team card.
 *
 * The seam this covers is the one the two changes sit on: `owner_kind` has to reach the row for
 * `/repositories` to mark an individually-owned repository, and `teamRows` has to stop drawing a card for
 * every login — 126 of AAT's 280 cards were people. Neither is visible from `cohort.test.ts`, which stubs the
 * store, nor from a component test, which is handed rows somebody wrote by hand.
 */
describe("the owner a row is reported under", () => {
  const REFERENCE = new Date(Date.UTC(2026, 8, 1));

  it("should say what kind of thing owns each repository, since a slug and a login look alike", async () => {
    await graphRepository("team-owned", new Date(Date.UTC(2026, 7, 20)));
    await personOwnedRepository("person-owned", "a1i-hussain");
    // Collected, so both rows come off the REPORTABLE branch. The unavailable one builds its own object and is
    // asserted separately below; without state here, this case would only ever exercise that one.
    await prisma.repositoryState.createMany({
      data: [
        { organization: ORGANIZATION, repository: "team-owned", fetchedAt: new Date(), payload: { defaultBranch: "main" } },
        { organization: ORGANIZATION, repository: "person-owned", fetchedAt: new Date(), payload: { defaultBranch: "main" } }
      ]
    });

    const rows = (await repositoryRows(CONFIGURATION, 26, REFERENCE)) as {
      repository: string;
      team: string;
      owner_kind?: string;
      merged_pull_requests?: number;
    }[];

    // Both rows carry counts, which is what says they came off the reportable branch rather than the one above it.
    expect(rows.map((row) => row.merged_pull_requests)).toEqual([0, 0]);

    const owners = new Map(rows.map((row) => [row.repository, row]));
    expect(owners.get("team-owned")).toMatchObject({ team: "dtsse", owner_kind: "team" });
    expect(owners.get("person-owned")).toMatchObject({ team: "a1i-hussain", owner_kind: "person" });
  });

  it("should say the kind on a repository nothing has been collected for, ownership not being a window fact", async () => {
    // The unavailable branch builds its own row, so the field has to be on both of them: a person-owned
    // repository this span cannot report is still owned by that person, and a row without the kind would be
    // linked to a team page for them.
    await personOwnedRepository("person-owned", "a1i-hussain");

    const rows = (await repositoryRows(CONFIGURATION, 26, REFERENCE)) as { repository: string; owner_kind?: string; detail?: string }[];

    expect(rows[0]?.detail).toBe("nothing has been collected for this repository");
    expect(rows[0]?.owner_kind).toBe("person");
  });

  it("should report a repository with no ownership row at all as unowned rather than as somebody's", async () => {
    await prisma.orgRepository.create({
      data: {
        organization: ORGANIZATION,
        repository: "collected-since",
        archived: false,
        visibility: "PUBLIC",
        pushedAt: new Date(Date.UTC(2026, 7, 20)),
        payload: { defaultBranch: "main" },
        observedAt: new Date(Date.UTC(2026, 7, 15)),
        lastObservedAt: new Date(Date.UTC(2026, 7, 15)),
        digest: "collected-since-digest"
      }
    });

    const rows = (await repositoryRows(CONFIGURATION, 26, REFERENCE)) as { team: string; owner_kind?: string }[];

    expect(rows[0]).toMatchObject({ team: "unowned", owner_kind: "none" });
  });

  it("should draw a card for a team and none for a person, whatever either of them owns", async () => {
    // THE 126 CARDS THAT WERE PEOPLE. `/teams/a1i-hussain` was a page headed `team` for one person who holds
    // admin on one repository as a direct collaborator.
    await graphRepository("team-owned", new Date(Date.UTC(2026, 7, 20)));
    await personOwnedRepository("person-owned", "a1i-hussain");

    const cards = (await teamRows(CONFIGURATION, 26, REFERENCE)) as { team: string }[];

    expect(cards.map((card) => card.team)).toEqual(["dtsse"]);
  });

  it("should still draw the unowned card, which is a bucket and not a person", async () => {
    // 141 repositories are reported under it. Dropped alongside the individuals, the cards would stop
    // accounting for them and the estate's team count would not add up against the page.
    await prisma.orgRepository.create({
      data: {
        organization: ORGANIZATION,
        repository: "orphan",
        archived: false,
        visibility: "PUBLIC",
        pushedAt: new Date(Date.UTC(2026, 7, 20)),
        payload: { defaultBranch: "main" },
        observedAt: new Date(Date.UTC(2026, 7, 15)),
        lastObservedAt: new Date(Date.UTC(2026, 7, 15)),
        digest: "orphan-digest"
      }
    });
    await graphOwnership("orphan", "none", "", "unowned");
    await personOwnedRepository("person-owned", "a1i-hussain");

    const cards = (await teamRows(CONFIGURATION, 26, REFERENCE)) as { team: string; repositories: number }[];

    expect(cards).toMatchObject([{ team: "unowned", repositories: 1 }]);
  });

  it("should count no person-owned repository for a team whose slug that login happens to equal", async () => {
    // Nothing in GitHub stops a login equalling a team slug, so the card's count has to exclude a
    // person-owned row by KIND rather than by the identifier failing to match.
    await graphRepository("theirs", new Date(Date.UTC(2026, 7, 20)));
    await prisma.repositoryOwnership.deleteMany({ where: { repository: "theirs" } });
    await graphOwnership("theirs", "person", "dtsse", "direct-collaborator-admin");
    await graphRepository("ours", new Date(Date.UTC(2026, 7, 20)));

    const cards = (await teamRows(CONFIGURATION, 26, REFERENCE)) as { team: string; repositories: number }[];

    expect(cards).toMatchObject([{ team: "dtsse", repositories: 1 }]);
  });

  it("should order the cards by holding, largest first, so 154 of them open on the estates that matter", async () => {
    await graphRepository("one", new Date(Date.UTC(2026, 7, 20)));
    await graphRepository("two", new Date(Date.UTC(2026, 7, 20)));
    // `zzz-small` sorts LAST alphabetically and holds more, which is the only fixture that can tell the two
    // orders apart — a larger team named `a...` would come first under either rule.
    await graphRepository("three", new Date(Date.UTC(2026, 7, 20)));
    await prisma.repositoryOwnership.deleteMany({ where: { repository: { in: ["one", "two"] } } });
    await graphOwnership("one", "team", "zzz-large", "teams-api-admin");
    await graphOwnership("two", "team", "zzz-large", "teams-api-admin");

    const cards = (await teamRows(CONFIGURATION, 26, REFERENCE)) as { team: string; repositories: number }[];

    expect(cards).toMatchObject([
      { team: "zzz-large", repositories: 2 },
      { team: "dtsse", repositories: 1 }
    ]);
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
