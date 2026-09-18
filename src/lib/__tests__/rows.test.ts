/**
 * The repository list's filtering and ordering, tested where they are decidable.
 *
 * These are the checks the table itself cannot make: that a filter never invents an empty list from a
 * parameter it did not recognise, that an unreportable repository keeps its row, and that the default
 * order is by team and name rather than by any figure.
 */

import { describe, expect, it } from "vitest";
import { RAG_LABEL } from "@/lib/rag";
import {
  ASSURANCE_CRITERIA,
  ASSURANCE_GRADE_LABEL,
  ASSURANCE_GRADE_STATE,
  ASSURANCE_GRADES,
  ASSURANCE_HINT,
  ASSURANCE_LABEL,
  answerOrder,
  assuranceOrder,
  CVE_AGGREGATE,
  CVE_COLUMNS,
  type CveColumn,
  criterionResult,
  cveCount,
  cveDetail,
  cveEvidence,
  cveOrder,
  EXPAND_LABEL,
  EXPANDED_PARAMETER,
  EXPANDED_VALUE,
  filterRepositories,
  HYGIENE_CHECKS,
  HYGIENE_CRITERION,
  hygieneSignals,
  INDIVIDUAL_LABEL,
  matchesRepository,
  matchesVisibility,
  orderRepositories,
  outcomeOrder,
  ownedByIndividual,
  owners,
  PRODUCTION_PARAMETER,
  PRODUCTION_VALUE,
  parseExpanded,
  parseProduction,
  parseVisibilities,
  productionCount,
  uncollectedCount,
  uncollectedDetail,
  VISIBILITIES,
  visibilityParameter
} from "@/lib/rows";
import { sorted } from "@/lib/sort";
import type { AssuranceHygieneSignals, RepositoryRow } from "@/lib/types";
import { UNCOLLECTED_DETAIL } from "@/lib/types";

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

/**
 * Which of the two kinds of `detail` the repositories list is allowed to print.
 *
 * A REASON IS ONLY WORTH PRINTING BESIDE THE FIGURES IT EXPLAINS. That page draws control state and no merge
 * column, so the merge-source and merge-gate sentences explained an absence a reader could not see — and on the 870
 * repositories whose private-and-internal walk the App installation does not cover (VIBE-590) that read as a fault
 * in the row. The repository and team pages, which do draw the merge figures, still render `detail` whole.
 */
describe("uncollectedDetail", () => {
  it("keeps the reason that explains every column the list draws", () => {
    expect(uncollectedDetail(row({ repository: "hmcts/ghost", detail: UNCOLLECTED_DETAIL }))).toBe(UNCOLLECTED_DETAIL);
  });

  it("drops a reason about merge sources, which the list has no column for", () => {
    const merges = "no merge history was read for this repository, so its merges are unmeasured rather than none";
    expect(uncollectedDetail(row({ repository: "hmcts/walled", detail: merges }))).toBeUndefined();
  });

  it("drops a reason about the merge gate, which the list has no column for either", () => {
    expect(uncollectedDetail(row({ repository: "hmcts/gated", detail: "the merge gate has not been collected" }))).toBeUndefined();
  });

  it("drops a joined pair of merge reasons rather than printing the half that matches nothing", () => {
    // `unreportedDetail` joins its two sentences with "; ", so a stale repository carries both. Neither is about a
    // column here, and an exact comparison is what keeps a joined string from matching on a prefix.
    const joined = "no merge history was read for this repository, so its merges are unmeasured rather than none; the merge gate has not been collected";
    expect(uncollectedDetail(row({ repository: "hmcts/stale", detail: joined }))).toBeUndefined();
  });

  it("has nothing to print for a row that gave no reason at all", () => {
    expect(uncollectedDetail(row({ repository: "hmcts/api" }))).toBeUndefined();
  });
});

/**
 * The count that goes with it, which is NOT `OverviewSummary.unavailable`.
 *
 * `unavailable` counts every row carrying any `detail`, so it includes the merge-history gap the list no longer
 * shows — which would leave the header announcing unreported repositories above a table where not one row gave a
 * reason. Counted off the rows through the same predicate that decides whether to print one.
 */
describe("uncollectedCount", () => {
  it("counts only the rows the list has a reason for", () => {
    const rows = [
      row({ repository: "hmcts/api" }),
      row({ repository: "hmcts/ghost", detail: UNCOLLECTED_DETAIL }),
      row({ repository: "hmcts/walled", detail: "no merge history was read for this repository, so its merges are unmeasured rather than none" })
    ];

    expect(uncollectedCount(rows)).toBe(1);
  });

  it("counts none where every repository was collected, whatever went unread in it", () => {
    // The state the live estate is in: 1,890 active repositories and none without collected state, with the merge
    // gap still present on many of them.
    const rows = [
      row({ repository: "hmcts/api" }),
      row({ repository: "hmcts/walled", detail: "the merged pull requests were not read for this repository, so they are unmeasured rather than none" })
    ];

    expect(uncollectedCount(rows)).toBe(0);
  });

  it("counts an empty estate as none rather than failing on it", () => {
    expect(uncollectedCount([])).toBe(0);
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

describe("filterRepositories", () => {
  it("filters on the term alone, which is now the only dimension besides the two toggles", () => {
    expect(filterRepositories(ROWS, "legacy")).toHaveLength(1);
    expect(filterRepositories(ROWS, "")).toHaveLength(ROWS.length);
  });

  it("keeps every row an unreportable repository included, since a term matches a name and not a figure", () => {
    // `hmcts/legacy` carries no readiness, no gate figures and no Sonar measures. It used to be filtered by six
    // dimensions that each counted it under an unmeasured band; none of those exist now, and a term is about
    // names — so it is in the list unless its name says otherwise.
    expect(filterRepositories(ROWS, "hmcts").map((entry) => entry.repository)).toContain("hmcts/legacy");
  });
});

describe("parseProduction", () => {
  it("names a parameter of its own, distinct from the three visibilities", () => {
    expect(PRODUCTION_PARAMETER).toBe("production");
    expect(VISIBILITIES.map(visibilityParameter)).not.toContain(PRODUCTION_PARAMETER);
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
    expect(filterRepositories(ROWS, "", true).map((entry) => entry.repository)).toEqual(["hmcts/web", "hmcts/api"]);
  });

  it("leaves the whole estate alone when the toggle is off, and by default", () => {
    expect(filterRepositories(ROWS, "", false)).toHaveLength(ROWS.length);
    expect(filterRepositories(ROWS, "")).toHaveLength(ROWS.length);
  });

  it("excludes a repository whose answer could not be read rather than guessing it either way", () => {
    // `hmcts/tools` was read and is not a production service; `hmcts/legacy` carries no answer at
    // all. Neither is in the filtered list, and the second is the one a `false` default would have
    // silently made a decision about.
    const found = filterRepositories(ROWS, "", true).map((entry) => entry.repository);
    expect(found).not.toContain("hmcts/tools");
    expect(found).not.toContain("hmcts/legacy");
  });

  it("ANDs with the term", () => {
    expect(filterRepositories(ROWS, "api", true).map((entry) => entry.repository)).toEqual(["hmcts/api"]);
    // A term the production repositories do not match is an empty table, not an ignored one.
    expect(filterRepositories(ROWS, "tools", true)).toEqual([]);
  });
});

describe("productionCount", () => {
  it("counts the production repositories the reader can currently see", () => {
    expect(productionCount(ROWS, "")).toBe(2);
  });

  it("counts neither a repository read as non-production nor one with no answer", () => {
    expect(productionCount([ROWS[2] as RepositoryRow, ROWS[3] as RepositoryRow], "")).toBe(0);
  });

  it("narrows with the term, which is what makes the figure move", () => {
    expect(productionCount(ROWS, "api")).toBe(1);
    expect(productionCount(ROWS, "legacy")).toBe(0);
  });

  it("excludes its own dimension, so the count says what turning the toggle on would leave", () => {
    // The count is read while the toggle is on as well as off, and it has to be the same figure:
    // one that counted its own filter would print the number already on screen.
    expect(productionCount(ROWS, "")).toBe(filterRepositories(ROWS, "", true).length);
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

    expect(filterRepositories(rows, "", false, new Set(["public"])).map((entry) => entry.repository)).toEqual(["hmcts/open"]);
    expect(filterRepositories(rows, "", false, new Set(["internal", "private"])).map((entry) => entry.repository)).toEqual(["hmcts/inner", "hmcts/closed"]);
    expect(filterRepositories(rows, "", false, new Set())).toEqual([]);
  });

  it("keeps a row whose visibility the service did not send, rather than emptying the table", () => {
    // The field only exists from 2026-09-14. Absent has to mean "this predates the field" and never "exclude it",
    // which is the same guess `ownedByIndividual` makes for `owner_kind` and in the same direction.
    expect(matchesVisibility(row({ repository: "hmcts/old" }), new Set(["public"]))).toBe(true);
    expect(filterRepositories(ROWS, "", false, new Set(["public"]))).toHaveLength(ROWS.length);
  });

  it("ANDs with the term and with the production toggle", () => {
    const rows = [
      row({ repository: "hmcts/open", visibility: "public", production: true }),
      row({ repository: "hmcts/inner", visibility: "internal", production: true })
    ];

    expect(filterRepositories(rows, "", true, new Set(["public"])).map((entry) => entry.repository)).toEqual(["hmcts/open"]);
    expect(filterRepositories(rows, "inner", true, new Set(["public"]))).toEqual([]);
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
    expect(Object.values(ASSURANCE_GRADE_LABEL)).toEqual(["Meets criteria", "Meets what was read", "Partly meets", "Cannot assess"]);
    // "Ready" and "Blocked" are readiness's answers to a different question.
    expect(Object.values(ASSURANCE_GRADE_LABEL)).not.toContain(RAG_LABEL.green);
    expect(Object.values(ASSURANCE_GRADE_LABEL)).not.toContain(RAG_LABEL.red);
  });

  it("gives a full read and a partial one different words, which is the whole point of the fourth grade", () => {
    // A repository that met the three criteria anybody could read must not print what a repository read in full
    // and met prints. Until 2026-09-15 both said "Meets criteria", so one failed org-wide secret-scanning call
    // shrank the claim behind every row on the page and changed nothing a reader could see.
    expect(ASSURANCE_GRADE_LABEL["partly-read"]).not.toBe(ASSURANCE_GRADE_LABEL.met);
    expect(ASSURANCE_GRADE_LABEL["partly-read"]).not.toBe(ASSURANCE_GRADE_LABEL.partial);
  });

  it("keeps the words, the colours and the sort order total over one list of grades", () => {
    // A grade added to `AssuranceGrade` has to be given a place, a word and a colour rather than silently sorting
    // as if it had none — the same guarantee `RAG_STATES` gives `rag.ts`'s maps.
    expect(ASSURANCE_GRADES).toEqual(["met", "partly-read", "partial", "unknown"]);
    expect(Object.keys(ASSURANCE_GRADE_LABEL)).toEqual([...ASSURANCE_GRADES]);
    expect(Object.keys(ASSURANCE_GRADE_STATE)).toEqual([...ASSURANCE_GRADES]);
  });

  it("draws in the RAG palette, so one page looks like one thing", () => {
    expect(ASSURANCE_GRADE_STATE.met).toBe("green");
    // Amber and not red: none of the four criteria is a disqualifier on its own.
    expect(ASSURANCE_GRADE_STATE.partial).toBe("amber");
    // Slate, on `rag.ts`'s own rule — a half-read question must not be coloured warm.
    expect(ASSURANCE_GRADE_STATE.unknown).toBe("cannot_assess");
  });

  it("colours an unread criterion slate rather than green or amber", () => {
    // Green would be the old bug in a new colour, and amber would blame a failed org-wide call on the team that
    // owns the repository. Nothing about the repository is wanting; a half of the question could not be read.
    expect(ASSURANCE_GRADE_STATE["partly-read"]).toBe("cannot_assess");
    expect(ASSURANCE_GRADE_STATE["partly-read"]).not.toBe(ASSURANCE_GRADE_STATE.met);
    expect(ASSURANCE_GRADE_STATE["partly-read"]).not.toBe(ASSURANCE_GRADE_STATE.partial);
  });

  it("names a column per criterion, in the criteria's own order", () => {
    expect(ASSURANCE_CRITERIA).toEqual(["named-owner", "automated-hygiene", "no-committed-secrets", "security-contact", "patching", "maintained"]);
    expect(ASSURANCE_CRITERIA.map((criterion) => ASSURANCE_LABEL[criterion])).toEqual([
      "Code owner",
      "Hygiene",
      "Secrets",
      "Security contact",
      // NAMED FOR THE CRITERION AND NOT THE FIELD: the column prints an age, but what a reader checks is whether
      // the team patches.
      "Patching cycle",
      "Maintained"
    ]);
  });

  it("explains Code owner as having an owner rather than as having a team", () => {
    // The rule the hint describes changed on 2026-09-15: an individual owner MEETS the criterion and only an
    // orphan fails it. A hint promising a team would contradict 217 of this estate's rows, which is what the
    // previous wording — "No if it is owned by an individual" — did.
    expect(ASSURANCE_HINT["named-owner"]).toContain("an owner at all");
    expect(ASSURANCE_HINT["named-owner"]).toContain("nothing owns it");
    expect(ASSURANCE_HINT["named-owner"]).not.toMatch(/No if it is owned by an individual/);
  });

  it("explains Maintained against the boundary the policy actually holds", () => {
    // `cohort.unmaintained_after_days` is one year from 2026-09-15. A hint saying two would tell a reader their
    // repository is fine for another year when the column has already flagged it.
    expect(ASSURANCE_HINT.maintained).toContain("within the last year");
    expect(ASSURANCE_HINT.maintained).not.toMatch(/two years/);
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

  it("sorts a partial read between a full one and a shortfall", () => {
    // Less assured than a repository read in full, and not a finding against the repository the way a criterion
    // read and failed is. The English words would sort it between "Meets criteria" and "Partly meets" by accident
    // and stop doing so the moment either is reworded.
    expect(assuranceOrder("met")).toBeLessThan(assuranceOrder("partly-read") as number);
    expect(assuranceOrder("partly-read")).toBeLessThan(assuranceOrder("partial") as number);
  });

  it("keeps a partly-read repository IN the order, unlike one nothing could be read for", () => {
    // Held back with `unknown` it would take most of the estate out of the column the moment one org-wide read
    // failed — and sorting by assurance is how a reader finds the repositories that fail.
    expect(assuranceOrder("partly-read")).toBeDefined();
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

describe("parseExpanded", () => {
  it("should name a parameter of its own when read beside the four filters", () => {
    // Expanding a column and narrowing the rows are different questions, and a control reading another's
    // parameter would answer one of them by accident.
    expect(EXPANDED_PARAMETER).toBe("hygiene");
    expect(VISIBILITIES.map(visibilityParameter)).not.toContain(EXPANDED_PARAMETER);
    expect(EXPANDED_PARAMETER).not.toBe(PRODUCTION_PARAMETER);
  });

  it("should read the value the toggle writes as expanded and everything else as collapsed", () => {
    // One spelling rather than truthiness, as the Production toggle reads: `?hygiene=0` is not an odd way of
    // saying yes.
    expect(parseExpanded(() => EXPANDED_VALUE)).toBe(true);
    expect(parseExpanded(() => null)).toBe(false);
    expect(parseExpanded(() => "")).toBe(false);
    expect(parseExpanded(() => "0")).toBe(false);
  });

  it("should read its own parameter and no other when another control carries the same value", () => {
    const query: Record<string, string> = { [PRODUCTION_PARAMETER]: EXPANDED_VALUE };
    expect(parseExpanded((parameter) => query[parameter] ?? null)).toBe(false);
    query[EXPANDED_PARAMETER] = EXPANDED_VALUE;
    expect(parseExpanded((parameter) => query[parameter] ?? null)).toBe(true);
  });

  it("should name the control after the action rather than after the column it opens", () => {
    // NOT "Hygiene checks", which is what it read until 2026-09-17: the column it expands is headed `Hygiene`
    // immediately to its left, so naming the button after its contents put the word on the page twice and left a
    // reader unable to tell the heading from the control.
    expect(EXPAND_LABEL).toBe("Expand");
  });
});

describe("HYGIENE_CHECKS", () => {
  /** One check's answer, found by the label its column carries rather than by position. */
  function answer(label: string, signals: AssuranceHygieneSignals): boolean | undefined {
    return HYGIENE_CHECKS.find((check) => check.label === label)?.read(signals);
  }

  it("should expand the hygiene criterion and no other, that being the only aggregate", () => {
    // `Assurance` sums the four graded criteria and each is already a column, so expanding it would draw them
    // twice; `patching` is one number and the other three are one signal apiece. This is the only column whose
    // "No" leaves a reader unable to say which control is missing.
    expect(HYGIENE_CRITERION).toBe("automated-hygiene");
    expect(ASSURANCE_CRITERIA).toContain(HYGIENE_CRITERION);
  });

  it("should draw four checks over five signals when the aggregate is expanded", () => {
    // FOUR AND NOT FIVE, because the two update signals are one requirement between them — which is the whole
    // reason the criterion is judged as a composite.
    expect(HYGIENE_CHECKS.map((check) => check.label)).toEqual(["Secret scanning", "Push protection", "Vulnerability alerts", "Dependency updates"]);
    for (const check of HYGIENE_CHECKS) {
      expect(check.hint.length).toBeGreaterThan(0);
    }
  });

  it("should read each single-signal check off its own signal when the report carries one", () => {
    // Crossed over, so a check wired to its neighbour's signal answers the other way round and fails.
    const signals: AssuranceHygieneSignals = { secret_scanning: true, push_protection: false, vulnerability_alerts: true };

    expect(answer("Secret scanning", signals)).toBe(true);
    expect(answer("Push protection", signals)).toBe(false);
    expect(answer("Vulnerability alerts", signals)).toBe(true);
  });

  it("should leave a check unread when the signal behind it is absent", () => {
    // ABSENT IS NOT FALSE: `hygieneFromMetadata` leaves every signal absent for a body it could not read, because
    // an unreadable response is not evidence that scanning is off.
    for (const check of HYGIENE_CHECKS) {
      expect(check.read({})).toBeUndefined();
      expect(check.read(undefined)).toBeUndefined();
    }
  });

  it("should meet the update requirement when either tool answers yes", () => {
    // THE BUG THE FOLD FIXED. Renovate does not turn GitHub's Dependabot setting on, so requiring both marked
    // down 244 repositories that keep their dependencies perfectly current. One tool doing the job is the
    // requirement met, whatever the other says — including where the other was never read.
    expect(answer("Dependency updates", { dependabot_security_updates: false, update_configuration: true })).toBe(true);
    expect(answer("Dependency updates", { dependabot_security_updates: true, update_configuration: false })).toBe(true);
    expect(answer("Dependency updates", { dependabot_security_updates: true, update_configuration: true })).toBe(true);
    expect(answer("Dependency updates", { update_configuration: true })).toBe(true);
  });

  it("should fail the update requirement only when both signals were read and both are off", () => {
    expect(answer("Dependency updates", { dependabot_security_updates: false, update_configuration: false })).toBe(false);
  });

  it("should leave the update requirement unread when one signal is off and the other was not read", () => {
    // The case that must not read as a finding: a repository whose Dependabot state is plainly off and whose
    // default branch could not be listed has not been shown to lack dependency updates.
    expect(answer("Dependency updates", { dependabot_security_updates: false })).toBeUndefined();
    expect(answer("Dependency updates", { update_configuration: false })).toBeUndefined();
  });
});

describe("hygieneSignals", () => {
  it("should find the signals a row's report carries", () => {
    const assured = row({
      repository: "hmcts/api",
      assurance: { grade: "partial", criteria: [], hygiene: { secret_scanning: true, push_protection: false } }
    });

    expect(hygieneSignals(assured)).toEqual({ secret_scanning: true, push_protection: false });
  });

  it("should find nothing when the row carries no assurance block, or one without signals", () => {
    // A repository nothing was collected for, and a row served by a build older than the field: both are unread
    // rather than a repository with its controls switched off.
    expect(hygieneSignals(row({ repository: "hmcts/old" }))).toBeUndefined();
    expect(hygieneSignals(row({ repository: "hmcts/older", assurance: { grade: "unknown", criteria: [] } }))).toBeUndefined();
  });
});

/**
 * The CVE columns, and the distinction they exist to keep: a repository nobody scanned is not a clean one.
 *
 * ROUGHLY 1,529 REPOSITORIES OF 1,890 HAVE NO PUBLISHED REPORT, because only three CNP builders publish one. So the
 * cheapest possible mistake here — folding that absence to `0` — would report four fifths of the estate as carrying
 * no critical CVEs when nothing has ever looked at it, and nothing on the page would say otherwise. Every case below
 * is ultimately about telling that dash from an earned zero.
 */
describe("the CVE columns", () => {
  /** A repository whose scan ran, with every band separated so a column reading its neighbour fails. */
  const SCANNED: RepositoryRow = row({
    repository: "hmcts/pcs-api",
    cves: {
      scanned_at: "2026-09-17T02:00:00Z",
      cves: {
        all: { total: 11, by_severity: { critical: 2, high: 3, medium: 1, low: 4, unknown: 1 } },
        live: { total: 7, by_severity: { critical: 2, high: 3, medium: 1, unknown: 1 } },
        suppressed: { total: 4, by_severity: { low: 4 } },
        occurrences: 96
      }
    }
  });

  /** A repository whose scan ran and found nothing: an earned zero in every column. */
  const CLEAN: RepositoryRow = row({
    repository: "hmcts/clean",
    cves: {
      scanned_at: "2026-09-17T02:00:00Z",
      cves: { all: { total: 0, by_severity: {} }, live: { total: 0, by_severity: {} }, suppressed: { total: 0, by_severity: {} }, occurrences: 0 }
    }
  });

  /** A repository nobody has scanned, carrying the reason instead of the figures. */
  const UNSCANNED: RepositoryRow = row({
    repository: "hmcts/unscanned",
    cves: { detail: "no CVE report has been published for this repository" }
  });

  /** The count a named column reads off a row, found by its heading as the table's cells are. */
  function count(heading: string, subject: RepositoryRow): number | undefined {
    const column = [CVE_AGGREGATE, ...CVE_COLUMNS].find((entry) => entry.label === heading);
    return cveCount(subject, column as CveColumn);
  }

  it("should break the aggregate into Total, Crit, High, Other and Suppressed, in that order", () => {
    expect(CVE_COLUMNS.map((column) => column.label)).toEqual(["Total", "Crit", "High", "Other", "Suppressed"]);
  });

  it("should head the aggregate with the suppression state spelled out in full", () => {
    // "Critical CVEs" would be read as every critical the scan found, and the two figures disagree: a team that has
    // reviewed and accepted a finding has done the work, and counting it here reports that judgement as a risk.
    expect(CVE_AGGREGATE.label).toBe("Unsuppressed Crit CVEs");
  });

  it("should count only unsuppressed findings in Total, Crit, High and Other when a scan has run", () => {
    expect(count("Total", SCANNED)).toBe(7);
    expect(count("Crit", SCANNED)).toBe(2);
    expect(count("High", SCANNED)).toBe(3);
    // Medium, low and unstated together: one medium, no live low, one of unstated severity.
    expect(count("Other", SCANNED)).toBe(2);
  });

  it("should add Crit, High and Other up to Total, so a reader can sum the row", () => {
    // THE ARITHMETIC THE BREAKDOWN PROMISES. `unknown` is counted in `Other` rather than dropped for this reason:
    // leaving those findings out would make Total larger than its own parts with nothing on the page to explain it.
    for (const subject of [SCANNED, CLEAN]) {
      const parts = ["Crit", "High", "Other"].reduce((running, heading) => running + (count(heading, subject) ?? 0), 0);
      expect(parts).toBe(count("Total", subject));
    }
  });

  it("should count the suppressed findings beside the live ones rather than among them", () => {
    // Four suppressed lows, which are in neither `Total` nor `Other`: reviewed and accepted is not outstanding.
    expect(count("Suppressed", SCANNED)).toBe(4);
    expect(count("Other", SCANNED)).toBe(2);
  });

  it("should repeat the aggregate in Crit, the two counting one figure", () => {
    // DELIBERATE, on the Hygiene column's rule: the aggregate keeps its place and the parts are drawn beside it.
    // They are one definition spread into two columns, so they cannot come to count different things.
    expect(count("Crit", SCANNED)).toBe(count("Unsuppressed Crit CVEs", SCANNED));
    expect(CVE_AGGREGATE.severities).toEqual(["critical"]);
  });

  it("should count a band with no findings as zero when the scan ran", () => {
    // A band with nothing in it is ABSENT from `by_severity`, and a `CveCount` only exists inside a report with a
    // scan behind it — so an empty band is a measured nothing and the one place `?? 0` is right.
    for (const column of [CVE_AGGREGATE, ...CVE_COLUMNS]) {
      expect(cveCount(CLEAN, column)).toBe(0);
    }
  });

  it("should count nothing at all for a repository no scan has run against", () => {
    // NOT ZERO. This is the mistake the whole feature is built to avoid, and it is the majority case on the estate.
    for (const column of [CVE_AGGREGATE, ...CVE_COLUMNS]) {
      expect(cveCount(UNSCANNED, column)).toBeUndefined();
    }
  });

  it("should count nothing for a row served by a deployment older than the field", () => {
    // An absent `cves` says the report layer predates it and nothing about the repository — `RepositoryRow.cves`
    // documents that, and it takes the same fallback as a published reason: unmeasured.
    expect(cveCount(row({ repository: "hmcts/old" }), CVE_AGGREGATE)).toBeUndefined();
    expect(cveEvidence(row({ repository: "hmcts/old" }))).toBeUndefined();
  });

  it("should find the figures where a scan ran and nothing where one has not", () => {
    expect(cveEvidence(SCANNED)?.live.total).toBe(7);
    expect(cveEvidence(UNSCANNED)).toBeUndefined();
  });

  it("should carry the report's own reason for a dash, and none where the figures arrived", () => {
    // Exactly one of the figures and the reason arrives, so a counted cell hovers nothing rather than an empty bubble.
    expect(cveDetail(UNSCANNED)).toBe("no CVE report has been published for this repository");
    expect(cveDetail(SCANNED)).toBeUndefined();
    expect(cveDetail(row({ repository: "hmcts/old" }))).toBeUndefined();
  });

  it("should sort the most findings first, so one ascending click opens on the worst", () => {
    // NEGATED, which is `findingOrder`'s rule applied to a number: the useful end of the column must not need two
    // clicks. `answerOrder`'s columns do the same thing for a Yes/No answer.
    const read = (subject: RepositoryRow) => cveOrder(cveCount(subject, CVE_AGGREGATE));

    expect(sorted([CLEAN, SCANNED], read, "ascending").map((subject) => subject.repository)).toEqual(["hmcts/pcs-api", "hmcts/clean"]);
  });

  it("should hold an unscanned repository back from both ends of the order", () => {
    // `sorted`'s own rule, which this column is exactly the case for: "which carries the most live criticals" is a
    // question about the repositories somebody scanned, and one nobody scanned is not the answer to it either way up.
    const read = (subject: RepositoryRow) => cveOrder(cveCount(subject, CVE_AGGREGATE));

    expect(sorted([UNSCANNED, CLEAN, SCANNED], read, "ascending").at(-1)?.repository).toBe("hmcts/unscanned");
    expect(sorted([UNSCANNED, CLEAN, SCANNED], read, "descending").at(-1)?.repository).toBe("hmcts/unscanned");
  });

  it("should carry a hint on every column, the dash and the zero named in the aggregate's", () => {
    // The dash is the whole reason this column can be misread, so the hint beside the heading has to say what it
    // means rather than leaving a reader to infer that an unscanned repository is a clean one.
    for (const column of [CVE_AGGREGATE, ...CVE_COLUMNS]) {
      expect(column.hint.length).toBeGreaterThan(0);
    }
    expect(CVE_AGGREGATE.hint).toContain("unmeasured rather than clean");
    expect(CVE_AGGREGATE.hint).toContain("0 means a scan ran and found none");
  });
});
