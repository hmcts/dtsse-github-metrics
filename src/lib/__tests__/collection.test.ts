/**
 * What the pages say about the collection their figures are anchored to.
 *
 * Two statements and no warning: the date the collection reached, and how many repositories it did not reach.
 * There is nothing here asserting a banner about staleness, because none is raised — the collectors do not run
 * at weekends, so a warning keyed off the age of the last collection fired every Monday on every page and named
 * a command the reader cannot run.
 */

import { describe, expect, it } from "vitest";
import { collectedLabel, unreportedLabel } from "@/lib/collection";

describe("collectedLabel", () => {
  it("labels the collection a window is anchored to", () => {
    expect(collectedLabel("2026-09-01T00:00:00+00:00")).toBe("Collected through 2026-09-01");
  });

  it("has nothing to label where nothing was collected", () => {
    expect(collectedLabel(undefined)).toBeNull();
    expect(collectedLabel(null)).toBeNull();
  });
});

/**
 * The unreported figure, in the two wordings the pages need for one number.
 *
 * The figure is an IMPORT fact either way — `spanWindow` anchors every span at the same `collectedAnchor`, so the
 * coverage comparison behind it returns the same answer at every span — which is why the snapshot wording is a
 * correction rather than a second claim.
 */
describe("unreportedLabel", () => {
  it("counts the repositories a window could not report, in the windowed pages' words", () => {
    expect(unreportedLabel(2)).toBe("2 repositories not reported at this span");
    expect(unreportedLabel(1)).toBe("1 repository not reported at this span");
  });

  it("names the import rather than a span for a page that states no window", () => {
    expect(unreportedLabel(2, true)).toBe("2 repositories the last import did not reach");
    expect(unreportedLabel(1, true)).toBe("1 repository the last import did not reach");
    // The words a page with no span must not print, since there is no span on it to refer to.
    expect(unreportedLabel(870, true)).not.toContain("span");
  });

  it("has nothing to say where every repository was reported", () => {
    expect(unreportedLabel(0)).toBeNull();
    expect(unreportedLabel(0, true)).toBeNull();
  });
});
