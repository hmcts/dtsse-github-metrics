/**
 * @vitest-environment jsdom
 */

/**
 * Who GitHub says is in a team, which is not the table beside it.
 *
 * What these cases are about is everything this table does NOT do: no count of anything anybody did, and no link
 * to a `/contributors/` page that would not exist for a member who merged nothing. Both are what separates it from
 * `TeamActorsTable`, and both are invisible in the markup unless something asserts their absence.
 */

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TeamMembersTable } from "@/components/TeamMembersTable";
import type { TeamMemberRow } from "@/lib/types";

/** Three members: one named maintainer, one named member, and one the identity mapping resolved no name for. */
const ROWS: TeamMemberRow[] = [
  { login: "alice", name: "Alice Archer", role: "MAINTAINER" },
  { login: "bob", name: "Bob Bell", role: "MEMBER" },
  { login: "ef32", role: "MEMBER" }
];

function mount(rows: readonly TeamMemberRow[] = ROWS) {
  render(<TeamMembersTable rows={rows} />);
}

function rows(): HTMLElement[] {
  return screen.getAllByRole("row").slice(1);
}

afterEach(cleanup);

describe("TeamMembersTable", () => {
  it("should name the person and their standing in the team, and count nothing", () => {
    mount();

    const headings = screen.getAllByRole("columnheader").map((cell) => cell.textContent);
    expect(headings).toEqual(["Member", "Role in team"]);
    // Neither of the contributor table's columns, because membership is not a measurement of anything anybody did.
    expect(headings).not.toContain("Repositories in team");
    expect(headings).not.toContain("Merges in team");
  });

  it("should lead on the name where the graph holds one and show the login under it", () => {
    mount();

    const cell = within(rows()[0] as HTMLElement).getAllByRole("cell")[0];
    expect(cell?.textContent).toBe("Alice Archeralice");
    // The login is the one line drawn in the machine-identifier font, which is what makes a mixed column
    // unambiguous about which of the two values a row is leading on.
    expect(cell?.querySelector(".font-mono")?.textContent).toBe("alice");
  });

  it("should show a login-only row as a login, in the font a machine identifier is drawn in", () => {
    mount([{ login: "ef32", role: "MEMBER" }]);

    const cell = within(rows()[0] as HTMLElement).getAllByRole("cell")[0];
    // One line and not two: `contributorLabel` has already put the login on the first, so a second copy of it
    // would be the noise that made a team card read " contributors".
    expect(cell?.textContent).toBe("ef32");
    expect(cell?.querySelector(".font-mono")?.textContent).toBe("ef32");
  });

  it("should word GitHub's roles as a reader would", () => {
    mount();

    const roles = rows().map((row) => within(row).getAllByRole("cell")[1]?.textContent);
    expect(roles).toEqual(["Maintainer", "Member", "Member"]);
  });

  it("should link nobody, there being no page for a member who landed nothing in the window", () => {
    // `/contributors/<login>` is built from the window's merges and refuses a login with none of them, so a link
    // per member would be a not-found page for exactly the people this section exists to name.
    mount();

    expect(screen.queryAllByRole("link")).toHaveLength(0);
  });

  it("should draw a row per member in the order it was given", () => {
    mount();

    expect(rows()).toHaveLength(3);
    expect(rows().map((row) => within(row).getAllByRole("cell")[0]?.textContent)).toEqual(["Alice Archeralice", "Bob Bellbob", "ef32"]);
  });
});
