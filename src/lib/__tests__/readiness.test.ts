/**
 * The readiness grouping `/teams` and `/contributors` count and filter by — the arithmetic behind both pages' tiles.
 */

import { describe, expect, it } from "vitest";
import { classify, contributorLabels, isReadinessKey, matchesReadiness, readinessTiles, teamLabels } from "@/lib/readiness";
import type { ReadinessLabel } from "@/lib/types";

describe("classify", () => {
  // Every non-empty combination of the three graded labels, so a combination left out of `GROUPS` fails here.
  it.each<[ReadinessLabel[], string, string]>([
    [["green"], "ready", "green"],
    [["green", "amber"], "ready", "green-amber"],
    [["green", "amber", "red"], "review", "green-amber-red"],
    [["green", "red"], "review", "green-red"],
    [["amber"], "review", "amber"],
    [["amber", "red"], "blocked", "amber-red"],
    [["red"], "blocked", "red"]
  ])("puts %j in %s, subgroup %s", (labels, group, subgroup) => {
    expect(classify(labels)).toEqual({ group, subgroup });
  });

  it("reads a combination whatever order and repetition its labels arrive in", () => {
    expect(classify(["red", "green", "red"])).toEqual({ group: "review", subgroup: "green-red" });
  });

  it("leaves an unreadable repository out of a graded combination", () => {
    expect(classify(["green", "cannot_assess"])).toEqual({ group: "ready", subgroup: "green" });
  });

  it("puts a row with only unreadable repositories in Cannot assess, which has no subgroup", () => {
    expect(classify(["cannot_assess"])).toEqual({ group: "cannot_assess" });
  });

  it("puts a row with no label at all in no group", () => {
    expect(classify([])).toBeUndefined();
  });
});

describe("teamLabels", () => {
  it("lists every label a repository holds, in RAG order, and drops the ungraded key", () => {
    expect(teamLabels({ red: 1, green: 3, amber: 0, not_assessed: 2, cannot_assess: 1 })).toEqual(["green", "red", "cannot_assess"]);
  });

  it("is empty for a team the policy graded nothing for", () => {
    expect(teamLabels({ not_assessed: 4 })).toEqual([]);
  });
});

describe("contributorLabels", () => {
  it("passes a person's labels through", () => {
    expect(contributorLabels(["green"], true)).toEqual(["green"]);
  });

  it("reads an empty or absent list as unreadable where the policy graded something", () => {
    expect(contributorLabels([], true)).toEqual(["cannot_assess"]);
    expect(contributorLabels(undefined, true)).toEqual(["cannot_assess"]);
  });

  it("is empty for everybody where the policy graded nothing", () => {
    expect(contributorLabels(["green"], false)).toEqual([]);
  });
});

describe("readinessTiles", () => {
  const tiles = readinessTiles([
    classify(["green"]),
    classify(["green"]),
    classify(["green", "amber"]),
    classify(["amber"]),
    classify(["red"]),
    classify(["cannot_assess"]),
    undefined
  ]);

  it("draws the four groups in order, ready first", () => {
    expect(tiles.map((tile) => [tile.key, tile.name, tile.state])).toEqual([
      ["ready", "Ready", "green"],
      ["review", "Review", "amber"],
      ["blocked", "Blocked", "red"],
      ["cannot_assess", "Cannot assess", "cannot_assess"]
    ]);
  });

  it("counts each group as the sum of its subgroups, and counts an ungrouped row nowhere", () => {
    expect(tiles.map((tile) => tile.count)).toEqual([3, 1, 1, 1]);
    for (const tile of tiles.filter((entry) => entry.subgroups.length > 0)) {
      expect(tile.subgroups.reduce((total, subgroup) => total + subgroup.count, 0)).toBe(tile.count);
    }
  });

  it("names each subgroup by its labels' words and keeps the ones counted at zero", () => {
    expect(tiles[1]?.subgroups.map((subgroup) => [subgroup.key, subgroup.name, subgroup.count])).toEqual([
      ["green-amber-red", "Ready + Caution + Blocked", 0],
      ["green-red", "Ready + Blocked", 0],
      ["amber", "Caution only", 1]
    ]);
    expect(tiles[0]?.subgroups[0]?.name).toBe("Ready only");
    expect(tiles[3]?.subgroups).toEqual([]);
  });
});

describe("matchesReadiness", () => {
  const mixed = classify(["green", "red"]);

  it("keeps a row in its group and in its subgroup", () => {
    expect(matchesReadiness(mixed, "review")).toBe(true);
    expect(matchesReadiness(mixed, "green-red")).toBe(true);
  });

  it("drops a row from another group or subgroup", () => {
    expect(matchesReadiness(mixed, "ready")).toBe(false);
    expect(matchesReadiness(mixed, "amber")).toBe(false);
    expect(matchesReadiness(undefined, "cannot_assess")).toBe(false);
  });

  it("keeps every row, the ungrouped included, under no filter or a key naming nothing", () => {
    expect(matchesReadiness(undefined, "")).toBe(true);
    expect(matchesReadiness(mixed, "purple")).toBe(true);
    expect(isReadinessKey("purple")).toBe(false);
  });
});
