import { beforeEach, describe, expect, it, vi } from "vitest";
import { AvailabilityReason, GitHubError } from "../domain/availability.ts";
import { EvidenceSource } from "../domain/coverage.ts";
import { CheckConclusion } from "../domain/facts.ts";
import { createGitHubClient } from "../github/client.ts";
import { personalAccessToken } from "../github/credentials.ts";
import type { TraceabilityConfiguration } from "../policy/schema.ts";
import {
  checkFact,
  collectDirectCommits,
  collectMergedPullRequests,
  findLastHumanCommit,
  HUMAN_COMMIT_PAGE_CAP,
  mutableEdge,
  statusConclusion
} from "./collect.ts";
import { deserialise } from "./fill.ts";
import { commitQuerySignature, querySignature, sourceSignature } from "./queries.ts";

function replying(...bodies: unknown[]): { fetch: typeof globalThis.fetch; sent: { query: string; variables: Record<string, unknown> }[] } {
  const queue = [...bodies];
  const sent: { query: string; variables: Record<string, unknown> }[] = [];
  const fetch = vi.fn((_url: string | URL, init?: RequestInit) => {
    const parsed = JSON.parse(String(init?.body ?? "{}")) as { query: string; variables: Record<string, unknown> };
    sent.push(parsed);
    return Promise.resolve(new Response(JSON.stringify({ data: queue.shift() ?? {} }), { status: 200, headers: { "content-type": "application/json" } }));
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, sent };
}

function client(fetch: typeof globalThis.fetch) {
  return createGitHubClient({ credentials: personalAccessToken("ghp_test"), fetch, pause: () => Promise.resolve(), clock: () => 1000 });
}

const PAGE_END = { hasNextPage: false, endCursor: null };

/** The documented default policy, which is what the collector reduces a title and a description against. */
const TRACEABILITY: TraceabilityConfiguration = { minimum_description: 30, reference_patterns: ["#\\d+", "[A-Z][A-Z0-9]+-\\d+"] };

function pullRequestNode(overrides: Record<string, unknown> = {}) {
  return {
    databaseId: 101,
    number: 11,
    title: "a change",
    body: "a description",
    createdAt: "2026-08-01T00:00:00Z",
    mergedAt: "2026-08-02T00:00:00Z",
    updatedAt: "2026-08-02T00:00:00Z",
    isDraft: false,
    additions: 10,
    deletions: 2,
    changedFiles: 3,
    timelineItems: { nodes: [] },
    author: { login: "alice", __typename: "User" },
    reviews: { pageInfo: PAGE_END, nodes: [] },
    commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
    ...overrides
  };
}

function merged(nodes: unknown[], overrides: Record<string, unknown> = {}) {
  return { repository: { pullRequests: { pageInfo: PAGE_END, nodes, ...overrides } } };
}

async function failing(work: Promise<unknown>): Promise<GitHubError> {
  const outcome = await work.then(
    () => undefined,
    (thrown: unknown) => thrown
  );
  expect(outcome).toBeInstanceOf(GitHubError);
  return outcome as GitHubError;
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

describe("signatures", () => {
  it("should give each independently cached source its own signature", () => {
    expect(querySignature()).not.toBe(commitQuerySignature());
  });

  it("should be stable across calls, so a reader and a writer agree", () => {
    expect(sourceSignature(EvidenceSource.PullRequests)).toBe(querySignature());
    expect(sourceSignature(EvidenceSource.DirectCommits)).toBe(commitQuerySignature());
  });

  it("should be sixteen hex characters", () => {
    expect(querySignature()).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("collectMergedPullRequests", () => {
  it("should convert a page of merged pull requests into facts", async () => {
    const { fetch } = replying(merged([pullRequestNode()]));

    const facts = await collectMergedPullRequests(client(fetch), "hmcts", "cath-service", new Date("2026-08-01Z"), new Date("2026-08-31Z"), TRACEABILITY);

    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ identifier: 101, number: 11, authorLogin: "alice", authorType: "User", additions: 10, deletions: 2, changedFiles: 3 });
  });

  it("should store what a description was measured to be rather than the description", async () => {
    // The whole of VIBE-571: `body` and `title` were two thirds of the estate's stored payload, read off disk on
    // every render to reach a length and a regex match. Both answers are derived here instead, and neither field
    // reaches a fact.
    const { fetch } = replying(merged([pullRequestNode({ title: "a change", body: `  ${"x".repeat(40)}  ` })]));

    const facts = await collectMergedPullRequests(client(fetch), "hmcts", "cath-service", new Date("2026-08-01Z"), new Date("2026-08-31Z"), TRACEABILITY);

    expect(facts[0]).not.toHaveProperty("body");
    expect(facts[0]).not.toHaveProperty("title");
    // Trimmed, so the stored length is the one the threshold is compared against.
    expect(facts[0]?.bodyLength).toBe(40);
  });

  it("should find a ticket reference in the title when the description carries none", async () => {
    const { fetch } = replying(merged([pullRequestNode({ title: "DTSSE-42 add the thing", body: "no reference at all" })]));

    const facts = await collectMergedPullRequests(client(fetch), "hmcts", "cath-service", new Date("2026-08-01Z"), new Date("2026-08-31Z"), TRACEABILITY);

    expect(facts[0]?.hasTicketReference).toBe(true);
  });

  it("should record a merge referencing nothing as measured and unreferenced", async () => {
    // `false`, not absent. Absent is reserved for a row cached before the field existed, and the two must stay
    // distinguishable — see `traceabilityReference`.
    const { fetch } = replying(merged([pullRequestNode({ title: "tidy up", body: "no reference at all" })]));

    const facts = await collectMergedPullRequests(client(fetch), "hmcts", "cath-service", new Date("2026-08-01Z"), new Date("2026-08-31Z"), TRACEABILITY);

    expect(facts[0]?.hasTicketReference).toBe(false);
  });

  it("should apply the configured reference patterns rather than a built-in set", async () => {
    const { fetch } = replying(merged([pullRequestNode({ title: "closes GH-91", body: "" })]));

    const facts = await collectMergedPullRequests(client(fetch), "hmcts", "cath-service", new Date("2026-08-01Z"), new Date("2026-08-31Z"), {
      minimum_description: 30,
      reference_patterns: ["GH-\\d+"]
    });

    expect(facts[0]?.hasTicketReference).toBe(true);
  });

  it("should stop walking once a pull request was updated before the window opened", async () => {
    // The termination condition, and the reason the walk is ordered by updatedAt rather than createdAt: mergedAt is
    // never later than updatedAt, so a node updated before the window opened cannot have merged inside it and
    // neither can anything after it. Without this the walk would read a repository's whole history every run.
    const { fetch, sent } = replying(
      merged([pullRequestNode(), pullRequestNode({ databaseId: 99, number: 9, mergedAt: "2026-07-01T00:00:00Z", updatedAt: "2026-07-01T00:00:00Z" })], {
        pageInfo: { hasNextPage: true, endCursor: "MORE" }
      }),
      merged([pullRequestNode({ databaseId: 98, number: 8 })])
    );

    const facts = await collectMergedPullRequests(client(fetch), "hmcts", "cath-service", new Date("2026-08-01Z"), new Date("2026-08-31Z"), TRACEABILITY);

    expect(facts.map((fact) => fact.number)).toEqual([11]);
    // One call only: the second page is never asked for, even though the first said there was one.
    expect(sent).toHaveLength(1);
  });

  it("should keep walking while pull requests are still being updated inside the window", async () => {
    const { fetch, sent } = replying(
      merged([pullRequestNode()], { pageInfo: { hasNextPage: true, endCursor: "MORE" } }),
      merged([pullRequestNode({ databaseId: 102, number: 12 })])
    );

    const facts = await collectMergedPullRequests(client(fetch), "hmcts", "cath-service", new Date("2026-08-01Z"), new Date("2026-08-31Z"), TRACEABILITY);

    expect(facts.map((fact) => fact.number)).toEqual([11, 12]);
    expect(sent).toHaveLength(2);
  });

  it("should fail loudly when GitHub omits the repository", async () => {
    const { fetch } = replying({ repository: null });

    const error = await failing(
      collectMergedPullRequests(client(fetch), "hmcts", "cath-service", new Date("2026-08-01Z"), new Date("2026-08-31Z"), TRACEABILITY)
    );

    expect(error.reason).toBe(AvailabilityReason.CollectionFailed);
    expect(error.message).toMatch(/omitted the repository/);
  });

  it("should exclude a merge at the window's exclusive end when the walk itself returned it", async () => {
    const { fetch } = replying(merged([pullRequestNode({ mergedAt: "2026-08-31T00:00:00Z" })]));

    const facts = await collectMergedPullRequests(client(fetch), "hmcts", "cath-service", new Date("2026-08-01Z"), new Date("2026-08-31Z"), TRACEABILITY);

    expect(facts).toEqual([]);
  });

  it("should deduplicate a merge two pages of the walk both returned", async () => {
    // A cursor walk can hand back a node it has already given: anything merged while the walk is in flight
    // reorders the `updatedAt` ordering the pages are cut from. The first page must therefore claim another,
    // or the walk stops before the duplicate is ever offered and this asserts nothing.
    const returnedTwice = pullRequestNode({ mergedAt: "2026-06-09T00:00:00Z" });
    const { fetch } = replying(merged([returnedTwice], { pageInfo: { hasNextPage: true, endCursor: "page-one" } }), merged([returnedTwice]));

    const facts = await collectMergedPullRequests(client(fetch), "hmcts", "cath-service", new Date("2026-05-10Z"), new Date("2026-08-08Z"), TRACEABILITY);

    expect(facts).toHaveLength(1);
  });

  it("should sort stably by merge instant and then identifier", async () => {
    const mergedAt = "2026-08-02T00:00:00Z";
    const { fetch } = replying(merged([pullRequestNode({ databaseId: 20, mergedAt }), pullRequestNode({ databaseId: 10, mergedAt })]));

    const facts = await collectMergedPullRequests(client(fetch), "hmcts", "cath-service", new Date("2026-08-01Z"), new Date("2026-08-31Z"), TRACEABILITY);

    expect(facts.map((fact) => fact.identifier)).toEqual([10, 20]);
  });

  it("should follow a search page cursor to the end", async () => {
    const { fetch, sent } = replying(
      merged([pullRequestNode({ databaseId: 1 })], { pageInfo: { hasNextPage: true, endCursor: "CURSOR" } }),
      merged([pullRequestNode({ databaseId: 2 })])
    );

    const facts = await collectMergedPullRequests(client(fetch), "hmcts", "cath-service", new Date("2026-08-01Z"), new Date("2026-08-31Z"), TRACEABILITY);

    expect(facts).toHaveLength(2);
    expect(sent[1]?.variables.cursor).toBe("CURSOR");
  });

  it("should read the ready-for-review event as the anchor a waiting time is measured from", async () => {
    const { fetch } = replying(merged([pullRequestNode({ timelineItems: { nodes: [{ createdAt: "2026-08-01T12:00:00Z" }] } })]));

    const facts = await collectMergedPullRequests(client(fetch), "hmcts", "cath-service", new Date("2026-08-01Z"), new Date("2026-08-31Z"), TRACEABILITY);

    expect(facts[0]?.readyForReviewAt?.toISOString()).toBe("2026-08-01T12:00:00.000Z");
  });

  it("should page an overflowing review connection with a focused follow-up", async () => {
    const { fetch, sent } = replying(
      merged([
        pullRequestNode({
          reviews: {
            pageInfo: { hasNextPage: true, endCursor: "REVIEWS" },
            nodes: [
              {
                databaseId: 1,
                submittedAt: "2026-08-01T06:00:00Z",
                state: "COMMENTED",
                author: { login: "bob", __typename: "User" },
                comments: { totalCount: 2 }
              }
            ]
          }
        })
      ]),
      {
        repository: {
          pullRequest: {
            reviews: {
              pageInfo: PAGE_END,
              nodes: [
                {
                  databaseId: 2,
                  submittedAt: "2026-08-01T07:00:00Z",
                  state: "APPROVED",
                  author: { login: "bob", __typename: "User" },
                  comments: { totalCount: 0 }
                }
              ]
            }
          }
        }
      }
    );

    const facts = await collectMergedPullRequests(client(fetch), "hmcts", "cath-service", new Date("2026-08-01Z"), new Date("2026-08-31Z"), TRACEABILITY);

    expect(facts[0]?.reviews.map((r) => r.identifier)).toEqual([1, 2]);
    expect(sent[1]?.variables.cursor).toBe("REVIEWS");
  });

  it("should page an overflowing status-check rollup with a focused follow-up", async () => {
    const contexts = (nodes: unknown[], hasNextPage: boolean, endCursor: string | null) => ({ pageInfo: { hasNextPage, endCursor }, nodes });
    const { fetch } = replying(
      merged([
        pullRequestNode({
          commits: {
            nodes: [
              {
                commit: {
                  statusCheckRollup: {
                    contexts: contexts(
                      [{ __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "SUCCESS", completedAt: "2026-08-01T09:00:00Z" }],
                      true,
                      "CHECKS"
                    )
                  }
                }
              }
            ]
          }
        })
      ]),
      {
        repository: {
          pullRequest: {
            commits: {
              nodes: [
                {
                  commit: {
                    statusCheckRollup: {
                      contexts: contexts(
                        [{ __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "FAILURE", completedAt: "2026-08-01T09:30:00Z" }],
                        false,
                        null
                      )
                    }
                  }
                }
              ]
            }
          }
        }
      }
    );

    const facts = await collectMergedPullRequests(client(fetch), "hmcts", "cath-service", new Date("2026-08-01Z"), new Date("2026-08-31Z"), TRACEABILITY);

    expect(facts[0]?.checks.map((c) => c.name)).toEqual(["build", "lint"]);
  });

  it("should report an unreadable body as a collection failure rather than crashing the run", async () => {
    const { fetch } = replying({ search: { issueCount: "not a number" } });

    const error = await failing(
      collectMergedPullRequests(client(fetch), "hmcts", "cath-service", new Date("2026-08-01Z"), new Date("2026-08-31Z"), TRACEABILITY)
    );

    expect(error.reason).toBe(AvailabilityReason.CollectionFailed);
  });
});

describe("checkFact", () => {
  it("should leave a running check with no conclusion, so it stays apart from one that failed", () => {
    const fact = checkFact({
      __typename: "CheckRun",
      name: "build",
      status: "IN_PROGRESS",
      conclusion: null,
      completedAt: null,
      context: null,
      state: null,
      createdAt: null
    });

    expect(fact.conclusion).toBeUndefined();
    expect(fact.completedAt).toBeUndefined();
  });

  it("should read a completed check run's conclusion and instant", () => {
    const fact = checkFact({
      __typename: "CheckRun",
      name: "build",
      status: "COMPLETED",
      conclusion: "SUCCESS",
      completedAt: new Date("2026-08-01T09:00:00Z"),
      context: null,
      state: null,
      createdAt: null
    });

    expect(fact).toMatchObject({ name: "build", conclusion: CheckConclusion.Success });
  });

  it("should map a legacy status context onto the check vocabulary", () => {
    const fact = checkFact({
      __typename: "StatusContext",
      name: null,
      status: null,
      conclusion: null,
      completedAt: null,
      context: "ci/jenkins",
      state: "SUCCESS",
      createdAt: new Date("2026-08-01T09:00:00Z")
    });

    expect(fact).toMatchObject({ name: "ci/jenkins", conclusion: CheckConclusion.Success });
  });
});

describe("statusConclusion", () => {
  it.each([
    ["SUCCESS", CheckConclusion.Success],
    ["FAILURE", CheckConclusion.Failure],
    ["ERROR", CheckConclusion.Failure],
    ["PENDING", undefined]
  ])("should map the legacy state %s to %s", (state, expected) => {
    expect(statusConclusion(state)).toBe(expected);
  });
});

describe("collectDirectCommits", () => {
  function commitNode(overrides: Record<string, unknown> = {}) {
    return {
      oid: "abc123",
      committedDate: "2026-08-02T00:00:00Z",
      additions: 5,
      deletions: 1,
      changedFilesIfAvailable: 2,
      author: { user: { login: "alice", __typename: "User" }, name: "Alice" },
      associatedPullRequests: { nodes: [] },
      statusCheckRollup: { state: "SUCCESS" },
      ...overrides
    };
  }

  function history(nodes: unknown[], overrides: Record<string, unknown> = {}) {
    return { repository: { defaultBranchRef: { target: { history: { pageInfo: PAGE_END, nodes, ...overrides } } } } };
  }

  it("should keep only commits no pull request introduced", async () => {
    const { fetch } = replying(history([commitNode(), commitNode({ oid: "def456", associatedPullRequests: { nodes: [{ number: 11 }] } })]));

    const facts = await collectDirectCommits(client(fetch), "hmcts", "cath-service", new Date("2026-08-01Z"), new Date("2026-08-31Z"));

    expect(facts.map((fact) => fact.sha)).toEqual(["abc123"]);
  });

  it("should decide window membership again, since GitHub's since and until are inclusive", async () => {
    const { fetch } = replying(history([commitNode({ committedDate: "2026-08-31T00:00:00Z" })]));

    expect(await collectDirectCommits(client(fetch), "hmcts", "cath-service", new Date("2026-08-01Z"), new Date("2026-08-31Z"))).toEqual([]);
  });

  it("should carry the bare rollup state, which is what makes this query cheap", async () => {
    const { fetch } = replying(history([commitNode()]));

    const facts = await collectDirectCommits(client(fetch), "hmcts", "cath-service", new Date("2026-08-01Z"), new Date("2026-08-31Z"));

    expect(facts[0]?.checkState).toBe("SUCCESS");
  });

  it("should treat a repository with no default branch history as empty rather than as a failure", async () => {
    const { fetch } = replying({ repository: { defaultBranchRef: null } });

    expect(await collectDirectCommits(client(fetch), "hmcts", "empty", new Date("2026-08-01Z"), new Date("2026-08-31Z"))).toEqual([]);
  });

  it("should fall back to the git author name when GitHub linked no account", async () => {
    const { fetch } = replying(history([commitNode({ author: { user: null, name: "Unlinked Person" } })]));

    const facts = await collectDirectCommits(client(fetch), "hmcts", "cath-service", new Date("2026-08-01Z"), new Date("2026-08-31Z"));

    expect(facts[0]).toMatchObject({ authorName: "Unlinked Person" });
    expect(facts[0]?.authorLogin).toBeUndefined();
  });
});

describe("findLastHumanCommit", () => {
  const SINCE = new Date("2024-08-08T00:00:00Z");
  const NONE = new Set<string>();
  const BOTS = new Set(["fluxcdbot"]);

  function node(committedDate: string, login: string | undefined, name = "Someone") {
    return { committedDate, author: { name, user: login === undefined ? null : { login, __typename: login.endsWith("[bot]") ? "Bot" : "User" } } };
  }

  function page(nodes: unknown[], hasNextPage = false, endCursor: string | null = null) {
    return { repository: { defaultBranchRef: { target: { history: { pageInfo: { hasNextPage, endCursor }, nodes } } } } };
  }

  it("should answer the first human commit on the first page and read no further", async () => {
    const { fetch, sent } = replying(page([node("2026-08-05T00:00:00Z", "renovate[bot]"), node("2026-08-04T00:00:00Z", "alice")], true, "c1"));

    const evidence = await findLastHumanCommit(client(fetch), "hmcts", "cath-service", SINCE, NONE, BOTS);

    expect(evidence).toEqual({ lastHumanCommitAt: new Date("2026-08-04T00:00:00Z") });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.variables).toMatchObject({ since: "2024-08-08T00:00:00Z", cursor: null });
  });

  it("should follow the cursor to a human commit on a later page", async () => {
    const { fetch, sent } = replying(page([node("2026-08-05T00:00:00Z", "fluxcdbot")], true, "c1"), page([node("2026-07-01T00:00:00Z", undefined, "Bob")]));

    const evidence = await findLastHumanCommit(client(fetch), "hmcts", "cath-service", SINCE, NONE, BOTS);

    expect(evidence).toEqual({ lastHumanCommitAt: new Date("2026-07-01T00:00:00Z") });
    expect(sent[1]?.variables).toMatchObject({ cursor: "c1" });
  });

  it("should say it searched back to the bound when history ran out with no human commit", async () => {
    const { fetch } = replying(page([node("2026-08-05T00:00:00Z", "renovate[bot]")]));

    expect(await findLastHumanCommit(client(fetch), "hmcts", "cath-service", SINCE, NONE, BOTS)).toEqual({ searchedBackTo: SINCE });
  });

  it("should stop at the page cap and say how far back it got", async () => {
    // Unknown beyond the oldest commit read, which the report must not read as "nobody".
    const pages = Array.from({ length: HUMAN_COMMIT_PAGE_CAP + 1 }, (_, index) =>
      page([node(new Date(Date.UTC(2026, 7, 20 - index)).toISOString(), "renovate[bot]")], true, `c${index}`)
    );
    const { fetch, sent } = replying(...pages);

    const evidence = await findLastHumanCommit(client(fetch), "hmcts", "cath-service", SINCE, NONE, BOTS);

    expect(sent).toHaveLength(HUMAN_COMMIT_PAGE_CAP);
    expect(evidence).toEqual({ searchedBackTo: new Date(Date.UTC(2026, 7, 20 - (HUMAN_COMMIT_PAGE_CAP - 1))) });
  });

  it("should answer neither instant for a branch with no commits", async () => {
    const { fetch } = replying({ repository: { defaultBranchRef: null } });

    expect(await findLastHumanCommit(client(fetch), "hmcts", "empty", SINCE, NONE, BOTS)).toEqual({});
  });

  it("should treat a repository GitHub omitted as a collection failure rather than an empty branch", async () => {
    const { fetch } = replying({ repository: null });

    await expect(findLastHumanCommit(client(fetch), "hmcts", "gone", SINCE, NONE, BOTS)).rejects.toMatchObject({
      reason: AvailabilityReason.CollectionFailed
    });
  });

  it("should treat a capped walk that read no commit at all as a collection failure", async () => {
    // Searching back to `since` would be a claim nothing supports, and it would answer every window "no".
    const pages = Array.from({ length: HUMAN_COMMIT_PAGE_CAP }, (_, index) => page([null], true, `c${index}`));
    const { fetch } = replying(...pages);

    await expect(findLastHumanCommit(client(fetch), "hmcts", "cath-service", SINCE, NONE, BOTS)).rejects.toMatchObject({
      reason: AvailabilityReason.CollectionFailed
    });
  });

  it("should treat an unreadable response as a collection failure", async () => {
    const { fetch } = replying(page([{ committedDate: "not a date", author: null }]));

    await expect(findLastHumanCommit(client(fetch), "hmcts", "cath-service", SINCE, NONE, BOTS)).rejects.toMatchObject({
      reason: AvailabilityReason.CollectionFailed
    });
  });
});

describe("mutableEdge", () => {
  it("should place the edge the configured hours before the reference", () => {
    const edge = mutableEdge({ startsAt: new Date("2026-08-01Z"), endsAt: new Date("2026-08-31Z") }, 6, new Date("2026-08-30T12:00:00Z"));

    expect(edge.toISOString()).toBe("2026-08-30T06:00:00.000Z");
  });

  it("should clamp to the window end when the reference is well past it", () => {
    const edge = mutableEdge({ startsAt: new Date("2026-08-01Z"), endsAt: new Date("2026-08-10Z") }, 6, new Date("2026-08-30T12:00:00Z"));

    expect(edge.toISOString()).toBe("2026-08-10T00:00:00.000Z");
  });

  it("should clamp to the window start when the whole window is inside the mutable edge", () => {
    const edge = mutableEdge({ startsAt: new Date("2026-08-30T09:00:00Z"), endsAt: new Date("2026-08-30T12:00:00Z") }, 6, new Date("2026-08-30T12:00:00Z"));

    expect(edge.toISOString()).toBe("2026-08-30T09:00:00.000Z");
  });
});

describe("deserialise", () => {
  it("should restore every instant field a stored fact carries", () => {
    const stored = {
      identifier: 101,
      mergedAt: "2026-08-02T00:00:00.000Z",
      createdAt: "2026-08-01T00:00:00.000Z",
      reviews: [{ submittedAt: "2026-08-01T06:00:00.000Z", state: "APPROVED" }],
      checks: [{ completedAt: "2026-08-01T09:00:00.000Z", name: "build" }]
    };

    const fact = deserialise<{ mergedAt: Date; reviews: { submittedAt: Date }[]; checks: { completedAt: Date }[] }>(stored);

    expect(fact.mergedAt).toBeInstanceOf(Date);
    expect(fact.reviews[0]?.submittedAt).toBeInstanceOf(Date);
    expect(fact.checks[0]?.completedAt).toBeInstanceOf(Date);
  });

  it("should leave a non-instant string alone", () => {
    expect(deserialise<{ title: string }>({ title: "2026-08-01T00:00:00Z is in the title" }).title).toBe("2026-08-01T00:00:00Z is in the title");
  });
});

describe("collecting through a hole in GitHub's answer", () => {
  function commitNode(overrides: Record<string, unknown> = {}) {
    return {
      oid: "abc123",
      committedDate: "2026-08-02T00:00:00Z",
      additions: 5,
      deletions: 1,
      changedFilesIfAvailable: 2,
      author: { user: { login: "alice", __typename: "User" }, name: "Alice" },
      associatedPullRequests: { nodes: [] },
      statusCheckRollup: { state: "SUCCESS" },
      ...overrides
    };
  }

  function history(nodes: unknown[], overrides: Record<string, unknown> = {}) {
    return { repository: { defaultBranchRef: { target: { history: { pageInfo: PAGE_END, nodes, ...overrides } } } } };
  }

  it("should skip a null node in a merged-pull-request search rather than fail the repository", async () => {
    const { fetch } = replying(merged([null, pullRequestNode()]));

    const facts = await collectMergedPullRequests(client(fetch), "hmcts", "cath-service", new Date("2026-08-01Z"), new Date("2026-08-31Z"), TRACEABILITY);

    expect(facts.map((fact) => fact.number)).toEqual([11]);
  });

  it("should skip a null node in commit history rather than fail the repository", async () => {
    const { fetch } = replying(history([null, commitNode()]));

    const facts = await collectDirectCommits(client(fetch), "hmcts", "cath-service", new Date("2026-08-01Z"), new Date("2026-08-31Z"));

    expect(facts.map((fact) => fact.sha)).toEqual(["abc123"]);
  });

  it("should fail loudly when a review follow-up page has lost its pull request", async () => {
    const { fetch } = replying(
      merged([
        pullRequestNode({
          reviews: {
            pageInfo: { hasNextPage: true, endCursor: "REVIEWS" },
            nodes: [
              {
                databaseId: 1,
                submittedAt: "2026-08-01T06:00:00Z",
                state: "APPROVED",
                author: { login: "bob", __typename: "User" },
                comments: { totalCount: 0 }
              }
            ]
          }
        })
      ]),
      { repository: { pullRequest: null } }
    );

    const error = await failing(
      collectMergedPullRequests(client(fetch), "hmcts", "cath-service", new Date("2026-08-01Z"), new Date("2026-08-31Z"), TRACEABILITY)
    );

    expect(error.message).toMatch(/omitted a pull request while collecting reviews/);
    expect(error.reason).toBe(AvailabilityReason.CollectionFailed);
  });

  it("should fail loudly when a status-check follow-up page has lost its pull request", async () => {
    const { fetch } = replying(
      merged([
        pullRequestNode({
          commits: {
            nodes: [
              {
                commit: {
                  statusCheckRollup: {
                    contexts: {
                      pageInfo: { hasNextPage: true, endCursor: "CHECKS" },
                      nodes: [{ __typename: "CheckRun", name: "build", conclusion: "SUCCESS", completedAt: "2026-08-02T00:00:00Z" }]
                    }
                  }
                }
              }
            ]
          }
        })
      ]),
      { repository: { pullRequest: null } }
    );

    const error = await failing(
      collectMergedPullRequests(client(fetch), "hmcts", "cath-service", new Date("2026-08-01Z"), new Date("2026-08-31Z"), TRACEABILITY)
    );

    expect(error.message).toMatch(/omitted a pull request while collecting status checks/);
    expect(error.reason).toBe(AvailabilityReason.CollectionFailed);
  });
});

describe("collecting a fact whose optional fields GitHub omitted", () => {
  it("should build a pull-request fact with no author, body or size", async () => {
    const { fetch } = replying(
      merged([
        pullRequestNode({
          author: null,
          title: null,
          body: null,
          additions: null,
          deletions: null,
          changedFiles: null,
          reviews: {
            pageInfo: PAGE_END,
            nodes: [{ databaseId: 1, submittedAt: "2026-08-01T06:00:00Z", state: "APPROVED", author: null, comments: { totalCount: 0 } }]
          },
          commits: {
            nodes: [
              {
                commit: {
                  statusCheckRollup: {
                    contexts: {
                      pageInfo: PAGE_END,
                      nodes: [
                        { __typename: "CheckRun", name: null, conclusion: null, completedAt: null, status: "IN_PROGRESS" },
                        { __typename: "StatusContext", context: null, state: null, createdAt: null }
                      ]
                    }
                  }
                }
              }
            ]
          }
        })
      ])
    );

    const facts = await collectMergedPullRequests(client(fetch), "hmcts", "cath-service", new Date("2026-08-01Z"), new Date("2026-08-31Z"), TRACEABILITY);

    const fact = facts[0];
    expect(fact).toBeDefined();
    expect(fact).not.toHaveProperty("authorLogin");
    expect(fact).not.toHaveProperty("additions");
    expect(fact?.reviews[0]).not.toHaveProperty("authorLogin");
    expect(fact?.checks.map((check) => check.name)).toEqual(["", ""]);
    // An omitted description is a MEASURED absence of one, unlike an omitted author: GitHub answered, and the
    // answer is zero characters and nothing referenced. Absent would mean nobody looked, which is what a
    // pre-narrowing cached row says. Neither field is `nullish`-guarded away, and an omitted TITLE must not
    // throw on the way to the reference search either.
    expect(fact?.bodyLength).toBe(0);
    expect(fact?.hasTicketReference).toBe(false);
  });

  it("should build a direct-commit fact with no author, size or rollup", async () => {
    const { fetch } = replying({
      repository: {
        defaultBranchRef: {
          target: {
            history: {
              pageInfo: PAGE_END,
              nodes: [
                {
                  oid: "abc123",
                  committedDate: "2026-08-02T00:00:00Z",
                  additions: null,
                  deletions: null,
                  changedFilesIfAvailable: null,
                  author: null,
                  associatedPullRequests: { nodes: [] },
                  statusCheckRollup: null
                }
              ]
            }
          }
        }
      }
    });

    const facts = await collectDirectCommits(client(fetch), "hmcts", "cath-service", new Date("2026-08-01Z"), new Date("2026-08-31Z"));

    expect(facts[0]?.sha).toBe("abc123");
    expect(facts[0]).not.toHaveProperty("authorLogin");
    expect(facts[0]).not.toHaveProperty("authorName");
    expect(facts[0]).not.toHaveProperty("additions");
  });

  it("should build a direct-commit fact whose author has a name but no account", async () => {
    const { fetch } = replying({
      repository: {
        defaultBranchRef: {
          target: {
            history: {
              pageInfo: PAGE_END,
              nodes: [
                {
                  oid: "def456",
                  committedDate: "2026-08-02T00:00:00Z",
                  additions: 1,
                  deletions: 0,
                  changedFilesIfAvailable: 1,
                  author: { user: null, name: "Alice Unmatched" },
                  associatedPullRequests: { nodes: [null] },
                  statusCheckRollup: { state: null }
                }
              ]
            }
          }
        }
      }
    });

    const facts = await collectDirectCommits(client(fetch), "hmcts", "cath-service", new Date("2026-08-01Z"), new Date("2026-08-31Z"));

    expect(facts[0]?.authorName).toBe("Alice Unmatched");
    expect(facts[0]).not.toHaveProperty("authorLogin");
  });

  it("should page a merged-pull-request search that reports no cursor with its next page", async () => {
    const { fetch, sent } = replying(
      merged([pullRequestNode()], { pageInfo: { hasNextPage: true, endCursor: null } }),
      merged([pullRequestNode({ databaseId: 102, number: 12 })])
    );

    const facts = await collectMergedPullRequests(client(fetch), "hmcts", "cath-service", new Date("2026-08-01Z"), new Date("2026-08-31Z"), TRACEABILITY);

    expect(facts.map((fact) => fact.number)).toEqual([11, 12]);
    expect(sent[1]?.variables.cursor).toBeNull();
  });
});
