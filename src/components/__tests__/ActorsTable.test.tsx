/**
 * @vitest-environment jsdom
 */

/**
 * What a header click does to the contributor list, which the server render cannot reach.
 *
 * `tables.test.ts` asserts the render this table OPENS on — readiness ascending, unlabelled last —
 * and that is the half a static renderer can see. The direction lives in component state, so the
 * reversal, the switch between columns, and above all THE GUARDRAIL that survives both of them are
 * only assertable from a browser: an unlabelled person sorts last whichever way the list is turned,
 * because "who is worst" is a question about the graded people and an unreadable repository is not
 * an answer to it read either way round.
 *
 * There is no navigation to assert and none to stub: this table holds its sort in state and puts
 * nothing in the URL, and it has no filter and no paging — the whole list is the estate's people.
 */

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ActorsTable } from "@/components/ActorsTable";
import type { ActorRow } from "@/lib/types";

/**
 * Four people who separate all three columns, and whose labels separate the combination order:
 * `dan` is all green, `carol` green and amber, `alice` blocked, and `bob` has nothing left to label.
 */
const ROWS: ActorRow[] = [
  { login: "alice", repositories: 3, labels: ["red"] },
  { login: "bob", repositories: 1, labels: [] },
  { login: "carol", repositories: 2, labels: ["green", "amber"] },
  { login: "dan", repositories: 4, labels: ["green"] }
];

function logins(): string[] {
  return screen
    .getAllByRole("row")
    .slice(1)
    .map((row) => within(row).getAllByRole("cell")[0]?.textContent ?? "");
}

function sortBy(label: string): string[] {
  fireEvent.click(within(screen.getByRole("columnheader", { name: new RegExp(label) })).getByRole("button"));
  return logins();
}

function announced(label: string): string | null {
  return screen.getByRole("columnheader", { name: new RegExp(label) }).getAttribute("aria-sort");
}

function mount(rows: readonly ActorRow[] = ROWS, labelled = true) {
  return render(<ActorsTable rows={rows} weeks={8} labelled={labelled} />);
}

afterEach(cleanup);

describe("ActorsTable sorting", () => {
  it("opens on readiness ascending, and says so on the column", () => {
    mount();

    expect(logins()).toEqual(["dan", "carol", "alice", "bob"]);
    expect(announced("Readiness")).toBe("ascending");
    expect(announced("Contributor")).toBe("none");
    expect(announced("Repositories")).toBe("none");
  });

  it("sorts on each column, reaching that column’s own reader", () => {
    mount();

    expect(sortBy("Contributor")).toEqual(["alice", "bob", "carol", "dan"]);
    expect(sortBy("Repositories")).toEqual(["bob", "carol", "alice", "dan"]);
  });

  it("reverses the active column and opens any other one ascending", () => {
    mount();

    expect(sortBy("Contributor")).toEqual(["alice", "bob", "carol", "dan"]);
    expect(sortBy("Contributor")).toEqual(["dan", "carol", "bob", "alice"]);
    expect(announced("Contributor")).toBe("descending");

    expect(sortBy("Repositories")).toEqual(["bob", "carol", "alice", "dan"]);
    expect(announced("Repositories")).toBe("ascending");
    expect(announced("Contributor")).toBe("none");
  });

  // The guardrail: reversing readiness answers "who is worst", and somebody whose repositories all
  // came back unreadable is not the answer to it — they stay at the bottom either way round.
  it("keeps a person with nothing left to label last in both directions", () => {
    mount();

    expect(sortBy("Readiness")).toEqual(["alice", "carol", "dan", "bob"]);
    expect(announced("Readiness")).toBe("descending");
    expect(sortBy("Readiness")).toEqual(["dan", "carol", "alice", "bob"]);
  });

  it("badges a person the service sent no labels key for as cannot assess", () => {
    mount([{ login: "eve", repositories: 2 }]);

    expect(screen.getByText("Cannot assess")).toBeTruthy();
  });

  /**
   * `Contributor` re-sorts through `compare`, which is locale-aware, and every fixture above is lowercase.
   *
   * GitHub logins are frequently capitalised, so the case the estate actually shows is the one no
   * assertion reached: a code-point sort would put every capital ahead of every lower-case login and
   * read as an order about ASCII rather than about spelling. Sorting stays alphabetical in both
   * directions and ranks nobody either way.
   */
  it("sorts mixed-case logins by their letters rather than by their case", () => {
    const mixed: ActorRow[] = [
      { login: "Zoe", repositories: 1, labels: ["green"] },
      { login: "alice", repositories: 1, labels: ["green"] },
      { login: "Bob", repositories: 1, labels: ["green"] }
    ];
    mount(mixed);

    expect(sortBy("Contributor")).toEqual(["alice", "Bob", "Zoe"]);
    expect(sortBy("Contributor")).toEqual(["Zoe", "Bob", "alice"]);
  });

  // The second cause of an empty label list: a readiness policy switched off grades nothing, so
  // every row arrives empty and the estate's own word for that is the one the other lists use.
  it("badges nobody as cannot assess where the policy graded nothing in the window", () => {
    mount([{ login: "eve", repositories: 2, labels: [] }], false);

    expect(screen.getByText("Not assessed")).toBeTruthy();
    expect(screen.queryByText("Cannot assess")).toBeNull();
  });

  it("links every login onto its own page at the span the list is read at", () => {
    mount();

    expect(screen.getByRole("link", { name: "dan" }).getAttribute("href")).toBe("/contributors/dan?weeks=8");
  });

  it("ranks nobody: no click puts a score, a rank or a metric column on the page", () => {
    const { container } = mount();

    for (const label of ["Contributor", "Repositories", "Readiness"]) {
      sortBy(label);
      expect(container.textContent).not.toMatch(/score|rank|verdict|average|%/i);
    }
  });
});

/**
 * The first column once it shows people rather than handles.
 *
 * A MIXED COLUMN IS THE ORDINARY CASE and not an edge one: 325 of the organisation's 778 members have set a
 * profile name, so a real list is roughly two named rows in five. These fixtures are mixed for that reason — a
 * fixture where everybody had a name would assert the easy half and hide the fallback, which is most of the estate.
 */
describe("ActorsTable contributor column", () => {
  const MIXED: ActorRow[] = [
    { login: "parisfreire", name: "Paris Freire", repositories: 3, labels: ["green"] },
    { login: "nameless", repositories: 2, labels: ["green"] }
  ];

  /** One person's cell, found by the login that is on it whichever line leads. */
  function cell(login: string): HTMLElement {
    return screen
      .getAllByRole("row")
      .slice(1)
      .map((row) => within(row).getAllByRole("cell")[0] as HTMLElement)
      .find((entry) => entry.textContent?.includes(login)) as HTMLElement;
  }

  it("leads on the name and keeps the login under it where GitHub holds one", () => {
    mount(MIXED);

    expect(cell("parisfreire").textContent).toBe("Paris Freireparisfreire");
    // The link is the primary line's, so a reader clicking what they can see reaches the same page either way.
    expect(within(cell("parisfreire")).getByRole("link").textContent).toBe("Paris Freire");
    expect(within(cell("parisfreire")).getByRole("link").getAttribute("href")).toBe("/contributors/parisfreire?weeks=8");
  });

  it("shows the login alone where there is no name, rather than an empty line", () => {
    // The shape that put " contributors" on every team card: an element rendered for a value nobody guaranteed.
    mount(MIXED);

    expect(cell("nameless").textContent).toBe("nameless");
    expect(cell("nameless").textContent).not.toContain("undefined");
    expect(cell("nameless").querySelector("p")).toBeNull();
  });

  it("draws the login in mono and the name not, which is what tells them apart", () => {
    // The one signal a mixed column has. Every login and repository name on the site is mono, so a proper-case
    // line in the body face is a name and a mono line is a handle — including on the row that has only the handle.
    mount(MIXED);

    expect(within(cell("parisfreire")).getByRole("link").className).not.toContain("font-mono");
    expect(cell("parisfreire").querySelector("p")?.className).toContain("font-mono");
    expect(within(cell("nameless")).getByRole("link").className).toContain("font-mono");
  });

  it("sorts on the value the column shows, not on the login under it", () => {
    // THE FIXTURE'S TWO ORDERS DISAGREE, which is what makes this able to fail. `aaron` leads `zack` by login and
    // trails it by the name shown on the row, so a column still reading `row.login` puts these the other way round.
    // A header showing names while sorting on logins is a header that lies about the order beneath it.
    mount([
      { login: "aaron", name: "Zoe Zeal", repositories: 1, labels: ["green"] },
      { login: "zack", repositories: 1, labels: ["green"] }
    ]);

    expect(sortBy("Contributor")).toEqual(["zack", "Zoe Zealaaron"]);
  });
});
