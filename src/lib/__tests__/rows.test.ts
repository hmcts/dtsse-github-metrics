/**
 * The repository list's filtering and ordering, tested where they are decidable.
 *
 * These are the checks the table itself cannot make: that a filter never invents an empty list from a
 * parameter it did not recognise, that an unreportable repository keeps its row, and that the default
 * order is by team and name rather than by any figure.
 */

import { describe, expect, it } from "vitest";
import { checksSlices, coverageSlices, distributionSlices, type PieSlice, reviewSlices, securitySlices, unreviewedSlices } from "@/lib/chart";
import { RAG_LABEL, RAG_STATES, state } from "@/lib/rag";
import {
  ASSURANCE_CRITERIA,
  ASSURANCE_GRADE_LABEL,
  ASSURANCE_GRADE_STATE,
  ASSURANCE_LABEL,
  answerOrder,
  assuranceOrder,
  criterionResult,
  ESTATE_FILTERS,
  FILTER_PARAMETERS,
  type FilterParameter,
  filterRepositories,
  INDIVIDUAL_LABEL,
  matchesRepository,
  matchesVisibility,
  orderRepositories,
  outcomeOrder,
  ownedByIndividual,
  owners,
  PRODUCTION_PARAMETER,
  PRODUCTION_VALUE,
  parseFilters,
  parseProduction,
  parseVisibilities,
  productionCount,
  VISIBILITIES,
  visibilityParameter
} from "@/lib/rows";
import { sorted } from "@/lib/sort";
import type { RepositoryRow } from "@/lib/types";

function row(fields: Partial<RepositoryRow> & { repository: string }): RepositoryRow {
  return { team: "platform", ...fields };
}

/**
 * Four repositories spread across every dimension, including one the window could not report.
 *
 * The gate figures, the policy's verdict and the Sonar measures are here so a filter can be checked
 * against the donut that draws the same dimension: an estate where every row is unmeasured would
 * agree with any classifier at all.
 *
 * All three production answers are represented, which is what the toggle's rule needs: two
 * repositories the list names, one it was read and does not name, and one whose list could not be
 * read at all — the row that has to be left out rather than guessed either way.
 *
 * THE `pushed_at` VALUES DELIBERATELY CROSS THE ALPHABETICAL ORDER, which is what makes the default-sort cases
 * able to fail. `hmcts/web` is the most recently pushed and sorts LAST by `(team, repository)`; `hmcts/api` is
 * the least recent of the three that have one and sorted second. A fixture where the two orders agreed would
 * assert the new default while the old one still passed — the exact failure the brief warned about, and one that
 * was found in an earlier attempt at this change.
 *
 * `hmcts/legacy` carries NO `pushed_at` at all, so absence is exercised rather than assumed: it is the row the
 * order has to hold back from both ends.
 */
const ROWS: RepositoryRow[] = [
  row({
    repository: "hmcts/web",
    team: "delivery",
    readiness: "red",
    finding_occurrences: 6,
    required_approving_reviews: 0,
    required_status_checks: 0,
    unreviewed_substantial: "above",
    sonar_coverage: 12.5,
    sonar_security_issues: 4,
    production: true,
    pushed_at: "2026-09-10T00:00:00Z"
  }),
  row({
    repository: "hmcts/api",
    team: "platform",
    readiness: "green",
    finding_occurrences: 0,
    required_approving_reviews: 2,
    required_status_checks: 3,
    unreviewed_substantial: "none",
    sonar_coverage: 95,
    sonar_security_issues: 0,
    production: true,
    pushed_at: "2026-07-01T00:00:00Z"
  }),
  row({
    repository: "hmcts/tools",
    team: "platform",
    readiness: "green",
    required_approving_reviews: 1,
    required_status_checks: 0,
    unreviewed_substantial: "within",
    sonar_coverage: 85,
    sonar_security_rating: { value: 4 },
    production: false,
    pushed_at: "2026-08-15T00:00:00Z"
  }),
  row({ repository: "hmcts/legacy", team: "platform", detail: "no window was collected" })
];

/**
 * The donut each dimension is drawn from, so a filter can be held against the slice it came off.
 *
 * The readiness donut counts a label DISTRIBUTION rather than rows — that is what the service sends
 * the pages — so its entry distributes these rows first, by the same `state` the filter bands with.
 */
const DONUT: Record<FilterParameter, (rows: readonly RepositoryRow[]) => PieSlice[]> = {
  label: (rows) =>
    distributionSlices(Object.fromEntries(RAG_STATES.map((readiness) => [readiness, rows.filter((entry) => state(entry.readiness) === readiness).length]))),
  review: reviewSlices,
  checks: checksSlices,
  unreviewed: unreviewedSlices,
  coverage: coverageSlices,
  security: securitySlices
};

describe("owners", () => {
  it("reads every owner of a shared repository, in the reporting order", () => {
    expect(owners(row({ repository: "hmcts/shared", team: "platform", teams: ["platform", "delivery"] }))).toEqual(["platform", "delivery"]);
  });

  it("folds the ordinary row, which carries no `teams` at all, to its one owner", () => {
    // Absence is the common case — 390 of the estate's repositories are shared and the rest carry no list — so it
    // has to read as "owned by this team" rather than as "owned by nobody".
    expect(owners(row({ repository: "hmcts/api", team: "platform" }))).toEqual(["platform"]);
  });
});

describe("the individual marker", () => {
  it("names the finding in the reader's word rather than the contract's", () => {
    // `person` is the kind the domain resolved; "Individual" is what a reader is being told about the
    // repository, which is that it is one person's rather than a team's.
    expect(INDIVIDUAL_LABEL).toBe("Individual");
  });

  it("carries no emoji: the word is the information", () => {
    expect(INDIVIDUAL_LABEL).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});

describe("ownedByIndividual", () => {
  it("marks a row the service says one person owns", () => {
    expect(ownedByIndividual(row({ repository: "hmcts/theirs", team: "a1i-hussain", owner_kind: "person" }))).toBe(true);
  });

  it("does not mark a team, whose name is the same shape as a login", () => {
    expect(ownedByIndividual(row({ repository: "hmcts/api", team: "civil-admins", owner_kind: "team" }))).toBe(false);
  });

  it("does not mark the unowned bucket, which is a destination rather than a person", () => {
    // 141 repositories are reported under `unowned`, which has a card and a name that already says what it is.
    // Marking it as an individual would say something false about every one of them.
    expect(ownedByIndividual(row({ repository: "hmcts/orphan", team: "unowned", owner_kind: "none" }))).toBe(false);
  });

  it("reads an absent kind as a team, which is what the field's absence used to mean", () => {
    // The field only exists from 2026-09-11 and `API_URL` used to be read per request, so a page can be served a
    // row without it. Every such row was rendered as a team before, and 1,499 of the estate's 1,846 owned
    // repositories are team-owned — reading absence as a person would mark most of the estate as somebody's own.
    expect(ownedByIndividual(row({ repository: "hmcts/api", team: "platform" }))).toBe(false);
  });
});

describe("orderRepositories", () => {
  it("opens on the most recently pushed, which is what a reader arriving is asking", () => {
    // THE ORDER THIS REPLACED was `(team, repository)`, which put these rows web, api, legacy, tools. Every
    // instant here crosses that order, so this case cannot pass under the old rule.
    expect(orderRepositories(ROWS).map((entry) => entry.repository)).toEqual(["hmcts/web", "hmcts/tools", "hmcts/api", "hmcts/legacy"]);
  });

  it("places a repository with no last push last, never at the top as though it were the freshest", () => {
    // GitHub omits `pushedAt` for a repository never pushed to, and the tempting fix is to default it. Defaulted
    // to NOW it would head the list, which is the direction that misleads: a reader opening the page would meet
    // the repositories nobody has ever pushed to under a heading saying "most recently pushed".
    //
    // Worth being precise about what this case can and cannot catch, since a weaker version of it passed under
    // both rules. Defaulting to the EPOCH is indistinguishable here — 1970 is older than anything real, so a
    // descending sort puts it last either way — and the two rules only part company in the ASCENDING direction,
    // which is the header-click path below rather than this one.
    expect(
      orderRepositories(ROWS)
        .map((entry) => entry.repository)
        .at(-1)
    ).toBe("hmcts/legacy");
    expect(orderRepositories([row({ repository: "hmcts/none" }), row({ repository: "hmcts/pushed", pushed_at: "2014-01-01T00:00:00Z" })])[0]?.repository).toBe(
      "hmcts/pushed"
    );
  });

  it("orders two repositories with no last push by name, so the tail is stable too", () => {
    // The absent rows are a set, not a heap: without an order among them, two renders of one estate could differ
    // in the tail — the same diffability rule the tiebreak above exists for, applied to the other bucket.
    const rows = [row({ repository: "hmcts/zebra" }), row({ repository: "hmcts/alpha" })];

    expect(orderRepositories(rows).map((entry) => entry.repository)).toEqual(["hmcts/alpha", "hmcts/zebra"]);
    expect(orderRepositories([...rows].reverse()).map((entry) => entry.repository)).toEqual(["hmcts/alpha", "hmcts/zebra"]);
  });

  it("holds a repository with no last push back from BOTH ends when the column is clicked", () => {
    // WHERE THE TWO RULES ACTUALLY PART COMPANY, and so where a default would be caught. `sorted` holds
    // `undefined` back from either direction, so a repository never pushed to is not the answer to "which was
    // pushed longest ago" any more than to "which was pushed most recently". An epoch default would put it FIRST
    // here; a `now` default would put it first the other way round.
    const read = (entry: RepositoryRow) => entry.pushed_at;

    expect(
      sorted(ROWS, read, "ascending")
        .map((entry) => entry.repository)
        .at(-1)
    ).toBe("hmcts/legacy");
    expect(
      sorted(ROWS, read, "descending")
        .map((entry) => entry.repository)
        .at(-1)
    ).toBe("hmcts/legacy");
  });

  it("breaks a tie on the instant by name, so two renders of one estate cannot differ", () => {
    // Not hypothetical: the instant has second resolution and a Terraform `for_each` apply touches many
    // repositories at once. "Two reports of one window must not differ" is a rule stated in three other places
    // in this codebase, and without the tiebreak the two rows could swap between renders.
    const same = "2026-09-01T12:00:00Z";
    const rows = [row({ repository: "hmcts/zebra", pushed_at: same }), row({ repository: "hmcts/alpha", pushed_at: same })];

    expect(orderRepositories(rows).map((entry) => entry.repository)).toEqual(["hmcts/alpha", "hmcts/zebra"]);
    expect(orderRepositories([...rows].reverse()).map((entry) => entry.repository)).toEqual(["hmcts/alpha", "hmcts/zebra"]);
  });

  it("places a shared repository once, at one position", () => {
    // The old order's stated decision, PRESERVED: a row appears once. It no longer appears under a heading, but
    // placing it under each of its owners would still print it twice in a table whose count the reader compares.
    const shared = row({ repository: "hmcts/shared", team: "delivery", teams: ["delivery", "platform"], pushed_at: "2026-09-12T00:00:00Z" });

    expect(orderRepositories([...ROWS, shared]).map((entry) => entry.repository)).toEqual([
      "hmcts/shared",
      "hmcts/web",
      "hmcts/tools",
      "hmcts/api",
      "hmcts/legacy"
    ]);
  });

  it("leaves the rows it was given untouched", () => {
    const original = [...ROWS];
    orderRepositories(ROWS);
    expect(ROWS).toEqual(original);
  });
});

describe("matchesRepository", () => {
  it("matches either name a reader would type, case-insensitively", () => {
    const entry = row({ repository: "hmcts/API-service", team: "Platform" });
    expect(matchesRepository(entry, "api")).toBe(true);
    expect(matchesRepository(entry, "platform")).toBe(true);
    expect(matchesRepository(entry, "delivery")).toBe(false);
  });

  it("matches a team that owns the repository without leading it", () => {
    // A reader typing a team name is asking what that team is on the hook for, which on a shared repository is not
    // settled by which owner happens to head the reporting order.
    const shared = row({ repository: "hmcts/shared", team: "platform", teams: ["platform", "Delivery"] });
    expect(matchesRepository(shared, "delivery")).toBe(true);
    expect(matchesRepository(shared, "platform")).toBe(true);
    expect(matchesRepository(shared, "research")).toBe(false);
  });

  it("matches everything on an empty term", () => {
    expect(matchesRepository(row({ repository: "hmcts/api" }), "  ")).toBe(true);
  });
});

describe("ESTATE_FILTERS", () => {
  it("names one dimension per donut, each with the parameter its links are written in", () => {
    expect(FILTER_PARAMETERS).toEqual(["label", "review", "checks", "unreviewed", "coverage", "security"]);
  });

  it("offers exactly the values its donut has slices for, in the same order and colours", () => {
    for (const filter of ESTATE_FILTERS) {
      const slices = DONUT[filter.parameter](ROWS);
      expect(filter.options.map((option) => option.key)).toEqual(slices.map((slice) => slice.key));
      expect(filter.options.map((option) => option.name)).toEqual(slices.map((slice) => slice.name));
      expect(filter.options.map((option) => option.color)).toEqual(slices.map((slice) => slice.color));
    }
  });
});

describe("parseFilters", () => {
  /** Read parameters off a plain object, which is the shape a `URLSearchParams` reader has. */
  function reader(query: Record<string, string>) {
    return (parameter: string) => query[parameter] ?? null;
  }

  it("reads every dimension at once, each in its own vocabulary", () => {
    expect(
      parseFilters(
        reader({
          label: "cannot_assess",
          review: "multiple",
          checks: "none",
          unreviewed: "within",
          coverage: "moderate",
          security: "high"
        })
      )
    ).toEqual({
      label: "cannot_assess",
      review: "multiple",
      checks: "none",
      unreviewed: "within",
      coverage: "moderate",
      security: "high"
    });
  });

  it("accepts each value its own dimension offers, and no value from another", () => {
    for (const filter of ESTATE_FILTERS) {
      for (const option of filter.options) {
        expect(parseFilters(reader({ [filter.parameter]: option.key }))).toEqual({
          [filter.parameter]: option.key
        });
      }
    }
    // `multiple` is a review band and nothing else, so it filters no other dimension.
    expect(parseFilters(reader({ coverage: "multiple" }))).toEqual({});
  });

  it("drops a value it does not recognise, so a stale link shows the list rather than a blank", () => {
    expect(parseFilters(reader({ label: "purple", review: "required" }))).toEqual({
      review: "required"
    });
    expect(parseFilters(reader({ security: "" }))).toEqual({});
    expect(parseFilters(reader({}))).toEqual({});
  });
});

describe("filterRepositories", () => {
  it("applies the term and the readiness together", () => {
    const found = filterRepositories(ROWS, "hmcts", { label: "green" });
    expect(found.map((entry) => entry.repository)).toEqual(["hmcts/api", "hmcts/tools"]);
  });

  it("keeps an unreportable repository, which carries no label, under the ungraded state", () => {
    expect(filterRepositories(ROWS, "", { label: "none" }).map((entry) => entry.repository)).toEqual(["hmcts/legacy"]);
  });

  it("selects a label this build does not know under the state its donut counted it in", () => {
    // A `metrics-serve` newer than these pages can send a fifth label, which `distributionState`
    // counts under "Not assessed". Selecting that slice has to return the row it counted, or the
    // table shows one row fewer than the wedge beside it said.
    const future = row({ repository: "hmcts/next", readiness: "purple" as "green" });
    expect(filterRepositories([...ROWS, future], "", { label: "none" }).map((entry) => entry.repository)).toEqual(["hmcts/legacy", "hmcts/next"]);
  });

  it("filters on the term alone when no dimension was named", () => {
    expect(filterRepositories(ROWS, "legacy", {})).toHaveLength(1);
    expect(filterRepositories(ROWS, "", {})).toHaveLength(ROWS.length);
  });

  it("filters on each dimension on its own, by the band its own donut counts with", () => {
    const named = (filters: Parameters<typeof filterRepositories>[2]) => filterRepositories(ROWS, "", filters).map((entry) => entry.repository);

    expect(named({ review: "multiple" })).toEqual(["hmcts/api"]);
    expect(named({ checks: "none" })).toEqual(["hmcts/web", "hmcts/tools"]);
    expect(named({ unreviewed: "above" })).toEqual(["hmcts/web"]);
    expect(named({ coverage: "moderate" })).toEqual(["hmcts/tools"]);
    expect(named({ security: "medium" })).toEqual(["hmcts/web"]);
    expect(named({ security: "high" })).toEqual(["hmcts/tools"]);
    // Every dimension counts the unreportable repository under its own unmeasured band.
    expect(named({ review: "unknown" })).toEqual(["hmcts/legacy"]);
  });

  it("holds every named dimension at once, and the term with them", () => {
    expect(filterRepositories(ROWS, "", { label: "green", checks: "none" }).map((entry) => entry.repository)).toEqual(["hmcts/tools"]);
    // Two dimensions no repository satisfies together is an empty table, which is the honest answer:
    // the reader asked for something, not for a parameter to be ignored.
    expect(filterRepositories(ROWS, "", { label: "red", checks: "required" })).toEqual([]);
    expect(filterRepositories(ROWS, "tools", { label: "green", checks: "none" })).toHaveLength(1);
    expect(filterRepositories(ROWS, "api", { label: "green", checks: "none" })).toHaveLength(0);
  });

  it("shows exactly the rows the clicked slice counted, for every slice of every donut", () => {
    for (const filter of ESTATE_FILTERS) {
      for (const slice of DONUT[filter.parameter](ROWS)) {
        expect(filterRepositories(ROWS, "", { [filter.parameter]: slice.key })).toHaveLength(slice.value);
      }
    }
  });
});

describe("parseProduction", () => {
  it("names a parameter of its own, outside the six the donuts write", () => {
    expect(PRODUCTION_PARAMETER).toBe("production");
    expect(FILTER_PARAMETERS).not.toContain(PRODUCTION_PARAMETER);
    expect(ESTATE_FILTERS.map((filter) => filter.parameter)).not.toContain(PRODUCTION_PARAMETER);
  });

  it("reads the value the toggle writes as on, and everything else as off", () => {
    expect(parseProduction(() => PRODUCTION_VALUE)).toBe(true);
    expect(parseProduction(() => null)).toBe(false);
    // Not truthiness: one spelling, so a hand-typed `?production=0` does not read as a yes.
    expect(parseProduction(() => "0")).toBe(false);
    expect(parseProduction(() => "")).toBe(false);
    expect(parseProduction(() => "yes")).toBe(false);
  });

  it("reads its own parameter and no other, so a chip’s value cannot turn it on", () => {
    const query: Record<string, string> = { label: PRODUCTION_VALUE };
    expect(parseProduction((parameter) => query[parameter] ?? null)).toBe(false);
    query[PRODUCTION_PARAMETER] = PRODUCTION_VALUE;
    expect(parseProduction((parameter) => query[parameter] ?? null)).toBe(true);
  });
});

describe("filterRepositories with the production toggle", () => {
  it("holds only the repositories the list names when the toggle is on", () => {
    expect(filterRepositories(ROWS, "", {}, true).map((entry) => entry.repository)).toEqual(["hmcts/web", "hmcts/api"]);
  });

  it("leaves the whole estate alone when the toggle is off, and by default", () => {
    expect(filterRepositories(ROWS, "", {}, false)).toHaveLength(ROWS.length);
    expect(filterRepositories(ROWS, "", {})).toHaveLength(ROWS.length);
  });

  it("excludes a repository whose answer could not be read rather than guessing it either way", () => {
    // `hmcts/tools` was read and is not a production service; `hmcts/legacy` carries no answer at
    // all. Neither is in the filtered list, and the second is the one a `false` default would have
    // silently made a decision about.
    const found = filterRepositories(ROWS, "", {}, true).map((entry) => entry.repository);
    expect(found).not.toContain("hmcts/tools");
    expect(found).not.toContain("hmcts/legacy");
  });

  it("ANDs with the term and with every dimension", () => {
    expect(filterRepositories(ROWS, "api", {}, true).map((entry) => entry.repository)).toEqual(["hmcts/api"]);
    expect(filterRepositories(ROWS, "", { label: "green" }, true).map((entry) => entry.repository)).toEqual(["hmcts/api"]);
    // A dimension the production repositories do not satisfy is an empty table, not an ignored one.
    expect(filterRepositories(ROWS, "", { checks: "none" }, true)).toEqual([ROWS.find((entry) => entry.repository === "hmcts/web")]);
    expect(filterRepositories(ROWS, "tools", { label: "green" }, true)).toEqual([]);
  });
});

describe("productionCount", () => {
  it("counts the production repositories the reader can currently see", () => {
    expect(productionCount(ROWS, "", {})).toBe(2);
  });

  it("counts neither a repository read as non-production nor one with no answer", () => {
    expect(productionCount([ROWS[2] as RepositoryRow, ROWS[3] as RepositoryRow], "", {})).toBe(0);
  });

  it("narrows with the term and the other dimensions, which is what makes the figure move", () => {
    expect(productionCount(ROWS, "api", {})).toBe(1);
    expect(productionCount(ROWS, "", { label: "green" })).toBe(1);
    expect(productionCount(ROWS, "", { label: "none" })).toBe(0);
  });

  it("excludes its own dimension, so the count says what turning the toggle on would leave", () => {
    // The count is read while the toggle is on as well as off, and it has to be the same figure:
    // one that counted its own filter would print the number already on screen.
    expect(productionCount(ROWS, "", {})).toBe(filterRepositories(ROWS, "", {}, true).length);
  });
});

/**
 * The visibility filter: three independent toggles, defaulting to public only.
 *
 * `INTERNAL` is the case worth having tests for. It is a real GitHub visibility and the estate's second largest —
 * 1,043 public, 441 internal, 396 private — so a two-way control or a single tri-state could not express what a
 * reader wants to ask.
 */
describe("the visibility filter", () => {
  function reader(query: Record<string, string>) {
    return (parameter: string) => query[parameter] ?? null;
  }

  it("offers all three visibilities, most open first", () => {
    expect(VISIBILITIES).toEqual(["public", "internal", "private"]);
  });

  it("shows public only when the URL says nothing", () => {
    // A DELIBERATE NARROWING. The page asks whether repositories meet the criteria for coding IN THE OPEN, and a
    // private repository is outside that question rather than failing it — so opening on all three would put 837
    // rows in front of a reader who has not asked for them.
    expect([...parseVisibilities(reader({}))]).toEqual(["public"]);
  });

  it("reads each toggle independently, so two can be on and one off", () => {
    // The combination a single tri-state could not express, and the obvious one to want.
    expect([...parseVisibilities(reader({ public: "true", internal: "true", private: "false" }))]).toEqual(["public", "internal"]);
  });

  it("lets the default itself be turned off, which is why off is written rather than absent", () => {
    // Were off expressed as the parameter's absence, `?public=` and a bare URL would be the same string and the
    // reader could never see the internal repositories alone.
    expect([...parseVisibilities(reader({ public: "false", internal: "true" }))]).toEqual(["internal"]);
  });

  it("selects nothing when the reader turns all three off, rather than silently showing everything", () => {
    // Three clicks are three clicks. Falling back to the default here would ignore them, which is what
    // `filterRepositories` refuses to do for a dimension nothing satisfies.
    expect([...parseVisibilities(reader({ public: "false", internal: "false", private: "false" }))]).toEqual([]);
  });

  it("names one parameter per visibility, and no other control's", () => {
    expect(VISIBILITIES.map(visibilityParameter)).toEqual(["public", "internal", "private"]);
    expect(VISIBILITIES.map(visibilityParameter)).not.toContain(PRODUCTION_PARAMETER);
  });

  it("filters the table to the visibilities showing", () => {
    const rows = [
      row({ repository: "hmcts/open", visibility: "public" }),
      row({ repository: "hmcts/inner", visibility: "internal" }),
      row({ repository: "hmcts/closed", visibility: "private" })
    ];

    expect(filterRepositories(rows, "", {}, false, new Set(["public"])).map((entry) => entry.repository)).toEqual(["hmcts/open"]);
    expect(filterRepositories(rows, "", {}, false, new Set(["internal", "private"])).map((entry) => entry.repository)).toEqual(["hmcts/inner", "hmcts/closed"]);
    expect(filterRepositories(rows, "", {}, false, new Set())).toEqual([]);
  });

  it("keeps a row whose visibility the service did not send, rather than emptying the table", () => {
    // The field only exists from 2026-09-14. Absent has to mean "this predates the field" and never "exclude it",
    // which is the same guess `ownedByIndividual` makes for `owner_kind` and in the same direction.
    expect(matchesVisibility(row({ repository: "hmcts/old" }), new Set(["public"]))).toBe(true);
    expect(filterRepositories(ROWS, "", {}, false, new Set(["public"]))).toHaveLength(ROWS.length);
  });

  it("ANDs with the term and with the production toggle", () => {
    const rows = [
      row({ repository: "hmcts/open", visibility: "public", production: true }),
      row({ repository: "hmcts/inner", visibility: "internal", production: true })
    ];

    expect(filterRepositories(rows, "", {}, true, new Set(["public"])).map((entry) => entry.repository)).toEqual(["hmcts/open"]);
    expect(filterRepositories(rows, "inner", {}, true, new Set(["public"]))).toEqual([]);
  });
});

/**
 * The assurance presentation: the grade's words, its colours, and where each column sorts.
 *
 * What these mostly assert is that the assurance vocabulary is NOT readiness's. A repository can be ready to
 * enable agentic tooling on and still fail the assurance criteria, so reusing "Ready" and "Blocked" here would
 * state something false about it.
 */
describe("the assurance grade's presentation", () => {
  it("reads in its own words and never in readiness's", () => {
    expect(Object.values(ASSURANCE_GRADE_LABEL)).toEqual(["Meets criteria", "Partly meets", "Cannot assess"]);
    // "Ready" and "Blocked" are readiness's answers to a different question.
    expect(Object.values(ASSURANCE_GRADE_LABEL)).not.toContain(RAG_LABEL.green);
    expect(Object.values(ASSURANCE_GRADE_LABEL)).not.toContain(RAG_LABEL.red);
  });

  it("draws in the RAG palette, so one page looks like one thing", () => {
    expect(ASSURANCE_GRADE_STATE.met).toBe("green");
    // Amber and not red: none of the four criteria is a disqualifier on its own.
    expect(ASSURANCE_GRADE_STATE.partial).toBe("amber");
    // Slate, on `rag.ts`'s own rule — a half-read question must not be coloured warm.
    expect(ASSURANCE_GRADE_STATE.unknown).toBe("cannot_assess");
  });

  it("names a column per criterion, in the criteria's own order", () => {
    expect(ASSURANCE_CRITERIA).toEqual(["named-owner", "automated-hygiene", "patching", "maintained"]);
    expect(ASSURANCE_CRITERIA.map((criterion) => ASSURANCE_LABEL[criterion])).toEqual(["Code owner", "Hygiene", "Oldest alert", "Maintained"]);
  });

  it("carries no emoji in any label: the word is the information", () => {
    for (const label of [...Object.values(ASSURANCE_GRADE_LABEL), ...Object.values(ASSURANCE_LABEL)]) {
      expect(label).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });
});

describe("assuranceOrder", () => {
  it("sorts met above partly, so ascending opens on the repositories that meet the criteria", () => {
    expect(assuranceOrder("met")).toBeLessThan(assuranceOrder("partial") as number);
  });

  it("holds an ungraded repository back from both ends", () => {
    // "Which repositories fail the criteria" is a question about the graded ones, read either way round.
    expect(assuranceOrder("unknown")).toBeUndefined();
    expect(assuranceOrder(undefined)).toBeUndefined();
  });
});

describe("outcomeOrder", () => {
  it("sorts met first, so one click on a criterion opens on the useful end", () => {
    expect(outcomeOrder("met")).toBeLessThan(outcomeOrder("unmet") as number);
  });

  it("holds an unreadable outcome back from both ends", () => {
    expect(outcomeOrder("unknown")).toBeUndefined();
    expect(outcomeOrder(undefined)).toBeUndefined();
  });
});

describe("criterionResult", () => {
  const assured = row({
    repository: "hmcts/api",
    assurance: {
      grade: "partial",
      criteria: [
        { criterion: "named-owner", outcome: "met", detail: "assigned to a team" },
        { criterion: "automated-hygiene", outcome: "unmet", detail: "not configured: secret scanning" }
      ]
    }
  });

  it("finds one criterion's result by its own name, not by position", () => {
    // By name because the columns are generated from `ASSURANCE_CRITERIA` while the report sends whatever it
    // judged: a positional read would silently pair a column with another criterion's answer if either list
    // ever changed.
    expect(criterionResult(assured, "automated-hygiene")).toMatchObject({ outcome: "unmet", detail: "not configured: secret scanning" });
  });

  it("finds nothing for a criterion the report did not judge, or a row with no assurance at all", () => {
    expect(criterionResult(assured, "patching")).toBeUndefined();
    expect(criterionResult(row({ repository: "hmcts/old" }), "named-owner")).toBeUndefined();
  });
});

describe("answerOrder", () => {
  it("orders no below yes, so ascending opens on the repositories without one", () => {
    expect(answerOrder(false)).toBe(0);
    expect(answerOrder(true)).toBe(1);
  });

  it("leaves an unreadable answer undefined, the value `sorted` holds back from both ends", () => {
    expect(answerOrder(undefined)).toBeUndefined();
  });
});
