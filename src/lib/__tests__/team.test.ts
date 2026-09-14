/**
 * What the team page says about a team, and what it will not say.
 *
 * The counts are of things — repositories configured, people who worked in them, repositories the
 * span could not report — and none of them combines a label, a rate or a verdict. The last test is
 * the guardrail itself: nothing here produces a figure two teams could be ordered by.
 */

import { describe, expect, it } from "vitest";
import { owners } from "@/lib/rows";
import { holdings, type PracticeFigure, people, practiceFigures, unreported } from "@/lib/team";
import type { TeamDetail, TeamPractice } from "@/lib/types";

function team(detail: Partial<TeamDetail> = {}): TeamDetail {
  return {
    team: "platform",
    repositories: [
      { repository: "api", team: "platform", readiness: "green" },
      { repository: "web", team: "platform", readiness: "red" }
    ],
    actors: [
      { login: "alice", repositories: 2, contributions: 9 },
      { login: "bob", repositories: 1, contributions: 3 }
    ],
    unavailable: 0,
    labels: { green: 1, red: 1 },
    ...detail
  };
}

describe("holdings", () => {
  it("counts every configured repository, reported or not", () => {
    expect(holdings(team({ unavailable: 1 }))).toBe("2 repositories");
  });

  it("pluralises against its own noun", () => {
    expect(holdings(team({ repositories: [{ repository: "api", team: "platform" }] }))).toBe("1 repository");
  });

  it("agrees with the card on /teams for a SHARED repository, which both count for every owner", () => {
    // 390 repositories on the estate have more than one owner. The card counts a shared repository for each of
    // them, and this page's count is the length of the list under it — so the two agree only if the list holds the
    // repositories the team owns without leading. Both sides are folded here through `owners`, which is what the
    // card's own report layer and `getTeam` read ownership by.
    const estate = [
      { repository: "shared", team: "platform", teams: ["platform", "delivery"] },
      { repository: "web", team: "delivery" },
      { repository: "api", team: "platform" }
    ];
    const card = estate.filter((entry) => owners(entry).includes("delivery")).length;

    expect(card).toBe(2);
    expect(holdings(team({ team: "delivery", repositories: estate.filter((entry) => owners(entry).includes("delivery")) }))).toBe(`${card} repositories`);
  });
});

describe("people", () => {
  it("counts everyone who authored a reported merge in the team", () => {
    expect(people(team())).toBe("2 contributors");
  });

  it("counts nobody where the span holds no reported merge for the team", () => {
    expect(people(team({ actors: [] }))).toBe("0 contributors");
  });
});

describe("unreported", () => {
  it("says how much of the team the span could not report", () => {
    expect(unreported(team({ unavailable: 2 }))).toBe("2 repositories not reported at this span");
    expect(unreported(team({ unavailable: 1 }))).toBe("1 repository not reported at this span");
  });

  it("says nothing at all where every repository was reported", () => {
    expect(unreported(team())).toBeUndefined();
  });
});

/**
 * The ways-of-working figures, which moved here from the repositories table.
 *
 * What these are mostly about is the DENOMINATOR. Each figure is out of what was measured rather than what the
 * team holds, because a repository whose merge gate GitHub withheld has no answer — and counting it against the
 * holding would report a missing permission as a repository that fails its team.
 */
describe("practiceFigures", () => {
  function practice(overrides: Partial<TeamPractice> = {}): TeamPractice {
    return {
      gates_measured: 10,
      enforces_review: 8,
      requires_multiple_reviews: 3,
      checks_measured: 10,
      enforces_checks: 6,
      unreviewed_measured: 7,
      unreviewed_clear: 4,
      unreviewed_within: 2,
      unreviewed_above: 1,
      merged_pull_requests: 120,
      direct_commits: 4,
      unreviewed_substantial_merges: 3,
      substantial_merges: 40,
      time_to_first_review_hours: 5.25,
      merge_cycle_time_hours: 30,
      ...overrides
    };
  }

  function figureOf(label: string, given = practice()): PracticeFigure {
    const found = practiceFigures(given).find((figure) => figure.label === label);
    if (found === undefined) {
      throw new Error(`${label} was not reported at all`);
    }
    return found;
  }

  it("states every count out of what was MEASURED, never out of the holding", () => {
    // Eight of the ten readable gates, not eight of however many the team owns: two repositories whose gate
    // nobody could read are not two repositories that fail to enforce review.
    expect(figureOf("Enforces review").value).toBe("8 of 10");
    expect(figureOf("Enforces CI").value).toBe("6 of 10");
    expect(figureOf("Repositories reviewing substantial changes").value).toBe("4 of 7");
  });

  it("computes no share, so nothing here is a figure two teams could be ordered by", () => {
    // The boundary `TeamsList` states: per-team counts are permitted and a team score is not. A percentage is
    // the thing a reader would sort on, so none is produced — the reader compares 8 of 10 with 38 of 40.
    for (const figure of practiceFigures(practice())) {
      expect(`${figure.value} ${figure.detail}`).not.toMatch(/%|score|rank|average|overall/i);
    }
  });

  it("says a figure was not measured rather than printing 0 of 0", () => {
    // "0 of 0" reads as a finding about the team. A gate nobody could read is not a gate requiring nothing —
    // the same distinction the row's own absent-means-unmeasured rule keeps.
    const unread = practice({ gates_measured: 0, enforces_review: 0, requires_multiple_reviews: 0, checks_measured: 0, enforces_checks: 0 });

    expect(figureOf("Enforces review", unread).value).toBe("not measured");
    expect(figureOf("Enforces review", unread).detail).toBe("no merge gate could be read");
    expect(figureOf("Enforces CI", unread).value).toBe("not measured");
  });

  it("says too few merges rather than nothing where the policy graded no repository", () => {
    // `minimum_merges` declines to grade thin evidence, which is a different answer from a team whose merges all
    // went unreviewed.
    const thin = practice({ unreviewed_measured: 0, unreviewed_clear: 0, unreviewed_within: 0, unreviewed_above: 0 });

    expect(figureOf("Repositories reviewing substantial changes", thin).value).toBe("not measured");
    expect(figureOf("Repositories reviewing substantial changes", thin).detail).toBe("too few merges to grade");
  });

  it("keeps the allowance apart from nothing having merged unreviewed", () => {
    // The policy's own three words. `within` is the allowance forgiving what it was configured to forgive, and
    // folding it into a pass would report a habit as a clean result.
    expect(figureOf("Repositories reviewing substantial changes").detail).toBe("2 within the allowance, 1 above it");
  });

  it("carries the stronger review requirement as detail rather than as a second verdict", () => {
    expect(figureOf("Enforces review").detail).toBe("3 require two or more approvals");
  });

  it("counts the CHANGES reviewed as well as the repositories, which is the figure with teeth", () => {
    // A team can be "4 of 7 clear" with three unreviewed merges or three hundred. The line above counts
    // repositories the policy graded clear; this counts what actually reached the default branch unreviewed.
    expect(figureOf("Substantial changes reviewed").value).toBe("37 of 40");
    expect(figureOf("Substantial changes reviewed").detail).toBe("3 merged with no independent review");
  });

  it("says nothing was graded rather than printing a rate the policy refused to state", () => {
    // `minimum_merges` declines thin evidence, so the report layer omits the counts entirely — and the page must
    // not fill that with "0 of 0", which reads as a team that reviews nothing.
    const ungraded = practice({ substantial_merges: undefined, unreviewed_substantial_merges: undefined });

    expect(figureOf("Substantial changes reviewed", ungraded).value).toBe("not measured");
    expect(figureOf("Substantial changes reviewed", ungraded).detail).toBe("no substantial change was graded at this span");
  });

  it("states direct pushes against every change that reached the branch", () => {
    // 4 of 400 and 4 of 6 are different findings, so the denominator is the team's whole traffic rather than the
    // direct commits alone. This is the user's "direct pushes to master", and the pair was already on the row.
    expect(figureOf("Direct pushes to the default branch").value).toBe("4 of 124");
    expect(figureOf("Direct pushes to the default branch").detail).toBe("120 arrived through a pull request");
  });

  it("says every change arrived through a pull request where none was direct", () => {
    expect(figureOf("Direct pushes to the default branch", practice({ direct_commits: 0 })).detail).toBe("every change arrived through a pull request");
  });

  it("reports both timing medians in hours, naming what kind of median they are", () => {
    // A MEDIAN OF MEDIANS, said on the page: it is the typical repository's typical wait rather than the median
    // across the team's changes, and the two are different numbers.
    expect(figureOf("Time to first review").value).toBe("5.3 hours");
    expect(figureOf("Time to first review").detail).toBe("typical repository’s typical wait");
    expect(figureOf("Merge cycle time").value).toBe("30 hours");
  });

  it("says a timing was not measured rather than reporting nought hours", () => {
    // `0 hours` would say a team reviews instantly when in fact nothing was observed.
    const unwatched = practice({ time_to_first_review_hours: undefined, merge_cycle_time_hours: undefined });

    expect(figureOf("Time to first review", unwatched).value).toBe("not measured");
    expect(figureOf("Time to first review", unwatched).detail).toBe("no repository observed an independent review");
    expect(figureOf("Merge cycle time", unwatched).value).toBe("not measured");
  });
});

describe("the team guardrails", () => {
  it("offers no combined label, score or ordering of teams", () => {
    const stated = [holdings(team()), people(team()), unreported(team({ unavailable: 1 }))].join(" ");
    expect(stated).not.toMatch(/score|verdict|rank|average|overall/i);
  });
});
