import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sourceSignature } from "../../src/evidence/behaviour/queries.ts";
import { EvidenceSource } from "../../src/evidence/domain/coverage.ts";
import { parseConfiguration } from "../../src/evidence/policy/load.ts";
import { builtReport, builtSpanCount, CACHEABLE_SPANS } from "../../src/evidence/report/cache.ts";
import { actorRows, directPushRows, forgetBuiltRows, mergeRows, overviewSummary, repositoryRows, teamRows } from "../../src/evidence/report/repositories.ts";
import { startReportWarmer, warmEverySpan } from "../../src/evidence/report/warmer.ts";
import { loadCachedFactsForOrganisation, storedRepositoryStates } from "../../src/evidence/store/facts.ts";
import { prisma } from "../../src/evidence/store/prisma.ts";
import { midnight } from "../../src/evidence/window/instant.ts";

/**
 * That making the report fast did not change what the report says.
 *
 * `repositoryRows` had no test at all while it fetched per repository, which is how a five-call-per-repository
 * loop reached AAT and made a page render take 20 to 28 seconds. Three things have since been done to it, and
 * each can be wrong in a way no page would show: BATCHING the reads could credit one repository's merges to
 * another, NARROWING the projection could drop a field the readiness assessment grades, and CACHING per span
 * could serve one span's figures for another or one revision's for the next.
 *
 * Every case here was checked against the behaviour it replaced — reintroduced, run, and seen to fail. A case
 * that passes either way would have shipped the original slowness just as quietly.
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

/** Where a fixture's coverage starts. Only its edge is read, so this is far enough back to be out of the way. */
const COVERAGE_FROM = new Date(Date.UTC(2026, 0, 1));

/**
 * The coverage a completed merge walk leaves behind, which is what says a repository was READ.
 *
 * A `repository_state` row does not say it. The stale path writes one having walked nothing, and a refused walk
 * writes one too — so a fixture whose zeroes are meant to be reported has to state its coverage, exactly as a
 * collection does. `endsAt` is where the report anchors: `prevailingCachedCoverage` takes the mode of these edges
 * and every row is reported against it.
 */
async function walked(repository: string, endsAt: Date = WINDOW.endsAt): Promise<void> {
  await prisma.sourceCoverage.createMany({
    data: [
      {
        organization: ORGANIZATION,
        repository,
        source: EvidenceSource.PullRequests,
        queryHash: PULL_REQUESTS,
        startsAt: COVERAGE_FROM,
        endsAt,
        accessedAt: new Date()
      },
      {
        organization: ORGANIZATION,
        repository,
        source: EvidenceSource.DirectCommits,
        queryHash: DIRECT_COMMITS,
        startsAt: COVERAGE_FROM,
        endsAt,
        accessedAt: new Date()
      }
    ]
  });
}

/**
 * One merged pull request as a collection stores it.
 *
 * CAMELCASE IN THE PAYLOAD, because that is what `serialise` writes: the stored document is the domain fact's own
 * field names, and the snake_case this fixture used until 2026-09-15 was a payload no collection has ever
 * produced. It read back as a fact with no `mergedAt` and no size at all, so `builtMergeRows` threw on
 * `mergedAt.toISOString()` and every case reaching the merge rows failed on the fixture rather than on the code.
 */
async function mergedPullRequest(repository: string, identifier: bigint, mergedAt: Date, authorLogin?: string): Promise<void> {
  await prisma.pullRequestFact.create({
    data: {
      organization: ORGANIZATION,
      repository,
      queryHash: PULL_REQUESTS,
      identifier,
      mergedAt,
      payload: {
        identifier: Number(identifier),
        number: Number(identifier),
        mergedAt: mergedAt.toISOString(),
        additions: 10,
        deletions: 1,
        changedFiles: 1,
        // Absent unless a case is about attribution, which is a real shape: GitHub matches no account to some
        // merges, and `builtMergeRows` sends no `author` for them.
        ...(authorLogin === undefined ? {} : { authorLogin, authorType: "User" })
      }
    }
  });
}

/**
 * One commit that reached the default branch with no pull request, as a collection stores it.
 *
 * `authorType` DEFAULTS TO `User` because that is what GitHub answers on this path — measured over 9,663 stored
 * direct commits, not one carries `Bot` — so a fixture typing a bot's commit `Bot` would test a shape the
 * collector never produces and would pass on the `[bot]` suffix rule alone.
 */
async function directCommit(repository: string, sha: string, committedAt: Date, author: { login?: string; name?: string }): Promise<void> {
  await prisma.directCommitFact.create({
    data: {
      organization: ORGANIZATION,
      repository,
      queryHash: DIRECT_COMMITS,
      sha,
      committedAt,
      payload: {
        sha,
        repository,
        committedAt: committedAt.toISOString(),
        additions: 4,
        deletions: 1,
        changedFiles: 1,
        ...(author.login === undefined ? {} : { authorLogin: author.login, authorType: "User" }),
        ...(author.name === undefined ? {} : { authorName: author.name })
      }
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

    const identifiers = (facts.get("alpha")?.pullRequests ?? []).map((row) => (row.payload as { identifier: number }).identifier);
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
    const identifiers = (facts.get("alpha")?.pullRequests ?? []).map((row) => (row.payload as { identifier: number }).identifier);
    expect(identifiers).toEqual([2]);
  });

  it("should drop the payload fields nothing reads, which is two thirds of the bytes", async () => {
    // `body` and `title` are collected for two neutral metrics that neither grade the readiness label nor
    // reach the dashboard, and on AAT they are 62 MB of a 93 MB read. They are subtracted in Postgres, so a
    // regression to a whole-payload projection is a regression in transferred bytes that nothing else notices.
    await graphRepository("alpha", new Date(Date.UTC(2026, 7, 20)));
    await prisma.pullRequestFact.create({
      data: {
        organization: ORGANIZATION,
        repository: "alpha",
        queryHash: PULL_REQUESTS,
        identifier: 1n,
        mergedAt: new Date(Date.UTC(2026, 7, 10)),
        payload: { identifier: 1, title: "a title", body: "a very long description", additions: 10, deletions: 1, changedFiles: 1 }
      }
    });

    const facts = await loadCachedFactsForOrganisation(
      ORGANIZATION,
      { pullRequests: PULL_REQUESTS, directCommits: DIRECT_COMMITS },
      WINDOW.startsAt,
      WINDOW.endsAt
    );

    const payload = (facts.get("alpha")?.pullRequests ?? [])[0]?.payload as Record<string, unknown>;
    expect(payload).not.toHaveProperty("body");
    expect(payload).not.toHaveProperty("title");
  });

  it("should keep every payload field the readiness assessment grades", async () => {
    // The counterpart of the case above, and the one that matters if somebody widens the drop list: the
    // assessment reads sizes, authorship, instants, reviews and checks off the same payload, and a projection
    // that removed one of them would silently regrade the whole estate rather than fail.
    await graphRepository("alpha", new Date(Date.UTC(2026, 7, 20)));
    await prisma.pullRequestFact.create({
      data: {
        organization: ORGANIZATION,
        repository: "alpha",
        queryHash: PULL_REQUESTS,
        identifier: 1n,
        mergedAt: new Date(Date.UTC(2026, 7, 10)),
        payload: {
          identifier: 1,
          number: 7,
          createdAt: new Date(Date.UTC(2026, 7, 9)).toISOString(),
          mergedAt: new Date(Date.UTC(2026, 7, 10)).toISOString(),
          readyForReviewAt: new Date(Date.UTC(2026, 7, 9)).toISOString(),
          authorLogin: "someone",
          authorType: "User",
          additions: 120,
          deletions: 4,
          changedFiles: 9,
          draft: false,
          reviews: [{ identifier: 3, submittedAt: new Date(Date.UTC(2026, 7, 10)).toISOString(), state: "APPROVED", authorLogin: "other", commentCount: 2 }],
          checks: [{ name: "build", conclusion: "SUCCESS", completedAt: new Date(Date.UTC(2026, 7, 10)).toISOString() }]
        }
      }
    });

    const facts = await loadCachedFactsForOrganisation(
      ORGANIZATION,
      { pullRequests: PULL_REQUESTS, directCommits: DIRECT_COMMITS },
      WINDOW.startsAt,
      WINDOW.endsAt
    );

    const payload = (facts.get("alpha")?.pullRequests ?? [])[0]?.payload as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual([
      "additions",
      "authorLogin",
      "authorType",
      "changedFiles",
      "checks",
      "createdAt",
      "deletions",
      "draft",
      "identifier",
      "mergedAt",
      "number",
      "readyForReviewAt",
      "reviews"
    ]);
  });

  it("should carry the instant each fact was selected on, which is the column and not the payload", async () => {
    // What lets ONE read answer for several nested windows. The narrowing in the report layer compares this,
    // deliberately rather than the payload's own `mergedAt`: the two are written from the same fact and should
    // agree, and a stored payload where they do not must not make a warmed span differ from a cold-built one.
    await graphRepository("alpha", new Date(Date.UTC(2026, 7, 20)));
    const mergedAt = new Date(Date.UTC(2026, 7, 10));
    await prisma.pullRequestFact.create({
      data: {
        organization: ORGANIZATION,
        repository: "alpha",
        queryHash: PULL_REQUESTS,
        identifier: 1n,
        mergedAt,
        // A payload disagreeing with its column, which is the only fixture that can tell the two apart.
        payload: { identifier: 1, mergedAt: new Date(Date.UTC(2020, 0, 1)).toISOString() }
      }
    });

    const facts = await loadCachedFactsForOrganisation(
      ORGANIZATION,
      { pullRequests: PULL_REQUESTS, directCommits: DIRECT_COMMITS },
      WINDOW.startsAt,
      WINDOW.endsAt
    );

    expect((facts.get("alpha")?.pullRequests ?? [])[0]?.at.getTime()).toBe(mergedAt.getTime());
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
    await walked("alpha");
    await walked("beta");
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
 * Absent where a merge history was never read, zero where it was read and held nothing.
 *
 * THE CONTRACT'S CENTRAL RULE, applied to the two figures that were exempt from it. A refused merge walk and the
 * stale path both leave a `repository_state` row and NO coverage, and the row built from either used to carry
 * `merged_pull_requests: 0` — a measurement nobody made, carrying no explanation, counted as available and summed
 * into its team's throughput. Every case here states what was WALKED rather than what was collected, because the
 * coverage is what tells the two apart.
 *
 * None of it is visible from a component test, which is handed rows somebody wrote by hand, and none of it from a
 * unit test of the store: the seam is the report reading one estate's coverage and deciding per row.
 */
describe("the merge figures a row states", () => {
  const REFERENCE = new Date(Date.UTC(2026, 8, 1));

  interface ReportedRow {
    repository: string;
    merged_pull_requests?: number;
    direct_commits?: number;
    unreviewed_substantial?: string;
    detail?: string;
  }

  async function rowsByRepository(): Promise<Map<string, ReportedRow>> {
    const rows = (await repositoryRows(CONFIGURATION, 26, REFERENCE)) as ReportedRow[];
    return new Map(rows.map((row) => [row.repository, row]));
  }

  /** A repository a collection reached and read a gate for, which is every fixture below's starting point. */
  async function collected(repository: string): Promise<void> {
    await graphRepository(repository, new Date(Date.UTC(2026, 7, 20)));
    await prisma.repositoryState.create({ data: { organization: ORGANIZATION, repository, fetchedAt: new Date(), payload: readableGate() } });
  }

  it("should report absent counts when the merge walk was refused, rather than a measured zero", async () => {
    // THE REFUSAL THIS IS ABOUT: `FORBIDDEN: Resource not accessible by integration` on the pull-request walk,
    // which `runCollect` counts, warns about and carries on from — leaving a state row, a readable gate and no
    // coverage. The walked repository beside it is what sets the anchor, exactly as the estate does.
    await collected("walked");
    await collected("refused");
    await walked("walked");

    const rows = await rowsByRepository();

    expect(rows.get("refused")?.merged_pull_requests).toBeUndefined();
    expect(rows.get("refused")?.direct_commits).toBeUndefined();
    expect(rows.get("refused")?.detail).toBe("no merge history was read for this repository, so its merges are unmeasured rather than none");
    // Still in the estate: the row is reported and says why it carries no figures, which is the opposite of
    // dropping it. Its gate was readable, so the sentence above is the only one it carries.
    expect(rows.size).toBe(2);
  });

  it("should keep a walked repository's zero, since nothing merged is a measurement", async () => {
    // THE CASE THE GATE MUST NOT SWALLOW. A repository read over a quiet window merged nothing, and `0` is the
    // honest answer for it — the gate asks whether the source was read, not whether anything came back.
    await collected("quiet");
    await walked("quiet");

    const rows = await rowsByRepository();

    expect(rows.get("quiet")?.merged_pull_requests).toBe(0);
    expect(rows.get("quiet")?.direct_commits).toBe(0);
    expect(rows.get("quiet")?.detail).toBeUndefined();
  });

  it("should report absent counts for a stale repository the collection never walked", async () => {
    // The shallow path, which is roughly 650 repositories on this estate: a state row carrying the assurance
    // answers, no merge gate, no merge walk. `cohort.active_within_days` already says it has no behaviour figures
    // to report; this is the report saying the same thing rather than reporting zeroes.
    await graphRepository("stale", new Date(Date.UTC(2024, 0, 15)));
    await prisma.repositoryState.create({
      data: { organization: ORGANIZATION, repository: "stale", fetchedAt: new Date(), payload: { defaultBranch: "main" } }
    });
    await collected("current");
    await walked("current");

    const rows = await rowsByRepository();

    expect(rows.get("stale")?.merged_pull_requests).toBeUndefined();
    expect(rows.get("stale")?.direct_commits).toBeUndefined();
    // BOTH ABSENCES, because they are two calls and two failures: the walk was never made and the gate was never
    // read. A row explaining one and not the other leaves a reader looking for the missing half.
    expect(rows.get("stale")?.detail).toBe(
      "no merge history was read for this repository, so its merges are unmeasured rather than none; the merge gate has not been collected"
    );
  });

  it("should count a repository whose merge history was not read as unavailable", async () => {
    // `unavailable` counts the rows carrying a detail, and until this it counted the merge GATE alone — a separate
    // REST call that usually succeeds, so a refused walk was counted as a reported repository.
    await collected("reported");
    await collected("refused");
    await walked("reported");

    const summary = (await overviewSummary(CONFIGURATION, 26, REFERENCE)) as { repositories: number; unavailable: number };

    expect(summary).toMatchObject({ repositories: 2, unavailable: 1 });
  });

  it("should leave a repository last walked before the anchor out of its team's throughput", async () => {
    // WALKED, BUT NOT FOR THIS REPORT, which is the case a "has it ever been collected" test would miss. The
    // facts in the cache are real and were read a month before the anchor, so counting them would report a
    // month-old answer as this window's — and summing them into the team's throughput is the estate figure the
    // ticket is about.
    await collected("current");
    await collected("lapsed");
    await walked("current");
    await walked("lapsed", new Date(Date.UTC(2026, 7, 1)));
    await mergedPullRequest("current", 1n, new Date(Date.UTC(2026, 7, 10)), "ada");
    await mergedPullRequest("lapsed", 2n, new Date(Date.UTC(2026, 6, 10)), "grace");

    const cards = (await teamRows(CONFIGURATION, 26, REFERENCE)) as { repositories: number; unavailable?: number; practice?: Record<string, number> }[];

    // Both repositories are still the team's, and one of the two is reportable: a holding of two with one
    // unavailable, and a throughput of the one merge anybody actually read.
    expect(cards[0]).toMatchObject({ repositories: 2, unavailable: 1 });
    expect(cards[0]?.practice).toMatchObject({ merged_pull_requests: 1, direct_commits: 0 });
  });

  it("should state the same absences on a warmed span as on one read for itself", async () => {
    // THE ONE-READ INVARIANT, from the report's side. The five spans are built from a single `readEstate`, so the
    // measured-ness has to ride on that read: computed per span it would be five queries, and computed per row it
    // would be one per repository per span. Either mistake still renders — this is what would fail.
    //
    // Dated off today's midnight because a warm anchors itself at `new Date()`, the reason the shared-read case
    // above gives.
    const anchor = midnight(new Date());
    await collected("walked");
    await collected("refused");
    await walked("walked", anchor);
    await mergedPullRequest("walked", 1n, new Date(anchor.getTime() - 86_400_000));

    const alone = (await repositoryRows(CONFIGURATION, 4, anchor)) as ReportedRow[];
    expect(alone.map((row) => row.merged_pull_requests)).toEqual([undefined, 1]);

    forgetBuiltRows();
    await warmEverySpan(CONFIGURATION);

    expect(((await repositoryRows(CONFIGURATION, 4, anchor)) as ReportedRow[]).map((row) => row.merged_pull_requests)).toEqual(
      alone.map((row) => row.merged_pull_requests)
    );
  });
});

/**
 * The direct commits `cohort.no_direct_pushes` permits a row to state.
 *
 * THE SHAPE IT IS FOR is one repository on the estate: `cnp-flux-config`, 362,987 commits on `master` and 18,714
 * inside a 90-day window, whose commit walk does not finish. It leaves pull-request coverage and none for the
 * commits, so the row reported a dash and "the direct commits were not read for this repository" indefinitely,
 * where the human answer is none — the pushes are `fluxcdbot`'s, which `cohort.bot_accounts` already excludes.
 *
 * A DECLARATION, AND THESE CASES ARE WHAT KEEPS IT ONE. Its branch ruleset requires a pull request on `master`,
 * which is not evidence: 91 of the 413 repositories carrying such a gate here hold direct-commit facts, this one
 * among them. So the second case below is the important one — a repository nobody declared and nobody walked must
 * still report an absence, which is VIBE-563's contract and what an inference from the gate would have broken.
 */
describe("the direct commits a declaration permits", () => {
  const REFERENCE = new Date(Date.UTC(2026, 8, 1));

  interface ReportedRow {
    repository: string;
    merged_pull_requests?: number;
    direct_commits?: number;
    detail?: string;
  }

  /** The estate's policy declaring that no person pushes to the named repositories' default branches. */
  function declaring(...repositories: string[]) {
    return parseConfiguration(`
version: 1
organization: hmcts
cohort:
  visibilities:
    - public
  include_archived: false
  no_direct_pushes:
${repositories.map((repository) => `    - ${repository}`).join("\n")}
`);
  }

  /**
   * The coverage a run leaves where the pull-request walk finished and the commit walk did not.
   *
   * `walked` above writes both rows, which is the one shape this cannot use: the whole case is a repository read
   * for one source and not the other, and it is what the live estate holds for `cnp-flux-config`.
   */
  async function walkedPullRequestsOnly(repository: string): Promise<void> {
    await prisma.sourceCoverage.create({
      data: {
        organization: ORGANIZATION,
        repository,
        source: EvidenceSource.PullRequests,
        queryHash: PULL_REQUESTS,
        startsAt: COVERAGE_FROM,
        endsAt: WINDOW.endsAt,
        accessedAt: new Date()
      }
    });
  }

  /** A repository a collection reached and read a gate for, whose commit walk got nowhere. */
  async function commitWalkNeverFinished(repository: string): Promise<void> {
    await graphRepository(repository, new Date(Date.UTC(2026, 7, 20)));
    await prisma.repositoryState.create({ data: { organization: ORGANIZATION, repository, fetchedAt: new Date(), payload: readableGate() } });
    await walkedPullRequestsOnly(repository);
  }

  async function rowFor(configuration: ReturnType<typeof parseConfiguration>, repository: string): Promise<ReportedRow | undefined> {
    const rows = (await repositoryRows(configuration, 26, REFERENCE)) as ReportedRow[];
    return rows.find((row) => row.repository === repository);
  }

  it("should report zero direct commits when the repository is declared and its commit walk never ran", async () => {
    await commitWalkNeverFinished("cnp-flux-config");
    const configuration = declaring("cnp-flux-config");

    const row = await rowFor(configuration, "cnp-flux-config");

    // Zero, off the facts it holds none of — the declaration permits the figure and never supplies it.
    expect(row?.direct_commits).toBe(0);
    expect(row?.merged_pull_requests).toBe(0);
    // Neither unread sentence: the pull requests were walked and the commits are declared, so the row explains
    // nothing because there is nothing left to explain.
    expect(row?.detail).toBeUndefined();
    // And so it is no longer one of the estate's `unavailable` rows, which counts the rows carrying a detail.
    const summary = (await overviewSummary(configuration, 26, REFERENCE)) as { repositories: number; unavailable: number };
    expect(summary).toMatchObject({ repositories: 1, unavailable: 0 });
  });

  it("should still report an absence when the repository is not declared and its commit walk never ran", async () => {
    // VIBE-563'S CONTRACT, restated against the declaration: absent means unmeasured. Every repository the gate
    // does not name keeps the answer it had, and this is the case an inference from the branch ruleset would have
    // turned into a confident zero for 91 repositories that really do hold direct commits.
    await commitWalkNeverFinished("undeclared");

    const row = await rowFor(CONFIGURATION, "undeclared");

    expect(row?.direct_commits).toBeUndefined();
    expect(row?.merged_pull_requests).toBe(0);
    expect(row?.detail).toBe("the direct commits were not read for this repository, so they are unmeasured rather than none");
  });

  it("should report zero direct commits when the declared name is cased differently from the repository's", async () => {
    // Folded on BOTH sides, so neither spelling has to be the canonical one: the name in the file is typed by hand
    // and a mis-cased one matching nothing would read as a declaration somebody made and the report ignored.
    await commitWalkNeverFinished("CNP-Flux-Config");

    const row = await rowFor(declaring("cnp-flux-config"), "CNP-Flux-Config");

    expect(row?.direct_commits).toBe(0);
    expect(row?.detail).toBeUndefined();
  });
});

/**
 * Which merges a report counts, and which it leaves out.
 *
 * `cohort.excluded_authors` defaulted to `renovate, dependabot` and APPLIED TO NOTHING: `inCohort` and
 * `excludedAuthors` existed, were unit-tested, and were called from no production path. So every figure on the
 * dashboard counted dependency automation — a Renovate pull request is small, single-file, frequently
 * auto-approved and merges in minutes, which inflated the throughput counts and the substantial-merge
 * denominators, deflated both timing medians, and lifted quiet repositories past `assessment.minimum_merges` so
 * that a repository with no human activity graded green instead of declining for insufficient sample.
 *
 * The direct-commit half is wider and separately measured: of 9,663 stored direct commits NOT ONE carries
 * `authorType: "Bot"`, and three suffix-less service accounts author 44% of them, so `cohort.bot_accounts` names
 * them and `reportedDirectCommit` drops them.
 *
 * NONE OF IT IS VISIBLE FROM A UNIT TEST OF THE FILTER, which is why these are here: the filter is applied at one
 * seam inside `readEstate`, and what has to be true is that every report built from that read — the rows, the
 * labels, the two activity tables, the contributor rows and the estate summary — counts the same cohort, while the
 * measured-versus-absent contract survives untouched.
 */
describe("the merges a report counts", () => {
  const REFERENCE = new Date(Date.UTC(2026, 8, 1));

  /** The estate's policy with one cohort block replaced, which is the only thing that differs between renders. */
  function policy(cohort: string) {
    return parseConfiguration(`
version: 1
organization: hmcts
cohort:
  visibilities:
    - public
  include_archived: false
${cohort}
`);
  }

  /** A repository a collection reached, read a gate for and walked both sources of. */
  async function walkedRepository(repository: string): Promise<void> {
    await graphRepository(repository, new Date(Date.UTC(2026, 7, 20)));
    await prisma.repositoryState.create({ data: { organization: ORGANIZATION, repository, fetchedAt: new Date(), payload: readableGate() } });
    await walked(repository);
  }

  interface CountedRow {
    repository: string;
    merged_pull_requests?: number;
    direct_commits?: number;
    readiness?: string;
    detail?: string;
  }

  async function rowFor(configuration: ReturnType<typeof parseConfiguration>, repository: string): Promise<CountedRow | undefined> {
    const rows = (await repositoryRows(configuration, 26, REFERENCE)) as CountedRow[];
    return rows.find((row) => row.repository === repository);
  }

  it("should leave a dependency bot's merges out of the count a row states", async () => {
    await walkedRepository("alpha");
    await mergedPullRequest("alpha", 1n, new Date(Date.UTC(2026, 7, 10)), "ada");
    await mergedPullRequest("alpha", 2n, new Date(Date.UTC(2026, 7, 11)), "renovate[bot]");
    await mergedPullRequest("alpha", 3n, new Date(Date.UTC(2026, 7, 12)), "dependabot[bot]");

    expect((await rowFor(CONFIGURATION, "alpha"))?.merged_pull_requests).toBe(1);
  });

  it("should report a measured zero when every merge in the window was a bot's", async () => {
    // THE CASE THAT MUST NOT BECOME AN ABSENCE. The walk happened and found merges; the report counts none of
    // them. That is a measured nothing, and `undefined` here would say nobody looked — which is the distinction
    // the whole contract rests on and the one filtering could most easily destroy.
    await walkedRepository("automated");
    await mergedPullRequest("automated", 1n, new Date(Date.UTC(2026, 7, 10)), "renovate[bot]");
    await directCommit("automated", "aaa", new Date(Date.UTC(2026, 7, 11)), { login: "fluxcdbot" });

    const row = await rowFor(CONFIGURATION, "automated");

    expect(row?.merged_pull_requests).toBe(0);
    expect(row?.direct_commits).toBe(0);
    // No sentence about an unread source, because both sources WERE read.
    expect(row?.detail).toBeUndefined();
  });

  it("should still report an absence, and not a zero, where the walk never happened", async () => {
    // The other half of the same rule, restated against the filter: a repository with no coverage carries no
    // figures at all, and filtering must not fill them in.
    await graphRepository("refused", new Date(Date.UTC(2026, 7, 20)));
    await prisma.repositoryState.create({
      data: { organization: ORGANIZATION, repository: "refused", fetchedAt: new Date(), payload: readableGate() }
    });
    await walkedRepository("anchor");
    await mergedPullRequest("refused", 1n, new Date(Date.UTC(2026, 7, 10)), "renovate[bot]");

    const row = await rowFor(CONFIGURATION, "refused");

    expect(row?.merged_pull_requests).toBeUndefined();
    expect(row?.direct_commits).toBeUndefined();
    expect(row?.detail).toBe("no merge history was read for this repository, so its merges are unmeasured rather than none");
  });

  it("should report the figures a changed exclusion asks for, with nothing recollected", async () => {
    // THE ACCEPTANCE CRITERION FOR THE SEAM'S PLACEMENT. The filter is applied after the cache is read, so the
    // stored facts stay complete and who counts is a reporting decision: the same rows in the same tables answer
    // two policies differently, and nothing has to be fetched again to change the answer.
    await walkedRepository("alpha");
    await mergedPullRequest("alpha", 1n, new Date(Date.UTC(2026, 7, 10)), "ada");
    await mergedPullRequest("alpha", 2n, new Date(Date.UTC(2026, 7, 11)), "renovate[bot]");
    const stored = await prisma.pullRequestFact.count();

    const excluding = (await rowFor(policy("  excluded_authors:\n    - renovate"), "alpha"))?.merged_pull_requests;
    forgetBuiltRows();
    const counting = (await rowFor(policy("  excluded_authors: []"), "alpha"))?.merged_pull_requests;
    forgetBuiltRows();
    const alsoAda = (await rowFor(policy("  excluded_authors:\n    - ada"), "alpha"))?.merged_pull_requests;

    expect([excluding, counting, alsoAda]).toEqual([1, 2, 1]);
    // Nothing was collected to make that happen: the cache holds exactly what it held before the three renders.
    expect(await prisma.pullRequestFact.count()).toBe(stored);
  });

  /**
   * One mechanical merge in the shape the estate actually holds them: one line, one file, auto-approved, CI
   * green, and merged an hour after the review.
   *
   * Written out rather than taken from `mergedPullRequest` because this case is about GRADING, and that fixture
   * stores no `reviews` or `checks` array — a cohort large enough to grade then throws inside `eligibleReviews`
   * instead of being graded.
   */
  async function mechanicalMerge(repository: string, identifier: bigint, mergedAt: Date, authorLogin: string): Promise<void> {
    const readyAt = new Date(mergedAt.getTime() - 2 * 3_600_000);
    const reviewedAt = new Date(mergedAt.getTime() - 3_600_000);
    await prisma.pullRequestFact.create({
      data: {
        organization: ORGANIZATION,
        repository,
        queryHash: PULL_REQUESTS,
        identifier,
        mergedAt,
        payload: {
          identifier: Number(identifier),
          number: Number(identifier),
          createdAt: readyAt.toISOString(),
          readyForReviewAt: readyAt.toISOString(),
          mergedAt: mergedAt.toISOString(),
          authorLogin,
          authorType: "User",
          additions: 1,
          deletions: 1,
          changedFiles: 1,
          draft: false,
          reviews: [
            {
              identifier: Number(identifier),
              submittedAt: reviewedAt.toISOString(),
              state: "APPROVED",
              authorLogin: "reviewer",
              authorType: "User",
              commentCount: 1
            }
          ],
          checks: [{ name: "build", conclusion: "SUCCESS", completedAt: reviewedAt.toISOString() }]
        }
      }
    });
  }

  it("should decline to grade a repository whose only merges were a bot's, rather than grading it green", async () => {
    // THE READINESS LABEL THE TICKET IS ABOUT, AS A FIXTURE — the live re-check on quiet Renovate-heavy
    // repositories needs the production estate, which this suite cannot reach.
    //
    // Twelve mechanical merges carry a quiet repository past `assessment.minimum_merges: 10`, and every
    // behavioural rate over them is Renovate's own practice: 100% reviewed, 100% approved, 100% checked, an
    // hour to review and two to merge. So the repository grades GREEN on the strength of automation, and the
    // label says a team is working well in a repository no person has touched. Counting the human cohort
    // instead — nought merges — declines it through `insufficient-merges`, which is what it is.
    await walkedRepository("quiet");
    for (let number = 1; number <= 12; number += 1) {
      await mechanicalMerge("quiet", BigInt(number), new Date(Date.UTC(2026, 7, 10, number)), "renovate[bot]");
    }

    const graded = (await rowFor(policy("  excluded_authors: []"), "quiet"))?.readiness;
    forgetBuiltRows();
    const declined = (await rowFor(policy("  excluded_authors:\n    - renovate"), "quiet"))?.readiness;

    expect(graded).toBe("green");
    expect(declined).toBe("cannot_assess");
  });

  it("should leave a named bot's direct commits out, and keep a person whose login merely contains bot", async () => {
    // `fluxcdbot` is typed `User` by GitHub and carries no `[bot]` suffix, so only the named list catches it.
    // `gemmatalbot` is Gemma Talbot, and a substring rule would call her work automation — the failure that
    // would be worse than the miscount it fixed.
    await walkedRepository("alpha");
    await directCommit("alpha", "aaa", new Date(Date.UTC(2026, 7, 10)), { login: "gemmatalbot" });
    await directCommit("alpha", "bbb", new Date(Date.UTC(2026, 7, 11)), { login: "fluxcdbot" });
    await directCommit("alpha", "ccc", new Date(Date.UTC(2026, 7, 12)), { login: "hmcts-platform-operations" });
    await directCommit("alpha", "ddd", new Date(Date.UTC(2026, 7, 13)), { login: "renovate[bot]" });
    // GitHub matched no account, so the git author name is the only identity there is.
    await directCommit("alpha", "eee", new Date(Date.UTC(2026, 7, 14)), { name: "fluxcdbot" });

    const row = await rowFor(CONFIGURATION, "alpha");
    const pushes = (await directPushRows(CONFIGURATION, 26, REFERENCE)) as { sha: string }[];

    expect(row?.direct_commits).toBe(1);
    expect(pushes.map((push) => push.sha)).toEqual(["aaa"]);
  });

  it("should keep a bot's pull request in the cohort where only the account list names it", async () => {
    // THE ASYMMETRY, stated as a test so nobody unifies the two lists. An agent's pull request was opened,
    // reviewed and merged through the gate, which is the practice being measured — `bot_accounts` decides who is
    // a person, not whose merges count, and `excluded_authors` is what drops a merge.
    await walkedRepository("alpha");
    await mergedPullRequest("alpha", 1n, new Date(Date.UTC(2026, 7, 10)), "claude");
    await directCommit("alpha", "aaa", new Date(Date.UTC(2026, 7, 11)), { login: "claude" });

    const row = await rowFor(CONFIGURATION, "alpha");

    expect(row?.merged_pull_requests).toBe(1);
    expect(row?.direct_commits).toBe(0);
  });

  it("should leave the bot's merges out of the estate summary and the team's throughput too", async () => {
    // Every report off the one read, not just the row: the header's totals and the team card's throughput are
    // summed from these rows, and a filter applied per report rather than per read would leave them disagreeing.
    await walkedRepository("alpha");
    await mergedPullRequest("alpha", 1n, new Date(Date.UTC(2026, 7, 10)), "ada");
    await mergedPullRequest("alpha", 2n, new Date(Date.UTC(2026, 7, 11)), "renovate[bot]");
    await directCommit("alpha", "aaa", new Date(Date.UTC(2026, 7, 12)), { login: "fluxcdbot" });

    const summary = (await overviewSummary(CONFIGURATION, 26, REFERENCE)) as { merged_pull_requests: number; direct_commits: number };
    const cards = (await teamRows(CONFIGURATION, 26, REFERENCE)) as { practice?: Record<string, number> }[];

    expect(summary).toMatchObject({ merged_pull_requests: 1, direct_commits: 0 });
    expect(cards[0]?.practice).toMatchObject({ merged_pull_requests: 1, direct_commits: 0 });
  });

  it("should list neither the bot's merge nor the bot as a contributor", async () => {
    await walkedRepository("alpha");
    await mergedPullRequest("alpha", 1n, new Date(Date.UTC(2026, 7, 10)), "ada");
    await mergedPullRequest("alpha", 2n, new Date(Date.UTC(2026, 7, 11)), "renovate[bot]");
    await directCommit("alpha", "aaa", new Date(Date.UTC(2026, 7, 12)), { login: "fluxcdbot" });

    const merges = (await mergeRows(CONFIGURATION, 26, REFERENCE)) as { author?: string }[];
    const actors = (await actorRows(CONFIGURATION, 26, REFERENCE)) as { login: string }[];

    expect(merges.map((merge) => merge.author)).toEqual(["ada"]);
    expect(actors.map((actor) => actor.login)).toEqual(["ada"]);
  });

  it("should count the same cohort on a warmed span as on one read for itself", async () => {
    // THE ONE-READ INVARIANT, from the exclusion's side. The filter runs inside `readEstate`, so all five spans
    // inherit it from one read — and a span derived from the shared read has to report the figure that span
    // would have read for itself. Anchored at today's midnight because a warm anchors itself at `new Date()`.
    const anchor = midnight(new Date());
    await walkedRepository("alpha");
    await prisma.sourceCoverage.updateMany({ where: { organization: ORGANIZATION, repository: "alpha" }, data: { endsAt: anchor } });
    await mergedPullRequest("alpha", 1n, new Date(anchor.getTime() - 86_400_000), "ada");
    await mergedPullRequest("alpha", 2n, new Date(anchor.getTime() - 86_400_000), "renovate[bot]");
    await directCommit("alpha", "aaa", new Date(anchor.getTime() - 86_400_000), { login: "fluxcdbot" });

    const alone = new Map<number, CountedRow | undefined>();
    for (const weeks of CACHEABLE_SPANS) {
      const rows = (await repositoryRows(CONFIGURATION, weeks, anchor)) as CountedRow[];
      alone.set(weeks, rows[0]);
    }
    expect([...alone.values()].map((row) => row?.merged_pull_requests)).toEqual(CACHEABLE_SPANS.map(() => 1));

    forgetBuiltRows();
    await warmEverySpan(CONFIGURATION);

    for (const weeks of CACHEABLE_SPANS) {
      const rows = (await repositoryRows(CONFIGURATION, weeks, anchor)) as CountedRow[];
      expect(rows[0]).toEqual(alone.get(weeks));
    }
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
    // WALKED, which is what makes the zeroes below measured ones. Collected and walked are different facts and
    // only the coverage states the second.
    await walked("team-owned");
    await walked("person-owned");

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

  it("should still hold one span's build after another span has been read", async () => {
    // The failure a single held entry had: reading a second span EVICTED the first, so a reader switching from
    // four weeks to twelve made the next reader of four weeks pay for a full rebuild. Nothing had changed —
    // the entry was thrown away by the reader who arrived next. Five spans on offer means five entries.
    await graphRepository("alpha", new Date(Date.UTC(2026, 7, 20)));
    const reference = new Date(Date.UTC(2026, 8, 1));

    const first = await repositoryRows(CONFIGURATION, 4, reference);
    await repositoryRows(CONFIGURATION, 12, reference);
    await repositoryRows(CONFIGURATION, 26, reference);

    expect(await repositoryRows(CONFIGURATION, 4, reference)).toBe(first);
  });

  it("should hold every offered span at once, so no reader meets a cold one", async () => {
    await graphRepository("alpha", new Date(Date.UTC(2026, 7, 20)));
    const reference = new Date(Date.UTC(2026, 8, 1));

    for (const weeks of CACHEABLE_SPANS) {
      await repositoryRows(CONFIGURATION, weeks, reference);
    }

    expect(builtSpanCount()).toBe(CACHEABLE_SPANS.length);
  });

  it("should not hold a span no page offers, so a query string cannot grow the cache without bound", async () => {
    // `?weeks=` is reader-controlled. A span off the selector's list is answered and forgotten rather than held,
    // or the map is keyed by whatever anybody types.
    await graphRepository("alpha", new Date(Date.UTC(2026, 7, 20)));
    const reference = new Date(Date.UTC(2026, 8, 1));

    const first = await repositoryRows(CONFIGURATION, 7, reference);

    expect(builtSpanCount()).toBe(0);
    expect(await repositoryRows(CONFIGURATION, 7, reference)).not.toBe(first);
  });

  it("should drop every superseded span when a collection lands, not only the one being read", async () => {
    // Without the prune, a process that never restarts accumulates one set of entries per daily collection.
    await graphRepository("alpha", new Date(Date.UTC(2026, 7, 20)));
    const reference = new Date(Date.UTC(2026, 8, 1));
    await repositoryRows(CONFIGURATION, 4, reference);
    await repositoryRows(CONFIGURATION, 12, reference);
    expect(builtSpanCount()).toBe(2);

    await prisma.collectionState.upsert({
      where: { id: 1 },
      create: { id: 1, revision: 42n, collectedAt: new Date() },
      update: { revision: 42n, collectedAt: new Date() }
    });
    await repositoryRows(CONFIGURATION, 4, reference);

    // Only the span just rebuilt: the twelve-week entry described the previous revision and went with it.
    expect(builtSpanCount()).toBe(1);
    await prisma.collectionState.deleteMany();
  });

  it("should not cache a failed build, so one database error is not served for the life of the process", async () => {
    const failing = () => Promise.reject(new Error("connection reset"));

    await expect(builtReport(ORGANIZATION, 4, failing)).rejects.toThrow("connection reset");

    expect(builtSpanCount()).toBe(0);
    await expect(builtReport(ORGANIZATION, 4, () => Promise.resolve([{ repository: "alpha" }]))).resolves.toEqual([{ repository: "alpha" }]);
  });

  it("should share one build between two concurrent readers rather than running it twice", async () => {
    // On a pod capped at one CPU, two readers arriving on a cold span must not start two builds that then
    // compete for the same core. This is also what makes the warmer safe beside live traffic.
    let builds = 0;
    const build = () => {
      builds += 1;
      return new Promise<unknown[]>((resolve) => setTimeout(() => resolve([{ repository: "alpha" }]), 20));
    };

    const [left, right] = await Promise.all([builtReport(ORGANIZATION, 8, build), builtReport(ORGANIZATION, 8, build)]);

    expect(builds).toBe(1);
    expect(right).toBe(left);
  });
});

describe("the warmer", () => {
  it("should build every offered span, so the first reader of each pays for none of it", async () => {
    await graphRepository("alpha", new Date(Date.UTC(2026, 7, 20)));

    await warmEverySpan(CONFIGURATION);

    expect(builtSpanCount()).toBe(CACHEABLE_SPANS.length);
  });

  it("should build each span from the shared read exactly as that span would have read for itself", async () => {
    // THE CASE THE SHARED READ COULD BE WRONG IN. One read of the widest span is narrowed in memory for the
    // other four, so a narrowing on the wrong boundary would report one span's merges as another's — every figure
    // on the page still plausible. Three merges, placed so that the 1-, 4- and 26-week spans each have a
    // DIFFERENT answer: an off-by-one window then shows up as the wrong count rather than as nothing at all.
    //
    // Dated off TODAY'S midnight because the warm anchors itself at `new Date()`, and with nothing collected the
    // anchor is that midnight. A fixed reference would compare two different windows and fail for that alone.
    const anchor = midnight(new Date());
    const daysBack = (days: number) => new Date(anchor.getTime() - days * 86_400_000);
    await graphRepository("alpha", daysBack(1));
    await prisma.repositoryState.create({
      data: { organization: ORGANIZATION, repository: "alpha", fetchedAt: new Date(), payload: readableGate() }
    });
    // Walked to the anchor, so the counts below are reported at all. The edge is that same midnight, which is
    // also what `collectedAnchor` snaps every span to — so the windows are the ones this case was written for.
    await walked("alpha", anchor);
    await mergedPullRequest("alpha", 1n, daysBack(1));
    await mergedPullRequest("alpha", 2n, daysBack(20));
    await mergedPullRequest("alpha", 3n, daysBack(120));

    // Read for itself, span by span, which is what a reader arriving on a cold span still does.
    const alone = new Map<number, number | undefined>();
    for (const weeks of CACHEABLE_SPANS) {
      const rows = (await repositoryRows(CONFIGURATION, weeks, anchor)) as { merged_pull_requests?: number }[];
      alone.set(weeks, rows[0]?.merged_pull_requests);
    }
    // Not an assertion about the shared read — it is what makes the comparison below able to fail.
    expect([...alone.values()]).toEqual([1, 2, 2, 2, 3]);

    forgetBuiltRows();
    await warmEverySpan(CONFIGURATION);

    for (const weeks of CACHEABLE_SPANS) {
      const rows = (await repositoryRows(CONFIGURATION, weeks, anchor)) as { merged_pull_requests?: number }[];
      expect(rows[0]?.merged_pull_requests).toBe(alone.get(weeks));
    }
  });

  it("should order two merges at the same instant the same way however the span was built", async () => {
    // THE DIFFERENCE THE SHARED READ ACTUALLY INTRODUCED, found by comparing all four reports for all five spans
    // against AAT: the sets matched and the SEQUENCES did not. `sort` is stable, so an equal-instant pair came out
    // in whatever order the fact map was iterated — which is the order the query returned the repositories in, and
    // that differs between a 26-week read and a 4-week one. Same rows, different report.
    //
    // The instants here are equal ACROSS REPOSITORIES, which is the only shape that can show it: within one
    // repository the facts arrive in one list whichever window read them.
    const anchor = midnight(new Date());
    const mergedAt = new Date(anchor.getTime() - 2 * 86_400_000);
    await graphRepository("zulu", anchor);
    await graphRepository("alpha", anchor);
    await mergedPullRequest("zulu", 1n, mergedAt);
    await mergedPullRequest("alpha", 2n, mergedAt);

    const alone = ((await mergeRows(CONFIGURATION, 1, anchor)) as { repository: string }[]).map((row) => row.repository);

    forgetBuiltRows();
    await warmEverySpan(CONFIGURATION);

    expect(((await mergeRows(CONFIGURATION, 1, anchor)) as { repository: string }[]).map((row) => row.repository)).toEqual(alone);
    // Stated rather than left implicit: the tie is broken on the repository, so the order is the data's and not
    // the query's. A test that only compared the two builds would pass if both were arbitrary in the same way.
    expect(alone).toEqual(["alpha", "zulu"]);
  });

  it("should warm the remaining spans even when one of them fails", async () => {
    // The spans are independent builds. A failure on the widest is no reason to leave the other four cold, and
    // the warmer is an optimisation that must never take the pod down with it.
    await graphRepository("alpha", new Date(Date.UTC(2026, 7, 20)));
    const broken = { ...CONFIGURATION, lookback: { ...CONFIGURATION.lookback, stale_collection_days: Number.NaN } };

    await expect(warmEverySpan(broken)).resolves.toBeUndefined();
  });

  it("should rebuild every span when a collection lands, so no reader pays for the first read after one", async () => {
    // The half a warm-at-boot alone does not cover: the 15:00 collection invalidates every span, and without
    // the poll the next reader of each one pays a cold build. The collector is in another pod, so the revision
    // in the database is the only signal that reaches here.
    await graphRepository("alpha", new Date(Date.UTC(2026, 7, 20)));
    const warmer = startReportWarmer(CONFIGURATION, 20);
    try {
      await warmer.settled();

      await prisma.collectionState.upsert({
        where: { id: 1 },
        create: { id: 1, revision: 7n, collectedAt: new Date() },
        update: { revision: 7n, collectedAt: new Date() }
      });
      await new Promise((settle) => setTimeout(settle, 60));
      await warmer.settled();

      // Reading one span AFTER the poll must find every entry current and so prune nothing. A count alone
      // cannot say this: five entries left over from the previous revision count five too. What separates the
      // two is what a read does to them — a stale set is pruned down to the one span just rebuilt.
      await repositoryRows(CONFIGURATION, 4, new Date(Date.UTC(2026, 8, 1)));
      expect(builtSpanCount()).toBe(CACHEABLE_SPANS.length);
    } finally {
      warmer.stop();
      await prisma.collectionState.deleteMany();
    }
  });

  it("should warm once and not again while the revision stands still", async () => {
    // The poll runs every minute for the life of the pod, so what it does on a revision that has not moved is
    // the steady state. It must be the single-row read and nothing else: re-warming would walk five spans a
    // minute for ever, and on one CPU that is work taken from whatever reader arrived.
    await graphRepository("alpha", new Date(Date.UTC(2026, 7, 20)));
    const warms = vi.spyOn(console, "info");
    const warmer = startReportWarmer(CONFIGURATION, 20);
    try {
      await warmer.settled();
      const landed = () => warms.mock.calls.filter(([line]) => String(line).includes("rebuilding every span")).length;
      expect(landed()).toBe(1);

      // Several polls' worth of time with nothing landing.
      await new Promise((settle) => setTimeout(settle, 90));
      await warmer.settled();

      expect(landed()).toBe(1);
    } finally {
      warmer.stop();
      warms.mockRestore();
    }
  });
});

/**
 * What the TEAM half of the report sends, which is where two bugs and one new section meet.
 *
 * `/teams/<team>` was throwing for every team on the estate before this: `teamRows` emitted neither `actors` nor
 * `unavailable`, and `src/app/teams/[team]/page.tsx` calls `.length` on the first — a TypeError caught as
 * `notFound()`, so the page reported "no such team" for every team there is. A component test could not see it,
 * because it is handed rows somebody wrote by hand; only the seam between the report layer and the contract shows
 * it. Pre-existing on master and unrelated to the table rework, fixed here because the ways-of-working section is
 * added to that same page and would otherwise be unreachable.
 */
/**
 * A collected state whose merge gate is readable, requiring two approvals and one status check.
 *
 * Shared because two cases need it and for one reason worth stating: a payload with NO `mergeGate` is not an
 * "empty" fixture — the row it produces carries `detail`, which is what `unavailable` counts and what keeps every
 * gate figure absent. So a case about the ways-of-working denominators has to state a real gate or it is asserting
 * against a repository the report could not grade.
 */
function readableGate() {
  return {
    defaultBranch: "main",
    mergeGate: {
      gate: {
        branch: "main",
        protected: true,
        rulesObserved: true,
        pullRequests: [{ requiredApprovingReviewCount: 2, dismissStaleReviewsOnPush: true, requireCodeOwnerReview: false, requireLastPushApproval: false }],
        statusChecks: [{ contexts: ["build"], strictRequiredStatusChecksPolicy: true }],
        restrictsDeletions: true,
        blocksForcePushes: true,
        requiresLinearHistory: false,
        restrictsBranchNames: false,
        unmodelledRules: []
      }
    }
  };
}

describe("the team rows", () => {
  const REFERENCE = new Date(Date.UTC(2026, 8, 1));

  it("should send actors as a COUNT and unavailable as a count, which the team card reads", async () => {
    // THE TWO FIELDS WHOSE ABSENCE BROKE THE PAGE. `unavailable` feeds the readiness donut and `lib/team.ts`;
    // `actors` was then emitted as `[]` because `TeamDetail` types it as `TeamActorRow[]` — but a card is a
    // `TeamRow`, where it is a NUMBER, and `TeamsList` printed the empty list as nothing at all.
    //
    // Zero here, and it is measured: a repository nothing was collected for holds no merges, which is nobody
    // having landed a change rather than nobody having counted.
    await graphRepository("alpha", new Date(Date.UTC(2026, 7, 20)));

    const cards = (await teamRows(CONFIGURATION, 26, REFERENCE)) as { team: string; actors?: unknown; unavailable?: number }[];

    expect(cards[0]?.actors).toBe(0);
    expect(cards[0]?.unavailable).toBe(1);
  });

  it("should count the people who landed changes, folded and deduplicated across the team's repositories", async () => {
    // A COUNT OF PEOPLE AND NOT OF ROWS. Four merges by three logins across two repositories the same team owns,
    // one of them spelled two ways — a GitHub login is unique case-insensitively — and one author GitHub matched
    // no account to. The card must read 3, which is also what `teamActors` puts in the table on that team's page:
    // both fold the same emitted merge rows, which is the acceptance criterion for the two agreeing.
    await graphRepository("alpha", new Date(Date.UTC(2026, 7, 20)));
    await graphRepository("beta", new Date(Date.UTC(2026, 7, 20)));
    await mergedPullRequest("alpha", 1n, new Date(Date.UTC(2026, 7, 21)), "Ada");
    await mergedPullRequest("alpha", 2n, new Date(Date.UTC(2026, 7, 22)), "ada");
    await mergedPullRequest("beta", 3n, new Date(Date.UTC(2026, 7, 23)), "grace");
    await mergedPullRequest("beta", 4n, new Date(Date.UTC(2026, 7, 24)), "alan");
    await mergedPullRequest("beta", 5n, new Date(Date.UTC(2026, 7, 25)));

    const cards = (await teamRows(CONFIGURATION, 26, REFERENCE)) as { repositories: number; actors?: unknown }[];

    expect(cards[0]).toMatchObject({ repositories: 2, actors: 3 });
  });

  it("should count a repository whose gate could not be read as unavailable rather than as reported", async () => {
    // `unavailable` counts the rows carrying `detail`, and a row carries one when there is no merge gate to grade
    // — whether nothing was collected at all or the collection could not read the gate. Both fixtures here are
    // collected AND walked; only one has a readable gate, which is what separates them. An unread merge history
    // is the other way a row carries a detail, so both are walked here or the case would count two.
    await graphRepository("gated", new Date(Date.UTC(2026, 7, 20)));
    await graphRepository("ungated", new Date(Date.UTC(2026, 7, 20)));
    await walked("gated");
    await walked("ungated");
    await prisma.repositoryState.createMany({
      data: [
        { organization: ORGANIZATION, repository: "gated", fetchedAt: new Date(), payload: readableGate() },
        // Collected, and GitHub would not disclose the rules — a real state, and a different one from uncollected.
        { organization: ORGANIZATION, repository: "ungated", fetchedAt: new Date(), payload: { defaultBranch: "main" } }
      ]
    });

    const cards = (await teamRows(CONFIGURATION, 26, REFERENCE)) as { repositories: number; unavailable?: number }[];

    expect(cards[0]).toMatchObject({ repositories: 2, unavailable: 1 });
  });

  it("should count the ways of working over what was MEASURED, not over the holding", async () => {
    // The denominator is the point. One repository's gate is readable and requires two approvals; the other was
    // never collected, so it has no answer — and counting it against the holding would report a repository nobody
    // could read as one that fails to enforce review.
    await graphRepository("gated", new Date(Date.UTC(2026, 7, 20)));
    await graphRepository("unread", new Date(Date.UTC(2026, 7, 20)));
    await prisma.repositoryState.create({
      data: { organization: ORGANIZATION, repository: "gated", fetchedAt: new Date(), payload: readableGate() }
    });

    const cards = (await teamRows(CONFIGURATION, 26, REFERENCE)) as { practice?: Record<string, number> }[];

    expect(cards[0]?.practice).toMatchObject({
      // ONE, not two: the uncollected repository is not in the denominator at all.
      gates_measured: 1,
      enforces_review: 1,
      // `requires_multiple_reviews` was asserted here until 2026-09-15. `teamPractice` stopped emitting it in
      // #21 — the >=2 count had no reader once the page printed the >=1 one — and this assertion outlived it
      // because these cases are not run by the pipeline.
      checks_measured: 1,
      enforces_checks: 1
    });
  });

  it("should count no ways-of-working figure for a team whose gates were all unreadable", async () => {
    // Every denominator zero rather than every count zero, which is what lets the page say "not measured" instead
    // of printing "0 of 0" — a figure that reads as a finding about the team.
    await graphRepository("alpha", new Date(Date.UTC(2026, 7, 20)));

    const cards = (await teamRows(CONFIGURATION, 26, REFERENCE)) as { practice?: Record<string, number> }[];

    expect(cards[0]?.practice).toMatchObject({ gates_measured: 0, checks_measured: 0, unreviewed_measured: 0 });
  });
});

/**
 * The two timing medians, which are the "time to review merge requests" half of what moved to the team page.
 *
 * Read off `BehaviourMetric.summary`, so the page and the assessment compare the same number at the same
 * percentile. What these cases are mostly about is the payload shape: the metrics reach into `reviews` without a
 * guard, and the cache does not promise every stored row has one.
 */
describe("the review timings", () => {
  const REFERENCE = new Date(Date.UTC(2026, 8, 1));

  /** One merged pull request with a review, which is what a timing can actually be measured from. */
  async function reviewedMerge(repository: string, options: { readyAt: Date; reviewedAt: Date; mergedAt: Date }): Promise<void> {
    await prisma.pullRequestFact.create({
      data: {
        organization: ORGANIZATION,
        repository,
        queryHash: PULL_REQUESTS,
        identifier: 501n,
        mergedAt: options.mergedAt,
        payload: {
          identifier: 501,
          number: 7,
          createdAt: options.readyAt.toISOString(),
          readyForReviewAt: options.readyAt.toISOString(),
          mergedAt: options.mergedAt.toISOString(),
          authorLogin: "author",
          authorType: "User",
          additions: 120,
          deletions: 4,
          changedFiles: 9,
          draft: false,
          // `authorType` is required for `isHumanReview`: a review with no type reads as a bot and is not eligible,
          // so a fixture without it measures nothing and the case would assert against an absence.
          reviews: [
            { identifier: 3, submittedAt: options.reviewedAt.toISOString(), state: "APPROVED", authorLogin: "reviewer", authorType: "User", commentCount: 2 }
          ],
          checks: []
        }
      }
    });
  }

  it("should report both medians in hours off the facts already cached", async () => {
    // Ready at 09:00, reviewed at 14:00, merged at 15:00: five hours to the first review and six to the merge.
    //
    // The state row is what puts this on the REPORTABLE branch. Without it `repositoryRow` returns early with
    // `detail` and no figures at all, so the case would assert an absence and pass whatever the metrics did.
    await graphRepository("alpha", new Date(Date.UTC(2026, 7, 20)));
    await prisma.repositoryState.create({
      data: { organization: ORGANIZATION, repository: "alpha", fetchedAt: new Date(), payload: readableGate() }
    });
    // Walked, like the state row and for the same reason: the medians are figures about the window's merge cohort,
    // so they are absent for a repository whose cohort was never read and the case would assert against that.
    await walked("alpha");
    await reviewedMerge("alpha", {
      readyAt: new Date(Date.UTC(2026, 7, 10, 9)),
      reviewedAt: new Date(Date.UTC(2026, 7, 10, 14)),
      mergedAt: new Date(Date.UTC(2026, 7, 10, 15))
    });

    const rows = (await repositoryRows(CONFIGURATION, 26, REFERENCE)) as { time_to_first_review_hours?: number; merge_cycle_time_hours?: number }[];

    expect(rows[0]?.time_to_first_review_hours).toBe(5);
    expect(rows[0]?.merge_cycle_time_hours).toBe(6);
  });

  it("should leave both absent where no review was observed, never reporting nought hours", async () => {
    // `0 hours` would say a team reviews instantly. Absent is what the contract means by unmeasured.
    await graphRepository("alpha", new Date(Date.UTC(2026, 7, 20)));
    await mergedPullRequest("alpha", 1n, new Date(Date.UTC(2026, 7, 10)));

    const rows = (await repositoryRows(CONFIGURATION, 26, REFERENCE)) as { time_to_first_review_hours?: number }[];

    expect(rows[0]?.time_to_first_review_hours).toBeUndefined();
  });

  it("should render the row rather than throwing when a stored payload carries no reviews array", async () => {
    // A REAL SHAPE IN THE CACHE, not defensive padding. `eligibleReviews` reads `pullRequest.reviews` with no
    // check, so a payload lacking it throws — and the projection in `loadCachedFactsForOrganisation` has been
    // narrowed once already, so "every stored payload carries every field" is an assumption about history. One
    // such row must not 500 the whole page.
    //
    // The state row is load-bearing: without it the row takes the unavailable branch, never reaches the metrics,
    // and the case passes with the guard removed. Found exactly that way. The coverage is load-bearing for the
    // same reason — an unwalked repository states no median either, so the guard would go unexercised.
    await graphRepository("alpha", new Date(Date.UTC(2026, 7, 20)));
    await prisma.repositoryState.create({
      data: { organization: ORGANIZATION, repository: "alpha", fetchedAt: new Date(), payload: readableGate() }
    });
    await walked("alpha");
    await prisma.pullRequestFact.create({
      data: {
        organization: ORGANIZATION,
        repository: "alpha",
        queryHash: PULL_REQUESTS,
        identifier: 601n,
        mergedAt: new Date(Date.UTC(2026, 7, 10)),
        // No `reviews`, which is what this case is about.
        payload: { identifier: 601, mergedAt: new Date(Date.UTC(2026, 7, 10)).toISOString(), additions: 10, deletions: 1, changedFiles: 1 }
      }
    });

    const rows = (await repositoryRows(CONFIGURATION, 26, REFERENCE)) as { repository: string; time_to_first_review_hours?: number }[];

    expect(rows[0]?.repository).toBe("alpha");
    expect(rows[0]?.time_to_first_review_hours).toBeUndefined();
  });
});
