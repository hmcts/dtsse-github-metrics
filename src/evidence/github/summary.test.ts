import { describe, expect, it } from "vitest";
import type { CallOutcome, RateLimitWait } from "./client.ts";
import { runSummaryLines } from "./summary.ts";

/** A counted outcome, spelled only as far as each case needs. */
function counted(outcome: Partial<CallOutcome>, count: number): { outcome: CallOutcome; count: number } {
  return {
    outcome: { status: 200, outcome: "ok", method: "GET", endpoint: "https://api.github.com/orgs/{organization}/repos", ...outcome },
    count
  };
}

function source(outcomes: { outcome: CallOutcome; count: number }[], waits: RateLimitWait[] = []) {
  return { callOutcomes: () => outcomes, rateLimitWaits: () => waits };
}

describe("runSummaryLines", () => {
  it("should order the endpoints by what they cost when a run spent unevenly across them", () => {
    // The summary exists to answer "where did the eleven thousand calls go", and insertion order answers it only
    // by accident — whichever endpoint the collection reached first would lead.
    const lines = runSummaryLines(
      source([
        counted({ endpoint: "https://api.github.com/orgs/{organization}/repos" }, 19),
        counted({ endpoint: "https://api.github.com/repos/{organization}/{repository}/dependabot/alerts" }, 1240),
        counted({ endpoint: "https://api.github.com/graphql AssuranceSignals" }, 38)
      ])
    );

    expect(lines).toEqual([
      "  200 ok GET https://api.github.com/repos/{organization}/{repository}/dependabot/alerts (x1240)",
      "  200 ok GET https://api.github.com/graphql AssuranceSignals (x38)",
      "  200 ok GET https://api.github.com/orgs/{organization}/repos (x19)"
    ]);
  });

  it("should order two endpoints of equal cost by name, so two runs over one estate read the same", () => {
    const lines = runSummaryLines(
      source([counted({ endpoint: "https://api.github.com/graphql MergedPullRequests" }, 5), counted({ endpoint: "https://api.github.com/graphql Checks" }, 5)])
    );

    expect(lines).toEqual(["  200 ok GET https://api.github.com/graphql Checks (x5)", "  200 ok GET https://api.github.com/graphql MergedPullRequests (x5)"]);
  });

  it("should report a retried and an exhausted attempt as their own lines rather than folding them into the successes", () => {
    const lines = runSummaryLines(
      source([
        counted({}, 1),
        counted({ status: 502, outcome: "retried" }, 3),
        counted({ status: 429, outcome: "rate-limited" }, 2),
        counted({ status: 0, outcome: "exhausted" }, 1)
      ])
    );

    expect(lines).toEqual([
      "  502 retried GET https://api.github.com/orgs/{organization}/repos (x3)",
      "  429 rate-limited GET https://api.github.com/orgs/{organization}/repos (x2)",
      "  0 exhausted GET https://api.github.com/orgs/{organization}/repos (x1)",
      "  200 ok GET https://api.github.com/orgs/{organization}/repos (x1)"
    ]);
  });

  it("should report the hours a quota cost a run, last and apart from the calls", () => {
    // A pause is not a call, so the two are never in one list: a reader who could add them together would.
    const lines = runSummaryLines(source([counted({}, 2)], [{ resource: "core", seconds: 61.4, count: 1 }]));

    expect(lines).toEqual(["  200 ok GET https://api.github.com/orgs/{organization}/repos (x2)", "  waited 61s for the core quota across 1 pause"]);
  });

  it("should pluralise the pauses and lead with the resource that cost the most", () => {
    const lines = runSummaryLines(
      source(
        [],
        [
          { resource: "core", seconds: 120, count: 3 },
          { resource: "graphql", seconds: 900, count: 2 }
        ]
      )
    );

    expect(lines).toEqual(["  waited 900s for the graphql quota across 2 pauses", "  waited 120s for the core quota across 3 pauses"]);
  });

  it("should order two resources that cost the same by name", () => {
    const lines = runSummaryLines(
      source(
        [],
        [
          { resource: "graphql", seconds: 60, count: 1 },
          { resource: "core", seconds: 60, count: 1 }
        ]
      )
    );

    expect(lines).toEqual(["  waited 60s for the core quota across 1 pause", "  waited 60s for the graphql quota across 1 pause"]);
  });

  it("should report nothing when a run made no call", () => {
    expect(runSummaryLines(source([]))).toEqual([]);
  });
});
