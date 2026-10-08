/**
 * The estate wheels: what each slice counts, and that every one of them still counts its cohort.
 *
 * THE FIGURES ARE THE CLAIM, so they are asserted rather than rendered and eyeballed. The previous charts on this
 * page included one drawn over a field the report layer has never emitted, which produced an all-unknown circle
 * that looked like a chart and said nothing — and nothing could have caught that from the markup, because an
 * all-unknown ring renders perfectly. So the arithmetic is a pure function of rows and this file holds it against
 * the distribution measured on AAT on 2026-09-22 over 1,049 public unarchived repositories:
 *
 *   Code owner       team 907   individual 54   nobody 88
 *   Maintained       maintained 913   unmaintained 136   no state stated 0
 *   Hygiene          all signals on 831   one or more off 218   no state stated 0
 *   Vulnerabilities  clear 710   live 255 (high + medium)   unscanned 84
 *
 * AGAINST A FIXTURE AND NEVER AGAINST LIVE DATA, because the estate moves under the assertion. The public cohort
 * was 1,046 on the morning of 2026-09-22 and 1,049 the same afternoon, and the wheel that used to stand where
 * `Vulnerabilities` does drifted by one repository between two readings hours apart. A test reading AAT would fail
 * on the estate changing, which is the one thing it must not report as a defect in this code.
 *
 * THE FIXTURE IS BUILT BY INDEX rather than transcribed, because the four dimensions are independent of each other:
 * one repository is team-owned, maintained, passes hygiene and is scanned by Dependabot alone, and there is no
 * correlation between the four for a fixture to preserve. Assigning each dimension its own index boundaries
 * reproduces all four distributions over one set of rows, which is what the wheels are drawn over.
 *
 * WHAT THE FIXTURE CANNOT PROVE, and what the cases after it do: that a row in a given state lands in the slice it
 * belongs to. The traps are all absences and all near-misses — a source that read a repository and found nothing is
 * not a source that never read it, a repository Renovate keeps current has met the dependency-updates requirement
 * Dependabot's own switch is off for, and an unread `owner_kind` is not an unowned repository — so each of those is
 * a case of its own with the row spelled out.
 */

import { describe, expect, it } from "vitest";
import { dimensionSlices, totalValue } from "@/lib/chart";
import { STRONG_GOOD_HEX } from "@/lib/rag";
import {
  CHECKS_PARAMETER,
  COVERAGE_PARAMETER,
  cohortRows,
  ESTATE_DIMENSIONS,
  type EstateDimension,
  EXPANDED_PARAMETER,
  filterRepositories,
  HYGIENE_CHECKS,
  hygieneSignals,
  LABEL_PARAMETER,
  MAINTAINED_PARAMETER,
  matchesSelections,
  OWNER_PARAMETER,
  parseSelections,
  productionCount,
  publicRepositories,
  REVIEW_PARAMETER,
  SIGNALS_PARAMETER,
  unowned,
  VULNERABILITY_PARAMETER
} from "@/lib/rows";
import type { AssuranceHygieneSignals, CveCount, CveEvidence, OpenAlertCount, RepositoryRow, SecurityAlertEvidence } from "@/lib/types";
import { UNCOLLECTED_DETAIL } from "@/lib/types";

/** The cohort the wheels were measured over. */
const PUBLIC_REPOSITORIES = 1049;

/** The report's own words where no dependency-scan report has ever been published for a repository. */
const NO_CVE_REPORT = "no CVE report has been published for this repository";

/** A Dependabot count block for a repository Dependabot IS watching, whatever it found — `0` is a real answer. */
function watching(open: number, bySeverity: OpenAlertCount["by_severity"] = {}): OpenAlertCount {
  return { open, by_severity: bySeverity };
}

/**
 * The alert block, with Dependabot either watching this repository or not.
 *
 * The other two families are always unread here. This wheel reads Dependabot alone — code scanning and secret
 * scanning are not dependency scans, and secret scanning's own state reaches the reader through `Hygiene`.
 */
function alerts(dependabot: OpenAlertCount): SecurityAlertEvidence {
  return { dependabot, code_scanning: { by_severity: {} }, secret_scanning: { by_severity: {} } };
}

/** A CVE position with a stated number of unsuppressed findings, which `0` is a real answer for. */
function scanned(live: number, bySeverity: CveCount["by_severity"] = {}): CveEvidence {
  return {
    all: { total: live, by_severity: bySeverity },
    live: { total: live, by_severity: bySeverity },
    suppressed: { total: 0, by_severity: {} },
    occurrences: live
  };
}

/** Every hygiene signal on, which is the only combination the wheel counts as a pass. */
const ALL_SIGNALS_ON: AssuranceHygieneSignals = {
  secret_scanning: true,
  push_protection: true,
  vulnerability_alerts: true,
  dependabot_security_updates: true,
  update_configuration: true
};

/** A row's assurance block carrying the stated signals, with the grade the wheels do not read. */
function withSignals(hygiene: AssuranceHygieneSignals): RepositoryRow["assurance"] {
  return { grade: "unknown", criteria: [], hygiene };
}

/**
 * The hygiene signals index `index` is given, passing below the boundary and failing above it.
 *
 * THE PASSING ROWS DO NOT ALL CARRY BOTH UPDATE SIGNALS, and that is the fixture's sharpest property rather than
 * decoration. A third of them have Dependabot security updates off with an update configuration present — the
 * repository Renovate keeps current — and another third the reverse. Counting the five raw signals instead of the
 * four checks would fail every one of those and take the pass count from 831 to about a third of it, which is the
 * real difference the `either` merge makes and the reason this fixture is built to expose it.
 *
 * The failing rows fail a DIFFERENT check by rotation, and the dependency-updates one needs BOTH of its signals off
 * — one off and the other on is a pass, which the case below asserts on its own.
 */
function signals(index: number, passing: boolean): AssuranceHygieneSignals {
  if (passing) {
    switch (index % 3) {
      case 0:
        return ALL_SIGNALS_ON;
      case 1:
        return { ...ALL_SIGNALS_ON, dependabot_security_updates: false };
      default:
        return { ...ALL_SIGNALS_ON, update_configuration: false };
    }
  }
  switch (index % 4) {
    case 0:
      return { ...ALL_SIGNALS_ON, secret_scanning: false };
    case 1:
      return { ...ALL_SIGNALS_ON, push_protection: false };
    case 2:
      return { ...ALL_SIGNALS_ON, vulnerability_alerts: false };
    default:
      return { ...ALL_SIGNALS_ON, dependabot_security_updates: false, update_configuration: false };
  }
}

/**
 * What the two vulnerability sources hold for index `index`, given which slice it belongs to.
 *
 * EVERY ROW IS READ BY ONE SOURCE OR THE OTHER OR BOTH, by rotation, because the whole point of the combined wheel
 * is the repositories only one of the two covers. A third of each populated slice is Jenkins with no Dependabot, a
 * third is Dependabot with no Jenkins report — the 686 the old wheel drew as unmeasured — and a third is both.
 *
 * THE HIGH/MEDIUM SPLIT IS THE FIXTURE'S OWN and not a measurement: the 255 live rows were measured before the wheel
 * read severity. Every live finding is graded high, or none of them is, so the even rows land in `high` and the odd
 * ones in `medium`.
 */
function vulnerabilities(index: number, slice: "clear" | "high" | "medium" | "unscanned"): Pick<RepositoryRow, "cves" | "security"> {
  if (slice === "unscanned") {
    return { cves: { detail: NO_CVE_REPORT }, security: alerts({ by_severity: {} }) };
  }
  const findings = slice === "clear" ? 0 : 1 + (index % 4);
  const band = slice === "high" ? { high: findings } : slice === "medium" ? { medium: findings } : {};
  switch (index % 3) {
    case 0:
      return { cves: { cves: scanned(findings, band) }, security: alerts({ by_severity: {} }) };
    case 1:
      return { cves: { detail: NO_CVE_REPORT }, security: alerts(watching(findings, band)) };
    default:
      return { cves: { cves: scanned(findings, band) }, security: alerts(watching(findings, band)) };
  }
}

/** Which vulnerability slice index `index` belongs to: 710 clear, 255 live split by parity, then 84 unscanned. */
function vulnerabilitySlice(index: number): "clear" | "high" | "medium" | "unscanned" {
  if (index < 710) {
    return "clear";
  }
  if (index < 965) {
    return index % 2 === 0 ? "high" : "medium";
  }
  return "unscanned";
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
    // 907 team, then 54 individual, then 88 with nothing owning them.
    owner_kind: index < 907 ? "team" : index < 961 ? "person" : "none",
    // 913 maintained, then 136 not.
    unmaintained: index >= 913,
    // 831 with every signal on, then 218 with one check off.
    assurance: withSignals(signals(index, index < 831)),
    // 710 clear on what read them, then 255 carrying live findings, then 84 neither source reads.
    ...vulnerabilities(index, vulnerabilitySlice(index))
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
    expect(counted(OWNER_PARAMETER)).toEqual({ team: 907, individual: 54, nobody: 88 });
  });

  it("should count the maintained distribution measured on the public estate", () => {
    // Two states on this estate and a third slice drawn at zero — see the wheel's own comment for why the slice
    // exists rather than the row being dropped from the total.
    expect(counted(MAINTAINED_PARAMETER)).toEqual({ maintained: 913, unmaintained: 136, unstated: 0 });
  });

  it("should count the hygiene distribution measured on the public estate", () => {
    expect(counted(SIGNALS_PARAMETER)).toEqual({ pass: 831, fail: 218, unstated: 0 });
  });

  it("should count the combined vulnerability distribution measured on the public estate", () => {
    // 128 even indices and 127 odd ones between 710 and 964 — the 255 live rows, split as `vulnerabilitySlice` says.
    expect(counted(VULNERABILITY_PARAMETER)).toEqual({ high: 128, medium: 127, clear: 710, unscanned: 84 });
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

  it("should order every wheel's slices best first with the unmeasured one last, except Vulnerabilities", () => {
    // The colours then run green, amber, slate in the same order on the stewardship wheels, which is what lets them
    // be read side by side. `Vulnerabilities` runs by severity, worst first — see its own case.
    for (const dimension of ESTATE_DIMENSIONS) {
      expect(dimension.slices[0]?.state).toBe(dimension.parameter === VULNERABILITY_PARAMETER ? "red" : "green");
      expect(dimension.slices.at(-1)?.state).toBe(dimension.parameter === OWNER_PARAMETER ? "red" : "none");
    }
  });

  it("should draw every wheel in the RAG palette rather than a scheme of its own, save the one stronger green", () => {
    const palette = new Set(["#4ade80", "#fbbf24", "#f87171", "#64748b"]);
    for (const dimension of ESTATE_DIMENSIONS) {
      for (const slice of dimensionSlices(dimension, ESTATE)) {
        const multiple = dimension.parameter === REVIEW_PARAMETER && slice.key === "multiple";
        expect(multiple ? slice.color === STRONG_GOOD_HEX : palette.has(slice.color)).toBe(true);
      }
    }
  });

  it("should filter on a parameter no other control on the page writes", () => {
    // `EXPANDED_PARAMETER` IS ALSO `hygiene`, and the wheel of that name must not write it. A stale value is
    // harmless either way — `parseSelections` ignores a key no slice has — but a wedge writing `hygiene=pass` over
    // the toggle's `hygiene=true` would COLLAPSE the aggregate columns as a side effect of filtering the list,
    // which is one control silently undoing another. Hence `signals`.
    const parameters = ESTATE_DIMENSIONS.map((dimension) => dimension.parameter);

    expect(parameters).not.toContain(EXPANDED_PARAMETER);
    expect(new Set(parameters).size).toBe(parameters.length);
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

describe("the hygiene wheel", () => {
  it("should count a repository with every signal on as passing", () => {
    expect(counted(SIGNALS_PARAMETER, only({ assurance: withSignals(ALL_SIGNALS_ON) }))).toEqual({ pass: 1, fail: 0, unstated: 0 });
  });

  it("should count a repository Renovate keeps current as passing when Dependabot's own switch is off", () => {
    // THE 290-REPOSITORY CASE, and the reason the wheel counts four checks rather than five signals: Renovate does
    // not turn GitHub's Dependabot setting on, so a rule requiring both would mark down a repository whose
    // dependencies are perfectly current. Measured over the public estate, that rule reads 541 passes where this
    // one reads 831.
    expect(counted(SIGNALS_PARAMETER, only({ assurance: withSignals({ ...ALL_SIGNALS_ON, dependabot_security_updates: false }) }))).toEqual({
      pass: 1,
      fail: 0,
      unstated: 0
    });
    expect(counted(SIGNALS_PARAMETER, only({ assurance: withSignals({ ...ALL_SIGNALS_ON, update_configuration: false }) }))).toEqual({
      pass: 1,
      fail: 0,
      unstated: 0
    });
  });

  it("should count a repository with neither update tool as failing", () => {
    // The requirement is that SOMETHING updates the dependencies, so it takes both being off to fail it.
    expect(
      counted(SIGNALS_PARAMETER, only({ assurance: withSignals({ ...ALL_SIGNALS_ON, dependabot_security_updates: false, update_configuration: false }) }))
    ).toEqual({ pass: 0, fail: 1, unstated: 0 });
  });

  it("should count a repository with one signal off as failing however many are on", () => {
    for (const signal of ["secret_scanning", "push_protection", "vulnerability_alerts"] as const) {
      expect(counted(SIGNALS_PARAMETER, only({ assurance: withSignals({ ...ALL_SIGNALS_ON, [signal]: false }) }))).toEqual({
        pass: 0,
        fail: 1,
        unstated: 0
      });
    }
  });

  it("should count a repository with a signal off and another unreadable as failing rather than as unstated", () => {
    // A NO BEATS AN UNREADABLE. The control was read and is off, and no answer that could not be read will turn it
    // back on — so this is a failure with a gap in the evidence, not a repository nothing is known about.
    expect(counted(SIGNALS_PARAMETER, only({ assurance: withSignals({ secret_scanning: false, push_protection: true, vulnerability_alerts: true }) }))).toEqual(
      { pass: 0, fail: 1, unstated: 0 }
    );
  });

  it("should count a repository with a signal unreadable and none off as no state stated rather than as passing", () => {
    // COUNTED AT ZERO ON THE PUBLIC ESTATE TODAY — every public repository discloses all five signals — and the
    // slice exists for the day one of them stops. Passing this row would claim a control is on that GitHub said
    // nothing about.
    expect(
      counted(SIGNALS_PARAMETER, only({ assurance: withSignals({ push_protection: true, vulnerability_alerts: true, update_configuration: true }) }))
    ).toEqual({ pass: 0, fail: 0, unstated: 1 });
  });

  it("should count a row with no hygiene signals at all as no state stated rather than as failing", () => {
    // The uncollected branch of the report emits no `assurance` — every hygiene column the table draws for it is a
    // dash, and this wheel must say the same rather than reporting the controls off.
    expect(counted(SIGNALS_PARAMETER, only({}))).toEqual({ pass: 0, fail: 0, unstated: 1 });
    expect(counted(SIGNALS_PARAMETER, only({ assurance: { grade: "unknown", criteria: [] } }))).toEqual({ pass: 0, fail: 0, unstated: 1 });
  });

  it("should agree with the four checks the Hygiene column expands into over the whole estate", () => {
    // THE DRIFT THIS WHEEL IS BUILT TO AVOID. The wheel filters the table by a judgement, and the table expands the
    // same judgement into four columns; a second derivation of it is how the ring and the columns beneath it come to
    // disagree. Asserted over the fixture rather than trusted, because the two only look like one definition.
    const passing = ESTATE.filter((entry) => HYGIENE_CHECKS.every((check) => check.read(hygieneSignals(entry)) === true)).length;

    expect(counted(SIGNALS_PARAMETER).pass).toBe(passing);
  });
});

describe("the combined vulnerability wheel", () => {
  /** The wheel's four counts with exactly one slice at one, for the single-row cases below. */
  function inSlice(key: "high" | "medium" | "clear" | "unscanned"): Record<string, number> {
    return { high: 0, medium: 0, clear: 0, unscanned: 0, [key]: 1 };
  }

  it("should draw its slices worst first: high, medium, clear, unscanned", () => {
    const slices = wheel(VULNERABILITY_PARAMETER).slices;

    expect(slices.map((slice) => slice.key)).toEqual(["high", "medium", "clear", "unscanned"]);
    expect(slices.map((slice) => slice.label)).toEqual(["High", "Medium", "Clear", "Unscanned"]);
    expect(slices.map((slice) => slice.state)).toEqual(["red", "amber", "green", "none"]);
  });

  it("should count a repository with a live critical finding on either source as high", () => {
    expect(counted(VULNERABILITY_PARAMETER, only({ cves: { cves: scanned(1, { critical: 1 }) }, security: alerts(watching(0)) }))).toEqual(inSlice("high"));
    expect(counted(VULNERABILITY_PARAMETER, only({ cves: { detail: NO_CVE_REPORT }, security: alerts(watching(1, { critical: 1 })) }))).toEqual(
      inSlice("high")
    );
  });

  it("should count a repository with a live high finding on either source as high", () => {
    expect(counted(VULNERABILITY_PARAMETER, only({ cves: { cves: scanned(3, { high: 1, low: 2 }) }, security: alerts(watching(0)) }))).toEqual(inSlice("high"));
    expect(counted(VULNERABILITY_PARAMETER, only({ cves: { cves: scanned(2, { medium: 2 }) }, security: alerts(watching(1, { high: 1 })) }))).toEqual(
      inSlice("high")
    );
  });

  it("should count a repository whose live findings are all medium or low as medium", () => {
    expect(counted(VULNERABILITY_PARAMETER, only({ cves: { cves: scanned(2, { medium: 1, low: 1 }) }, security: alerts(watching(1, { low: 1 })) }))).toEqual(
      inSlice("medium")
    );
  });

  it("should count ungraded live findings as medium rather than clear", () => {
    // THE CVE `unknown` BAND, and a Dependabot alert counted in `open` with no band of its own: both are findings,
    // and neither is critical or high, so they are amber.
    expect(counted(VULNERABILITY_PARAMETER, only({ cves: { cves: scanned(2, { unknown: 2 }) }, security: alerts(watching(0)) }))).toEqual(inSlice("medium"));
    expect(counted(VULNERABILITY_PARAMETER, only({ cves: { detail: NO_CVE_REPORT }, security: alerts(watching(3)) }))).toEqual(inSlice("medium"));
  });

  it("should count a repository Dependabot alone reads and finds nothing on as clear", () => {
    // THE 686-REPOSITORY CASE, and the error the wheel this replaced made: no dependency-scan report has been
    // published, so the old wheel drew this as unmeasured — when Dependabot has read it and found nothing.
    expect(counted(VULNERABILITY_PARAMETER, only({ cves: { detail: NO_CVE_REPORT }, security: alerts(watching(0)) }))).toEqual(inSlice("clear"));
  });

  it("should count a repository the Jenkins scan alone reads as clear on that source when it finds nothing", () => {
    // A MEASURED ZERO on the other source, with Dependabot not watching. The reader's "clear" means clear on
    // whichever source read it, which for this repository is one of the two.
    expect(counted(VULNERABILITY_PARAMETER, only({ cves: { cves: scanned(0) }, security: alerts({ by_severity: {} }) }))).toEqual(inSlice("clear"));
  });

  it("should not let one source finding nothing clear a finding the other raised", () => {
    expect(counted(VULNERABILITY_PARAMETER, only({ cves: { cves: scanned(2, { medium: 2 }) }, security: alerts(watching(0)) }))).toEqual(inSlice("medium"));
    expect(counted(VULNERABILITY_PARAMETER, only({ cves: { cves: scanned(0) }, security: alerts(watching(2, { critical: 2 })) }))).toEqual(inSlice("high"));
  });

  it("should count a repository neither source reads as unscanned", () => {
    // THE 84. No dependency-scan report has been published AND Dependabot is not watching it, which is the estate's
    // real blind spot and a far smaller one than the 770 the Jenkins report alone implied.
    expect(counted(VULNERABILITY_PARAMETER, only({ cves: { detail: NO_CVE_REPORT }, security: alerts({ by_severity: {} }) }))).toEqual(inSlice("unscanned"));
    expect(counted(VULNERABILITY_PARAMETER, only({}))).toEqual(inSlice("unscanned"));
  });

  it("should not read a Dependabot severity band on a repository Dependabot is not watching", () => {
    // `open` is the read signal. A band without it is not a finding, and counting it would put a row nobody read in
    // the red slice — the wheel would then hold it twice.
    expect(counted(VULNERABILITY_PARAMETER, only({ cves: { detail: NO_CVE_REPORT }, security: alerts({ by_severity: { critical: 1 } }) }))).toEqual(
      inSlice("unscanned")
    );
  });

  it("should count a repository whose only findings are suppressed or dismissed as clear", () => {
    // WHY THE TWO SOURCES MAY BE COMBINED AT ALL: both count only what is live. A CVE suppressed in the build is
    // outside `CveEvidence.live`, and an alert somebody dismissed is outside the `open` figure GitHub serves — so
    // neither number carries an accepted risk and a zero from either is a real all-clear.
    expect(
      counted(
        VULNERABILITY_PARAMETER,
        only({
          cves: {
            cves: {
              all: { total: 9, by_severity: { critical: 9 } },
              live: { total: 0, by_severity: {} },
              suppressed: { total: 9, by_severity: { critical: 9 } },
              occurrences: 9
            }
          },
          security: alerts(watching(0))
        })
      )
    ).toEqual(inSlice("clear"));
  });

  it("should not read an absent Dependabot count as zero alerts", () => {
    // The absence is the ONLY thing separating "Dependabot found nothing" from "Dependabot is not watching this",
    // and reading it as zero would report the second as the first — which is the error the whole wheel exists to
    // stop making. With no Jenkins report either, this row is unscanned rather than clear.
    expect(counted(VULNERABILITY_PARAMETER, only({ security: alerts({ by_severity: {}, detail: "dependabot/alerts is not enabled" }) }))).toEqual(
      inSlice("unscanned")
    );
  });
});

describe("the wheels' unmeasured slices", () => {
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

describe("the wheels' cohorts", () => {
  const MIXED: RepositoryRow[] = [
    { repository: "open", team: "dtsse", visibility: "public" },
    { repository: "inner", team: "dtsse", visibility: "internal" },
    { repository: "closed", team: "dtsse", visibility: "private" },
    { repository: "unstated", team: "dtsse" }
  ];

  it("should hand the public cohort the public rows alone", () => {
    expect(cohortRows("public", MIXED).map((entry) => entry.repository)).toEqual(["open"]);
  });

  it("should hand the all cohort every row, including one whose visibility nobody read", () => {
    expect(cohortRows("all", MIXED).map((entry) => entry.repository)).toEqual(["open", "inner", "closed", "unstated"]);
  });

  it("should keep the four stewardship and security wheels on the public estate", () => {
    const publicOnly = [OWNER_PARAMETER, MAINTAINED_PARAMETER, SIGNALS_PARAMETER, VULNERABILITY_PARAMETER];

    expect(publicOnly.map((parameter) => wheel(parameter).cohort)).toEqual(["public", "public", "public", "public"]);
  });

  it("should count the four brought-back wheels over every repository, in the order the group draws them", () => {
    const everywhere = ESTATE_DIMENSIONS.filter((dimension) => dimension.cohort === "all").map((dimension) => dimension.title);

    expect(everywhere).toEqual(["AI readiness", "Enforces review", "Enforces CI", "Test coverage"]);
  });

  it("should count every row on an all-cohort wheel, the internal, private and unread ones included", () => {
    for (const dimension of ESTATE_DIMENSIONS.filter((entry) => entry.cohort === "all")) {
      expect(totalValue(dimensionSlices(dimension, cohortRows(dimension.cohort, MIXED)))).toBe(MIXED.length);
    }
  });

  it("should filter the table on a wedge whatever cohort its wheel is counted over", () => {
    // The selections are read off the parameter and matched against the row; neither looks at the cohort, so an
    // internal row in a clicked slice stays in the list rather than being dropped for not being public.
    const internal: RepositoryRow = { repository: "inner", team: "dtsse", visibility: "internal", owner_kind: "person" };
    const selections = parseSelections((parameter) => (parameter === OWNER_PARAMETER ? "individual" : null));

    expect(matchesSelections(internal, selections)).toBe(true);
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
    const selections = parseSelections(query(`weeks=12&repository=pcs&${OWNER_PARAMETER}=team&${VULNERABILITY_PARAMETER}=unscanned`));

    expect([...selections]).toEqual([
      [OWNER_PARAMETER, "team"],
      [VULNERABILITY_PARAMETER, "unscanned"]
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

describe("the all-repositories wheels", () => {
  /** The one slice a single row lands in on a wheel, failing if it lands in none or in more than one. */
  function slice(parameter: string, fields: Partial<RepositoryRow>): string {
    const holding = dimensionSlices(wheel(parameter), only(fields)).filter((entry) => entry.value === 1);
    expect(holding).toHaveLength(1);
    return holding[0]?.key ?? "";
  }

  /** A row nothing was collected for, which carries none of the window's figures. */
  const UNCOLLECTED: Partial<RepositoryRow> = { visibility: "internal", detail: UNCOLLECTED_DETAIL };

  it("should count each readiness label in its own slice, in RAG order", () => {
    expect(wheel(LABEL_PARAMETER).slices.map((entry) => entry.key)).toEqual(["green", "amber", "red", "cannot_assess", "none"]);
    expect(slice(LABEL_PARAMETER, { readiness: "green" })).toBe("green");
    expect(slice(LABEL_PARAMETER, { readiness: "amber" })).toBe("amber");
    expect(slice(LABEL_PARAMETER, { readiness: "red" })).toBe("red");
    expect(slice(LABEL_PARAMETER, { readiness: "cannot_assess" })).toBe("cannot_assess");
  });

  it("should count a repository with no readiness label, or one this build does not know, as not assessed", () => {
    expect(slice(LABEL_PARAMETER, {})).toBe("none");
    expect(slice(LABEL_PARAMETER, { readiness: "purple" as unknown as RepositoryRow["readiness"] })).toBe("none");
  });

  it("should band the approvals a merge gate requires: two or more, one, none, unread", () => {
    expect(slice(REVIEW_PARAMETER, { required_approving_reviews: 3 })).toBe("multiple");
    expect(slice(REVIEW_PARAMETER, { required_approving_reviews: 2 })).toBe("multiple");
    expect(slice(REVIEW_PARAMETER, { required_approving_reviews: 1 })).toBe("required");
    expect(slice(REVIEW_PARAMETER, { required_approving_reviews: 0 })).toBe("none");
    expect(slice(REVIEW_PARAMETER, {})).toBe("unknown");
  });

  it("should draw Multiple in the stronger green and Unenforced in red", () => {
    const colours = Object.fromEntries(dimensionSlices(wheel(REVIEW_PARAMETER), []).map((entry) => [entry.key, entry.color]));

    expect(colours).toEqual({ multiple: STRONG_GOOD_HEX, required: "#4ade80", none: "#f87171", unknown: "#64748b" });
  });

  it("should band the status checks a merge gate requires: any, none, unread", () => {
    expect(slice(CHECKS_PARAMETER, { required_status_checks: 4 })).toBe("required");
    expect(slice(CHECKS_PARAMETER, { required_status_checks: 1 })).toBe("required");
    expect(slice(CHECKS_PARAMETER, { required_status_checks: 0 })).toBe("none");
    expect(slice(CHECKS_PARAMETER, {})).toBe("unknown");
  });

  it("should band coverage on the boundaries the repository page grades it by", () => {
    expect(slice(COVERAGE_PARAMETER, { sonar_coverage: 100 })).toBe("high");
    expect(slice(COVERAGE_PARAMETER, { sonar_coverage: 90 })).toBe("high");
    expect(slice(COVERAGE_PARAMETER, { sonar_coverage: 89.9 })).toBe("moderate");
    expect(slice(COVERAGE_PARAMETER, { sonar_coverage: 80 })).toBe("moderate");
    expect(slice(COVERAGE_PARAMETER, { sonar_coverage: 79.9 })).toBe("low");
    expect(slice(COVERAGE_PARAMETER, { sonar_coverage: 0 })).toBe("low");
    expect(slice(COVERAGE_PARAMETER, {})).toBe("unknown");
  });

  it("should count a repository nothing was collected for in each wheel's unmeasured slice", () => {
    expect(slice(LABEL_PARAMETER, UNCOLLECTED)).toBe("none");
    expect(slice(REVIEW_PARAMETER, UNCOLLECTED)).toBe("unknown");
    expect(slice(CHECKS_PARAMETER, UNCOLLECTED)).toBe("unknown");
    expect(slice(COVERAGE_PARAMETER, UNCOLLECTED)).toBe("unknown");
  });

  it("should filter the table on a brought-back wheel's slice", () => {
    const rows: RepositoryRow[] = [
      { repository: "two", team: "dtsse", visibility: "private", required_approving_reviews: 2 },
      { repository: "one", team: "dtsse", visibility: "internal", required_approving_reviews: 1 },
      { repository: "zero", team: "dtsse", visibility: "public", required_approving_reviews: 0 }
    ];
    const selections = parseSelections((parameter) => (parameter === REVIEW_PARAMETER ? "multiple" : null));

    expect(rows.filter((entry) => matchesSelections(entry, selections)).map((entry) => entry.repository)).toEqual(["two"]);
  });
});
