/**
 * @vitest-environment jsdom
 */

/**
 * The commits that reached a default branch without a pull request.
 *
 * THE COLUMN THAT IS NOT HERE is the point of this table, and the first case asserts its absence: a direct push had
 * no pull request, so there was nothing to review, and a `Reviewed` column would invite a dash that read as
 * "unknown" rather than as "not applicable".
 */

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TeamDirectPushesTable } from "@/components/TeamDirectPushesTable";
import type { TeamDirectPushRow } from "@/lib/types";

/**
 * Three pushes that separate every column.
 *
 * `deadbeefcafe` carries a git author NAME and no CI answer — the shape a commit GitHub linked no account for and
 * no check ever reported on, which is why both fields are optional.
 */
const ROWS: TeamDirectPushRow[] = [
  { repository: "web", sha: "aaaaaaabbbbbb", committed_at: "2026-08-31T09:00:00Z", author: "alice", ci: true, lines: 20, files: 3 },
  { repository: "api", sha: "cccccccdddddd", committed_at: "2026-08-30T09:00:00Z", author: "bob", ci: false, lines: 5, files: 1 },
  { repository: "docs", sha: "deadbeefcafe", committed_at: "2026-08-29T09:00:00Z", author: "Some Person" }
];

/**
 * What a SIGHTED reader sees in a cell: its text with every `sr-only` node removed.
 *
 * An unmeasured cell renders `Absent` since 2026-09-15 — the dash `aria-hidden` beside the words "not measured" —
 * so raw `textContent` is the spoken rendering rather than the printed one.
 */
function printed(cell: Element | undefined): string {
  const copy = cell?.cloneNode(true) as HTMLElement | undefined;
  for (const hidden of copy?.querySelectorAll(".sr-only") ?? []) {
    hidden.remove();
  }
  return copy?.textContent ?? "";
}

/**
 * Assert a cell reads as unmeasured, in the dash on screen AND the words a screen reader is given.
 *
 * These cases asserted `textContent === "-"`, and that hyphen was the whole of what carried "absent means
 * unmeasured" — announced as "hyphen", or skipped between two empty cells. Strictly more is required now: the dash
 * must still be exactly a dash, and it must also be named.
 */
function expectUnmeasured(cell: Element | undefined): void {
  expect(printed(cell)).toBe("-");
  expect(cell?.querySelector(".sr-only")?.textContent).toBe("not measured");
}

function mount(rows: readonly TeamDirectPushRow[] = ROWS) {
  render(<TeamDirectPushesTable rows={rows} weeks={12} />);
}

function order(): string[] {
  return screen
    .getAllByRole("row")
    .slice(1)
    .map((row) => within(row).getAllByRole("cell")[2]?.textContent ?? "");
}

function header(label: string): HTMLElement {
  return screen.getByRole("button", { name: label });
}

afterEach(cleanup);

describe("TeamDirectPushesTable", () => {
  it("has no Reviewed column, because a push with no pull request had nothing to review", () => {
    mount();

    const headings = screen.getAllByRole("columnheader").map((cell) => cell.textContent);
    expect(headings).toEqual(["Pushed", "Repository", "Commit", "Author", "CI", "Lines", "Files"]);
    expect(headings).not.toContain("Reviewed");
  });

  it("opens newest first and says which column that is", () => {
    mount();

    expect(order()).toEqual(["aaaaaaa", "ccccccc", "deadbee"]);
    expect(screen.getByRole("columnheader", { name: "Pushed" }).getAttribute("aria-sort")).toBe("descending");
  });

  it("shortens the sha to the seven characters somebody pastes into git show", () => {
    mount();

    expect(screen.getByText("deadbee")).toBeDefined();
    expect(screen.queryByText("deadbeefcafe")).toBeNull();
  });

  it("keeps a commit no check reported on apart from one whose checks failed", () => {
    // A dash and a No are different answers: the first was never measured, the second was and failed.
    mount();

    const cells = screen.getAllByRole("row").map((row) => within(row).queryAllByRole("cell")[4]);
    expect(cells.map(printed)).toContain("No");
    // The unmeasured one is found by its accessible name rather than by its glyph, which is the distinction
    // the dash could not make on its own.
    expect(cells.map((cell) => cell?.querySelector(".sr-only")?.textContent)).toContain("not measured");
  });

  it("shows the git author name where GitHub linked no account, and does not link it", () => {
    mount();

    expect(screen.getByText("Some Person")).toBeDefined();
    expect(screen.queryByRole("link", { name: "Some Person" })).toBeNull();
  });

  it("sorts on each column, and puts an unmeasured size last either way", () => {
    mount();

    fireEvent.click(header("Lines"));
    expect(order()).toEqual(["ccccccc", "aaaaaaa", "deadbee"]);

    fireEvent.click(header("Lines"));
    expect(order()).toEqual(["aaaaaaa", "ccccccc", "deadbee"]);

    fireEvent.click(header("Repository"));
    expect(order()).toEqual(["ccccccc", "deadbee", "aaaaaaa"]);

    fireEvent.click(header("Commit"));
    expect(order()).toEqual(["aaaaaaa", "ccccccc", "deadbee"]);

    fireEvent.click(header("Author"));
    expect(order()[0]).toBe("aaaaaaa");

    fireEvent.click(header("CI"));
    expect(order()[0]).toBe("ccccccc");

    fireEvent.click(header("Files"));
    expect(order()[0]).toBe("ccccccc");

    fireEvent.click(header("Pushed"));
    expect(order()).toEqual(["deadbee", "ccccccc", "aaaaaaa"]);
  });

  it("links each push to its repository, carrying the span", () => {
    mount();

    expect(screen.getByRole("link", { name: "api" }).getAttribute("href")).toBe("/repositories/api?weeks=12");
  });

  it("prints a dash for an unmeasured size rather than a zero", () => {
    mount([ROWS[2] as TeamDirectPushRow]);

    const cells = within(screen.getAllByRole("row")[1] as HTMLElement).getAllByRole("cell");
    expectUnmeasured(cells[5]);
    expectUnmeasured(cells[6]);
  });

  it("thousand-separates a large push", () => {
    mount([{ repository: "web", sha: "eeeeeeeffffff", committed_at: "2026-08-31T09:00:00Z", lines: 12345, files: 9 }]);

    expect(screen.getByText("12,345")).toBeDefined();
  });

  it("renders nothing but the header row where nothing was pushed directly", () => {
    mount([]);

    expect(screen.getAllByRole("row")).toHaveLength(1);
  });
});
