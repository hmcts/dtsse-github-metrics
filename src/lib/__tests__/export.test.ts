/**
 * What the estate export puts in each column, which is the part of it that can be silently wrong.
 *
 * A misplaced button is visible. A column reading the wrong criterion, or a cell saying "No" where the page says a
 * dash, is not — it is a file somebody opens in a spreadsheet a week later and reports from. So every cell is
 * asserted against the word the table prints for the same row, and the two columns that are new here — the owning
 * team's contributors, and the dash that separates "there is no team" from "nobody contributed" — get their own
 * cases.
 *
 * THE END-TO-END QUOTING CASE IS THE CONTRIBUTORS CELL, not `Detail`, from 2026-09-17. It used to be `Detail`,
 * whose sentence was the longest free text on a row and the likeliest to carry a comma. That column now carries
 * `uncollectedDetail` — one known string with no comma in it, or nothing — so a comma test on it would be
 * arranging a value the report layer cannot produce. A person's name is the free text that remains, and
 * "Arah, Tam" is a real shape of one; `csv.test.ts` asserts on `csvField` itself besides.
 */

import { describe, expect, it } from "vitest";
import { csvDocument } from "@/lib/csv";
import { CONTRIBUTOR_SEPARATOR, repositoryExportHeadings, repositoryExportRows } from "@/lib/export";
import type { Contributor, RepositoryRow } from "@/lib/types";
import { UNCOLLECTED_DETAIL } from "@/lib/types";

const CONTRIBUTORS: Record<string, Contributor[]> = {
  dtsse: [{ login: "ef32", name: "Tam Arah" }, { login: "nameless" }],
  quiet: [],
  unowned: [{ login: "somebody", name: "Some Body" }]
};

/**
 * One well-measured repository, crossed over on the criteria so a column wired to its neighbour fails.
 *
 * `no-committed-secrets` is `unmet` and every other criterion `met`, which separates the one column that answers
 * what was FOUND from the five that answer whether the criterion passed: the secrets cell reads Yes here and every
 * other cell reads Yes only because it passed.
 */
const MEASURED: RepositoryRow = {
  repository: "pcs-api",
  team: "dtsse",
  owner_kind: "team",
  pushed_at: "2026-09-10T09:30:00Z",
  visibility: "public",
  production: true,
  assurance: {
    grade: "partial",
    criteria: [
      { criterion: "named-owner", outcome: "met", detail: "assigned to a team" },
      { criterion: "automated-hygiene", outcome: "met", detail: "every hygiene signal is on" },
      { criterion: "no-committed-secrets", outcome: "unmet", detail: "2 secret-scanning alerts open" },
      { criterion: "security-contact", outcome: "met", detail: "a security policy applies" },
      { criterion: "patching", outcome: "met", detail: "the oldest open critical or high alert is 120 days old" },
      { criterion: "maintained", outcome: "met", detail: "pushed to recently enough" }
    ],
    oldest_severe_alert_days: 120
  }
};

/**
 * A repository whose hygiene signals separate all three answers and both halves of the update requirement.
 *
 * Scanning on, push protection off, vulnerability alerts NOT DISCLOSED, and the two update signals disagreeing —
 * so the folded column has to read Yes off Renovate alone while the aggregate beside it stays what the report
 * judged. A fixture with every signal on could not fail.
 */
const SIGNALLED: RepositoryRow = {
  ...MEASURED,
  repository: "hygiene-service",
  assurance: {
    grade: "partial",
    criteria: [{ criterion: "automated-hygiene", outcome: "unmet", detail: "not configured: push protection" }],
    hygiene: { secret_scanning: true, push_protection: false, dependabot_security_updates: false, update_configuration: true }
  }
};

/** A repository nothing was collected for: every window field absent, and the `detail` that says so. */
const UNMEASURED: RepositoryRow = {
  repository: "quiet-service",
  team: "quiet",
  owner_kind: "team",
  detail: UNCOLLECTED_DETAIL
};

/**
 * A repository whose control state WAS collected and whose merge history was not.
 *
 * The row the `Detail` column stopped carrying: its reason is about merged pull requests and direct commits, and
 * this file exports no column for either — so a reader opening the spreadsheet would meet an explanation for an
 * absence they cannot see. See `uncollectedDetail`.
 */
const MERGES_UNREAD: RepositoryRow = {
  repository: "walled-service",
  team: "quiet",
  owner_kind: "team",
  detail: "no merge history was read for this repository, so its merges are unmeasured rather than none"
};

/**
 * One column's cell off a row, found by its heading so an inserted column cannot shift an assertion.
 *
 * The heading is located in THE FILE'S OWN HEADER ROW rather than in a list held beside it, because the columns now
 * depend on whether the reader expanded the hygiene aggregate: an index taken from the collapsed headings would read
 * the wrong cell of an expanded file, and read it plausibly.
 */
function cell(rows: string[][], repository: string, heading: string): string | undefined {
  const row = rows.find((entry) => entry.includes(repository));
  return row?.[(rows[0] ?? []).indexOf(heading)];
}

describe("repositoryExportRows", () => {
  it("should head every column the table shows, plus the owning team's contributors", () => {
    // `Team` and `Team contributors` lead, because the second unpacks the first: the estate table's Team cell links
    // to a page that lists those people, and a spreadsheet cannot follow a link.
    expect(repositoryExportHeadings()).toEqual([
      "Team",
      "Team contributors",
      "Repository",
      "Detail",
      "Last pushed",
      "Visibility",
      "Code owner",
      "Hygiene",
      "Secrets",
      "Security contact",
      "Patching cycle",
      "Maintained",
      "Unsuppressed Crit CVEs",
      "Production",
      "Assurance"
    ]);
  });

  it("should put the headings in the first row and one row per repository after it", () => {
    const rows = repositoryExportRows([MEASURED, UNMEASURED], CONTRIBUTORS);

    expect(rows[0]).toEqual(repositoryExportHeadings());
    expect(rows).toHaveLength(3);
    // Every row is the width of the header, or a reader lines the columns up against the wrong names.
    for (const row of rows) {
      expect(row).toHaveLength(repositoryExportHeadings().length);
    }
  });

  it("should keep the rows in the order it was handed, filtering and re-ordering nothing", () => {
    // The reader is looking at a table and this is a copy of it. Deciding the scope here as well as in the control
    // would be two answers to "what is on screen", and this one is the answer nobody can see.
    const rows = repositoryExportRows([UNMEASURED, MEASURED], CONTRIBUTORS);

    expect(rows[1]?.[repositoryExportHeadings().indexOf("Repository")]).toBe("quiet-service");
    expect(rows[2]?.[repositoryExportHeadings().indexOf("Repository")]).toBe("pcs-api");
  });

  it("should print the last push as the UTC day the page prints, not the instant", () => {
    // A second rendering of one window is two claims about it. The page reads `2026-09-10`, so the file must too.
    const rows = repositoryExportRows([MEASURED], CONTRIBUTORS);

    expect(cell(rows, "pcs-api", "Last pushed")).toBe("2026-09-10");
  });

  it("should print each criterion as the Yes, No or dash its column prints", () => {
    const rows = repositoryExportRows([MEASURED, UNMEASURED], CONTRIBUTORS);

    expect(cell(rows, "pcs-api", "Code owner")).toBe("Yes");
    expect(cell(rows, "pcs-api", "Maintained")).toBe("Yes");
    // Nothing was collected, so every criterion is unreadable — a dash and never a No, which would report a
    // missing collection as a repository that fails.
    expect(cell(rows, "quiet-service", "Code owner")).toBe("-");
    expect(cell(rows, "quiet-service", "Assurance")).toBe("Cannot assess");
  });

  it("should invert Secrets with the column, answering what was FOUND", () => {
    // The one column whose Yes is the bad answer. Reading every criterion the same way here would put "Yes" against
    // a clean repository in the one place Yes means an open credential leak.
    const rows = repositoryExportRows([MEASURED], CONTRIBUTORS);

    expect(cell(rows, "pcs-api", "Secrets")).toBe("Yes");
    expect(cell(rows, "pcs-api", "Code owner")).toBe("Yes");
  });

  it("should print the patching age with no verdict, and a dash where nothing is open", () => {
    const rows = repositoryExportRows([MEASURED, UNMEASURED], CONTRIBUTORS);

    expect(cell(rows, "pcs-api", "Patching cycle")).toBe("120d");
    // Not `0d`, which would claim an alert was raised today.
    expect(cell(rows, "quiet-service", "Patching cycle")).toBe("-");
  });

  it("should print the assurance grade in its own words rather than the contract's", () => {
    const rows = repositoryExportRows([MEASURED], CONTRIBUTORS);

    expect(cell(rows, "pcs-api", "Assurance")).toBe("Partly meets");
    expect(cell(rows, "pcs-api", "Assurance")).not.toBe("partial");
  });

  it("should answer Production Yes, No or a dash, keeping an unread list apart from a No", () => {
    const rows = repositoryExportRows([MEASURED, { ...UNMEASURED, production: false }, UNMEASURED], CONTRIBUTORS);

    expect(cell(rows, "pcs-api", "Production")).toBe("Yes");
    expect(rows[2]?.[repositoryExportHeadings().indexOf("Production")]).toBe("No");
    expect(rows[3]?.[repositoryExportHeadings().indexOf("Production")]).toBe("-");
  });

  it("should unpack the owning team's contributors into one cell, separated by a semicolon", () => {
    const rows = repositoryExportRows([MEASURED], CONTRIBUTORS);

    expect(cell(rows, "pcs-api", "Team contributors")).toBe(`Tam Arah (ef32)${CONTRIBUTOR_SEPARATOR}nameless`);
    expect(CONTRIBUTOR_SEPARATOR).toBe("; ");
  });

  it("should resolve a contributor's name the way the page does, login and all", () => {
    // The same rule as every cell on `/contributors`: the name where GitHub holds one, the login where it does not,
    // and the login kept beside the name because it is what joins the person to GitHub.
    const rows = repositoryExportRows([MEASURED], CONTRIBUTORS);
    const contributors = cell(rows, "pcs-api", "Team contributors") ?? "";

    expect(contributors).toContain("Tam Arah (ef32)");
    expect(contributors).toContain("nameless");
    expect(contributors).not.toContain("undefined");
    expect(contributors).not.toContain("()");
  });

  it("should leave the contributors cell EMPTY where a team's window holds nobody", () => {
    // Measured as nothing, which is a different answer from unmeasured — the window was read and nobody landed a
    // change in any of that team's repositories.
    const rows = repositoryExportRows([UNMEASURED], CONTRIBUTORS);

    expect(cell(rows, "quiet-service", "Team contributors")).toBe("");
  });

  it("should leave the contributors cell empty where the team is absent from the fold entirely", () => {
    const rows = repositoryExportRows([{ ...MEASURED, team: "never-heard-of" }], CONTRIBUTORS);

    expect(cell(rows, "pcs-api", "Team contributors")).toBe("");
  });

  it("should DASH the contributors cell for a repository one person owns", () => {
    // 206 repositories on this estate are owned by an individual rather than a team, so there is no team whose
    // contributors could be listed — which is not the same claim as a team that nobody contributed to.
    const rows = repositoryExportRows([{ ...MEASURED, team: "a1i-hussain", owner_kind: "person" }], CONTRIBUTORS);

    expect(cell(rows, "pcs-api", "Team")).toBe("a1i-hussain");
    expect(cell(rows, "pcs-api", "Team contributors")).toBe("-");
  });

  it("should keep the unowned bucket's contributors, it being a reported destination", () => {
    const rows = repositoryExportRows([{ ...MEASURED, team: "unowned", owner_kind: "none" }], CONTRIBUTORS);

    expect(cell(rows, "pcs-api", "Team contributors")).toBe("Some Body (somebody)");
  });

  it("should carry an empty Detail rather than a dash where a repository has nothing to explain", () => {
    // `detail` is the reason a row has no figures, not a measurement — so a repository with figures has no reason
    // to give, and a dash would read as a value that could not be read.
    const rows = repositoryExportRows([MEASURED, UNMEASURED], CONTRIBUTORS);

    expect(cell(rows, "pcs-api", "Detail")).toBe("");
    expect(cell(rows, "quiet-service", "Detail")).toBe(UNCOLLECTED_DETAIL);
  });

  /**
   * The merge reason is not exported, because no column here is about merges.
   *
   * THE FILE IS A COPY OF THE TABLE is the promise this module is built on, and the table stopped printing this
   * sentence for the same reason: it explains merged-pull-request and direct-commit figures, and neither the page
   * nor this file carries a column for one. An empty cell says "nothing to explain about what you are looking at",
   * which is true; the sentence would say "something could not be measured" about a column that is not there.
   */
  it("should leave Detail empty where the only reason is about merges the file does not carry", () => {
    const rows = repositoryExportRows([MERGES_UNREAD], CONTRIBUTORS);

    expect(cell(rows, "walled-service", "Detail")).toBe("");
  });

  /**
   * THE FAILURE A HAND-ROLLED WRITER IS FEARED FOR, asserted end to end rather than on the writer alone: the value
   * is a real field on a real row, and an unquoted comma in it shifts every column after it.
   */
  it("should quote a contributors cell holding a name with a comma in it", () => {
    const document = csvDocument(repositoryExportRows([MEASURED], { dtsse: [{ login: "ef32", name: "Arah, Tam" }] }));

    expect(document).toContain('"Arah, Tam (ef32)"');
    expect(document.split("\r\n")).toHaveLength(2);
  });
});

/**
 * The columns the hygiene aggregate expands into, which the FILE follows the page on.
 *
 * The file and the page must not drift, which is this module's whole premise — so the checks are here exactly when
 * the reader has expanded them and absent exactly when they have not. Carrying them unconditionally would hand
 * somebody four columns their page does not show; omitting them from an expanded export would drop data because of
 * a UI toggle, which is the worse half of the same failure.
 */
describe("repositoryExportRows with the hygiene aggregate expanded", () => {
  it("should head the four checks after the aggregate when the reader has expanded it", () => {
    // AFTER `Hygiene` AND BEFORE `Secrets`, which is where the table draws them: a file whose column order differed
    // from the page's is a second document about one window.
    expect(repositoryExportHeadings(true)).toEqual([
      "Team",
      "Team contributors",
      "Repository",
      "Detail",
      "Last pushed",
      "Visibility",
      "Code owner",
      "Hygiene",
      "Secret scanning",
      "Push protection",
      "Vulnerability alerts",
      "Dependency updates",
      "Secrets",
      "Security contact",
      "Patching cycle",
      "Maintained",
      // ONE TOGGLE OPENS BOTH AGGREGATES, so a file the hygiene checks reached carries the CVE breakdown too — and
      // each set sits immediately after the aggregate it belongs to, which is where the table draws it.
      "Unsuppressed Crit CVEs",
      "Total",
      "Crit",
      "High",
      "Other",
      "Suppressed",
      "Production",
      "Assurance"
    ]);
  });

  it("should head no check when the aggregate is collapsed, which is what the page shows", () => {
    for (const label of ["Secret scanning", "Push protection", "Vulnerability alerts", "Dependency updates"]) {
      expect(repositoryExportHeadings()).not.toContain(label);
    }
  });

  it("should keep every row the width of the header when the checks are drawn", () => {
    const rows = repositoryExportRows([SIGNALLED, UNMEASURED], CONTRIBUTORS, true);

    for (const row of rows) {
      expect(row).toHaveLength(repositoryExportHeadings(true).length);
    }
  });

  it("should print Yes for a signal that is on and No for one that is off", () => {
    const rows = repositoryExportRows([SIGNALLED], CONTRIBUTORS, true);

    expect(cell(rows, "hygiene-service", "Secret scanning")).toBe("Yes");
    expect(cell(rows, "hygiene-service", "Push protection")).toBe("No");
    // The aggregate is untouched: it is the report's own judgement, not a fold over the cells beside it.
    expect(cell(rows, "hygiene-service", "Hygiene")).toBe("No");
  });

  it("should print a dash for a signal nobody read, never a No", () => {
    // GitHub disclosed nothing about vulnerability alerts on this row, and a repository nobody could read has not
    // been shown to have the control off. A `No` here would report a missing permission as a finding.
    const rows = repositoryExportRows([SIGNALLED, UNMEASURED], CONTRIBUTORS, true);

    expect(cell(rows, "hygiene-service", "Vulnerability alerts")).toBe("-");
    // Nothing was collected for this one at all, so every check is a dash.
    for (const label of ["Secret scanning", "Push protection", "Vulnerability alerts", "Dependency updates"]) {
      expect(cell(rows, "quiet-service", label)).toBe("-");
    }
  });

  it("should print the two update signals as one column met by either tool", () => {
    // Dependabot security updates are off and a Renovate configuration is present, which is 244 repositories of
    // this estate. Two independent columns would put a "No" against every one of them.
    const rows = repositoryExportRows([SIGNALLED], CONTRIBUTORS, true);

    expect(cell(rows, "hygiene-service", "Dependency updates")).toBe("Yes");
    expect(repositoryExportHeadings(true).filter((heading) => heading.includes("epend"))).toEqual(["Dependency updates"]);
  });

  it("should print No for the update requirement only when both signals were read and both are off", () => {
    const neither: RepositoryRow = {
      ...SIGNALLED,
      assurance: { grade: "partial", criteria: [], hygiene: { dependabot_security_updates: false, update_configuration: false } }
    };
    const half: RepositoryRow = {
      ...SIGNALLED,
      repository: "half-read",
      assurance: { grade: "partial", criteria: [], hygiene: { dependabot_security_updates: false } }
    };
    const rows = repositoryExportRows([neither, half], CONTRIBUTORS, true);

    expect(cell(rows, "hygiene-service", "Dependency updates")).toBe("No");
    // One read and off, one never read: not a finding, and the dash says so.
    expect(cell(rows, "half-read", "Dependency updates")).toBe("-");
  });
});

/**
 * The CVE columns in the file, which have to agree with the page including on the dash.
 *
 * A COLUMN OF ZEROES WHERE THE PAGE SHOWS DASHES IS THE FAILURE THIS FILE IS MOST EXPOSED TO. Roughly 1,529
 * repositories of 1,890 have no published scan, and a spreadsheet is where a reader would sum the column, sort it,
 * and conclude the estate is clean. The dash is what stops that, and it is the same mark `alertAge` and the criteria
 * cells already use here.
 */
describe("repositoryExportRows with the CVE counts", () => {
  /** A repository whose scan ran, every band separated so a column reading its neighbour fails. */
  const SCANNED: RepositoryRow = {
    ...MEASURED,
    repository: "scanned-service",
    cves: {
      scanned_at: "2026-09-17T02:00:00Z",
      cves: {
        all: { total: 11, by_severity: { critical: 2, high: 3, medium: 1, low: 4, unknown: 1 } },
        live: { total: 7, by_severity: { critical: 2, high: 3, medium: 1, unknown: 1 } },
        suppressed: { total: 4, by_severity: { low: 4 } },
        occurrences: 96
      }
    }
  };

  /** A repository a scan ran against and found nothing in: the earned zero. */
  const CLEAN: RepositoryRow = {
    ...MEASURED,
    repository: "clean-service",
    cves: {
      scanned_at: "2026-09-17T02:00:00Z",
      cves: { all: { total: 0, by_severity: {} }, live: { total: 0, by_severity: {} }, suppressed: { total: 0, by_severity: {} }, occurrences: 0 }
    }
  };

  /** A repository nobody has scanned, carrying the reason instead of the figures. */
  const UNSCANNED: RepositoryRow = {
    ...MEASURED,
    repository: "unscanned-service",
    cves: { detail: "no CVE report has been published for this repository" }
  };

  it("should carry the aggregate whether or not the reader expanded it", () => {
    expect(repositoryExportHeadings()).toContain("Unsuppressed Crit CVEs");
    expect(repositoryExportHeadings(true)).toContain("Unsuppressed Crit CVEs");
  });

  it("should carry the five figures only where the reader has expanded them", () => {
    // The file follows the toggle, which is what keeps it a copy of the table rather than a second document.
    for (const heading of ["Total", "Crit", "High", "Other", "Suppressed"]) {
      expect(repositoryExportHeadings()).not.toContain(heading);
      expect(repositoryExportHeadings(true)).toContain(heading);
    }
  });

  it("should print the live critical count for a repository whose scan ran", () => {
    const rows = repositoryExportRows([SCANNED], CONTRIBUTORS);

    expect(cell(rows, "scanned-service", "Unsuppressed Crit CVEs")).toBe("2");
  });

  it("should print a ZERO where a scan ran and found nothing, and a DASH where none has run", () => {
    // THE DISTINCTION THE WHOLE COLUMN RESTS ON, asserted on one document so the two cells can be compared. An empty
    // cell would be read as a zero by the spreadsheet somebody opens this in, which is why the dash is written.
    const rows = repositoryExportRows([CLEAN, UNSCANNED], CONTRIBUTORS);

    expect(cell(rows, "clean-service", "Unsuppressed Crit CVEs")).toBe("0");
    expect(cell(rows, "unscanned-service", "Unsuppressed Crit CVEs")).toBe("-");
  });

  it("should print a dash in every figure of the breakdown for an unscanned repository", () => {
    const rows = repositoryExportRows([UNSCANNED, CLEAN], CONTRIBUTORS, true);

    for (const heading of ["Total", "Crit", "High", "Other", "Suppressed"]) {
      expect(cell(rows, "unscanned-service", heading)).toBe("-");
      expect(cell(rows, "clean-service", heading)).toBe("0");
    }
  });

  it("should break the count into the unsuppressed bands, the suppressed ones counted beside them", () => {
    // `Total` is the live total, so Crit, High and Other sum to it: 2 + 3 + 2 = 7. The four suppressed lows are in
    // `Suppressed` alone, and a reader adding the first four figures is not double-counting them.
    const rows = repositoryExportRows([SCANNED], CONTRIBUTORS, true);

    expect(["Total", "Crit", "High", "Other", "Suppressed"].map((heading) => cell(rows, "scanned-service", heading))).toEqual(["7", "2", "3", "2", "4"]);
  });

  it("should print the same figure in Crit as in the aggregate beside it", () => {
    // Deliberate, on the Hygiene column's rule: the aggregate keeps its place and its parts are drawn beside it.
    const rows = repositoryExportRows([SCANNED], CONTRIBUTORS, true);

    expect(cell(rows, "scanned-service", "Crit")).toBe(cell(rows, "scanned-service", "Unsuppressed Crit CVEs"));
  });

  it("should keep every row the width of the header when the figures are drawn", () => {
    const rows = repositoryExportRows([SCANNED, UNSCANNED, UNMEASURED], CONTRIBUTORS, true);

    for (const row of rows) {
      expect(row).toHaveLength(repositoryExportHeadings(true).length);
    }
  });

  it("should print a dash for a row served by a deployment older than the field", () => {
    // An absent `cves` says the report layer predates it and nothing about the repository, so it takes the same
    // fallback as a published reason: unmeasured.
    const rows = repositoryExportRows([MEASURED], CONTRIBUTORS, true);

    expect(cell(rows, "pcs-api", "Unsuppressed Crit CVEs")).toBe("-");
    expect(cell(rows, "pcs-api", "Total")).toBe("-");
  });
});
