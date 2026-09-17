import { describe, expect, it, vi } from "vitest";
import { readinessPolicy } from "../../assessment/assessment.ts";
import type { Merges, PullRequestFact, ReviewFact } from "../../domain/facts.ts";
import { ReviewState } from "../../domain/facts.ts";
import type { MergeGateReport } from "../../domain/merge-gate.ts";
import { parseConfiguration } from "../../policy/load.ts";
import type { MeasuredRow } from "../measured.ts";
import { behaviourFigures, unreportedDetail } from "./figures.ts";

/**
 * Which figures one row can honestly state about its window.
 *
 * ABSENT MEANS UNMEASURED AND ZERO MEANS MEASURED-AS-NOTHING, and every case here is about the boundary between the
 * two: a quiet repository merged nothing and says `0`, a repository whose walk was refused merged an unknown amount
 * and says nothing at all. A `0` on the second is the estate's throughput counting a repository nobody read.
 */

const CONFIGURATION = parseConfiguration(`
version: 1
organization: hmcts
assessment:
  minimum_merges: 1
`);

const POLICY = readinessPolicy(CONFIGURATION);

const BOTH: MeasuredRow = { pullRequests: true, directCommits: true };

function review(submittedAt: Date): ReviewFact {
  return { identifier: 1, submittedAt, state: ReviewState.Approved, authorLogin: "grace", authorType: "User", commentCount: 1 };
}

/** One substantial merged pull request, reviewed two hours before it merged. */
function merge(identifier: number, options: { reviewed: boolean } = { reviewed: true }): PullRequestFact {
  const mergedAt = new Date(Date.UTC(2026, 7, 10, identifier));
  const readyAt = new Date(mergedAt.getTime() - 4 * 3_600_000);
  return {
    identifier,
    repository: "alpha",
    number: identifier,
    createdAt: readyAt,
    readyForReviewAt: readyAt,
    mergedAt,
    draft: false,
    authorLogin: "ada",
    authorType: "User",
    additions: 120,
    deletions: 4,
    changedFiles: 6,
    reviews: options.reviewed ? [review(new Date(mergedAt.getTime() - 2 * 3_600_000))] : [],
    checks: []
  };
}

function cohort(count: number, options: { reviewed: boolean } = { reviewed: true }): Merges {
  return { pullRequests: Array.from({ length: count }, (_, index) => merge(index + 1, options)), directCommits: [] };
}

describe("the figures a row states about its window", () => {
  it("should count zero merges when both sources were read and the window was quiet", () => {
    // MEASURED AS NOTHING. Both counts are present and zero, which is what a walked but quiet repository is.
    const figures = behaviourFigures(POLICY, { pullRequests: [], directCommits: [] }, BOTH);

    expect(figures.merged_pull_requests).toBe(0);
    expect(figures.direct_commits).toBe(0);
  });

  it("should state neither count when neither source was read", () => {
    const figures = behaviourFigures(POLICY, cohort(3), { pullRequests: false, directCommits: false });

    expect(Object.keys(figures)).toEqual([]);
  });

  it("should state the merge count and withhold the commit count when only the merge walk came back", () => {
    // GATED INDEPENDENTLY, because they are two walks recording two coverage series.
    const figures = behaviourFigures(POLICY, cohort(3), { pullRequests: true, directCommits: false });

    expect(figures.merged_pull_requests).toBe(3);
    expect("direct_commits" in figures).toBe(false);
  });

  it("should state the commit count and withhold the merge count when only the commit walk came back", () => {
    const figures = behaviourFigures(POLICY, cohort(3), { pullRequests: false, directCommits: true });

    expect(figures.direct_commits).toBe(0);
    expect("merged_pull_requests" in figures).toBe(false);
  });

  it("should withhold every graded figure when only one of the two sources was read", () => {
    // The graded figures need BOTH: `sufficient` counts merges and direct commits together, so a verdict over half
    // a cohort would be a finding about the half that answered.
    const figures = behaviourFigures(POLICY, cohort(3), { pullRequests: true, directCommits: false });

    expect("unreviewed_substantial" in figures).toBe(false);
    expect("substantial_merges" in figures).toBe(false);
    expect("time_to_first_review_hours" in figures).toBe(false);
  });

  it("should grade the window and count its substantial merges when both sources were read", () => {
    const figures = behaviourFigures(POLICY, cohort(3, { reviewed: false }), BOTH);

    expect(figures.unreviewed_substantial).toBeDefined();
    expect(figures.substantial_merges).toBe(3);
    expect(figures.unreviewed_substantial_merges).toBe(3);
  });

  it("should withhold the substantial counts when the policy declined to grade a thin cohort", () => {
    // The policy refuses to grade below `minimum_merges`, and reporting the raw counts anyway would let a team page
    // state a rate the policy refused to state.
    const thin = readinessPolicy(parseConfiguration("version: 1\norganization: hmcts\nassessment:\n  minimum_merges: 5\n"));

    const figures = behaviourFigures(thin, cohort(2), BOTH);

    expect("substantial_merges" in figures).toBe(false);
    expect("unreviewed_substantial_merges" in figures).toBe(false);
  });

  it("should report the median hours a merge waited for review when the facts support one", () => {
    const figures = behaviourFigures(POLICY, cohort(3), BOTH);

    expect(figures.time_to_first_review_hours).toBe(2);
    expect(figures.merge_cycle_time_hours).toBe(4);
  });

  it("should report absent medians and log the reason when a stored payload has no reviews array", () => {
    // A REAL SHAPE IN THE CACHE, not defensive padding: `eligibleReviews` reads `pullRequest.reviews` without a
    // check, and one such row must not turn the whole page into a 500.
    //
    // The merge is TRIVIAL on purpose. `unreviewedSubstantialCounts` reaches `eligibleReviews` only for a
    // substantial merge, so a trivial one is the cohort where the timings are the first thing to read the missing
    // array — which is the shape this guard can actually answer for. See the note below on the shape it cannot.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const trivial = { ...merge(1), additions: 2, deletions: 0, changedFiles: 1, reviews: undefined as unknown as ReviewFact[] };

    const figures = behaviourFigures(POLICY, { pullRequests: [trivial], directCommits: [] }, BOTH);

    expect("time_to_first_review_hours" in figures).toBe(false);
    expect("merge_cycle_time_hours" in figures).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("the review timings could not be measured"));
    warn.mockRestore();
  });

  it("should still fail the whole row when a SUBSTANTIAL merge is missing its reviews array", () => {
    // WHAT THE GUARD DOES NOT COVER, asserted so the limit is stated rather than assumed. `timingMedians` catches
    // its own throw, but `unreviewedSubstantial` is evaluated first in the same literal and reads the same array
    // without a check — so on a substantial merge the row throws before the catch is reached, which is the 500 the
    // guard's own header says the report layer must not produce. Narrowing that is a change to the policy's
    // reader, not to this module, and it is left as a finding rather than made here.
    const substantial = { ...merge(1), reviews: undefined as unknown as ReviewFact[] };

    expect(() => behaviourFigures(POLICY, { pullRequests: [substantial], directCommits: [] }, BOTH)).toThrow(TypeError);
  });
});

describe("why a row carries less than a full set of figures", () => {
  const READABLE: MergeGateReport = { gate: { branch: "main" } as MergeGateReport["gate"] };

  it("should say nothing when both sources were read and the gate was readable", () => {
    expect(unreportedDetail(READABLE, BOTH)).toBeUndefined();
  });

  it("should name both sources when no merge history was read at all", () => {
    expect(unreportedDetail(READABLE, { pullRequests: false, directCommits: false })).toBe(
      "no merge history was read for this repository, so its merges are unmeasured rather than none"
    );
  });

  it("should name the direct commits when only that walk went unread", () => {
    expect(unreportedDetail(READABLE, { pullRequests: true, directCommits: false })).toBe(
      "the direct commits were not read for this repository, so they are unmeasured rather than none"
    );
  });

  it("should name the merged pull requests when only that walk went unread", () => {
    expect(unreportedDetail(READABLE, { pullRequests: false, directCommits: true })).toBe(
      "the merged pull requests were not read for this repository, so they are unmeasured rather than none"
    );
  });

  it("should report the gate's own reason when the sources were read and the gate was not", () => {
    expect(unreportedDetail({ detail: "the merge gate has not been collected" }, BOTH)).toBe("the merge gate has not been collected");
  });

  it("should join both reasons when a stale repository has an unread source and an unreadable gate", () => {
    // TWO INDEPENDENT ABSENCES, joined rather than ranked: dropping either would leave a figure on the row with
    // nothing to explain it.
    expect(unreportedDetail({ detail: "the merge gate has not been collected" }, { pullRequests: false, directCommits: false })).toBe(
      "no merge history was read for this repository, so its merges are unmeasured rather than none; the merge gate has not been collected"
    );
  });

  it("should say nothing when a gateless report carries no reason and both sources were read", () => {
    expect(unreportedDetail({}, BOTH)).toBeUndefined();
  });
});
