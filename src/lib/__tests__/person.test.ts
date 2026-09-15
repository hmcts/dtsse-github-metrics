/**
 * How a contributor is named, which is one rule read by a table cell and by an export.
 *
 * The cases here are the fallback and nothing else, because the fallback is the whole of it: two people in five
 * have a profile name and the other three do not, so the branch that "only happens sometimes" is the common one.
 */

import { describe, expect, it } from "vitest";
import { contributorEntry, contributorLabel } from "@/lib/person";

describe("contributorLabel", () => {
  it("should show the profile name when the organisation graph holds one", () => {
    expect(contributorLabel({ login: "parisfreire", name: "Paris Freire" })).toBe("Paris Freire");
  });

  it("should fall back to the login when no name was collected", () => {
    expect(contributorLabel({ login: "parisfreire" })).toBe("parisfreire");
  });

  it("should never derive a name from a login", () => {
    // `ef32` is `Tam Arah` on the live estate. No rule over the characters of a login could produce that, and a
    // wrong name attached to a real person is worse than the login they log in with.
    expect(contributorLabel({ login: "ef32" })).toBe("ef32");
  });
});

describe("contributorEntry", () => {
  it("should keep the login beside the name where there is one", () => {
    // The name says who somebody is; the login is what joins them to GitHub and to every other report. A cell
    // carrying only "Paris Freire" cannot be looked up.
    expect(contributorEntry({ login: "parisfreire", name: "Paris Freire" })).toBe("Paris Freire (parisfreire)");
  });

  it("should carry the login alone where there is no name, with no empty parentheses", () => {
    expect(contributorEntry({ login: "parisfreire" })).toBe("parisfreire");
  });

  it("should never render the word undefined for an uncollected name", () => {
    // The shape that put " contributors" on every team card: a template literal over a value nobody guaranteed.
    for (const rendered of [contributorEntry({ login: "nameless" }), contributorLabel({ login: "nameless" })]) {
      expect(rendered).not.toContain("undefined");
      expect(rendered).not.toBe("");
    }
  });
});
