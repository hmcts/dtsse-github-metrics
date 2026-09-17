import { describe, expect, it } from "vitest";
import type { TeamMember } from "../../org/people.ts";
import { builtTeamMemberRows } from "./members.ts";

/**
 * Each team's members as the team page lists them.
 *
 * A DIFFERENT QUESTION FROM WHO CONTRIBUTED, and the two are named through ONE map so a member and a contributor who
 * are the same person cannot be shown under two different names. Absent and empty are different answers here, and
 * that distinction is made in `teamMembers` and only preserved by this.
 */

function member(login: string, role = "MEMBER"): TeamMember {
  return { login, role };
}

const NO_NAMES = new Map<string, string>();

describe("each team's members", () => {
  it("should carry the login and the role GitHub gave for every member", () => {
    const members = builtTeamMemberRows(new Map([["dtsse", [member("ada"), member("grace", "MAINTAINER")]]]), NO_NAMES);

    expect(members.get("dtsse")).toEqual([
      { login: "ada", role: "MEMBER" },
      { login: "grace", role: "MAINTAINER" }
    ]);
  });

  it("should name a member through the folded map the contributor rows are named through", () => {
    // The team walk and the people walk each spell a login however GitHub answered them, and a case difference
    // would read as a member with no name.
    const members = builtTeamMemberRows(new Map([["dtsse", [member("ParisFreire")]]]), new Map([["parisfreire", "Paris Freire"]]));

    // GitHub's own spelling is what a reader sees; the fold is only how the name was found.
    expect(members.get("dtsse")).toEqual([{ login: "ParisFreire", name: "Paris Freire", role: "MEMBER" }]);
  });

  it("should omit the name rather than send an empty one when the graph resolved none", () => {
    const members = builtTeamMemberRows(new Map([["dtsse", [member("ef32")]]]), NO_NAMES);

    expect("name" in (members.get("dtsse")?.[0] ?? {})).toBe(false);
  });

  it("should leave a team with no membership read out of the map entirely", () => {
    // ABSENT AND EMPTY ARE DIFFERENT ANSWERS: an empty list under the heading would read as "GitHub says this team
    // has nobody in it", where 15 teams on this estate simply have no membership row at all.
    const members = builtTeamMemberRows(new Map([["dtsse", [member("ada")]]]), NO_NAMES);

    expect(members.has("civil")).toBe(false);
    expect(members.get("civil")).toBeUndefined();
  });

  it("should keep a team GitHub read and found nobody in as an empty list", () => {
    const members = builtTeamMemberRows(new Map([["civil", []]]), NO_NAMES);

    expect(members.get("civil")).toEqual([]);
  });

  it("should order a team's members alphabetically and case-insensitively", () => {
    // The rule `builtActorRows` and `teamActors` order by, so the two lists on a team's page are alphabetised the
    // same way and neither is ordered by a database collation the other is not.
    const members = builtTeamMemberRows(new Map([["dtsse", [member("Zoe"), member("ada"), member("Bob")]]]), NO_NAMES);

    expect(members.get("dtsse")?.map((person) => person.login)).toEqual(["ada", "Bob", "Zoe"]);
  });

  it("should strip absences per team rather than over the map, which would take the whole section with it", () => {
    // `stripAbsent` walks objects and arrays and a `Map` is neither — handed one it would return an empty object.
    const members = builtTeamMemberRows(
      new Map([
        ["dtsse", [member("ada")]],
        ["civil", [member("grace")]]
      ]),
      NO_NAMES
    );

    expect([...members.keys()].sort()).toEqual(["civil", "dtsse"]);
  });
});
