import { describe, expect, it } from "vitest";
import type { CohortEntry } from "../../org/cohort.ts";
import { OwnerKind } from "../../org/graph.ts";
import { HUMAN_COMMIT_UNCOLLECTED_DETAIL, storedMaintenance } from "./maintenance.ts";

/**
 * The Maintenance section, from the cohort entry's push instant and the human answer `collect` stored.
 *
 * The case worth guarding is the one with nothing stored: the push column still answers, and the human one must
 * read unknown rather than no — a repository nobody searched is not one nobody worked on.
 */

const FETCHED = new Date("2026-10-08T00:00:00Z");

const ENTRY: CohortEntry = {
  repository: "alpha",
  owners: ["dtsse"],
  ownerKind: OwnerKind.Team,
  archived: false,
  visibility: "public",
  behaviourCollectable: true,
  unmaintained: false,
  pushedAt: new Date("2026-09-01T00:00:00Z")
};

describe("storedMaintenance", () => {
  it("should report the push and a stored human commit, as a jsonb round trip left them", () => {
    const report = storedMaintenance(ENTRY, { maintenance: { lastHumanCommitAt: "2026-08-01T00:00:00.000Z" } }, FETCHED);

    expect(report).toEqual({
      fetched_at: "2026-10-08T00:00:00.000Z",
      maintenance: { last_push_at: "2026-09-01T00:00:00.000Z", last_human_commit_at: "2026-08-01T00:00:00.000Z" },
      windows: [
        { months: 6, committed_within: true, human_committed_within: true },
        { months: 12, committed_within: true, human_committed_within: true },
        { months: 24, committed_within: true, human_committed_within: true }
      ]
    });
  });

  it("should leave a window the search stopped short of unknown, and say where it stopped", () => {
    // Searched back to 2026-01-01: past the six-month cutoff, short of the twelve- and twenty-four-month ones.
    const report = storedMaintenance(ENTRY, { maintenance: { searchedBackTo: "2026-01-01T00:00:00.000Z" } }, FETCHED);

    expect(report.maintenance).toEqual({ last_push_at: "2026-09-01T00:00:00.000Z", searched_back_to: "2026-01-01T00:00:00.000Z" });
    expect(report.windows).toEqual([
      { months: 6, committed_within: true, human_committed_within: false },
      { months: 12, committed_within: true, human_detail: "the search stopped at 2026-01-01" },
      { months: 24, committed_within: true, human_detail: "the search stopped at 2026-01-01" }
    ]);
    expect(report.detail).toBeUndefined();
  });

  it("should answer an empty branch as no human commit in any window", () => {
    const report = storedMaintenance(ENTRY, { maintenance: {} }, FETCHED);

    expect(report.windows.every((window) => window.human_committed_within === false)).toBe(true);
    expect(report.detail).toBeUndefined();
  });

  it("should still report the push column where no human answer was stored, and say why the other is missing", () => {
    const report = storedMaintenance(ENTRY, { defaultBranch: "main" }, FETCHED);

    expect(report.maintenance).toEqual({ last_push_at: "2026-09-01T00:00:00.000Z" });
    expect(report.windows.every((window) => window.committed_within)).toBe(true);
    expect(report.windows.every((window) => !("human_committed_within" in window))).toBe(true);
    expect(report.detail).toBe(HUMAN_COMMIT_UNCOLLECTED_DETAIL);
  });

  it("should read a stored instant it cannot parse as uncollected rather than as an empty branch", () => {
    const report = storedMaintenance(ENTRY, { maintenance: { lastHumanCommitAt: "not a date" } }, FETCHED);

    expect(report.maintenance).toEqual({ last_push_at: "2026-09-01T00:00:00.000Z" });
    expect(report.windows.every((window) => !("human_committed_within" in window))).toBe(true);
    expect(report.detail).toBe(HUMAN_COMMIT_UNCOLLECTED_DETAIL);
  });

  it("should answer every push window false where the listing carried no push instant", () => {
    const { pushedAt: _, ...unpushed } = ENTRY;
    const report = storedMaintenance(unpushed, undefined, FETCHED);

    expect(report.maintenance).toEqual({});
    expect(report.windows.every((window) => !window.committed_within)).toBe(true);
    expect(report.detail).toBe(HUMAN_COMMIT_UNCOLLECTED_DETAIL);
  });

  it("should prefer a found commit over a search bound where a malformed payload carries both", () => {
    const report = storedMaintenance(
      ENTRY,
      { maintenance: { lastHumanCommitAt: "2026-08-01T00:00:00.000Z", searchedBackTo: "2025-01-01T00:00:00.000Z" } },
      FETCHED
    );

    expect(report.maintenance).toEqual({ last_push_at: "2026-09-01T00:00:00.000Z", last_human_commit_at: "2026-08-01T00:00:00.000Z" });
  });
});
