import { beforeEach, describe, expect, it, vi } from "vitest";
import { AvailabilityReason, GitHubError } from "../domain/availability.ts";
import {
  classify,
  failureMessage,
  graphqlBodyFailure,
  graphqlErrorReason,
  graphqlErrorSummary,
  graphqlRateLimited,
  reportsFeatureDisabled
} from "./classify.ts";
import { createGitHubClient, nextLink } from "./client.ts";
import { personalAccessToken } from "./credentials.ts";
import { endpointTemplate } from "./endpoint-template.ts";

// Ported from tests/test_github.py. Every case drives a stubbed `fetch`, so nothing here reaches GitHub,
// and the injected clock and pause mean nothing sleeps.

interface Reply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

function replying(...replies: Reply[]): { fetch: typeof globalThis.fetch; calls: string[] } {
  const queue = [...replies];
  const calls: string[] = [];
  const fetch = vi.fn((url: string | URL) => {
    calls.push(String(url));
    const next = queue.shift() ?? { status: 200, body: {} };
    const body = typeof next.body === "string" ? next.body : JSON.stringify(next.body ?? {});
    return Promise.resolve(new Response(body, { status: next.status ?? 200, headers: { "content-type": "application/json", ...next.headers } }));
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

function client(fetch: typeof globalThis.fetch, options: { clock?: () => number; rateLimitReserve?: number } = {}) {
  const paused: number[] = [];
  const instance = createGitHubClient({
    credentials: personalAccessToken("ghp_test"),
    fetch,
    pause: (ms: number) => {
      paused.push(ms);
      return Promise.resolve();
    },
    clock: options.clock ?? (() => 1_000),
    rateLimitReserve: options.rateLimitReserve
  });
  return { instance, paused };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "debug").mockImplementation(() => undefined);
});

describe("get", () => {
  it("should return a parsed body when GitHub answers", async () => {
    const { fetch } = replying({ body: { full_name: "hmcts/cath-service" } });

    expect(await client(fetch).instance.get("/repos/hmcts/cath-service")).toEqual({ full_name: "hmcts/cath-service" });
  });

  it("should append query parameters", async () => {
    const { fetch, calls } = replying({ body: [] });

    await client(fetch).instance.get("/repos/hmcts/cath-service/dependabot/alerts", { state: "open", per_page: 100 });

    expect(calls[0]).toContain("state=open");
    expect(calls[0]).toContain("per_page=100");
  });

  it.each([
    [401, AvailabilityReason.AuthenticationFailed],
    [403, AvailabilityReason.PermissionDenied],
    [404, AvailabilityReason.NotFoundOrInaccessible],
    [500, AvailabilityReason.CollectionFailed]
  ])("should classify HTTP %i as %s", async (status, reason) => {
    // 500 retries to exhaustion first, so give it three replies.
    const { fetch } = replying({ status, body: { message: "no" } }, { status, body: { message: "no" } }, { status, body: { message: "no" } });

    const error = await client(fetch)
      .instance.get("/repos/hmcts/cath-service")
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(GitHubError);
    expect((error as GitHubError).reason).toBe(reason);
  });

  it("should read a 403 explaining a disabled feature as an observation rather than a refusal", async () => {
    const { fetch } = replying({ status: 403, body: { message: "Dependabot alerts are disabled for this repository." } });

    const error = await client(fetch)
      .instance.get("/repos/hmcts/cath-service/dependabot/alerts")
      .catch((thrown: unknown) => thrown);

    expect((error as GitHubError).reason).toBe(AvailabilityReason.FeatureDisabled);
  });

  it("should keep an unrecognised 403 a refusal, so a real permission problem is never hidden", async () => {
    const { fetch } = replying({ status: 403, body: { message: "Resource not accessible by personal access token" } });

    const error = await client(fetch)
      .instance.get("/repos/hmcts/cath-service/dependabot/alerts")
      .catch((thrown: unknown) => thrown);

    expect((error as GitHubError).reason).toBe(AvailabilityReason.PermissionDenied);
  });

  it("should refuse a 200 whose body is not JSON", async () => {
    const { fetch } = replying({ body: "<html>proxy</html>" });

    await expect(client(fetch).instance.get("/repos/hmcts/cath-service")).rejects.toThrow(/unreadable body/);
  });
});

describe("retrying", () => {
  it("should retry a 500 with exponential backoff and succeed", async () => {
    const { fetch } = replying({ status: 500, body: {} }, { body: { ok: true } });
    const { instance, paused } = client(fetch);

    expect(await instance.get("/repos/hmcts/cath-service")).toEqual({ ok: true });
    expect(paused).toEqual([1000]);
  });

  it("should not retry a 404, because the identical request gets the identical answer", async () => {
    const { fetch } = replying({ status: 404, body: { message: "Not Found" } });

    await expect(client(fetch).instance.get("/repos/hmcts/missing")).rejects.toThrow(GitHubError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("should wait the stated retry-after on a rate-limited 403 rather than reporting a refusal", async () => {
    // Retrying a refusal spends a minute learning nothing; reporting a spent quota as a refusal records
    // "nobody may look" as a fact about the repository.
    const { fetch } = replying({ status: 403, headers: { "retry-after": "30" }, body: { message: "API rate limit exceeded" } }, { body: { ok: true } });
    const { instance, paused } = client(fetch);

    expect(await instance.get("/repos/hmcts/cath-service")).toEqual({ ok: true });
    expect(paused).toEqual([30_000]);
  });

  it("should wait until the reset instant when remaining is zero and no retry-after is given", async () => {
    const { fetch } = replying({ status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1060" }, body: {} }, { body: { ok: true } });
    const { instance, paused } = client(fetch, { clock: () => 1_000 });

    await instance.get("/repos/hmcts/cath-service");

    expect(paused).toEqual([60_000]);
  });

  it("should treat a 429 as rate limited even with no headers at all", async () => {
    const { fetch } = replying({ status: 429, body: {} }, { body: { ok: true } });
    const { instance, paused } = client(fetch);

    await instance.get("/repos/hmcts/cath-service");

    expect(paused).toEqual([60_000]);
  });

  it("should report rate limiting once the attempts are spent", async () => {
    const { fetch } = replying({ status: 429, body: {} }, { status: 429, body: {} }, { status: 429, body: {} });

    const error = await client(fetch)
      .instance.get("/repos/hmcts/cath-service")
      .catch((thrown: unknown) => thrown);

    expect((error as GitHubError).reason).toBe(AvailabilityReason.RateLimited);
  });

  it("should ignore a retry-after that is an HTTP-date rather than a number of seconds", async () => {
    // The HTTP spec allows it, and an unguarded parse raised out of the retry path as an unclassified
    // crash instead of a graded refusal.
    const { fetch } = replying(
      { status: 403, headers: { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" }, body: { message: "rate limit" } },
      { body: { ok: true } }
    );
    const { instance, paused } = client(fetch);

    await instance.get("/repos/hmcts/cath-service");

    // Falls through to the flat 60s rather than throwing on the unparseable header.
    expect(paused).toEqual([60_000]);
  });

  it("should mint a fresh token once on a 401 and retry", async () => {
    let refreshed = 0;
    const { fetch } = replying({ status: 401, body: { message: "Bad credentials" } }, { body: { ok: true } });
    const instance = createGitHubClient({
      credentials: {
        token: () => Promise.resolve("ghs_test"),
        refresh: () => {
          refreshed += 1;
          return Promise.resolve(true);
        },
        describe: () => "test"
      },
      fetch,
      pause: () => Promise.resolve(),
      clock: () => 1_000
    });

    expect(await instance.get("/repos/hmcts/cath-service")).toEqual({ ok: true });
    expect(refreshed).toBe(1);
  });

  it("should classify a 401 without retrying when the credential cannot be replaced", async () => {
    // A PAT reports false from refresh, so retrying would send the same refused string.
    const { fetch } = replying({ status: 401, body: { message: "Bad credentials" } });

    await expect(client(fetch).instance.get("/repos/hmcts/cath-service")).rejects.toThrow(GitHubError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("graphql", () => {
  it("should return the data of a successful query", async () => {
    const { fetch } = replying({ body: { data: { search: { issueCount: 569 } } } });

    expect(await client(fetch).instance.graphql("query {}")).toEqual({ search: { issueCount: 569 } });
  });

  it("should read a FORBIDDEN error inside an HTTP 200 as a permission denial", async () => {
    // GitHub answers a GraphQL failure with HTTP 200 and an errors array, so a status read on its own
    // grades a query nobody was allowed to run as a call that worked.
    const { fetch } = replying({ status: 200, body: { errors: [{ type: "FORBIDDEN", message: "Resource not accessible by personal access token" }] } });

    const error = await client(fetch)
      .instance.graphql("query {}")
      .catch((thrown: unknown) => thrown);

    expect((error as GitHubError).reason).toBe(AvailabilityReason.PermissionDenied);
    // Counted at the status the failure IS, so grepping a log for 403 finds it.
    expect((error as GitHubError).status).toBe(403);
  });

  it("should wait out a GraphQL rate-limit error carried in a 200", async () => {
    const { fetch } = replying(
      { status: 200, body: { errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] } },
      { body: { data: { ok: true } } }
    );
    const { instance, paused } = client(fetch);

    expect(await instance.graphql("query {}")).toEqual({ ok: true });
    expect(paused).toEqual([60_000]);
  });

  it("should refuse a response carrying no data", async () => {
    const { fetch } = replying({ body: {} });

    await expect(client(fetch).instance.graphql("query {}")).rejects.toThrow(/no data/);
  });
});

describe("paginate", () => {
  it("should follow the link header to the end", async () => {
    const { fetch } = replying(
      { body: [{ id: 1 }], headers: { link: '<https://api.github.com/repos/hmcts/x/alerts?page=2>; rel="next"' } },
      { body: [{ id: 2 }] }
    );

    const pages: unknown[][] = [];
    for await (const page of client(fetch).instance.paginate("/repos/hmcts/x/alerts")) {
      pages.push(page);
    }

    expect(pages).toEqual([[{ id: 1 }], [{ id: 2 }]]);
  });

  it("should not follow a next link pointing off GitHub's own host", async () => {
    // Not GitHub's pagination, and not followed with GitHub's credential attached.
    const { fetch } = replying({ body: [{ id: 1 }], headers: { link: '<https://evil.test/steal>; rel="next"' } });

    const pages: unknown[][] = [];
    for await (const page of client(fetch).instance.paginate("/repos/hmcts/x/alerts")) {
      pages.push(page);
    }

    expect(pages).toEqual([[{ id: 1 }]]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("rate limit accounting", () => {
  it("should record the budget GitHub reports and expose it under GitHub's own resource name", async () => {
    const { fetch } = replying({
      body: {},
      headers: {
        "x-ratelimit-resource": "search",
        "x-ratelimit-limit": "30",
        "x-ratelimit-remaining": "29",
        "x-ratelimit-used": "1",
        "x-ratelimit-reset": "1060"
      }
    });
    const { instance } = client(fetch);

    await instance.get("/search/commits");

    expect(instance.budget("search")).toEqual({ limit: 30, remaining: 29, used: 1, resetsAt: 1060 });
  });

  it("should ignore a partial budget, because a remaining with no reset cannot be waited on", async () => {
    const { fetch } = replying({ body: {}, headers: { "x-ratelimit-resource": "core", "x-ratelimit-remaining": "0" } });
    const { instance } = client(fetch);

    await instance.get("/repos/hmcts/cath-service");

    expect(instance.budget("core")).toBeUndefined();
  });

  it("should wait out a window at genuine zero before spending a call proving it", async () => {
    const { fetch } = replying(
      {
        body: {},
        headers: {
          "x-ratelimit-resource": "core",
          "x-ratelimit-limit": "5000",
          "x-ratelimit-remaining": "0",
          "x-ratelimit-used": "5000",
          "x-ratelimit-reset": "1060"
        }
      },
      { body: { ok: true } }
    );
    const { instance, paused } = client(fetch);

    await instance.get("/repos/hmcts/a");
    await instance.get("/repos/hmcts/b");

    expect(paused).toEqual([60_000]);
  });

  it("should not wait when the budget still has calls left in it", async () => {
    // A budget with calls left is not exhausted. GraphQL charges points, so a threshold above zero throws
    // away everything between it and zero.
    const { fetch } = replying(
      {
        body: {},
        headers: {
          "x-ratelimit-resource": "core",
          "x-ratelimit-limit": "5000",
          "x-ratelimit-remaining": "75",
          "x-ratelimit-used": "4925",
          "x-ratelimit-reset": "1060"
        }
      },
      { body: { ok: true } }
    );
    const { instance, paused } = client(fetch);

    await instance.get("/repos/hmcts/a");
    await instance.get("/repos/hmcts/b");

    expect(paused).toEqual([]);
  });
});

describe("counting", () => {
  it("should count a retried operation once while counting each of its responses", async () => {
    // Two different numbers: how much the run cost GitHub, and what GitHub answered.
    const { fetch } = replying({ status: 500, body: {} }, { body: { ok: true } });
    const { instance } = client(fetch);

    await instance.get("/repos/hmcts/cath-service");

    expect(instance.requestsIssued()).toBe(1);
  });

  it("should collapse many repositories into one counted endpoint", async () => {
    const { fetch } = replying({ body: {} }, { body: {} });
    const { instance } = client(fetch);

    await instance.get("/repos/hmcts/cath-service");
    await instance.get("/repos/hmcts/pcs-api");

    const counted = instance.callOutcomes();
    expect(counted).toHaveLength(1);
    expect(counted[0]?.count).toBe(2);
    expect(counted[0]?.outcome.endpoint).toBe("https://api.github.com/repos/{organization}/{repository}");
  });
});

describe("endpointTemplate", () => {
  it.each([
    ["https://api.github.com/repos/hmcts/cath-service", "https://api.github.com/repos/{organization}/{repository}"],
    ["https://api.github.com/repos/hmcts/cath-service/rulesets/12345", "https://api.github.com/repos/{organization}/{repository}/rulesets/{id}"],
    [
      "https://api.github.com/repos/hmcts/cath-service/branches/main/protection",
      "https://api.github.com/repos/{organization}/{repository}/branches/{branch}/protection"
    ],
    ["https://api.github.com/repos/hmcts/cath-service/commits/a8810dc", "https://api.github.com/repos/{organization}/{repository}/commits/{sha}"],
    ["https://api.github.com/orgs/hmcts/teams", "https://api.github.com/orgs/{organization}/teams"],
    ["https://api.github.com/graphql", "https://api.github.com/graphql"]
  ])("should normalise %s", (url, expected) => {
    expect(endpointTemplate(url)).toBe(expected);
  });

  it("should placeholder a pagination cursor but keep a describing parameter", () => {
    // Left alone, a paginated read fragments into one counted endpoint per page.
    expect(endpointTemplate("https://api.github.com/repos/hmcts/x/alerts?state=open&page=4")).toBe(
      "https://api.github.com/repos/{organization}/{repository}/alerts?state=open&page={page}"
    );
  });
});

describe("classification helpers", () => {
  it.each([
    ["Dependabot alerts are disabled for this repository.", true],
    ["Code Security must be enabled for this repository to use code scanning", true],
    ["Advanced security is not enabled for this repository", true],
    ["Upgrade to GitHub Pro or make this repository public to enable this feature", true],
    ["Resource not accessible by personal access token", false],
    ["You have exceeded a secondary rate limit", false]
  ])("should read %s as feature-disabled=%s", (message, expected) => {
    expect(reportsFeatureDisabled(message)).toBe(expected);
  });

  it("should prefer GitHub's own message when reporting a failure", () => {
    expect(failureMessage(JSON.stringify({ message: "Not Found" }))).toBe("Not Found");
    expect(failureMessage("<html/>")).toBe("no message");
  });

  it("should count each kind of GraphQL error once, keeping first-appearance order", () => {
    // One search returned the same FORBIDDEN 76 times; repeating it buries the error that appears once.
    const summary = graphqlErrorSummary([
      { type: "FORBIDDEN", message: "no" },
      { type: "FORBIDDEN", message: "no" },
      { type: "NOT_FOUND", message: "gone" }
    ]);

    expect(summary).toBe("FORBIDDEN: no (x2); NOT_FOUND: gone");
  });

  it.each([
    [[{ type: "FORBIDDEN", message: "" }], AvailabilityReason.PermissionDenied],
    [[{ type: "OTHER", message: "Resource not accessible by integration" }], AvailabilityReason.PermissionDenied],
    [[{ type: "NOT_FOUND", message: "Could not resolve" }], AvailabilityReason.CollectionFailed]
  ])("should classify %o as %s", (errors, expected) => {
    expect(graphqlErrorReason(errors)).toBe(expected);
  });

  it("should report no body failure when a GraphQL response carries no errors", () => {
    expect(graphqlBodyFailure(200, JSON.stringify({ data: {} }))).toBeUndefined();
  });

  it.each([
    [JSON.stringify({ errors: [{ message: "API rate limit exceeded" }] }), true],
    [JSON.stringify({ errors: [{ type: "RATE_LIMITED" }] }), true],
    [JSON.stringify({ errors: [{ type: "FORBIDDEN" }] }), false],
    ["not json", false]
  ])("should detect a GraphQL rate limit in %s as %s", (body, expected) => {
    expect(graphqlRateLimited(body)).toBe(expected);
  });

  it("should default an unmapped status to a collection failure", () => {
    expect(classify(502, "{}")[1]).toBe(AvailabilityReason.CollectionFailed);
  });
});

describe("nextLink", () => {
  it("should read the next url out of a link header", () => {
    const header = '<https://api.github.com/x?page=1>; rel="prev", <https://api.github.com/x?page=3>; rel="next"';

    expect(nextLink(header)).toBe("https://api.github.com/x?page=3");
  });

  it("should report nothing on the last page", () => {
    expect(nextLink('<https://api.github.com/x?page=1>; rel="prev"')).toBeUndefined();
  });
});
