import { describe, expect, it } from "vitest";
import { CheckConclusion, type CheckFact, type DirectCommitFact, type Merges, type PullRequestFact, type ReviewFact, ReviewState } from "../../domain/facts.ts";
import { builtDirectPushRows, builtMergeRows } from "./changes.ts";

/**
 * Every merged pull request in the window, and every commit that reached a default branch without one.
 *
 * THE ORDER IS PART OF THE REPORT and not a detail. `Array.prototype.sort` is stable, so a tied pair used to come out
 * in whatever order the fact map was iterated — a function of which repository the QUERY returned first, which made
 * one window built from a shared read and the same window read for itself produce the same rows in a different
 * sequence. This is a table a reader diffs against last week's.
 */

function review(state: ReviewState, submittedAt: Date, authorLogin = "grace"): ReviewFact {
  return { identifier: 1, submittedAt, state, authorLogin, authorType: "User", commentCount: 1 };
}

function check(conclusion: CheckConclusion, completedAt: Date): CheckFact {
  return { name: "build", conclusion, completedAt };
}

function merge(overrides: Partial<PullRequestFact> = {}): PullRequestFact {
  const mergedAt = new Date(Date.UTC(2026, 7, 10, 12));
  return {
    identifier: 1,
    repository: "alpha",
    number: 1,
    createdAt: new Date(Date.UTC(2026, 7, 9)),
    mergedAt,
    draft: false,
    authorLogin: "ada",
    authorType: "User",
    additions: 30,
    deletions: 2,
    changedFiles: 3,
    reviews: [review(ReviewState.Approved, new Date(mergedAt.getTime() - 3_600_000))],
    checks: [check(CheckConclusion.Success, new Date(mergedAt.getTime() - 3_600_000))],
    ...overrides
  };
}

function commit(overrides: Partial<DirectCommitFact> = {}): DirectCommitFact {
  return {
    sha: "aaaaaaa",
    repository: "alpha",
    committedAt: new Date(Date.UTC(2026, 7, 12)),
    authorLogin: "alan",
    authorType: "User",
    checkState: "SUCCESS",
    additions: 4,
    deletions: 1,
    changedFiles: 1,
    ...overrides
  };
}

function facts(entries: Record<string, Partial<Merges>>): Map<string, Merges> {
  return new Map(Object.entries(entries).map(([repository, merges]) => [repository, { pullRequests: [], directCommits: [], ...merges }]));
}

describe("the merge rows a window holds", () => {
  it("should name the repository, the number and the merge instant on every row", () => {
    const rows = builtMergeRows(facts({ alpha: { pullRequests: [merge()] } }));

    expect(rows).toEqual([
      { repository: "alpha", number: 1, merged_at: "2026-08-10T12:00:00.000Z", author: "ada", reviewed: true, ci: true, lines: 32, files: 3 }
    ]);
  });

  it("should report a merge as unreviewed when its reviews array holds nothing eligible", () => {
    // MEASURED AND FOUND NOTHING: the array was read, so `false` is an answer rather than an absence.
    const rows = builtMergeRows(facts({ alpha: { pullRequests: [merge({ reviews: [] })] } }));

    expect(rows[0]?.reviewed).toBe(false);
  });

  it("should leave the review verdict absent when the stored payload carries no reviews array", () => {
    // GUARDED ON THE ARRAY'S PRESENCE, not on its contents. An absent array is UNMEASURED and an empty one is
    // measured-and-found-nothing, and the two must not render alike.
    const rows = builtMergeRows(facts({ alpha: { pullRequests: [merge({ reviews: undefined as unknown as ReviewFact[] })] } }));

    expect("reviewed" in (rows[0] ?? {})).toBe(false);
  });

  it("should leave the CI verdict absent when the stored payload carries no checks array", () => {
    const rows = builtMergeRows(facts({ alpha: { pullRequests: [merge({ checks: undefined as unknown as CheckFact[] })] } }));

    expect("ci" in (rows[0] ?? {})).toBe(false);
  });

  it("should report CI as false when the checks array was read and held nothing", () => {
    // An empty list is `false` rather than absent: the merge was looked at and no check had reported on it.
    const rows = builtMergeRows(facts({ alpha: { pullRequests: [merge({ checks: [] })] } }));

    expect(rows[0]?.ci).toBe(false);
  });

  it("should report CI as false when a check that finished had failed", () => {
    const failed = merge({ checks: [check(CheckConclusion.Failure, new Date(Date.UTC(2026, 7, 10, 11)))] });

    expect(builtMergeRows(facts({ alpha: { pullRequests: [failed] } }))[0]?.ci).toBe(false);
  });

  it("should leave the size absent when the payload records no line counts", () => {
    const sizeless = merge({ additions: undefined, deletions: undefined, changedFiles: undefined });
    const row = builtMergeRows(facts({ alpha: { pullRequests: [sizeless] } }))[0];

    expect("lines" in (row ?? {})).toBe(false);
    expect("files" in (row ?? {})).toBe(false);
  });

  it("should order the rows newest first", () => {
    const older = merge({ number: 1, mergedAt: new Date(Date.UTC(2026, 7, 9)) });
    const newer = merge({ number: 2, mergedAt: new Date(Date.UTC(2026, 7, 11)) });

    expect(builtMergeRows(facts({ alpha: { pullRequests: [older, newer] } })).map((row) => row.number)).toEqual([2, 1]);
  });

  it("should break a tie on the repository and the number rather than on the order the facts were held in", () => {
    // `(repository, number)` is unique, so the sequence below is a function of the facts alone. Two merges at the
    // same second are ordinary: the four-week window's 7,375 merges include 62 sharing 31 instants.
    const at = new Date(Date.UTC(2026, 7, 10, 12));
    const held = facts({
      beta: { pullRequests: [merge({ repository: "beta", number: 9, mergedAt: at })] },
      alpha: { pullRequests: [merge({ number: 5, mergedAt: at }), merge({ number: 2, mergedAt: at })] }
    });

    expect(builtMergeRows(held).map((row) => `${row.repository}#${row.number}`)).toEqual(["alpha#2", "alpha#5", "beta#9"]);
  });
});

describe("the direct-push rows a window holds", () => {
  it("should name the repository, the sha and the commit instant on every row", () => {
    const rows = builtDirectPushRows(facts({ alpha: { directCommits: [commit()] } }));

    expect(rows).toEqual([{ repository: "alpha", sha: "aaaaaaa", committed_at: "2026-08-12T00:00:00.000Z", author: "alan", ci: true, lines: 5, files: 1 }]);
  });

  it("should fall back to the git author name when GitHub matched no account", () => {
    // The same fallback `isHumanCommitAuthor` reads, and the reason a direct push can be attributed to a name and
    // no account.
    const rows = builtDirectPushRows(facts({ alpha: { directCommits: [commit({ authorLogin: undefined, authorName: "Alan Turing" })] } }));

    expect(rows[0]?.author).toBe("Alan Turing");
  });

  it("should leave the CI verdict absent when the commit records no check state", () => {
    const rows = builtDirectPushRows(facts({ alpha: { directCommits: [commit({ checkState: undefined })] } }));

    expect("ci" in (rows[0] ?? {})).toBe(false);
  });

  it("should report CI as false when the recorded check state is anything but success", () => {
    const rows = builtDirectPushRows(facts({ alpha: { directCommits: [commit({ checkState: "FAILURE" })] } }));

    expect(rows[0]?.ci).toBe(false);
  });

  it("should break a tie on the repository before the sha, which is not unique across the estate", () => {
    // `GAPS2` and `GAPS2-archive` hold the same commit, so ordering on the sha alone would still leave the pair to
    // the map's iteration order.
    const at = new Date(Date.UTC(2026, 7, 12));
    const held = facts({
      "GAPS2-archive": { directCommits: [commit({ repository: "GAPS2-archive", sha: "ffff111", committedAt: at })] },
      GAPS2: { directCommits: [commit({ repository: "GAPS2", sha: "ffff111", committedAt: at })] }
    });

    expect(builtDirectPushRows(held).map((row) => row.repository)).toEqual(["GAPS2", "GAPS2-archive"]);
  });
});
