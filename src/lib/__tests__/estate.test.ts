/**
 * The four estate wheels: what each slice counts, and that the four of them still count the estate.
 *
 * THE FIGURES ARE THE CLAIM, so they are asserted rather than rendered and eyeballed. The previous charts on this
 * page included one drawn over a field the report layer has never emitted, which produced an all-unknown circle
 * that looked like a chart and said nothing — and nothing could have caught that from the markup, because an
 * all-unknown ring renders perfectly. So the arithmetic is a pure function of rows and this file holds it against
 * the distribution measured on AAT on 2026-09-22 over 1,046 public unarchived repositories:
 *
 *   Code owner         team 904   individual 54    nobody 88
 *   Maintained         maintained 909   unmaintained 137
 *   Code scanning      on 164   off 623   no state stated 259
 *   Unsuppressed CVEs  reported clean 214   at least one live CVE 64   no report 768
 *
 * THE CVE ROW MOVES AND THE OTHER THREE DO NOT. Re-reading the same estate through this code gives 215 reported
 * clean and 767 with no report — one repository across the boundary, with the live count unchanged at 64, which is
 * what ONE NEWLY PUBLISHED CLEAN REPORT looks like and not a difference in how a row is classified. The figures
 * above are kept as the measurement they were taken as. If this ever drifts by more than a repository or two, or
 * drifts in the live slice, the thing to suspect is `cveEvidence` rather than the estate.
 *
 * THE FIXTURE IS BUILT BY INDEX rather than transcribed, because the four dimensions are independent of each other:
 * one repository is team-owned, maintained, has code scanning off and has no CVE report, and there is no
 * correlation between the four for a fixture to preserve. Assigning each dimension its own index boundaries
 * reproduces all four distributions over one set of rows, which is what the wheels are drawn over.
 *
 * WHAT THE FIXTURE CANNOT PROVE, and what the cases after it do: that a row in a given state lands in the slice it
 * belongs to. The traps are all absences — a scan read and found clean is not a scan nobody ran, a CVE report
 * whose totals are zero is not the absence of a report, and an unread `owner_kind` is not an unowned repository —
 * so each of those is a case of its own with the row spelled out.
 */

import { describe, expect, it } from "vitest";
import { dimensionSlices, totalValue } from "@/lib/chart";
import {
  CVE_PARAMETER,
  ESTATE_DIMENSIONS,
  type EstateDimension,
  filterRepositories,
  MAINTAINED_PARAMETER,
  matchesSelections,
  OWNER_PARAMETER,
  parseSelections,
  productionCount,
  publicRepositories,
  SCANNING_PARAMETER,
  scanState,
  unowned
} from "@/lib/rows";
import type { CveEvidence, OpenAlertCount, RepositoryRow } from "@/lib/types";

/** The cohort the wheels were measured over. */
const PUBLIC_REPOSITORIES = 1046;

/** What GitHub says when a family was never switched on — the sentence `scanState` is the reader of. */
const NOT_ENABLED = "code-scanning/alerts is not enabled for this repository";

/** A code-scanning count block for a family that WAS read, whatever it found. */
function read(open: number): OpenAlertCount {
  return { open, by_severity: {} };
}

/** A CVE position with a stated number of unsuppressed findings, which `0` is a real answer for. */
function scanned(live: number): CveEvidence {
  return {
    all: { total: live, by_severity: {} },
    live: { total: live, by_severity: {} },
    suppressed: { total: 0, by_severity: {} },
    occurrences: live
  };
}

/**
 * One row of the fixture, in the state its index puts it in.
 *
 * Each boundary is a running total of the measured figures above, so the four distributions are read straight off
 * the table rather than computed from percentages.
 */
function row(index: number): RepositoryRow {
  return {
    repository: `repository-${index}`,
    team: "dtsse",
    visibility: "public",
    // 904 team, then 54 individual, then 88 with nothing owning them.
    owner_kind: index < 904 ? "team" : index < 958 ? "person" : "none",
    // 909 maintained, then 137 not.
    unmaintained: index >= 909,
    // 164 read, then 623 answered "not enabled", then 259 that said nothing either way.
    security: {
      dependabot: { by_severity: {} },
      code_scanning: index < 164 ? read(index % 3) : index < 787 ? { by_severity: {}, detail: NOT_ENABLED } : { by_severity: {} },
      secret_scanning: { by_severity: {} }
    },
    // 214 reported clean, then 64 carrying live findings, then 768 with no report published at all.
    cves: index < 214 ? { cves: scanned(0) } : index < 278 ? { cves: scanned(1 + (index % 4)) } : { detail: "no CVE report has been published" }
  };
}

const ESTATE: RepositoryRow[] = Array.from({ length: PUBLIC_REPOSITORIES }, (_, index) => row(index));

/** One wheel by the parameter it filters on, refusing rather than silently measuring the wrong one. */
function wheel(parameter: string): EstateDimension {
  const found = ESTATE_DIMENSIONS.find((dimension) => dimension.parameter === parameter);
  if (found === undefined) {
    throw new Error(`no estate wheel filters on ${parameter}`);
  }
  return found;
}

/** What one wheel counts over the estate, keyed by slice so the assertion names the slice it is about. */
function counted(parameter: string, rows: readonly RepositoryRow[] = ESTATE): Record<string, number> {
  return Object.fromEntries(dimensionSlices(wheel(parameter), rows).map((slice) => [slice.key, slice.value]));
}

/** A single public row, for the cases where one row's state is the whole question. */
function only(fields: Partial<RepositoryRow>): RepositoryRow[] {
  return [{ repository: "one", team: "dtsse", visibility: "public", ...fields }];
}

describe("the estate summary wheels", () => {
  it("should count the code owner distribution measured on the public estate", () => {
    expect(counted(OWNER_PARAMETER)).toEqual({ team: 904, individual: 54, nobody: 88 });
  });

  it("should count the maintained distribution measured on the public estate", () => {
    // Two states on this estate and a third slice drawn at zero — see the wheel's own comment for why the slice
    // exists rather than the row being dropped from the total.
    expect(counted(MAINTAINED_PARAMETER)).toEqual({ maintained: 909, unmaintained: 137, unstated: 0 });
  });

  it("should count the code scanning distribution measured on the public estate", () => {
    expect(counted(SCANNING_PARAMETER)).toEqual({ on: 164, off: 623, unstated: 259 });
  });

  it("should count the unsuppressed CVE distribution measured on the public estate", () => {
    expect(counted(CVE_PARAMETER)).toEqual({ clean: 214, live: 64, unreported: 768 });
  });

  it("should put every repository in exactly one slice of every wheel", () => {
    // THE PROPERTY THE STATED DENOMINATOR RESTS ON. A row falling through every slice of a wheel would be counted
    // nowhere, and the wheel would under-total against the figure printed beside the heading with nothing on the
    // page to say so.
    for (const dimension of ESTATE_DIMENSIONS) {
      expect(totalValue(dimensionSlices(dimension, ESTATE))).toBe(PUBLIC_REPOSITORIES);
    }
  });

  it("should put a row with every optional field absent in exactly one slice of every wheel", () => {
    // The same property where nothing has been read: a deployment older than any of these fields must still be
    // counted once per wheel rather than vanishing out of the total.
    for (const dimension of ESTATE_DIMENSIONS) {
      expect(totalValue(dimensionSlices(dimension, only({})))).toBe(1);
    }
  });

  it("should order every wheel's slices best first with the unmeasured one last", () => {
    // The colours then run green, amber, slate in the same order on all four, which is what lets four wheels side
    // by side be read as one thing.
    for (const dimension of ESTATE_DIMENSIONS) {
      expect(dimension.slices[0]?.state).toBe("green");
      expect(dimension.slices.at(-1)?.state).toBe(dimension.parameter === OWNER_PARAMETER ? "red" : "none");
    }
  });

  it("should draw every wheel in the RAG palette rather than a scheme of its own", () => {
    const palette = new Set(["#4ade80", "#fbbf24", "#f87171", "#64748b"]);
    for (const dimension of ESTATE_DIMENSIONS) {
      for (const slice of dimensionSlices(dimension, ESTATE)) {
        expect(palette.has(slice.color)).toBe(true);
      }
    }
  });

  it("should label every wheel and every slice, so no wedge is identified by colour alone", () => {
    for (const dimension of ESTATE_DIMENSIONS) {
      expect(dimension.title).not.toBe("");
      expect(dimension.hint).not.toBe("");
      for (const slice of dimension.slices) {
        expect(slice.label).not.toBe("");
      }
    }
  });
});

describe("the wheels' unmeasured slices", () => {
  it("should count a scan read and found clean as on rather than as unmeasured", () => {
    // `open: 0` is the measured zero the whole three-state answer exists for: somebody looked and there was
    // nothing. Folding it in with the repositories nobody looked at is the one wrong answer that reads as news.
    expect(
      counted(SCANNING_PARAMETER, only({ security: { dependabot: { by_severity: {} }, code_scanning: read(0), secret_scanning: { by_severity: {} } } }))
    ).toEqual({ on: 1, off: 0, unstated: 0 });
  });

  it("should count a family with no count and no sentence as no state stated rather than as off", () => {
    expect(
      counted(
        SCANNING_PARAMETER,
        only({ security: { dependabot: { by_severity: {} }, code_scanning: { by_severity: {} }, secret_scanning: { by_severity: {} } } })
      )
    ).toEqual({ on: 0, off: 0, unstated: 1 });
  });

  it("should count a row with no alert block at all as no state stated", () => {
    // The uncollected branch of the report emits no `security` — every column the table draws for it is empty, and
    // this wheel must say the same rather than reporting the control off.
    expect(counted(SCANNING_PARAMETER, only({}))).toEqual({ on: 0, off: 0, unstated: 1 });
  });

  it("should count a CVE report whose unsuppressed total is zero as reported clean", () => {
    expect(counted(CVE_PARAMETER, only({ cves: { cves: scanned(0) } }))).toEqual({ clean: 1, live: 0, unreported: 0 });
  });

  it("should count a repository with no published report as having no report rather than as clean", () => {
    // THE THREE-QUARTERS CASE. A repository with no Java, Node or Python dependency tree has nothing for that
    // stage to scan and Dependabot may be watching it regardless, so this is neither a good answer nor a bad one.
    expect(counted(CVE_PARAMETER, only({ cves: { detail: "no CVE report has been published for this repository" } }))).toEqual({
      clean: 0,
      live: 0,
      unreported: 1
    });
    expect(counted(CVE_PARAMETER, only({}))).toEqual({ clean: 0, live: 0, unreported: 1 });
  });

  it("should count an unread owner kind as a team rather than as unowned", () => {
    // `ownedByIndividual`'s rule, in the direction it documents: absence means a deployment older than the field,
    // and the other reading would report most of the estate as belonging to nobody.
    expect(counted(OWNER_PARAMETER, only({}))).toEqual({ team: 1, individual: 0, nobody: 0 });
    expect(unowned({})).toBe(false);
  });

  it("should count a row with no maintenance answer in the stated-nothing slice rather than as maintained", () => {
    expect(counted(MAINTAINED_PARAMETER, only({}))).toEqual({ maintained: 0, unmaintained: 0, unstated: 1 });
  });
});

describe("scanState", () => {
  it("should read a family as read when it carries a count, whatever the sentence beside it says", () => {
    expect(scanState({ open: 0, by_severity: {}, detail: NOT_ENABLED })).toBe("read");
    expect(scanState({ open: 7, by_severity: {} })).toBe("read");
  });

  it("should read a family as not enabled only from the sentence the collector writes for it", () => {
    expect(scanState({ by_severity: {}, detail: NOT_ENABLED })).toBe("not-enabled");
    expect(scanState({ by_severity: {}, detail: "code-scanning/alerts could not be read for the organisation" })).toBe("unmeasured");
  });

  it("should read a family with no count and no block as unmeasured", () => {
    expect(scanState({ by_severity: {} })).toBe("unmeasured");
    expect(scanState(undefined)).toBe("unmeasured");
  });
});

describe("publicRepositories", () => {
  it("should keep the public rows and drop the internal and the private ones", () => {
    const mixed: RepositoryRow[] = [
      { repository: "open", team: "dtsse", visibility: "public" },
      { repository: "inner", team: "dtsse", visibility: "internal" },
      { repository: "closed", team: "dtsse", visibility: "private" }
    ];

    expect(publicRepositories(mixed).map((entry) => entry.repository)).toEqual(["open"]);
  });

  it("should drop a row whose visibility nobody read, unlike the table's own filter", () => {
    // The opposite direction from `matchesVisibility`, and right for the opposite reason: a figure whose whole
    // claim is that every member is public cannot hold a repository whose visibility is unknown.
    expect(publicRepositories([{ repository: "unstated", team: "dtsse" }])).toEqual([]);
  });
});

describe("the wedge filter", () => {
  const ROWS: RepositoryRow[] = [
    { repository: "owned", team: "dtsse", visibility: "public", owner_kind: "team", unmaintained: false, production: true },
    { repository: "orphan", team: "unowned", visibility: "public", owner_kind: "none", unmaintained: false },
    { repository: "stale", team: "dtsse", visibility: "public", owner_kind: "team", unmaintained: true, production: true }
  ];

  /** The reader's query, as the parameters a component would read off it. */
  function query(search: string) {
    const parameters = new URLSearchParams(search);
    return (parameter: string) => parameters.get(parameter);
  }

  function shown(search: string): string[] {
    return filterRepositories(ROWS, "", false, undefined, parseSelections(query(search))).map((entry) => entry.repository);
  }

  it("should narrow the list to the slice a reader clicked", () => {
    expect(shown(`${OWNER_PARAMETER}=nobody`)).toEqual(["orphan"]);
    expect(shown(`${MAINTAINED_PARAMETER}=unmaintained`)).toEqual(["stale"]);
  });

  it("should stack two wedges as an AND rather than replacing one with the other", () => {
    expect(shown(`${OWNER_PARAMETER}=team&${MAINTAINED_PARAMETER}=maintained`)).toEqual(["owned"]);
    expect(shown(`${OWNER_PARAMETER}=nobody&${MAINTAINED_PARAMETER}=unmaintained`)).toEqual([]);
  });

  it("should show the whole list when no wedge has been clicked", () => {
    expect(shown("")).toEqual(["owned", "orphan", "stale"]);
  });

  it("should ignore a slice key no wheel has rather than emptying the table", () => {
    // A stale or mistyped URL shows the estate, not an empty list for a filter the reader cannot see.
    expect(shown(`${OWNER_PARAMETER}=nobody-at-all`)).toEqual(["owned", "orphan", "stale"]);
    expect(parseSelections(query(`${OWNER_PARAMETER}=nobody-at-all`)).size).toBe(0);
  });

  it("should read only the wheels' own parameters off the query", () => {
    const selections = parseSelections(query(`weeks=12&repository=pcs&${OWNER_PARAMETER}=team&${CVE_PARAMETER}=unreported`));

    expect([...selections]).toEqual([
      [OWNER_PARAMETER, "team"],
      [CVE_PARAMETER, "unreported"]
    ]);
  });

  it("should match every row when nothing is selected", () => {
    expect(ROWS.every((entry) => matchesSelections(entry, new Map()))).toBe(true);
  });

  it("should count the production repositories a clicked wedge leaves, so the toggle says what it would do", () => {
    // The toggle's count reflects the reader's OTHER controls, and a wedge is now one of them: two of these three
    // rows deploy to production, and one of those two is unmaintained.
    expect(productionCount(ROWS, "", undefined, parseSelections(query("")))).toBe(2);
    expect(productionCount(ROWS, "", undefined, parseSelections(query(`${MAINTAINED_PARAMETER}=unmaintained`)))).toBe(1);
  });
});
