import { describe, expect, it } from "vitest";
import type * as contract from "../../../lib/types.ts";
import type { DirectCommitFact, Merges, PullRequestFact } from "../../domain/facts.ts";
import { builtActorRows } from "./actors.ts";

/**
 * Everyone who authored a merge into a reported repository, with the repositories they appeared in.
 *
 * A COUNT AND A SET OF LABELS, NEVER A METRIC, which is the scope boundary `lib/sort.ts` states: people may not be
 * ranked, so nothing here can be ordered by. The label ORDER is a rendering decision the report makes, and it was
 * alphabetical — `amber, cannot_assess, green, red` — until 2026-09-15.
 */

function merge(repository: string, authorLogin: string | undefined, identifier: number): PullRequestFact {
  return {
    identifier,
    repository,
    number: identifier,
    createdAt: new Date(Date.UTC(2026, 7, 9)),
    mergedAt: new Date(Date.UTC(2026, 7, 10)),
    draft: false,
    authorLogin,
    authorType: "User",
    additions: 30,
    deletions: 2,
    changedFiles: 3,
    reviews: [],
    checks: []
  };
}

function commit(repository: string, authorLogin: string): DirectCommitFact {
  return {
    sha: `${repository}-sha`,
    repository,
    committedAt: new Date(Date.UTC(2026, 7, 12)),
    authorLogin,
    authorType: "User",
    additions: 4,
    deletions: 1,
    changedFiles: 1
  };
}

function facts(entries: Record<string, Partial<Merges>>): Map<string, Merges> {
  return new Map(Object.entries(entries).map(([repository, merges]) => [repository, { pullRequests: [], directCommits: [], ...merges }]));
}

/**
 * One estate row, carrying only what the contributor rows read off it.
 *
 * `readiness` is DELIBERATELY WIDER than the contract's own union here, because the label order this file is about
 * has to answer for a label the domain adds later: `readinessRank` sorts an unknown one last rather than throwing,
 * and a fixture confined to the four known words could not state that.
 */
function row(repository: string, readiness?: string): contract.RepositoryRow {
  return { repository, team: "dtsse", ...(readiness === undefined ? {} : { readiness: readiness as contract.ReadinessLabel }) };
}

const NO_NAMES = new Map<string, string>();
const NO_BOTS = new Set<string>();

describe("the contributor rows a window holds", () => {
  it("should count the repositories somebody appeared in rather than the changes they made", () => {
    const held = facts({ alpha: { pullRequests: [merge("alpha", "ada", 1), merge("alpha", "ada", 2)] }, beta: { pullRequests: [merge("beta", "ada", 3)] } });

    const actors = builtActorRows([row("alpha"), row("beta")], held, NO_NAMES, NO_BOTS);

    expect(actors).toEqual([{ login: "ada", repositories: 2 }]);
  });

  it("should attribute a direct push as well as a merged pull request", () => {
    const held = facts({ alpha: { pullRequests: [merge("alpha", "ada", 1)], directCommits: [commit("alpha", "alan")] } });

    expect(builtActorRows([row("alpha")], held, NO_NAMES, NO_BOTS).map((actor) => actor.login)).toEqual(["ada", "alan"]);
  });

  it("should keep the first spelling of a login seen rather than fold it on the way out", () => {
    // GitHub is case-insensitive on logins, so any spelling is as good as any other — picking one deterministically
    // keeps the rows stable between builds, and lower-casing somebody's login on screen is a wrongness with no
    // upside.
    const held = facts({ alpha: { pullRequests: [merge("alpha", "ParisFreire", 1)] }, beta: { pullRequests: [merge("beta", "parisfreire", 2)] } });

    const actors = builtActorRows([row("alpha"), row("beta")], held, NO_NAMES, NO_BOTS);

    expect(actors).toEqual([{ login: "ParisFreire", repositories: 2 }]);
  });

  it("should name somebody from the folded map when the graph resolved a name for them", () => {
    const held = facts({ alpha: { pullRequests: [merge("alpha", "Ada", 1)] } });

    expect(builtActorRows([row("alpha")], held, new Map([["ada", "Ada Lovelace"]]), NO_BOTS)[0]?.name).toBe("Ada Lovelace");
  });

  it("should omit the name rather than send an empty string when nobody has set one", () => {
    // Absent for the 58% of the organisation who have set no profile name; an empty string would render as a blank
    // line under the login.
    const held = facts({ alpha: { pullRequests: [merge("alpha", "ada", 1)] } });

    expect("name" in (builtActorRows([row("alpha")], held, NO_NAMES, NO_BOTS)[0] ?? {})).toBe(false);
  });

  it("should leave a bot out of the rows while still keeping its repository's labels for the people", () => {
    const held = facts({ alpha: { pullRequests: [merge("alpha", "renovate[bot]", 1), merge("alpha", "ada", 2)] } });

    expect(builtActorRows([row("alpha")], held, NO_NAMES, new Set(["renovate[bot]"])).map((actor) => actor.login)).toEqual(["ada"]);
  });

  it("should skip an unattributed change rather than count it as an anonymous contributor", () => {
    const held = facts({ alpha: { pullRequests: [merge("alpha", undefined, 1)] } });

    expect(builtActorRows([row("alpha")], held, NO_NAMES, NO_BOTS)).toEqual([]);
  });

  it("should carry their repositories' labels in the order those labels mean something in", () => {
    // RENDERED IN THE ORDER SENT, so two people carrying the same set must be shown the same badges in the same
    // sequence. Alphabetical would be `amber, cannot_assess, green, red`, which is neither the order the labels
    // mean anything in nor stable across locales.
    const held = facts({
      alpha: { pullRequests: [merge("alpha", "ada", 1)] },
      beta: { pullRequests: [merge("beta", "ada", 2)] },
      gamma: { pullRequests: [merge("gamma", "ada", 3)] },
      delta: { pullRequests: [merge("delta", "ada", 4)] }
    });
    const rows = [row("alpha", "red"), row("beta", "cannot_assess"), row("gamma", "green"), row("delta", "amber")];

    expect(builtActorRows(rows, held, NO_NAMES, NO_BOTS)[0]?.labels).toEqual(["green", "amber", "red", "cannot_assess"]);
  });

  it("should sort an unknown label last rather than take the page down", () => {
    const held = facts({ alpha: { pullRequests: [merge("alpha", "ada", 1)] }, beta: { pullRequests: [merge("beta", "ada", 2)] } });

    expect(builtActorRows([row("alpha", "chartreuse"), row("beta", "green")], held, NO_NAMES, NO_BOTS)[0]?.labels).toEqual(["green", "chartreuse"]);
  });

  it("should deduplicate a label carried by two of their repositories", () => {
    const held = facts({ alpha: { pullRequests: [merge("alpha", "ada", 1)] }, beta: { pullRequests: [merge("beta", "ada", 2)] } });

    expect(builtActorRows([row("alpha", "green"), row("beta", "green")], held, NO_NAMES, NO_BOTS)[0]?.labels).toEqual(["green"]);
  });

  it("should omit the label list when none of their repositories was graded", () => {
    const held = facts({ alpha: { pullRequests: [merge("alpha", "ada", 1)] } });

    expect("labels" in (builtActorRows([row("alpha")], held, NO_NAMES, NO_BOTS)[0] ?? {})).toBe(false);
  });

  it("should order the rows alphabetically and case-insensitively, which is what the table documents", () => {
    const held = facts({
      alpha: { pullRequests: [merge("alpha", "Zoe", 1), merge("alpha", "ada", 2), merge("alpha", "Bob", 3)] }
    });

    expect(builtActorRows([row("alpha")], held, NO_NAMES, NO_BOTS).map((actor) => actor.login)).toEqual(["ada", "Bob", "Zoe"]);
  });
});
