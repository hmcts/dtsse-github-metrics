import { describe, expect, it } from "vitest";
import type * as contract from "../../lib/types.ts";
import { builtOverviewSummary, type OverviewInput } from "./overview.ts";

/**
 * The estate's summary for one window, folded from the reports the same build produced.
 *
 * EVERY FIGURE IS A FOLD OF ROWS ALREADY IN HAND, which is what stops the header and the tables below it disagreeing:
 * the contributor count is the length of the contributor report rather than a second walk of the facts, and the team
 * count is the list the cards are drawn from rather than a second read of the graph.
 */

const REFERENCE = new Date(Date.UTC(2026, 8, 17, 14, 30));
const WINDOW = { startsAt: new Date(Date.UTC(2026, 7, 20)), endsAt: new Date(Date.UTC(2026, 8, 17)) };

function row(overrides: Partial<contract.RepositoryRow> = {}): contract.RepositoryRow {
  return { repository: "alpha", team: "dtsse", ...overrides };
}

function input(overrides: Partial<OverviewInput> = {}): OverviewInput {
  return {
    organization: "hmcts",
    weeks: 4,
    window: WINDOW,
    collectedThrough: new Date(Date.UTC(2026, 8, 17)),
    rows: [row()],
    teams: ["dtsse"],
    actors: 1,
    ...overrides
  };
}

describe("the estate summary one window reports", () => {
  it("should report every instant as an ISO string rather than as a Date", () => {
    const summary = builtOverviewSummary(input(), REFERENCE);

    expect(summary.starts_at).toBe("2026-08-20T00:00:00.000Z");
    expect(summary.ends_at).toBe("2026-09-17T00:00:00.000Z");
    expect(summary.built_at).toBe("2026-09-17T14:30:00.000Z");
    expect(summary.collected_through).toBe("2026-09-17T00:00:00.000Z");
  });

  it("should omit the collected edge when nothing has been collected", () => {
    const summary = builtOverviewSummary(input({ collectedThrough: undefined }), REFERENCE);

    expect("collected_through" in summary).toBe(false);
  });

  it("should count the rows it was handed and how many of them could not be reported", () => {
    const rows = [row(), row({ repository: "beta", detail: "nothing has been collected for this repository" })];

    const summary = builtOverviewSummary(input({ rows }), REFERENCE);

    expect(summary.repositories).toBe(2);
    expect(summary.unavailable).toBe(1);
  });

  it("should count the teams the cards are drawn for rather than the ones the file overrides", () => {
    // `configuration.teams` names only the handful somebody has overridden an owner for, so counting it would
    // report a few cards for an estate of 154 teams.
    const summary = builtOverviewSummary(input({ teams: ["dtsse", "civil", "unowned"] }), REFERENCE);

    expect(summary.teams).toBe(3);
  });

  it("should report the contributor count it was handed rather than derive a second one", () => {
    // So the header and `/contributors` cannot disagree about how many people the span holds.
    expect(builtOverviewSummary(input({ actors: 42 }), REFERENCE).actors).toBe(42);
  });

  it("should total the throughput across the rows, counting an unmeasured row as nothing", () => {
    // ABSENT MEANS UNMEASURED: a repository nobody walked contributes nothing to the total rather than a zero that
    // would be indistinguishable from a quiet one — but the total itself cannot be absent, so it folds to `0`.
    const rows = [row({ merged_pull_requests: 6, direct_commits: 1 }), row({ repository: "beta" })];

    const summary = builtOverviewSummary(input({ rows }), REFERENCE);

    expect(summary.merged_pull_requests).toBe(6);
    expect(summary.direct_commits).toBe(1);
  });

  it("should distribute the readiness labels the rows carry and ignore the ungraded ones", () => {
    const rows = [
      row({ readiness: "green" }),
      row({ repository: "beta", readiness: "green" }),
      row({ repository: "gamma", readiness: "red" }),
      row({ repository: "delta" })
    ];

    expect(builtOverviewSummary(input({ rows }), REFERENCE).labels).toEqual({ green: 2, red: 1 });
  });

  it("should report an empty distribution rather than omit it when nothing was graded", () => {
    // The donut reads this without a guard, so an absent map would take the page down where an empty one draws
    // nothing.
    expect(builtOverviewSummary(input({ rows: [row()] }), REFERENCE).labels).toEqual({});
  });

  it("should report zero repositories for an estate the cohort resolved to nothing", () => {
    const summary = builtOverviewSummary(input({ rows: [], teams: [], actors: 0 }), REFERENCE);

    expect(summary).toMatchObject({ repositories: 0, unavailable: 0, teams: 0, actors: 0, merged_pull_requests: 0, direct_commits: 0 });
  });
});
