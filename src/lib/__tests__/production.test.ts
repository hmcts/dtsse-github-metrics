/**
 * What `lib/production.ts` owes the rest of the app.
 *
 * The interesting assertion is the last group: every colour this module spends is a NAMED Tailwind
 * colour declared in `tailwind.config.ts`, not a hex written into a class string. Nothing else
 * catches that — an arbitrary-value class like `bg-[#4169e1]` type-checks, lints, renders and would
 * pass an assertion on the class name, while quietly putting the site's palette in two places.
 */

import { describe, expect, it } from "vitest";
import {
  PRODUCTION_BADGE,
  PRODUCTION_DOT,
  PRODUCTION_LABEL,
  PRODUCTION_SOURCE_HINT,
  PRODUCTION_TOGGLE_ACTIVE,
  PRODUCTION_TOGGLE_INACTIVE,
  productionHint
} from "@/lib/production";
import type { ProductionSource } from "@/lib/types";
import config from "../../../tailwind.config";

/** Every class string the module publishes, which is every one the app is allowed to use. */
const CLASSES = [PRODUCTION_BADGE, PRODUCTION_TOGGLE_ACTIVE, PRODUCTION_TOGGLE_INACTIVE, PRODUCTION_DOT];

/** The palette as `tailwind.config.ts` declares it, cast rather than narrowed: the shape is ours. */
const COLORS = config.theme!.extend!.colors as {
  rag: Record<string, string>;
  royal: Record<string, string>;
};

describe("production vocabulary", () => {
  it("names the attribute in a word", () => {
    expect(PRODUCTION_LABEL).toBe("Production");
  });

  it("names no emoji anywhere", () => {
    expect(JSON.stringify([PRODUCTION_LABEL, ...CLASSES])).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});

describe("where the answer came from", () => {
  const SOURCES: ProductionSource[] = ["approvals-list", "configured-list", "marked"];

  it("names a sentence for each of the three sources, and only those three", () => {
    // Keyed by the union rather than by `string`, so a fourth source added to the contract fails to compile here
    // rather than rendering a cell with no explanation.
    expect(Object.keys(PRODUCTION_SOURCE_HINT).sort()).toEqual([...SOURCES].sort());
  });

  it.each(SOURCES)("says where a %s answer came from in words a reader could act on", (source) => {
    expect(productionHint(source)).toBe(PRODUCTION_SOURCE_HINT[source]);
    expect(productionHint(source)).toMatch(/\.$/);
  });

  it("names the place each source is edited, so a reader knows where to go", () => {
    expect(PRODUCTION_SOURCE_HINT["approvals-list"]).toContain("production-approvals list");
    expect(PRODUCTION_SOURCE_HINT["configured-list"]).toContain("metrics.yaml");
    expect(PRODUCTION_SOURCE_HINT.marked).toContain("database");
  });

  it("says nothing for a row whose answer no source gave", () => {
    // The dash cell. A tooltip here would explain an answer nobody gave.
    expect(productionHint(undefined)).toBeUndefined();
  });
});

describe("the badge classes", () => {
  it("keeps a border, so the badge survives a monochrome print", () => {
    expect(PRODUCTION_BADGE.split(" ")).toContain("border");
    expect(PRODUCTION_BADGE).toContain("border-royal-border");
  });

  it("carries no dismiss affordance of its own: it is not a chip", () => {
    expect(PRODUCTION_BADGE).not.toContain("cursor");
  });
});

describe("the toggle classes", () => {
  it("is royal when active and greyed when inactive", () => {
    expect(PRODUCTION_TOGGLE_ACTIVE).toContain("royal");
    expect(PRODUCTION_TOGGLE_INACTIVE).not.toContain("royal");
    expect(PRODUCTION_TOGGLE_INACTIVE).toContain("slate");
  });

  // The shade is named `border`, so this asserts on the class TOKENS rather than the string: it is
  // `ring-royal-border` that is wanted and a bare `border` utility that is not.
  it("shifts nothing as it turns on: the active state adds a ring, not a border", () => {
    const tokens = PRODUCTION_TOGGLE_ACTIVE.split(" ");
    expect(tokens).toContain("ring-1");
    expect(tokens).not.toContain("border");
  });

  it("keeps the dot royal in both states, so the control names its colour while off", () => {
    expect(PRODUCTION_DOT).toBe("bg-royal");
  });
});

describe("the configured colour", () => {
  it("gives the badge a surface, a border and a legible word", () => {
    expect(Object.keys(COLORS.royal).sort()).toEqual(["DEFAULT", "border", "surface", "text"]);
  });

  it("keeps the colour out of the rag group, which holds the report’s verdicts", () => {
    expect(Object.keys(COLORS.rag)).not.toContain("royal");
    expect(JSON.stringify(COLORS.rag)).not.toContain(COLORS.royal.DEFAULT);
  });

  it("writes every colour as a named utility, with no hex literal in any class string", () => {
    for (const classes of CLASSES) {
      expect(classes).not.toMatch(/#|\[/);
    }
  });

  it("names only shades the palette declares", () => {
    const declared = Object.keys(COLORS.royal).map((shade) => (shade === "DEFAULT" ? "" : `-${shade}`));
    const used = CLASSES.flatMap((classes) => classes.split(" "))
      .map((name) => /royal(-[a-z]+)?$/.exec(name)?.[0])
      .filter((name): name is string => name !== undefined);
    expect(used.length).toBeGreaterThan(0);
    for (const name of used) {
      expect(declared).toContain(name.replace("royal", ""));
    }
  });
});
