import { describe, expect, it } from "vitest";
import { byCodePoint, mostPermissiveAccess } from "./graph.ts";

describe("mostPermissiveAccess", () => {
  it("should take the access given when nothing was held before", () => {
    expect(mostPermissiveAccess(undefined, "push")).toBe("push");
  });

  it("should keep the existing access where it is the more permissive", () => {
    expect(mostPermissiveAccess("admin", "push")).toBe("admin");
  });

  it("should take the new access where it is the more permissive", () => {
    expect(mostPermissiveAccess("pull", "maintain")).toBe("maintain");
  });
});

describe("byCodePoint", () => {
  it("should order by code point rather than by locale, so a hyphen sorts where its code point puts it", () => {
    expect(["sscsapi", "sscs-api"].sort(byCodePoint)).toEqual(["sscs-api", "sscsapi"]);
    expect(byCodePoint("b", "a")).toBe(1);
  });

  it("should read two equal handles as a tie", () => {
    expect(byCodePoint("appreg", "appreg")).toBe(0);
  });
});
