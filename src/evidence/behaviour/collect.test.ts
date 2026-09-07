import { beforeEach, describe, expect, it, vi } from "vitest";
import { AvailabilityReason, GitHubError } from "../domain/availability.ts";
import { EvidenceSource } from "../domain/coverage.ts";
import { CheckConclusion } from "../domain/facts.ts";
import { createGitHubClient } from "../github/client.ts";
import { personalAccessToken } from "../github/credentials.ts";
import { checkFact, collectDirectCommits, collectMergedPullRequests, collectOpenPullRequestState, mutableEdge, statusConclusion } from "./collect.ts";
import { deserialise } from "./fill.ts";
import { commitQuerySignature, dateShards, mergedSearchQuery, openPullRequestSearchQueries, querySignature, sourceSignature } from "./queries.ts";

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

function pullRequestNode(overrides: Record<string, unknown> = {}) {
  return {
    databaseId: 101,
    number: 11,
    title: "a change",
    body: "a description",
    createdAt: "2026-08-01T00:00:00Z",
    mergedAt: "2026-08-02T00:00:00Z",
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

function search(nodes: unknown[], overrides: Record<string, unknown> = {}) {
  return { search: { issueCount: nodes.length, pageInfo: PAGE_END, nodes, ...overrides } };
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
});

describe("dateShards", () => {
  it("should split a window into thirty-day intervals that meet exactly", () => {
    const shards = [...dateShards(new Date("2026-05-10T00:00:00Z"), new Date("2026-08-08T00:00:00Z"))];

    expect(shards).toHaveLength(3);
    expect(shards[0]?.startsAt.toISOString()).toBe("2026-05-10T00:00:00.000Z");
    expect(shards[0]?.endsAt.toISOString()).toBe("2026-06-09T00:00:00.000Z");
    expect(shards[1]?.startsAt.toISOString()).toBe("2026-06-09T00:00:00.000Z");
    expect(shards.at(-1)?.endsAt.toISOString()).toBe("2026-08-08T00:00:00.000Z");
  });

  it("should yield one shard for a window shorter than the shard length", () => {
    expect([...dateShards(new Date("2026-08-01Z"), new Date("2026-08-05Z"))]).toHaveLength(1);
  });

  it("should yield nothing for an empty window", () => {
    expect([...dateShards(new Date("2026-08-01Z"), new Date("2026-08-01Z"))]).toEqual([]);
  });
});

describe("mergedSearchQuery", () => {
  it("should use an inclusive range with second precision and no fractional part", () => {
    const query = mergedSearchQuery("hmcts", "cath-service", new Date("2026-08-01T00:00:00.000Z"), new Date("2026-08-31T00:00:00.000Z"));

    expect(query).toBe("repo:hmcts/cath-service is:pr is:merged merged:2026-08-01T00:00:00Z..2026-08-31T00:00:00Z");
  });
});

describe("openPullRequestSearchQueries", () => {
  it("should express the exclusive upper bound by ending the inclusive range one second early", () => {
    const queries = openPullRequestSearchQueries(
      "hmcts",
      "cath-service",
      { startsAt: new Date("2026-05-09T00:00:00Z"), endsAt: new Date("2026-08-08T00:00:00Z") },
      new Date("2026-07-25T00:00:00Z")
    );

    expect(queries.openedQuery).toBe("repo:hmcts/cath-service is:pr created:2026-05-09T00:00:00Z..2026-08-07T23:59:59Z");
    expect(queries.closedWithoutMergeQuery).toContain("is:closed -is:merged closed:2026-05-09T00:00:00Z..2026-08-07T23:59:59Z");
    expect(queries.openQuery).toBe("repo:hmcts/cath-service is:pr is:open");
    expect(queries.staleOpenQuery).toBe("repo:hmcts/cath-service is:pr is:open updated:<2026-07-25T00:00:00Z");
  });
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
  it("should convert a search page into facts", async () => {
    const { fetch } = replying(search([pullRequestNode()]));

    const facts = await collectMergedPullRequests(client(fetch), "hmcts", "cath-service", new Date("2026-08-01Z"), new Date("2026-08-31Z"));

    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ identifier: 101, number: 11, authorLogin: "alice", authorType: "User", additions: 10, deletions: 2, changedFiles: 3 });
  });

  it("should refuse a shard above GitHub's 1,000-result cap rather than subdividing it", async () => {
    const { fetch } = replying(search([pullRequestNode()], { issueCount: 1001 }));

    const error = await failing(collectMergedPullRequests(client(fetch), "hmcts", "cath-service", new Date("2026-08-01Z"), new Date("2026-08-31Z")));

    expect(error.reason).toBe(AvailabilityReason.IncompleteHistory);
    expect(error.message).toMatch(/1,000-result limit/);
  });

  it("should exclude a merge outside the half-open window even though the shard range is inclusive", async () => {
    const { fetch } = replying(search([pullRequestNode({ mergedAt: "2026-08-31T00:00:00Z" })]));

    const facts = await collectMergedPullRequests(client(fetch), "hmcts", "cath-service", new Date("2026-08-01Z"), new Date("2026-08-31Z"));

    expect(facts).toEqual([]);
  });

  it("should deduplicate a merge two overlapping shards both returned", async () => {
    const onBoundary = pullRequestNode({ mergedAt: "2026-06-09T00:00:00Z" });
    const { fetch } = replying(search([onBoundary]), search([onBoundary]), search([]), search([]));

    const facts = await collectMergedPullRequests(client(fetch), "hmcts", "cath-service", new Date("2026-05-10Z"), new Date("2026-08-08Z"));

    expect(facts).toHaveLength(1);
  });

  it("should sort stably by merge instant and then identifier", async () => {
    const mergedAt = "2026-08-02T00:00:00Z";
    const { fetch } = replying(search([pullRequestNode({ databaseId: 20, mergedAt }), pullRequestNode({ databaseId: 10, mergedAt })]));

    const facts = await collectMergedPullRequests(client(fetch), "hmcts", "cath-service", new Date("2026-08-01Z"), new Date("2026-08-31Z"));

    expect(facts.map((fact) => fact.identifier)).toEqual([10, 20]);
  });

  it("should follow a search page cursor to the end", async () => {
    const { fetch, sent } = replying(
      search([pullRequestNode({ databaseId: 1 })], { pageInfo: { hasNextPage: true, endCursor: "CURSOR" } }),
      search([pullRequestNode({ databaseId: 2 })])
    );

    const facts = await collectMergedPullRequests(client(fetch), "hmcts", "cath-service", new Date("2026-08-01Z"), new Date("2026-08-31Z"));

    expect(facts).toHaveLength(2);
    expect(sent[1]?.variables.cursor).toBe("CURSOR");
  });

  it("should read the ready-for-review event as the anchor a waiting time is measured from", async () => {
    const { fetch } = replying(search([pullRequestNode({ timelineItems: { nodes: [{ createdAt: "2026-08-01T12:00:00Z" }] } })]));

    const facts = await collectMergedPullRequests(client(fetch), "hmcts", "cath-service", new Date("2026-08-01Z"), new Date("2026-08-31Z"));

    expect(facts[0]?.readyForReviewAt?.toISOString()).toBe("2026-08-01T12:00:00.000Z");
  });

  it("should page an overflowing review connection with a focused follow-up", async () => {
    const { fetch, sent } = replying(
      search([
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

    const facts = await collectMergedPullRequests(client(fetch), "hmcts", "cath-service", new Date("2026-08-01Z"), new Date("2026-08-31Z"));

    expect(facts[0]?.reviews.map((r) => r.identifier)).toEqual([1, 2]);
    expect(sent[1]?.variables.cursor).toBe("REVIEWS");
  });

  it("should page an overflowing status-check rollup with a focused follow-up", async () => {
    const contexts = (nodes: unknown[], hasNextPage: boolean, endCursor: string | null) => ({ pageInfo: { hasNextPage, endCursor }, nodes });
    const { fetch } = replying(
      search([
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

    const facts = await collectMergedPullRequests(client(fetch), "hmcts", "cath-service", new Date("2026-08-01Z"), new Date("2026-08-31Z"));

    expect(facts[0]?.checks.map((c) => c.name)).toEqual(["build", "lint"]);
  });

  it("should report an unreadable body as a collection failure rather than crashing the run", async () => {
    const { fetch } = replying({ search: { issueCount: "not a number" } });

    const error = await failing(collectMergedPullRequests(client(fetch), "hmcts", "cath-service", new Date("2026-08-01Z"), new Date("2026-08-31Z")));

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

describe("collectOpenPullRequestState", () => {
  it("should read four counts from one round trip", async () => {
    const { fetch, sent } = replying({
      openedInWindow: { issueCount: 12 },
      closedWithoutMerge: { issueCount: 3 },
      currentlyOpen: { issueCount: 7 },
      staleOpen: { issueCount: 2 }
    });

    const summary = await collectOpenPullRequestState(
      client(fetch),
      "hmcts",
      "cath-service",
      { startsAt: new Date("2026-08-01Z"), endsAt: new Date("2026-08-31Z") },
      14,
      new Date("2026-08-31T00:00:00Z")
    );

    expect(summary).toEqual({ openedInWindow: 12, closedWithoutMerge: 3, currentlyOpen: 7, staleOpen: 2 });
    expect(sent).toHaveLength(1);
  });

  it("should measure staleness from the last update rather than from when a pull request was opened", async () => {
    const { fetch, sent } = replying({
      openedInWindow: { issueCount: 0 },
      closedWithoutMerge: { issueCount: 0 },
      currentlyOpen: { issueCount: 0 },
      staleOpen: { issueCount: 0 }
    });

    await collectOpenPullRequestState(
      client(fetch),
      "hmcts",
      "cath-service",
      { startsAt: new Date("2026-08-01Z"), endsAt: new Date("2026-08-31Z") },
      14,
      new Date("2026-08-31T00:00:00Z")
    );

    expect(sent[0]?.variables.staleOpenQuery).toContain("updated:<2026-08-17T00:00:00Z");
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
    const { fetch } = replying(search([null, pullRequestNode()]));

    const facts = await collectMergedPullRequests(client(fetch), "hmcts", "cath-service", new Date("2026-08-01Z"), new Date("2026-08-31Z"));

    expect(facts.map((fact) => fact.number)).toEqual([11]);
  });

  it("should skip a null node in commit history rather than fail the repository", async () => {
    const { fetch } = replying(history([null, commitNode()]));

    const facts = await collectDirectCommits(client(fetch), "hmcts", "cath-service", new Date("2026-08-01Z"), new Date("2026-08-31Z"));

    expect(facts.map((fact) => fact.sha)).toEqual(["abc123"]);
  });

  it("should fail loudly when a review follow-up page has lost its pull request", async () => {
    const { fetch } = replying(
      search([
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

    const error = await failing(collectMergedPullRequests(client(fetch), "hmcts", "cath-service", new Date("2026-08-01Z"), new Date("2026-08-31Z")));

    expect(error.message).toMatch(/omitted a pull request while collecting reviews/);
    expect(error.reason).toBe(AvailabilityReason.CollectionFailed);
  });

  it("should fail loudly when a status-check follow-up page has lost its pull request", async () => {
    const { fetch } = replying(
      search([
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

    const error = await failing(collectMergedPullRequests(client(fetch), "hmcts", "cath-service", new Date("2026-08-01Z"), new Date("2026-08-31Z")));

    expect(error.message).toMatch(/omitted a pull request while collecting status checks/);
    expect(error.reason).toBe(AvailabilityReason.CollectionFailed);
  });
});

describe("collecting a fact whose optional fields GitHub omitted", () => {
  it("should build a pull-request fact with no author, body or size", async () => {
    const { fetch } = replying(
      search([
        pullRequestNode({
          author: null,
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

    const facts = await collectMergedPullRequests(client(fetch), "hmcts", "cath-service", new Date("2026-08-01Z"), new Date("2026-08-31Z"));

    const fact = facts[0];
    expect(fact).toBeDefined();
    expect(fact).not.toHaveProperty("authorLogin");
    expect(fact).not.toHaveProperty("additions");
    expect(fact?.reviews[0]).not.toHaveProperty("authorLogin");
    expect(fact?.checks.map((check) => check.name)).toEqual(["", ""]);
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
      search([pullRequestNode()], { pageInfo: { hasNextPage: true, endCursor: null } }),
      search([pullRequestNode({ databaseId: 102, number: 12 })])
    );

    const facts = await collectMergedPullRequests(client(fetch), "hmcts", "cath-service", new Date("2026-08-01Z"), new Date("2026-08-31Z"));

    expect(facts.map((fact) => fact.number)).toEqual([11, 12]);
    expect(sent[1]?.variables.cursor).toBeNull();
  });
});
