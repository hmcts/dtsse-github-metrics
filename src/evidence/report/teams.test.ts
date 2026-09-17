import { describe, expect, it } from "vitest";
import type * as contract from "../../lib/types.ts";
import { OwnerKind } from "../org/graph.ts";
import { type AttributedChange, builtTeamRows } from "./teams.ts";

/**
 * Each team's card, aggregated over the repositories it owns.
 *
 * PROPORTIONS OF A STATED DENOMINATOR AND NOT A SCORE. `TeamsList` is explicit that there is no combined team label
 * and no team score, so every figure here is a count over a denominator the card also states — and the denominator is
 * how many of the team's repositories had a readable answer, never its whole holding.
 */

const NO_NAMES = new Map<string, string>();

function row(repository: string, overrides: Partial<contract.RepositoryRow> = {}): contract.RepositoryRow {
  return { repository, team: "dtsse", owner_kind: OwnerKind.Team, ...overrides };
}

function card(rows: readonly contract.RepositoryRow[], teams: readonly string[], changes: readonly AttributedChange[] = []): contract.TeamRow[] {
  return builtTeamRows(rows, changes, teams, NO_NAMES);
}

describe("which repositories a team's card counts", () => {
  it("should count a repository for every team that owns it rather than only the one leading its row", () => {
    // THE CONSEQUENCE IS DELIBERATE: the cards' repository counts now sum to MORE than `overview.repositories`. A
    // shared repository is one repository in the estate and a holding of two teams, and both numbers are right.
    const rows = [row("alpha", { team: "dtsse", teams: ["dtsse", "platform"] })];

    const cards = card(rows, ["dtsse", "platform"]);

    expect(cards.map((entry) => entry.repositories)).toEqual([1, 1]);
  });

  it("should fall back to the primary owner when the row carries no owner list", () => {
    // `teams` is absent on the ordinary single-owner row, and treating that as "owned by nobody" would empty the
    // cards for most of the estate.
    expect(card([row("alpha", { team: "dtsse" })], ["dtsse"])[0]?.repositories).toBe(1);
  });

  it("should exclude a person-owned repository however its owner's login reads", () => {
    // Nothing stops a login matching a team slug, and one that did would put somebody's repository under that
    // team's count beside a card it was never included in.
    const rows = [row("alpha", { team: "dtsse", owner_kind: OwnerKind.Person })];

    expect(card(rows, ["dtsse"])[0]?.repositories).toBe(0);
  });

  it("should report a card for a team holding nothing rather than leave it out", () => {
    const cards = card([row("alpha")], ["dtsse", "civil"]);

    expect(cards.map((entry) => entry.team)).toEqual(["dtsse", "civil"]);
    expect(cards[1]?.repositories).toBe(0);
  });

  it("should use the slug as the display name when the file overrides none", () => {
    // Falling back rather than prettifying the slug, because a generated title would read as a name somebody chose.
    expect(card([row("alpha")], ["dtsse"])[0]?.display_name).toBe("dtsse");
  });

  it("should use the configured display name when the file overrides one", () => {
    expect(builtTeamRows([row("alpha")], [], ["dtsse"], new Map([["dtsse", "Developer Tools"]]))[0]?.display_name).toBe("Developer Tools");
  });
});

describe("how many people a team's card counts", () => {
  it("should count somebody once however many of the team's repositories they worked in", () => {
    // Unioned across the team's repositories rather than summed: a sum would be a count of rows dressed as a count
    // of people.
    const rows = [row("alpha"), row("beta")];
    const changes = [
      { repository: "alpha", author: "ada" },
      { repository: "beta", author: "ada" }
    ];

    expect(card(rows, ["dtsse"], changes)[0]?.actors).toBe(1);
  });

  it("should count a login spelled two ways across the window's rows as one person", () => {
    const changes = [
      { repository: "alpha", author: "ParisFreire" },
      { repository: "alpha", author: "parisfreire" }
    ];

    expect(card([row("alpha")], ["dtsse"], changes)[0]?.actors).toBe(1);
  });

  it("should skip an unattributed change rather than count it as one more person", () => {
    const changes = [{ repository: "alpha", author: "ada" }, { repository: "alpha" }];

    expect(card([row("alpha")], ["dtsse"], changes)[0]?.actors).toBe(1);
  });

  it("should report the contributor count as a number and never as a list", () => {
    // `TeamRow.actors` is a `number` and `TeamDetail.actors` is a list, and the confusion between the two blanked
    // all 154 cards: `TeamsList` prints it through a template literal, so a list degrades to " contributors".
    expect(typeof card([row("alpha")], ["dtsse"])[0]?.actors).toBe("number");
  });
});

describe("how a team's card reports its practice", () => {
  it("should state the denominator beside every figure it counts", () => {
    const rows = [
      row("alpha", { required_approving_reviews: 2, required_status_checks: 1 }),
      row("beta", { required_approving_reviews: 0, required_status_checks: 0 }),
      row("gamma")
    ];

    const practice = card(rows, ["dtsse"])[0]?.practice;

    expect(practice).toMatchObject({ gates_measured: 2, enforces_review: 1, checks_measured: 2, enforces_checks: 1 });
  });

  it("should exclude a repository whose gate GitHub withheld from the denominator", () => {
    // Dividing by the holding would report an unreadable gate as a repository that fails.
    const rows = [row("alpha", { required_approving_reviews: 2 }), row("beta")];

    expect(card(rows, ["dtsse"])[0]?.practice?.gates_measured).toBe(1);
  });

  it("should count the policy's verdict in its own three words rather than fold it to a pass and a fail", () => {
    // `within` is the allowance forgiving what it was configured to forgive, which is a different fact from nothing
    // having merged unreviewed at all.
    const rows = [
      row("alpha", { unreviewed_substantial: "none" }),
      row("beta", { unreviewed_substantial: "within" }),
      row("gamma", { unreviewed_substantial: "above" }),
      row("delta")
    ];

    expect(card(rows, ["dtsse"])[0]?.practice).toMatchObject({
      unreviewed_measured: 3,
      unreviewed_clear: 1,
      unreviewed_within: 1,
      unreviewed_above: 1
    });
  });

  it("should total the changes as well as the repositories, which is the denominator with teeth", () => {
    // A team can be "8 of 24 clear" and have two unreviewed merges or two hundred.
    const rows = [
      row("alpha", { unreviewed_substantial_merges: 2, substantial_merges: 10, merged_pull_requests: 40, direct_commits: 1 }),
      row("beta", { unreviewed_substantial_merges: 3, substantial_merges: 5, merged_pull_requests: 4 })
    ];

    expect(card(rows, ["dtsse"])[0]?.practice).toMatchObject({
      unreviewed_substantial_merges: 5,
      substantial_merges: 15,
      merged_pull_requests: 44,
      direct_commits: 1
    });
  });

  it("should report the typical repository's typical wait as a median of the medians", () => {
    // A MEDIAN OF MEDIANS, and it is the figure a reader of a TEAM page wants: one repository with a three-week
    // review does not become the team's story. A mean would let one stalled repository drag the figure.
    const rows = [
      row("alpha", { time_to_first_review_hours: 1, merge_cycle_time_hours: 10 }),
      row("beta", { time_to_first_review_hours: 5, merge_cycle_time_hours: 20 }),
      row("gamma", { time_to_first_review_hours: 100, merge_cycle_time_hours: 30 })
    ];

    expect(card(rows, ["dtsse"])[0]?.practice).toMatchObject({ time_to_first_review_hours: 5, merge_cycle_time_hours: 20 });
  });

  it("should average the two central values when a team holds an even number of measured repositories", () => {
    // The definition `distribution` in `behaviour/metrics.ts` uses, so a team of one reports exactly that
    // repository's own figure.
    const rows = [row("alpha", { time_to_first_review_hours: 2 }), row("beta", { time_to_first_review_hours: 5 })];

    expect(card(rows, ["dtsse"])[0]?.practice?.time_to_first_review_hours).toBe(3.5);
  });

  it("should leave a timing absent rather than zero when no repository reported one", () => {
    // A team whose repositories all had too few reviews to measure has no wait to report, and `0 hours` would read
    // as instant review.
    const practice = card([row("alpha")], ["dtsse"])[0]?.practice;

    expect(practice === undefined ? {} : practice).not.toHaveProperty("time_to_first_review_hours");
  });

  it("should distribute the readiness labels its repositories carry", () => {
    const rows = [row("alpha", { readiness: "green" }), row("beta", { readiness: "green" }), row("gamma", { readiness: "amber" }), row("delta")];

    expect(card(rows, ["dtsse"])[0]?.labels).toEqual({ green: 2, amber: 1 });
  });

  it("should count how many of its repositories could not be reported", () => {
    const rows = [row("alpha"), row("beta", { detail: "nothing has been collected for this repository" })];

    expect(card(rows, ["dtsse"])[0]?.unavailable).toBe(1);
  });
});
