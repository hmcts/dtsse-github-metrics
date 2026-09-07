import { beforeEach, describe, expect, it, vi } from "vitest";
import { mergeCodeowners, parseCodeowners } from "./codeowners.ts";

// Ported from the cases `build_team_configuration.py` handled by accident, plus the three it got wrong. Nothing
// here touches `fetch`: parsing a CODEOWNERS file is a function of the text and the surveyed organisation, so
// every case is a string.

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "debug").mockImplementation(() => undefined);
});

describe("parseCodeowners", () => {
  it("should read the team named on the default line", () => {
    expect(parseCodeowners("* @hmcts/appreg\n", "hmcts")).toEqual({ teams: ["appreg"], people: [] });
  });

  it("should drop the surveyed organisation's own prefix", () => {
    // `appreg` is what the teams API returns, so it is the key `knownTeams` can be checked against.
    expect(parseCodeowners("* @hmcts/platform-operations", "hmcts").teams).toEqual(["platform-operations"]);
  });

  it("should drop the organisation's prefix whatever case it was written in", () => {
    expect(parseCodeowners("* @HMCTS/AppReg", "hmcts").teams).toEqual(["appreg"]);
  });

  it("should keep a foreign organisation's prefix, because there the prefix is the part that matters", () => {
    const owners = parseCodeowners("* @hmcts/appreg\ndocs/ @ministryofjustice/appreg\n", "hmcts");

    expect(owners.teams).toEqual(["appreg", "ministryofjustice/appreg"]);
  });

  it("should read every line, not only the default one", () => {
    // HMCTS repositories routinely name a default owner and then name teams per directory; a `*`-only rule
    // would drop every one of the latter.
    const document = ["* @hmcts/appreg", "/infrastructure/ @hmcts/platform-operations", "/docs/ @hmcts/dtsse"].join("\n");

    expect(parseCodeowners(document, "hmcts").teams).toEqual(["appreg", "dtsse", "platform-operations"]);
  });

  it("should report owners for a file with no default line at all", () => {
    expect(parseCodeowners("/src/ @hmcts/dtsse\n", "hmcts").teams).toEqual(["dtsse"]);
  });

  it("should cut comments before reading handles", () => {
    // A handle in a note is not an owner. Cutting the comment first is what keeps this file from attributing
    // the repository to whoever was mentioned in passing.
    const document = ["# ask @hmcts/platform-operations before editing this", "* @hmcts/appreg # owned by @hmcts/dtsse historically"].join("\n");

    expect(parseCodeowners(document, "hmcts")).toEqual({ teams: ["appreg"], people: [] });
  });

  it("should read a whole-line comment as naming nobody", () => {
    expect(parseCodeowners("# @hmcts/appreg\n", "hmcts")).toEqual({ teams: [], people: [] });
  });

  it("should read a bare handle as a person rather than as a team", () => {
    expect(parseCodeowners("* @alice @hmcts/appreg\n", "hmcts")).toEqual({ teams: ["appreg"], people: ["alice"] });
  });

  it("should reject GitHub's documentation placeholders, which are the estate's commonest 'individual owner'", () => {
    // 18 occurrences across 97 files, copied out of GitHub's own docs. Neither is a person.
    expect(parseCodeowners("* @global-owner1 @global-owner2 @alice\n", "hmcts").people).toEqual(["alice"]);
  });

  it("should reject a placeholder whatever case it was written in", () => {
    expect(parseCodeowners("* @Global-Owner1\n", "hmcts").people).toEqual([]);
  });

  it("should fold one team written two ways into one team", () => {
    // Left as two, the file would look contested and the sole-owner rung would not fire for a repository that
    // plainly has one owner.
    const owners = parseCodeowners("* @hmcts/AppReg\n/src/ @hmcts/appreg\n", "hmcts");

    expect(owners.teams).toEqual(["appreg"]);
  });

  it("should fold one person written two ways into one person", () => {
    expect(parseCodeowners("* @Alice\n/src/ @alice\n", "hmcts").people).toEqual(["alice"]);
  });

  it("should not read an email address as a person", () => {
    // GitHub accepts an email as an owner, and scanning for `@name` across the line would read `@example` out
    // of it.
    expect(parseCodeowners("* someone@example.com\n", "hmcts")).toEqual({ teams: [], people: [] });
  });

  it("should read carriage-return line endings", () => {
    expect(parseCodeowners("* @hmcts/appreg\r\n/src/ @hmcts/dtsse\r\n", "hmcts").teams).toEqual(["appreg", "dtsse"]);
  });

  it("should tolerate leading whitespace and repeated spaces", () => {
    expect(parseCodeowners("   *    @hmcts/appreg   @bob  \n", "hmcts")).toEqual({ teams: ["appreg"], people: ["bob"] });
  });

  it("should ignore a handle that reads as neither a team nor a person", () => {
    // A bare `@`, a team prefix with no team, a handle carrying a second slash: each is a token this file
    // cannot place, and placing it anyway is how a repository acquires an owner nobody wrote down.
    expect(parseCodeowners("* @ @hmcts/ @hmcts/appreg/extra\n", "hmcts")).toEqual({ teams: [], people: [] });
  });

  it("should read an empty document as naming nobody", () => {
    expect(parseCodeowners("", "hmcts")).toEqual({ teams: [], people: [] });
  });

  it("should return sorted output, so two runs over one file produce identical facts", () => {
    const owners = parseCodeowners("* @hmcts/zebra @hmcts/alpha @zoe @adam\n", "hmcts");

    expect(owners).toEqual({ teams: ["alpha", "zebra"], people: ["adam", "zoe"] });
  });

  it("should keep a team handle carrying dots and underscores", () => {
    expect(parseCodeowners("* @hmcts/team_one.two\n", "hmcts").teams).toEqual(["team_one.two"]);
  });
});

describe("mergeCodeowners", () => {
  it("should union the owners of the several paths one repository may carry", () => {
    const merged = mergeCodeowners([
      { teams: ["appreg"], people: ["alice"] },
      { teams: ["dtsse", "appreg"], people: ["bob"] }
    ]);

    expect(merged).toEqual({ teams: ["appreg", "dtsse"], people: ["alice", "bob"] });
  });

  it("should read no files as naming nobody", () => {
    expect(mergeCodeowners([])).toEqual({ teams: [], people: [] });
  });
});
