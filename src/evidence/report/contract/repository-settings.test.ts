import { describe, expect, it } from "vitest";
import { storedSettings } from "./repository-settings.ts";

/**
 * The repository settings a collection stored, read back for the secure-by-design checks.
 *
 * Anything that is not a well-formed block reads as unread, which the assessment reports as an informational clear
 * rather than as a weak setting.
 */

describe("the repository settings a collection stored", () => {
  it("should read nothing when the payload is not an object", () => {
    expect(storedSettings(undefined)).toBeUndefined();
    expect(storedSettings(null)).toBeUndefined();
    expect(storedSettings("main")).toBeUndefined();
  });

  it("should read nothing from a payload stored before settings were collected", () => {
    expect(storedSettings({ defaultBranch: "main", mergeGate: { detail: "x" } })).toBeUndefined();
  });

  it("should read nothing when settings is not an object", () => {
    expect(storedSettings({ settings: null })).toBeUndefined();
    expect(storedSettings({ settings: "all" })).toBeUndefined();
    expect(storedSettings({ settings: [] })).toBeUndefined();
  });

  it("should read both blocks when both were stored", () => {
    const settings = {
      actions: { enabled: true, allowedActions: "all", shaPinningRequired: false },
      issues: { enabled: true, creationPolicy: "COLLABORATORS_ONLY" }
    };

    expect(storedSettings({ settings })).toEqual(settings);
  });

  it("should read a disabled block with no policy as it was stored", () => {
    expect(storedSettings({ settings: { actions: { enabled: false }, issues: { enabled: false } } })).toEqual({
      actions: { enabled: false },
      issues: { enabled: false }
    });
  });

  it("should read an empty settings object as both settings unread", () => {
    expect(storedSettings({ settings: {} })).toEqual({});
  });

  it("should drop a malformed block as unread and keep the well-formed one", () => {
    expect(storedSettings({ settings: { actions: { enabled: "yes", allowedActions: "all" }, issues: { enabled: true, creationPolicy: "ALL" } } })).toEqual({
      issues: { enabled: true, creationPolicy: "ALL" }
    });
    expect(storedSettings({ settings: { actions: { enabled: true, allowedActions: 3 }, issues: "ALL" } })).toEqual({});
    expect(storedSettings({ settings: { actions: { enabled: true, allowedActions: "all", shaPinningRequired: "no" } } })).toEqual({});
  });
});
