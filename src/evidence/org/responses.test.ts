import { describe, expect, it } from "vitest";
import { CodeownersPaths } from "./graph.ts";
import { ownershipEntry, teamAccess } from "./responses.ts";

describe("ownershipEntry", () => {
  it("should read the echoed name and one blob slot per CODEOWNERS path, in path order", () => {
    const entry = ownershipEntry({ name: "pcs-api", p0: { text: "* @hmcts/appreg", byteSize: 15, isTruncated: false } });

    expect(entry.name).toBe("pcs-api");
    expect(entry.files).toHaveLength(CodeownersPaths.length);
    expect(entry.files[0]).toEqual({ text: "* @hmcts/appreg", byteSize: 15, isTruncated: false });
    expect(entry.files.slice(1).every((file) => file === undefined)).toBe(true);
  });

  it("should leave the name absent, not undefined, where GitHub echoed none", () => {
    expect(Object.hasOwn(ownershipEntry({}), "name")).toBe(false);
  });

  it("should leave the name absent where GitHub echoed something that is not a string", () => {
    expect(Object.hasOwn(ownershipEntry({ name: 7 }), "name")).toBe(false);
  });
});

describe("teamAccess", () => {
  it("should map GraphQL's WRITE and READ onto the REST words the ladder indexes by", () => {
    expect(teamAccess("WRITE")).toBe("push");
    expect(teamAccess("READ")).toBe("pull");
    expect(teamAccess("admin")).toBe("admin");
  });

  it("should place nothing for a permission that is absent", () => {
    expect(teamAccess(null)).toBeUndefined();
    expect(teamAccess(undefined)).toBeUndefined();
  });

  it("should place nothing for a permission this build does not know", () => {
    expect(teamAccess("OWNER")).toBeUndefined();
  });
});
