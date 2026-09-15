/**
 * @vitest-environment jsdom
 */

/**
 * The merges a team landed, and the two answers each of them carries.
 *
 * WHAT THIS TABLE IS FOR is the reason the assertions look as they do: it is the evidence under the ways-of-working
 * counts, so what matters is that an unreviewed merge is FINDABLE — sortable to the top, distinguishable from one
 * nobody sized, and never rendered as a zero.
 */

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TeamMergesTable } from "@/components/TeamMergesTable";
import type { TeamMergeRow } from "@/lib/types";

/**
 * Four merges that separate every column.
 *
 * `web#7` is the unreviewed one, `api#2` failed CI, and `docs#9` is the merge GitHub did not size — which has to
 * stay apart from a merge of no lines.
 */
const ROWS: TeamMergeRow[] = [
  { repository: "api", number: 2, merged_at: "2026-08-30T09:00:00Z", author: "alice", reviewed: true, ci: false, lines: 12, files: 2 },
  { repository: "web", number: 7, merged_at: "2026-08-31T09:00:00Z", author: "bob", reviewed: false, ci: true, lines: 4000, files: 40 },
  { repository: "docs", number: 9, merged_at: "2026-08-28T09:00:00Z", reviewed: true, ci: true },
  { repository: "api", number: 3, merged_at: "2026-08-29T09:00:00Z", author: "carol", reviewed: true, ci: true, lines: 0, files: 1 }
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
 * unmeasured" — the rule that keeps a merge nobody measured apart from one that went unreviewed, which is exactly
 * what this table exists to distinguish. Strictly more is required now: still a dash, and now also named.
 */
function expectUnmeasured(cell: Element | undefined): void {
  expect(printed(cell)).toBe("-");
  expect(cell?.querySelector(".sr-only")?.textContent).toBe("not measured");
}

function mount(rows: readonly TeamMergeRow[] = ROWS) {
  render(<TeamMergesTable rows={rows} weeks={4} />);
}

/** The merges in render order, as `repository#number`, which is the pair that identifies a row. */
function order(): string[] {
  return screen
    .getAllByRole("row")
    .slice(1)
    .map((row) => {
      const cells = within(row).getAllByRole("cell");
      return `${cells[1]?.textContent}${cells[2]?.textContent}`;
    });
}

function header(label: string): HTMLElement {
  return screen.getByRole("button", { name: label });
}

function announced(label: string): string | null {
  return screen.getByRole("columnheader", { name: label }).getAttribute("aria-sort");
}

afterEach(cleanup);

describe("TeamMergesTable", () => {
  it("opens in the order the service served, newest first, and says which column that is", () => {
    // NOT RE-SORTED on mount. The report layer already orders newest first, so an untouched table renders the
    // list as given — but the header still has to state the order, or a reader cannot tell it from an arbitrary one.
    mount();

    expect(order()).toEqual(["api#2", "web#7", "docs#9", "api#3"]);
    expect(announced("Merged")).toBe("descending");
    expect(announced("Reviewed")).toBe("none");
  });

  it("heads the date, the change, its author, and the two answers it carries", () => {
    mount();

    expect(screen.getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual([
      "Merged",
      "Repository",
      "Change",
      "Author",
      "Reviewed",
      "CI",
      "Lines",
      "Files"
    ]);
  });

  it("sorts the unreviewed merges to the top, which is the question this table is opened with", () => {
    mount();
    fireEvent.click(header("Reviewed"));

    // Ascending on the flag puts `false` first: the merge nobody else looked at leads the list.
    expect(order()[0]).toBe("web#7");
  });

  it("groups the two answers rather than interleaving them, in both directions", () => {
    mount();
    fireEvent.click(header("CI"));
    expect(order()[0]).toBe("api#2");

    fireEvent.click(header("CI"));
    expect(order().at(-1)).toBe("api#2");
  });

  it("reverses the column already sorted and opens a new one ascending", () => {
    mount();

    fireEvent.click(header("Merged"));
    expect(announced("Merged")).toBe("ascending");
    expect(order()).toEqual(["docs#9", "api#3", "api#2", "web#7"]);

    fireEvent.click(header("Lines"));
    expect(announced("Lines")).toBe("ascending");
    expect(announced("Merged")).toBe("none");
  });

  it("keeps a merge GitHub did not size apart from one of no lines, and sorts it last either way", () => {
    // `api#3` merged zero lines, which is a measurement; `docs#9` was never sized, which is not. A dash for the
    // second and `0` for the first is the whole absent-versus-zero rule, in the one place it is easiest to lose.
    mount();

    fireEvent.click(header("Lines"));
    expect(order()).toEqual(["api#3", "api#2", "web#7", "docs#9"]);

    fireEvent.click(header("Lines"));
    expect(order().at(-1)).toBe("docs#9");

    const sized = screen.getAllByRole("row").find((row) => within(row).queryByText("api"));
    expect(sized).toBeDefined();
  });

  it("prints a dash for an author GitHub attributed to nobody, never an empty cell", () => {
    mount([ROWS[2] as TeamMergeRow]);

    const cells = within(screen.getAllByRole("row")[1] as HTMLElement).getAllByRole("cell");
    expectUnmeasured(cells[3]);
    expectUnmeasured(cells[6]);
    expectUnmeasured(cells[7]);
  });

  it("keeps a merge nobody measured apart from one that went unreviewed, and sorts it last either way", () => {
    // THE SHAPE THAT BROKE THE PAGE. A payload stored before the collector recorded reviews carries no array, so
    // the report emits neither answer — and a `No` here would accuse a team of skipping a review nobody looked for.
    const unmeasured: TeamMergeRow = { repository: "old", number: 1, merged_at: "2026-08-27T09:00:00Z", author: "dan" };
    mount([...ROWS, unmeasured]);

    const dashed = screen.getAllByRole("row").find((row) => within(row).queryByText("old"));
    const cells = within(dashed as HTMLElement).getAllByRole("cell");
    expectUnmeasured(cells[4]);
    expectUnmeasured(cells[5]);

    fireEvent.click(header("Reviewed"));
    expect(order().at(-1)).toBe("old#1");

    fireEvent.click(header("Reviewed"));
    expect(order().at(-1)).toBe("old#1");
  });

  // Every column at once: each header hands the table its own reader, and a mis-wired one orders by the column
  // beside it — which no single-column case would catch. The same guard `RepositoriesTable` carries.
  it("sorts on each remaining column, putting a merge with no answer last", () => {
    mount();

    fireEvent.click(header("Repository"));
    expect(order()).toEqual(["api#2", "api#3", "docs#9", "web#7"]);

    fireEvent.click(header("Change"));
    expect(order()).toEqual(["api#2", "api#3", "web#7", "docs#9"]);

    fireEvent.click(header("Author"));
    // `docs#9` has no author, so it sorts last rather than reading as the first name alphabetically.
    expect(order()).toEqual(["api#2", "web#7", "api#3", "docs#9"]);

    fireEvent.click(header("Files"));
    expect(order()).toEqual(["api#3", "api#2", "web#7", "docs#9"]);
  });

  it("thousand-separates a large diff so a four-figure change is not misread", () => {
    mount();

    expect(screen.getByText("4,000")).toBeDefined();
  });

  it("links each merge to its repository, carrying the span", () => {
    mount();

    expect(screen.getAllByRole("link", { name: "web" })[0]?.getAttribute("href")).toBe("/repositories/web?weeks=4");
  });

  it("renders nothing but the header row for a team with no merges", () => {
    mount([]);

    expect(screen.getAllByRole("row")).toHaveLength(1);
  });
});
