/**
 * @vitest-environment jsdom
 */

/**
 * What a click does to the estate table: the sort it holds in state, and the filter it puts in the
 * URL.
 *
 * Neither is reachable through `react-dom/server`, which is why `tables.test.ts` leaves this
 * component out and tests its decidable half as pure functions in `lib/__tests__/rows.test.ts`
 * instead. The join between them — that a header click reaches the right column's reader, and that a
 * chip's × navigates rather than filtering in place — is only visible from a browser.
 *
 * The `weeks` in the URL is asserted on every navigation. A filter that dropped the span would
 * silently re-render the page at the default window, showing a different window's figures under the
 * filter the reader just applied.
 */

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RepositoriesTable } from "@/components/RepositoriesTable";
import { PRODUCTION_TOGGLE_ACTIVE, PRODUCTION_TOGGLE_INACTIVE } from "@/lib/production";
import { INDIVIDUAL_LABEL } from "@/lib/rows";
import type { RepositoryRow } from "@/lib/types";

let replaced: string[] = [];

let parameters = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: (target: string) => void replaced.push(target) }),
  usePathname: () => "/repositories",
  useSearchParams: () => parameters
}));

function url(query: string): void {
  parameters = new URLSearchParams(query);
  window.history.replaceState(null, "", query === "" ? "/repositories" : `/repositories?${query}`);
}

/**
 * Three rows that separate every column: no two share a value on any of them, and `api` carries no
 * figures at all so the unmeasured-sorts-last rule is exercised.
 *
 * THE `pushed_at` VALUES CROSS THE ALPHABETICAL AND THE TEAM ORDER, which is what makes the default-sort case
 * able to fail. Under the old `(team, repository)` rule these read docs, web, api; by last push they read web,
 * docs, api. A fixture where the two agreed would assert the new default while the old one still passed.
 *
 * Each row also states its own assurance outcomes, crossed over between rows so a column wired to the wrong
 * criterion sorts the rows the other way and fails rather than agreeing by coincidence.
 *
 * ALL THREE ARE PUBLIC, deliberately, because the table now opens filtered to public only. A fixture with an
 * internal or private row would silently hide it from every ordering and column assertion here — which is what
 * happened on the first attempt at this change. The visibility filter has its own describe below, with its own
 * rows, so what it does is asserted where the reader can see the intent.
 */
const ROWS: RepositoryRow[] = [
  {
    repository: "web",
    team: "delivery",
    pushed_at: "2026-09-10T00:00:00Z",
    visibility: "public",
    // Still on the row though no longer a COLUMN here: the readiness donut above the table filters on it, and
    // the label moved to /teams rather than being deleted.
    readiness: "red",
    merged_pull_requests: 3,
    direct_commits: 9,
    // A second dimension the donuts filter on, so two parameters in the URL can be seen to AND
    // rather than to overwrite one another: `web` requires no approval and `docs` requires two.
    required_approving_reviews: 0,
    // The only production service here, so the toggle's count is one and the row it leaves is
    // known: `docs` was read and is not one, and `api`'s answer is absent entirely.
    production: true,
    assurance: {
      grade: "partial",
      criteria: [
        { criterion: "named-owner", outcome: "met", detail: "assigned to a team" },
        // Crossed over from `docs`: this one fails hygiene and meets maintenance, and `docs` is the reverse.
        { criterion: "automated-hygiene", outcome: "unmet", detail: "not configured: secret scanning" },
        // An outstanding leaked credential, crossed over from `docs` which has none.
        { criterion: "no-committed-secrets", outcome: "unmet", detail: "2 secret-scanning alerts open, the oldest for 900 days" },
        { criterion: "security-contact", outcome: "met", detail: "a security policy applies, usually the organisation's own rather than this repository's" },
        { criterion: "patching", outcome: "met", detail: "the oldest open critical or high alert is 120 days old" },
        { criterion: "maintained", outcome: "met", detail: "pushed to recently enough to read as maintained" }
      ],
      oldest_severe_alert_days: 120
    }
  },
  {
    repository: "api",
    team: "platform",
    visibility: "public",
    detail: "No merge activity in this window."
  },
  {
    repository: "docs",
    team: "content",
    pushed_at: "2026-08-01T00:00:00Z",
    visibility: "public",
    readiness: "green",
    merged_pull_requests: 8,
    direct_commits: 1,
    required_approving_reviews: 2,
    production: false,
    assurance: {
      grade: "partial",
      criteria: [
        { criterion: "named-owner", outcome: "unmet", detail: "nothing owns it, so nobody is accountable for it" },
        { criterion: "automated-hygiene", outcome: "met", detail: "every hygiene signal is on" },
        { criterion: "no-committed-secrets", outcome: "met", detail: "no secret-scanning alert is open" },
        { criterion: "security-contact", outcome: "met", detail: "a security policy applies, usually the organisation's own rather than this repository's" },
        { criterion: "patching", outcome: "met", detail: "no critical or high alert is open" },
        { criterion: "maintained", outcome: "unmet", detail: "not archived and not pushed to for longer than the policy allows, so it should be archived" }
      ]
    }
  }
];

/** The repository names down the table, in the order the current render puts them. */
function order(): string[] {
  return screen
    .getAllByRole("row")
    .slice(1)
    .map((row) => within(row).getAllByRole("cell")[1]?.textContent ?? "")
    .map((cell) => cell.replace("No merge activity in this window.", ""));
}

/**
 * The column names, left to right, read off each header's `aria-label`.
 *
 * NOT `textContent`, which is no longer the heading: every column carries an `InfoTooltip` whose text sits in the
 * cell twice — once as the trigger's `aria-label` and once in a bubble kept hidden with CSS rather than removed
 * from the DOM. `SortHeader` names the cell explicitly for that reason, and this reads the name it set.
 */
function headerNames(): (string | null)[] {
  return screen.getAllByRole("columnheader").map((cell) => cell.getAttribute("aria-label"));
}

/**
 * One row's cell under a named column, found by the HEADER'S POSITION rather than a hardcoded index.
 *
 * By name because these tests are mostly about which column is wired to which field: a column inserted to the
 * left of one being asserted would otherwise leave the assertion reading its neighbour, and passing. That is not
 * hypothetical here — the table gained six columns and lost eight in one change.
 */
function cellOf(repository: string, label: string): HTMLElement | undefined {
  const headers = headerNames();
  const entry = screen
    .getAllByRole("row")
    .slice(1)
    .find((row) => within(row).getAllByRole("cell")[1]?.textContent?.startsWith(repository));
  return within(entry as HTMLElement).getAllByRole("cell")[headers.indexOf(label)];
}

/** One row's Production cell, kept as its own reader because several cases read only it. */
function productionCell(repository: string): HTMLElement | undefined {
  return cellOf(repository, "Production");
}

/** Every cell in one criterion's column, whatever each of them answers. */
function criterionCells(label: string): (HTMLElement | undefined)[] {
  return ["web", "api", "docs"].map((repository) => cellOf(repository, label));
}

/**
 * A column's header cell, matched on the WHOLE name rather than a substring.
 *
 * Anchored because two headings are now prefixes of others: `Team` of `Code owner`, and `Maintained` would be of
 * anything beginning with it. An unanchored match throws "found multiple elements" — which is at least loud, but
 * a substring that matched exactly one heading by luck would silently assert against the wrong column.
 */
function headerCell(label: string): HTMLElement {
  return screen.getByRole("columnheader", { name: new RegExp(`^${label}$`) });
}

/**
 * A column's SORT control, which is no longer the only button in its header.
 *
 * Each heading now carries an `InfoTooltip` beside it, whose trigger is also a button — named with the hint rather
 * than the column, so the two are told apart by name. An unnamed `getByRole("button")` here would throw on every
 * column that has a hint, which is all of them.
 */
function header(label: string): HTMLElement {
  return within(headerCell(label)).getByRole("button", { name: new RegExp(`^${label}$`) });
}

/** Sort on a column and report the order it left, so a click reads as one line in a test. */
function sortBy(label: string): string[] {
  fireEvent.click(header(label));
  return order();
}

function mount(rows: readonly RepositoryRow[] = ROWS) {
  return render(<RepositoriesTable rows={rows} weeks={12} />);
}

beforeEach(() => {
  replaced = [];
  url("weeks=12");
});

afterEach(cleanup);

describe("RepositoriesTable sorting", () => {
  it("opens on the most recently pushed, and says so on that column", () => {
    // THE DEFAULT THIS REPLACED put these rows docs, web, api — by team, `content` before `delivery` before
    // `platform`. The fixture's instants cross that order, so this case cannot pass under the old rule.
    //
    // `Last pushed` ANNOUNCES ITSELF, from 2026-09-15. The opening order is still `orderRepositories` rather than
    // a click's `sorted` — it tie-breaks equal instants on the name — but leaving every header `none` made the
    // order the table was in unstateable, so a reader had no way to tell it from an arbitrary one.
    mount();

    expect(order()).toEqual(["web", "docs", "api"]);
    expect(announced("Last pushed")).toBe("descending");
    for (const label of ["Team", "Repository", "Assurance"]) {
      expect(announced(label)).toBe("none");
    }
  });

  // Every column at once: each header hands the table its own reader function, and a mis-wired one
  // sorts by the column beside it, which no single-column assertion would catch.
  it("sorts on each column ascending, putting a repository with no answer last", () => {
    mount();

    // By team: content, then delivery, then platform.
    expect(sortBy("Team")).toEqual(["docs", "web", "api"]);
    expect(sortBy("Repository")).toEqual(["api", "docs", "web"]);
    // Oldest push first, and `api` — which has none — last rather than read as the oldest.
    expect(sortBy("Last pushed")).toEqual(["docs", "web", "api"]);
    // Every fixture row is public — see the fixture's own note — so this asserts only that the header is wired
    // and that equal values keep their order. What the column DOES is asserted in the visibility describe below,
    // where the rows differ; a fixture that differed here would be hidden by the public-only default instead.
    expect(sortBy("Visibility")).toEqual(["web", "api", "docs"]);
    // Both rows are `partial`, so this orders them by nothing and only proves the header is wired: what it
    // must NOT do is put `api`, whose grade could not be read, anywhere but last.
    expect(sortBy("Assurance").at(-1)).toBe("api");
    // The four criteria. `web` meets the owner criterion and `docs` does not; hygiene and maintenance are
    // crossed over between them, so a header reading the wrong criterion sorts the pair the other way round.
    expect(sortBy("Code owner")).toEqual(["web", "docs", "api"]);
    expect(sortBy("Hygiene")).toEqual(["docs", "web", "api"]);
    // THE ONE COLUMN THAT SORTS THE OTHER WAY UP, from 2026-09-15: it states what was FOUND, so `web` — which has
    // two open alerts — leads, where every other criterion leads with the repositories that pass. `api`, whose
    // org-wide read never happened, still sorts last: nobody looked is not the same as nothing found.
    expect(sortBy("Secrets")).toEqual(["web", "docs", "api"]);
    // Met for both, which is the point of the column: it reads Yes almost everywhere. What it must still do is
    // hold `api` back, since an unanswered criterion is not a met one.
    expect(sortBy("Security contact").at(-1)).toBe("api");
    // The AGE, ascending. `web` has 120 days; `docs` has nothing severe open and `api` was never collected, and
    // BOTH sort last — the column orders the repositories that have an alert, and "no alert open" is not an
    // answer to "which has the oldest" any more than "nobody looked" is.
    expect(sortBy("Patching cycle")[0]).toBe("web");
    expect(sortBy("Maintained")).toEqual(["web", "docs", "api"]);
    // No below Yes, and `api`, whose list could not be read, last rather than counted as either.
    expect(sortBy("Production")).toEqual(["docs", "web", "api"]);
  });

  it("keeps the unreadable answer last when a criterion column is reversed", () => {
    mount();

    sortBy("Code owner");
    expect(sortBy("Code owner")).toEqual(["docs", "web", "api"]);
    expect(announced("Code owner")).toBe("descending");

    sortBy("Hygiene");
    expect(sortBy("Hygiene")).toEqual(["web", "docs", "api"]);
    expect(announced("Hygiene")).toBe("descending");
  });

  it("reverses the column already sorted, and opens any other one ascending", () => {
    mount();

    expect(sortBy("Code owner")).toEqual(["web", "docs", "api"]);
    expect(announced("Code owner")).toBe("ascending");

    expect(sortBy("Code owner")).toEqual(["docs", "web", "api"]);
    expect(announced("Code owner")).toBe("descending");

    // A different column starts from its own top rather than inheriting the reversal.
    expect(sortBy("Repository")).toEqual(["api", "docs", "web"]);
    expect(announced("Repository")).toBe("ascending");
    expect(announced("Code owner")).toBe("none");
  });

  it("keeps a repository with no last push last in both directions", () => {
    // `api` has no `pushed_at`. It is not the answer to "pushed longest ago" any more than to "pushed most
    // recently", which is what `sorted` holding `undefined` back from both ends buys.
    mount();

    expect(sortBy("Last pushed").at(-1)).toBe("api");
    expect(sortBy("Last pushed").at(-1)).toBe("api");
    expect(announced("Last pushed")).toBe("descending");
  });

  it("sorts without navigating: how one reader is looking at the list is not in the URL", () => {
    mount();

    sortBy("Code owner");

    expect(replaced).toEqual([]);
  });
});

describe("RepositoriesTable columns", () => {
  it("heads the identity columns, then one per criterion, then the grade they build to", () => {
    // EIGHT COLUMNS WENT and five of them rendered a dash for the whole estate before they did — Open, Stale,
    // Sonar, Findings and CODEOWNERS all read fields the report layer never emitted. Readiness went for a
    // different reason: it grades readiness for AI enablement, which is a different question from these
    // criteria, and it moved to `/teams` rather than being deleted.
    //
    // ASSURANCE READS LAST, from 2026-09-15, where it used to sit between the identity columns and its own
    // evidence. It is the conclusion the criterion columns reach, so a reader meets the evidence and then the
    // verdict rather than being given the verdict and asked to scan rightwards for why.
    mount();

    expect(headerNames()).toEqual([
      "Team",
      "Repository",
      "Last pushed",
      "Visibility",
      "Code owner",
      "Hygiene",
      "Secrets",
      "Security contact",
      "Patching cycle",
      "Maintained",
      "Production",
      "Assurance"
    ]);
  });

  it("prints Yes, No and a dash, never a zero for a criterion that was not read", () => {
    mount();

    expect(cellOf("web", "Code owner")?.textContent).toBe("Yes");
    expect(cellOf("docs", "Code owner")?.textContent).toBe("No");
    // `api` carries no assurance block at all, which is a repository nothing has been collected for.
    expect(cellOf("api", "Code owner")?.textContent).toBe("-");
  });

  /**
   * The one column that answers the opposite way round, and the case that stops it being "simplified" back.
   *
   * Every other criterion prints Yes when the repository PASSES. `Secrets` prints Yes when secrets were FOUND,
   * because a column headed with the name of the bad thing answering Yes for a clean repository read backwards.
   * The colours invert with the word — a green Yes here would sit over an open credential leak — and the criterion
   * underneath is untouched, which the grade assertion at the end is here to hold.
   */
  it("answers Secrets as what was FOUND, in the colours of a finding rather than a pass", () => {
    mount();

    // `web` has two open alerts; `docs` has none. Yes is the one with the problem.
    expect(cellOf("web", "Secrets")?.textContent).toBe("Yes");
    expect(cellOf("docs", "Secrets")?.textContent).toBe("No");
    // Nobody read the org-wide alerts for `api`, which is not the same as finding none.
    expect(cellOf("api", "Secrets")?.textContent).toBe("-");

    expect(cellOf("web", "Secrets")?.outerHTML).toContain("text-rag-amber");
    expect(cellOf("docs", "Secrets")?.outerHTML).toContain("text-rag-green");

    // The inversion is the CELL's and not the criterion's: `web` still fails the criterion, so its grade is not
    // improved by the column now reading Yes.
    expect(cellOf("web", "Assurance")?.textContent).toBe("Partly meets");
  });

  it("prints the alert AGE with no threshold and no colour", () => {
    // "Measurement first": no SLA has been agreed, so the number is the finding and the reader is the judge.
    // A tone here would publish a policy nobody chose — which is why this asserts the ABSENCE of one.
    mount();

    expect(cellOf("web", "Patching cycle")?.textContent).toBe("120d");
    // Nothing severe open reads as a dash rather than as `0d`, which would claim an alert was raised today.
    expect(cellOf("docs", "Patching cycle")?.textContent).toBe("-");
    expect(cellOf("web", "Patching cycle")?.outerHTML).not.toMatch(/emerald|amber|rose|rag-/);
  });

  it("prints the last push as a day and the visibility as a word", () => {
    mount();

    expect(cellOf("web", "Last pushed")?.textContent).toBe("2026-09-10");
    expect(cellOf("api", "Last pushed")?.textContent).toBe("-");
    expect(cellOf("api", "Visibility")?.textContent).toBe("public");
  });

  it("grades the assurance column in its own words, never in readiness's", () => {
    // A repository can be ready to enable agentic tooling on and still fail these criteria, so "Ready" and
    // "Blocked" here would say something false about it.
    mount();

    expect(cellOf("web", "Assurance")?.textContent).toBe("Partly meets");
    expect(cellOf("api", "Assurance")?.textContent).toBe("Cannot assess");
    for (const repository of ["web", "docs", "api"]) {
      expect(cellOf(repository, "Assurance")?.textContent).not.toMatch(/Ready|Blocked|Caution/);
    }
  });

  /**
   * THE CASE THAT WAS INVISIBLE, and the reason the grade gained a fourth value.
   *
   * `GET /orgs/{org}/secret-scanning/alerts` is one call for the whole estate, so when it fails every row loses
   * the secrets criterion at once. The cell already read as a dash — and the grade beside it still said "Meets
   * criteria", on three criteria instead of four, with nothing on the page saying the claim had shrunk.
   */
  it("distinguishes a repository read in full from one that met only what could be read", () => {
    const criteria = (secrets: "met" | "unknown"): RepositoryRow["assurance"] => ({
      grade: secrets === "met" ? "met" : "partly-read",
      criteria: [
        { criterion: "named-owner", outcome: "met", detail: "assigned to a team" },
        { criterion: "automated-hygiene", outcome: "met", detail: "every hygiene signal is on" },
        secrets === "met"
          ? { criterion: "no-committed-secrets", outcome: "met", detail: "no secret-scanning alert is open" }
          : { criterion: "no-committed-secrets", outcome: "unknown", detail: "the secret-scanning alerts could not be read" },
        { criterion: "security-contact", outcome: "met", detail: "a security policy applies, usually the organisation's own rather than this repository's" },
        { criterion: "patching", outcome: "met", detail: "no critical or high alert is open" },
        { criterion: "maintained", outcome: "met", detail: "pushed to recently enough to read as maintained" }
      ]
    });
    mount([
      { repository: "read", team: "delivery", visibility: "public", pushed_at: "2026-09-10T00:00:00Z", assurance: criteria("met") },
      { repository: "unread", team: "delivery", visibility: "public", pushed_at: "2026-09-09T00:00:00Z", assurance: criteria("unknown") }
    ]);

    expect(cellOf("read", "Assurance")?.textContent).toBe("Meets criteria");
    expect(cellOf("unread", "Assurance")?.textContent).toBe("Meets what was read");
    // Both rows print a dash for the criterion, which is why the GRADE is the only place the shrunken claim can
    // show. The unread one is drawn slate rather than green: a half-read question is not coloured warm.
    expect(cellOf("unread", "Secrets")?.textContent).toBe("-");
    expect(cellOf("unread", "Assurance")?.outerHTML).toContain("slate");
    expect(cellOf("unread", "Assurance")?.outerHTML).not.toContain("green");
  });

  // Header and cell together: a centred column whose header still read from the left, or the other
  // way round, would put the title off the answers under it.
  it("centres every outcome column under a centred header", () => {
    mount();

    for (const label of ["Code owner", "Hygiene", "Secrets", "Security contact", "Maintained"]) {
      for (const cell of criterionCells(label)) {
        expect(cell?.className).toContain("text-center");
      }
      expect(headerCell(label).className).toContain("text-center");
    }
    // The age is a figure and reads down a right edge instead.
    expect(cellOf("web", "Patching cycle")?.className).toContain("text-right");
  });

  it("tones the criteria, which ARE the grade on this page", () => {
    // THE REVERSAL from the old table, whose every cell was deliberately untoned because none of them was a
    // grade. These are the grade, so a met criterion reads green and an unmet one amber — and the WORD carries
    // the information, so the colour is support rather than the answer.
    mount();

    expect(cellOf("web", "Code owner")?.outerHTML).toContain("text-rag-green");
    expect(cellOf("docs", "Code owner")?.outerHTML).toContain("text-rag-amber");
    // An unreadable criterion stays slate: a missing permission is not a bad result.
    expect(cellOf("api", "Code owner")?.outerHTML).toContain("text-slate-500");
  });

  // Read off the whole cell rather than its own class list: the readiness cell three columns to the
  // left is toned by a span INSIDE an uncoloured `<td>`, so a governance answer coloured the same way
  // would slip past an assertion that only looked at the cell element.
  it("tones neither identity column, which state facts rather than grades", () => {
    // The old table's rule, kept where it still holds. Every cell there was untoned because none was a grade;
    // now four of them ARE the grade — see the case above — and these two are not. When a repository was last
    // pushed to and whether it is public are facts about the estate's shape, neither better nor worse, which is
    // the same argument `production.ts` makes for its own attribute.
    mount();

    for (const label of ["Last pushed", "Visibility"]) {
      for (const repository of ["web", "api", "docs"]) {
        expect(cellOf(repository, label)?.outerHTML).not.toMatch(/emerald|amber|rose|rag-/);
      }
    }
  });
});

describe("RepositoriesTable production column", () => {
  it("answers Yes, No or a dash, as every other governance column on the row does", () => {
    mount();

    expect(productionCell("web")?.textContent).toBe("Yes");
    // Read the list and it does not name this one: that is an answer, and No says it.
    expect(productionCell("docs")?.textContent).toBe("No");
    // The list could not be read at all, which is not the same claim and must not read as No.
    expect(productionCell("api")?.textContent).toBe("-");
  });

  it("holds an unread answer back from both ends of its own sort", () => {
    mount();

    sortBy("Production");
    expect(sortBy("Production")).toEqual(["web", "docs", "api"]);
    expect(announced("Production")).toBe("descending");
  });

  it("grades nothing in the column: production is an attribute, not a verdict", () => {
    mount();

    for (const repository of ["web", "docs", "api"]) {
      expect(productionCell(repository)?.outerHTML).not.toMatch(/emerald|amber|rose|rag-/);
    }
  });
});

/**
 * The Team cell, which is where an individually-owned repository is now marked.
 *
 * Its own fixture rather than a fourth row in `ROWS`, so the ordering and filtering assertions above keep
 * counting three rows: what is under test here is one cell's contents, not the table's arrangement.
 */
describe("RepositoriesTable owner cell", () => {
  const OWNERS: RepositoryRow[] = [
    { repository: "ours", team: "civil-admins", owner_kind: "team" },
    { repository: "theirs", team: "a1i-hussain", owner_kind: "person" },
    { repository: "orphan", team: "unowned", owner_kind: "none" }
  ];

  /** One row's Team cell, found under its header for `productionCell`'s reason. */
  function ownerCell(repository: string): HTMLElement | undefined {
    return cellOf(repository, "Team");
  }

  it("links a team's name and marks it as nothing", () => {
    mount(OWNERS);

    expect(
      within(ownerCell("ours") as HTMLElement)
        .getByRole("link")
        .getAttribute("href")
    ).toBe("/teams/civil-admins?weeks=12");
    expect(ownerCell("ours")?.textContent).toBe("civil-admins");
  });

  it("marks one person and links nothing, there being no team page for them", () => {
    // THE LINK THIS CHANGE HAD TO NOT LEAVE BEHIND. `/teams` lists teams only, so `/teams/a1i-hussain` is the
    // not-found page — and 206 repositories of this estate are owned by one person.
    mount(OWNERS);

    const cell = ownerCell("theirs") as HTMLElement;
    expect(within(cell).queryByRole("link")).toBeNull();
    expect(cell.textContent).toBe(`a1i-hussain${INDIVIDUAL_LABEL}`);
  });

  it("keeps the unowned bucket linked, which is a card and not a person", () => {
    mount(OWNERS);

    expect(
      within(ownerCell("orphan") as HTMLElement)
        .getByRole("link")
        .getAttribute("href")
    ).toBe("/teams/unowned?weeks=12");
    expect(ownerCell("orphan")?.textContent).toBe("unowned");
  });

  it("links a row carrying no kind, so a row served without the field is not stranded", () => {
    mount();

    expect(
      within(ownerCell("api") as HTMLElement)
        .getByRole("link")
        .getAttribute("href")
    ).toBe("/teams/platform?weeks=12");
  });

  it("still finds a person’s repository by their name in the term, marker or no marker", () => {
    // The marker changes what the cell renders and must not change what the term searches: a reader typing a
    // login is asking which repositories that person is on the hook for.
    url("weeks=12&repository=hussain");
    mount(OWNERS);

    expect(order()).toEqual(["theirs"]);
  });
});

/**
 * The term box, and what the bar holds now that the donut chips have gone.
 *
 * The chip cases that used to live here went with `ESTATE_FILTERS` on 2026-09-14: the donuts were the only way to
 * create one of those filters, so a chip a reader could dismiss but never apply was a half-wired control. What is
 * left is the term and the four toggles, each of which has its own affordance.
 */
describe("RepositoriesTable filtering", () => {
  it("shows no chip at all, there being no dimension left to chip", () => {
    mount();

    expect(chips()).toEqual([]);
    expect(order()).toEqual(["web", "docs", "api"]);
  });

  it("ignores a stale donut parameter rather than filtering on it", () => {
    // LINKS SHARED BEFORE THIS CHANGE still carry `?label=green&review=multiple`. They must show the whole table
    // rather than an empty one: the dimension no longer exists, so the honest reading of the parameter is that it
    // means nothing, not that it matches nothing.
    url("weeks=12&label=green&review=multiple");
    mount();

    expect(chips()).toEqual([]);
    expect(order()).toEqual(["web", "docs", "api"]);
  });

  it("applies the term in the URL to both the repository name and its team", () => {
    url("weeks=12&repository=PLAT");
    mount();

    expect(order()).toEqual(["api"]);
  });

  it("says a filter matched nothing rather than drawing an empty table", () => {
    url("weeks=12&repository=nothing-here");
    mount();

    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByText(/No repository matches this filter/)).toBeTruthy();
  });

  it("names the controls an empty table can be cleared of, and no longer a chip", () => {
    url("weeks=12&repository=nothing-here");
    mount();

    expect(screen.getByText(/Clear the term, the Production toggle, or a visibility/)).toBeTruthy();
  });
});

describe("RepositoriesTable production toggle", () => {
  it("is the first thing in the bar, ahead of the visibility toggles", () => {
    mount();

    expect(bar().children[0]).toBe(toggle());
    // No chips at all: the donut dimensions they reported went with the charts.
    expect(chips()).toEqual([]);
  });

  it("carries the count of the production repositories a reader could turn it on for", () => {
    mount();

    expect(toggle().textContent).toBe("Production1");
    expect(within(toggle()).getByText("1").className).toContain("tabular-nums");
  });

  it("counts within the term and the other dimensions, but not within itself", () => {
    url("weeks=12&repository=docs");
    mount();

    // `docs` is the one row the term leaves and it is not a production service, so the toggle
    // offers nothing — and says so rather than printing the estate's total.
    expect(toggle().textContent).toBe("Production0");
  });

  it("reads the same count while it is on, which is what excluding its own filter buys", () => {
    url("weeks=12&production=true");
    mount();

    expect(toggle().textContent).toBe("Production1");
  });

  it("is greyed and unpressed while off, and royal and pressed while on", () => {
    mount();

    expect(toggle().getAttribute("aria-pressed")).toBe("false");
    for (const name of PRODUCTION_TOGGLE_INACTIVE.split(" ")) {
      expect(toggle().className).toContain(name);
    }

    cleanup();
    url("weeks=12&production=true");
    mount();

    expect(toggle().getAttribute("aria-pressed")).toBe("true");
    for (const name of PRODUCTION_TOGGLE_ACTIVE.split(" ")) {
      expect(toggle().className).toContain(name);
    }
  });

  it("has no way to remove it: it is a control, not a chip", () => {
    url("weeks=12&production=true");
    mount();

    expect(screen.queryByRole("button", { name: /Remove Production/ })).toBeNull();
    // The chips' × is an `svg` inside the chip. The toggle holds a dot and two words and no icon,
    // so there is nothing on it a reader could read as a dismissal.
    expect(toggle().innerHTML).not.toContain("<svg");
    // The toggle FIRST, then the three visibility toggles and no chip. Every one of the four is a control the
    // reader turns on and off rather than something they added to the bar, so none carries a ×.
    expect(within(bar()).getAllByRole("button")[0]).toBe(toggle());
    expect(within(bar()).getAllByRole("button")).toHaveLength(4);
    for (const button of within(bar()).getAllByRole("button")) {
      expect(button.innerHTML).not.toContain("<svg");
    }
  });

  it("holds only the production repositories while it is on", () => {
    url("weeks=12&production=true");
    mount();

    expect(order()).toEqual(["web"]);
  });

  it("writes its parameter on the click, keeping the span, the term and an active chip", () => {
    url("weeks=26&repository=e&label=red");
    mount();

    fireEvent.click(toggle());

    expect(replaced).toEqual(["/repositories?weeks=26&repository=e&label=red&production=true"]);
  });

  it("clears the parameter on the second click, dropping it rather than emptying it", () => {
    url("weeks=26&repository=e&label=red&production=true");
    mount();

    fireEvent.click(toggle());

    expect(replaced).toEqual(["/repositories?weeks=26&repository=e&label=red"]);
  });
});

/**
 * The visibility toggles, which have their OWN rows because the table opens filtered to public only.
 *
 * A fixture mixing visibilities into `ROWS` would be hidden from every other assertion in this file by that
 * default — which happened on the first attempt at this change — so what the filter does is asserted here, where
 * a reader can see that the rows differ on purpose.
 */
describe("RepositoriesTable visibility toggles", () => {
  const MIXED: RepositoryRow[] = [
    { repository: "open", team: "platform", visibility: "public", pushed_at: "2026-09-03T00:00:00Z" },
    { repository: "inner", team: "platform", visibility: "internal", pushed_at: "2026-09-02T00:00:00Z" },
    { repository: "closed", team: "platform", visibility: "private", pushed_at: "2026-09-01T00:00:00Z" }
  ];

  /** One visibility's toggle, found by the word on it as a reader would. */
  function visibilityToggle(visibility: string): HTMLElement {
    return within(bar()).getByRole("button", { name: new RegExp(`^${visibility}`) });
  }

  it("shows public only when the URL says nothing", () => {
    // THE DEFAULT, and a deliberate narrowing: the page asks whether repositories meet the criteria for coding
    // IN THE OPEN, and a private repository is outside that question rather than failing it.
    mount(MIXED);

    expect(order()).toEqual(["open"]);
  });

  it("offers all three visibilities, each with the estate's count for it", () => {
    // Three because INTERNAL is real and is the estate's second largest — 441 repositories on AAT — so a
    // two-way control could not name them. The counts are of the whole estate rather than the filtered rows, so
    // they say what turning each on would bring in.
    mount(MIXED);

    expect(["public", "internal", "private"].map((visibility) => visibilityToggle(visibility).textContent)).toEqual(["public1", "internal1", "private1"]);
  });

  it("marks only the visibilities showing as pressed", () => {
    mount(MIXED);

    expect(visibilityToggle("public").getAttribute("aria-pressed")).toBe("true");
    expect(visibilityToggle("internal").getAttribute("aria-pressed")).toBe("false");
  });

  it("adds one visibility without dropping another, which is what independent means", () => {
    // The combination a single tri-state could not express, and the one somebody reviewing what HMCTS publishes
    // actually wants: public and internal, not private.
    url("weeks=12&public=true&internal=true");
    mount(MIXED);

    expect(order()).toEqual(["open", "inner"]);
  });

  it("writes the parameter explicitly on both clicks, keeping the span and the term", () => {
    // EXPLICIT IN BOTH DIRECTIONS, unlike the production toggle. Absence has to keep meaning "the reader has
    // said nothing" so it can fall back to public-only; were off expressed as absence, turning public off would
    // produce the same URL as never having touched it.
    url("weeks=26&repository=e");
    mount(MIXED);

    fireEvent.click(visibilityToggle("internal"));
    expect(replaced).toEqual(["/repositories?weeks=26&repository=e&internal=true"]);
  });

  it("turns the default itself off rather than being unable to", () => {
    url("weeks=12&public=true");
    mount(MIXED);

    fireEvent.click(visibilityToggle("public"));

    expect(replaced).toEqual(["/repositories?weeks=12&public=false"]);
  });

  it("says nothing matches when every visibility is off, rather than showing the estate", () => {
    // Three clicks are three clicks: falling back to the default here would ignore them.
    url("weeks=12&public=false&internal=false&private=false");
    mount(MIXED);

    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByText(/No repository matches this filter/)).toBeTruthy();
  });

  it("keeps a row whose visibility the service did not send", () => {
    // The field only exists from 2026-09-14, so absence must mean "this predates it" and never "exclude it" —
    // otherwise a deployment pointed at an older collection would render an empty table.
    mount([{ repository: "old", team: "platform" }]);

    expect(order()).toEqual(["old"]);
  });
});

/** The filter bar, which is always drawn: it holds the Production toggle whether or not a chip is. */
function bar(): HTMLElement {
  return screen.getByRole("group", { name: "Repository filters" });
}

/**
 * What each chip reads, in the order the bar puts them.
 *
 * PAST THE FOUR TOGGLES rather than only the first, from 2026-09-14. The bar holds the Production toggle and the
 * three visibility ones ahead of any chip, and each is a `<button>` where a chip is a `<span>` — so the chips are
 * the non-button children rather than a fixed offset, which cannot drift as controls are added.
 */
function chips(): string[] {
  return Array.from(bar().children)
    .filter((child) => child.tagName !== "BUTTON")
    .map((chip) => chip.textContent ?? "");
}

/** The Production toggle, found the way a reader does: by the word on it. */
function toggle(): HTMLElement {
  return within(bar()).getByRole("button", { name: /Production/ });
}

/** What a screen reader is told about a column's sort — the property of the `<th>`, not the button. */
function announced(label: string): string | null {
  return headerCell(label).getAttribute("aria-sort");
}
