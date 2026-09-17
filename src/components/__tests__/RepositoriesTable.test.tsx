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
 * toggle rewrites the query rather than filtering in place — is only visible from a browser.
 *
 * EVERY CONTROL WRITES THE URL AND NONE OF THEM NAVIGATES, and both halves are asserted: `written()` is
 * the query the click left in `window.location`, and `replaced` must stay empty. The router is stubbed
 * for the second of those alone — nothing in this component calls it any more, and a `router.replace`
 * put back would refetch the whole estate for state the browser is already holding. `replaced` is what
 * would notice.
 *
 * The `weeks` in the URL is asserted on every write. A control that dropped the span would silently
 * re-render the page at the default window, showing a different window's figures under the filter the
 * reader just applied.
 */

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RepositoriesTable } from "@/components/RepositoriesTable";
import { PRODUCTION_SOURCE_HINT, PRODUCTION_TOGGLE_ACTIVE, PRODUCTION_TOGGLE_INACTIVE } from "@/lib/production";
import { EXPAND_LABEL, INDIVIDUAL_LABEL } from "@/lib/rows";
import type { RepositoryRow } from "@/lib/types";
import { UNCOLLECTED_DETAIL } from "@/lib/types";

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
 * Where the controls have left the browser, which is where their state now lives.
 *
 * Read off `window.location` rather than off a spy, so what is asserted is the address a reader would be
 * able to copy — the same string the old `router.replace` assertions named, arrived at without a request.
 */
function written(): string {
  return `${window.location.pathname}${window.location.search}`;
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
    // Answered by the organisation's own document, where `docs` below is answered by a hand-marked column: the
    // two sources are crossed over the two answers, so a cell reading the wrong one cannot pass by coincidence.
    production_source: "approvals-list",
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
  // The row nothing was collected for, carrying the one `detail` this table prints — see `uncollectedDetail`.
  {
    repository: "api",
    team: "platform",
    visibility: "public",
    detail: UNCOLLECTED_DETAIL
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
    // Forced off by hand, which is the only layer that can say no — see `reportedProduction`.
    production_source: "marked",
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
    .map((cell) => cell.replace(UNCOLLECTED_DETAIL, ""));
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

  it("says which of the three sources answered, on the cell rather than in a column of its own", () => {
    // The column means three things now — the organisation's approvals list, this service's own list, and a
    // marked column — so "Yes" alone leaves a reader unable to tell an approved service from a hand-listed one.
    mount();

    expect(productionCell("web")?.getAttribute("title")).toBe(PRODUCTION_SOURCE_HINT["approvals-list"]);
    expect(productionCell("docs")?.getAttribute("title")).toBe(PRODUCTION_SOURCE_HINT.marked);
  });

  it("hovers nothing on a row whose answer no source gave", () => {
    // `api` carries neither field. An empty bubble over a dash would offer a provenance for an answer nobody gave.
    mount();

    expect(productionCell("api")?.hasAttribute("title")).toBe(false);
  });

  it("heads the column with all three sources and no CNP qualifier", () => {
    // The hint used to name the approvals list alone and end "Only applicable to CNP repositories", which the
    // second list makes false: most of what it adds was never onboarded to CNP at all.
    mount();

    // Read off the tooltip's trigger, which is where `SortHeader` puts the hint: the `<th>` is named with the
    // label alone so a screen reader does not recite two sentences of prose under every cell.
    const tooltip = within(headerCell("Production")).getByRole("button", { name: /production-approvals/ });
    const hint = tooltip.getAttribute("aria-label") ?? "";

    expect(hint).not.toMatch(/CNP/);
    for (const phrase of ["production-approvals list", "own production list", "marked by hand"]) {
      expect(hint).toContain(phrase);
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

  /**
   * A table handed no span links bare, to the team and to the repository both.
   *
   * `/repositories` renders it that way from 2026-09-17. `proxy` writes any span a URL names into the `weeks`
   * cookie, so a link carrying that page's pinned default would reset a reader who had chosen 26 weeks on the teams
   * pages — silently, on a click about a repository. The team page still passes its own span, which the case above
   * covers, so both directions are held.
   */
  it("links to a team and a repository without a span where it was handed none", () => {
    render(<RepositoriesTable rows={OWNERS} />);

    expect(
      within(ownerCell("ours") as HTMLElement)
        .getByRole("link")
        .getAttribute("href")
    ).toBe("/teams/civil-admins");
    expect(screen.getByRole("link", { name: "ours" }).getAttribute("href")).toBe("/repositories/ours");
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
/**
 * The reason under a repository's name, which is one of the two kinds `detail` carries.
 *
 * This table draws control state and no merge column, so a reason about merged pull requests or the merge gate
 * explained an absence the reader could not see — and it appeared on the 870 repositories whose private-and-internal
 * walk the App installation does not cover (VIBE-590), reading as a fault in each of them. The repository and team
 * pages, which do draw the merge figures, still render `detail` whole.
 */
describe("RepositoriesTable row detail", () => {
  const MERGE_REASON = "no merge history was read for this repository, so its merges are unmeasured rather than none";

  it("prints the reason that explains the columns it draws", () => {
    mount([{ repository: "ghost", team: "platform", detail: UNCOLLECTED_DETAIL }]);

    expect(screen.getByText(UNCOLLECTED_DETAIL)).toBeTruthy();
  });

  it("prints nothing where the only reason is about merges it has no column for", () => {
    mount([{ repository: "walled", team: "platform", detail: MERGE_REASON }]);

    expect(screen.queryByText(MERGE_REASON)).toBeNull();
    // The row itself stays, and its name with it: dropping the row would make the list read as the whole estate.
    expect(screen.getByRole("link", { name: "walled" })).toBeTruthy();
  });

  it("prints nothing at all for a row that gave no reason", () => {
    mount([{ repository: "api", team: "platform" }]);

    expect(screen.queryByText(UNCOLLECTED_DETAIL)).toBeNull();
  });
});

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
    // NAMES THE × RATHER THAN ANY ICON, which is what this asserted until 2026-09-15. It read
    // `not.toContain("<svg")` — a proxy for "no icon at all" that held only while the toggles carried none, and
    // it broke the moment a tick was added to say a toggle is on. The claim being made is about a DISMISSAL
    // affordance, so it is now made about the dismissal glyph: lucide renders each icon with its own
    // `lucide-<name>` class, so a × arriving on any of the four fails here while the tick does not.
    // The toggle FIRST, then the three visibility toggles and no chip. Every one of the four is a control the
    // reader turns on and off rather than something they added to the bar, so none carries a ×.
    expect(within(bar()).getAllByRole("button")[0]).toBe(toggle());
    expect(within(bar()).getAllByRole("button")).toHaveLength(4);
    for (const button of within(bar()).getAllByRole("button")) {
      expect(button.innerHTML).not.toContain("lucide-x");
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

    expect(written()).toBe("/repositories?weeks=26&repository=e&label=red&production=true");
  });

  it("clears the parameter on the second click, dropping it rather than emptying it", () => {
    url("weeks=26&repository=e&label=red&production=true");
    mount();

    fireEvent.click(toggle());

    expect(written()).toBe("/repositories?weeks=26&repository=e&label=red");
  });

  it("filters in the browser rather than asking the server for rows it already has", () => {
    // THE DEFECT THIS REPLACED. `/repositories` is `force-dynamic`, so every `router.replace` re-ran the page and
    // refetched the estate — for a filter `filterRepositories` applies to the rows already in props.
    url("weeks=26");
    mount();

    fireEvent.click(toggle());

    expect(replaced).toEqual([]);
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

  /**
   * A TICK AS WELL AS `aria-pressed`, so the on state is not carried by fill colour alone.
   *
   * Both toggle families said "on" by changing their background and nothing else, which is the rule this codebase
   * keeps everywhere it grades something: colour is never the sole carrier of meaning. A reader who cannot
   * separate two dark fills could not tell which of the four controls was filtering the table.
   *
   * The two channels are asserted together and separately: the attribute is what assistive technology reads, the
   * tick is what a sighted reader sees, and the tick is `aria-hidden` precisely so the state is not announced
   * twice. Dropping either one is a regression for somebody.
   */
  it("ticks the visibilities that are on, so the state is not colour alone", () => {
    mount(MIXED);

    expect(visibilityToggle("public").querySelector("svg")).not.toBeNull();
    expect(visibilityToggle("internal").querySelector("svg")).toBeNull();
    expect(visibilityToggle("private").querySelector("svg")).toBeNull();

    // Hidden from the accessibility tree, because `aria-pressed` already says it.
    expect(visibilityToggle("public").querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("ticks the Production toggle on the same rule", () => {
    url("weeks=12&production=true");
    mount(MIXED);

    expect(toggle().querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");

    cleanup();
    url("weeks=12");
    mount(MIXED);

    expect(toggle().querySelector("svg")).toBeNull();
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
    expect(written()).toBe("/repositories?weeks=26&repository=e&internal=true");
  });

  it("turns the default itself off rather than being unable to", () => {
    url("weeks=12&public=true");
    mount(MIXED);

    fireEvent.click(visibilityToggle("public"));

    expect(written()).toBe("/repositories?weeks=12&public=false");
  });

  it("keeps each toggle's parameter as the next one is written, having read the live query", () => {
    // THE CASE THAT ONLY EXISTS NOW THE CONTROLS DO NOT NAVIGATE. `useSearchParams` catches up a transition
    // later, so a second click reading the hook would write over what the first one left. `filterTarget` is
    // handed `window.location.search` for exactly this, and three clicks in a row is what proves it.
    url("weeks=12");
    mount(MIXED);

    fireEvent.click(visibilityToggle("internal"));
    fireEvent.click(visibilityToggle("private"));
    fireEvent.click(toggle());

    expect(written()).toBe("/repositories?weeks=12&internal=true&private=true&production=true");
    expect(replaced).toEqual([]);
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

/**
 * WHERE A CONTROL HANDED TO THE TABLE IS DRAWN, which nothing pinned before — and is how the export came to sit
 * up in the section heading, a component away from the filters whose state it reflects, without a test noticing.
 *
 * The position is the assertion, not the presence: it belongs at the end of the filter row because that is the
 * state it exports, and it belongs OUTSIDE the `Repository filters` group so what a screen reader hears announced
 * as the filters is still four toggles and nothing else.
 */
describe("RepositoriesTable action slot", () => {
  function mountWithAction() {
    return render(<RepositoriesTable rows={ROWS} weeks={12} action={<button type="button">Export CSV</button>} />);
  }

  it("draws the action in the filter row, after the toggles", () => {
    mountWithAction();
    const filters = screen.getByRole("group", { name: "Repository filters" });
    const action = screen.getByRole("button", { name: "Export CSV" });

    // ONE LEVEL DOWN FROM THE FILTERS, from the expand toggle: the two controls that are about the COLUMNS rather
    // than about which rows are shown are clustered at the end of the row, so the toggle sits beside the button
    // whose file it changes. Still the same row as the filters, which is what this case exists to hold.
    expect(filters.parentElement).toBe(action.parentElement?.parentElement);
    // `compareDocumentPosition` rather than an index, so this states "after the toggles" and not "in slot two".
    expect(filters.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("keeps the action out of the filters group, so the group is still the toggles alone", () => {
    mountWithAction();
    const filters = screen.getByRole("group", { name: "Repository filters" });

    expect(within(filters).queryByRole("button", { name: "Export CSV" })).toBeNull();
    // Production plus the three visibilities, and nothing else with a pressed state.
    expect(within(filters).getAllByRole("button")).toHaveLength(4);
  });

  it("renders no action where none is given, which is how a team's page gets no estate export", () => {
    mount();

    expect(screen.queryByRole("button", { name: "Export CSV" })).toBeNull();
    expect(within(screen.getByRole("group", { name: "Repository filters" })).getAllByRole("button")).toHaveLength(4);
  });
});

/**
 * The expand toggle, and the four columns it breaks the Hygiene aggregate into.
 *
 * ITS OWN ROWS, on the visibility toggles' precedent: these carry the hygiene SIGNALS, which no other case in this
 * file asserts and which would otherwise have to be spread across `ROWS` where every ordering assertion counts.
 *
 * The state is in the URL rather than in the component, so a click is asserted as a NAVIGATION and what the columns
 * do is asserted by mounting at each URL. That is the same shape as the four filter toggles and deliberately not the
 * shape of the sort: expanding changes what the table reports, and `RepositoriesExport` can only see the query
 * string.
 */
describe("RepositoriesTable hygiene expansion", () => {
  /**
   * Three rows that separate all three answers and both halves of the update requirement.
   *
   * `scanned` has scanning on, push protection off, alerts UNDISCLOSED and the two update signals disagreeing —
   * so the folded column has to read Yes off the Renovate half alone. `bare` was collected and disclosed neither
   * update signal, and `nothing` carries no assurance block at all.
   */
  const SIGNALLED: RepositoryRow[] = [
    {
      repository: "scanned",
      team: "platform",
      visibility: "public",
      pushed_at: "2026-09-10T00:00:00Z",
      assurance: {
        grade: "partial",
        criteria: [{ criterion: "automated-hygiene", outcome: "unmet", detail: "not configured: push protection" }],
        hygiene: { secret_scanning: true, push_protection: false, dependabot_security_updates: false, update_configuration: true }
      }
    },
    {
      repository: "bare",
      team: "platform",
      visibility: "public",
      pushed_at: "2026-09-09T00:00:00Z",
      assurance: { grade: "unknown", criteria: [], hygiene: { secret_scanning: false } }
    },
    { repository: "nothing", team: "platform", visibility: "public", pushed_at: "2026-09-08T00:00:00Z" }
  ];

  const CHECKS = ["Secret scanning", "Push protection", "Vulnerability alerts", "Dependency updates"];

  /** The expand toggle, found the way a reader does: by the word on it. */
  function expander(): HTMLElement {
    return screen.getByRole("button", { name: EXPAND_LABEL });
  }

  it("should draw no check when the URL says nothing, the aggregate being the default", () => {
    mount(SIGNALLED);

    for (const label of CHECKS) {
      expect(headerNames()).not.toContain(label);
    }
    expect(expander().getAttribute("aria-pressed")).toBe("false");
  });

  it("should draw the four checks between the aggregate and Secrets when the URL says expanded", () => {
    // BETWEEN, not appended: the checks are the parts of the column beside them, and a reader scanning rightwards
    // has to meet the verdict and then its evidence.
    url("weeks=12&hygiene=true");
    mount(SIGNALLED);

    expect(headerNames().slice(headerNames().indexOf("Hygiene"), headerNames().indexOf("Secrets") + 1)).toEqual(["Hygiene", ...CHECKS, "Secrets"]);
    expect(expander().getAttribute("aria-pressed")).toBe("true");
  });

  it("should hide the checks again when the parameter is dropped", () => {
    url("weeks=12&hygiene=true");
    mount(SIGNALLED);
    expect(headerNames()).toContain("Push protection");

    cleanup();
    url("weeks=12");
    mount(SIGNALLED);

    expect(headerNames()).not.toContain("Push protection");
    // The aggregate never goes anywhere: it is the graded criterion, and the grade beside it would otherwise have
    // no column explaining it.
    expect(headerNames()).toContain("Hygiene");
  });

  it("should write its parameter on the click, keeping the span, the term and the filters", () => {
    url("weeks=26&repository=e&production=true");
    mount(SIGNALLED);

    fireEvent.click(expander());

    expect(written()).toBe("/repositories?weeks=26&repository=e&production=true&hygiene=true");
  });

  it("should clear the parameter on the second click, dropping it rather than emptying it", () => {
    url("weeks=26&repository=e&hygiene=true");
    mount(SIGNALLED);

    fireEvent.click(expander());

    expect(written()).toBe("/repositories?weeks=26&repository=e");
  });

  it("should ask the server for nothing: the four checks are already on the rows it was given", () => {
    // THE REPORTED DEFECT. Every answer the checks print comes from `hygieneSignals(row)`, so expanding needed no
    // request — and made one, against a `force-dynamic` page holding 1,880 repositories. The button looked dead.
    url("weeks=26");
    mount(SIGNALLED);

    fireEvent.click(expander());

    expect(replaced).toEqual([]);
  });

  it("should tick the toggle while it is on, so the state is not colour alone", () => {
    // The four filter toggles' own affordance, and here for their reason: a reader who cannot separate two dark
    // fills would have no way to tell whether the control is on. The tick is `aria-hidden` because `aria-pressed`
    // already says it.
    url("weeks=12&hygiene=true");
    mount(SIGNALLED);

    expect(expander().querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");

    cleanup();
    url("weeks=12");
    mount(SIGNALLED);

    expect(expander().querySelector("svg")).toBeNull();
  });

  it("should sit outside the filters group, which is still the four toggles alone", () => {
    url("weeks=12&hygiene=true");
    mount(SIGNALLED);
    const filters = screen.getByRole("group", { name: "Repository filters" });

    expect(within(filters).queryByRole("button", { name: EXPAND_LABEL })).toBeNull();
    expect(within(filters).getAllByRole("button")).toHaveLength(4);
    // In the filter row all the same, and after the toggles: it is a control over the table, not over the page.
    expect(filters.compareDocumentPosition(expander()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(filters.parentElement).toBe(expander().parentElement?.parentElement);
  });

  it("should print Yes for a signal that is on and No for one that is off", () => {
    url("weeks=12&hygiene=true");
    mount(SIGNALLED);

    expect(cellOf("scanned", "Secret scanning")?.textContent).toBe("Yes");
    expect(cellOf("scanned", "Push protection")?.textContent).toBe("No");
    expect(cellOf("bare", "Secret scanning")?.textContent).toBe("No");
    // The aggregate is the report's judgement and not a fold over the cells beside it.
    expect(cellOf("scanned", "Hygiene")?.textContent).toBe("No");
  });

  it("should print a dash for a signal nobody read, and never invert one", () => {
    // GitHub disclosed nothing about vulnerability alerts on `scanned`, and nothing at all was collected for
    // `nothing`. Neither has been shown to have a control switched off. The inversion the `Secrets` column makes
    // is that column's alone: a signal that is on reads Yes here.
    url("weeks=12&hygiene=true");
    mount(SIGNALLED);

    expect(cellOf("scanned", "Vulnerability alerts")?.textContent).toBe("-");
    for (const label of CHECKS) {
      expect(cellOf("nothing", label)?.textContent).toBe("-");
    }
  });

  it("should leave an unread signal slate rather than colouring it warm", () => {
    // `rag.ts`'s rule, which this column is exactly the case for: a half-read question coloured amber makes a
    // permission the token lacks read as a control the team turned off.
    url("weeks=12&hygiene=true");
    mount(SIGNALLED);

    expect(cellOf("scanned", "Vulnerability alerts")?.outerHTML).toContain("text-slate-500");
    expect(cellOf("scanned", "Vulnerability alerts")?.outerHTML).not.toMatch(/amber|rose|rag-/);
    expect(cellOf("scanned", "Secret scanning")?.outerHTML).toContain("text-rag-green");
    expect(cellOf("scanned", "Push protection")?.outerHTML).toContain("text-rag-amber");
  });

  it("should draw the two update signals as one column met by either tool", () => {
    // Dependabot security updates off and a Renovate configuration present is 244 repositories of this estate.
    // Two independent columns would put a No against every one of them, which is the bug the `either` merge fixed.
    url("weeks=12&hygiene=true");
    mount(SIGNALLED);

    expect(headerNames().filter((label) => label?.includes("epend"))).toEqual(["Dependency updates"]);
    expect(cellOf("scanned", "Dependency updates")?.textContent).toBe("Yes");
    // Neither signal was read for `bare`, which is unread rather than a repository nothing updates.
    expect(cellOf("bare", "Dependency updates")?.textContent).toBe("-");
  });

  it("should sort a check on its own signal, holding an unread one back from both ends", () => {
    url("weeks=12&hygiene=true");
    mount(SIGNALLED);

    // Ascending opens on the repositories MISSING the control, which is what a reader sorting a hygiene check is
    // looking for. `nothing`, which nobody read, is last either way round.
    expect(sortBy("Push protection")).toEqual(["scanned", "bare", "nothing"]);
    expect(sortBy("Secret scanning")).toEqual(["bare", "scanned", "nothing"]);
    expect(sortBy("Secret scanning").at(-1)).toBe("nothing");
  });

  it("should keep the column a reader sorted by when the aggregate is expanded", () => {
    // THE REASON THE EXPANDED COLUMNS ARE BUILT ONCE. The sort holds the column as an OBJECT and compares it by
    // identity, so rebuilding the list per render would silently forget what the table was ordered by the moment
    // the reader expanded it.
    const view = mount(SIGNALLED);
    sortBy("Repository");
    expect(announced("Repository")).toBe("ascending");

    url("weeks=12&hygiene=true");
    view.rerender(<RepositoriesTable rows={SIGNALLED} weeks={12} />);

    expect(announced("Repository")).toBe("ascending");
    expect(order()).toEqual(["bare", "nothing", "scanned"]);
  });
});
