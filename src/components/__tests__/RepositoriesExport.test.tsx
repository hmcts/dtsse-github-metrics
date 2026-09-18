/**
 * @vitest-environment jsdom
 */

/**
 * What the export control hands the reader, and what it refuses to.
 *
 * The columns are asserted in `lib/__tests__/export.test.ts` and the quoting in `lib/__tests__/csv.test.ts`. What
 * is only visible from a browser is the join: that the button reads the SAME filters off the URL that the table
 * does, that a click actually produces a download rather than navigating, and that the file it names is
 * distinguishable from the next one. A control that exported the whole estate while the reader looked at eleven
 * rows would type-check perfectly and be wrong in a way nobody would notice until they counted the file.
 *
 * `URL.createObjectURL` is stubbed because jsdom implements neither half of it. What the stub records is the blob,
 * which is the document the reader would have got.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RepositoriesExport } from "@/components/RepositoriesExport";
import { TERM_PARAMETER } from "@/lib/rows";
import type { Contributor, RepositoryRow } from "@/lib/types";

let parameters = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useSearchParams: () => parameters
}));

/** Three public repositories under two teams, plus one private and one internal for the visibility toggles. */
const ROWS: RepositoryRow[] = [
  { repository: "pcs-api", team: "dtsse", visibility: "public", default_branch_committed_at: "2026-09-10T00:00:00Z", production: true },
  { repository: "pcs-frontend", team: "dtsse", visibility: "public", default_branch_committed_at: "2026-09-09T00:00:00Z" },
  { repository: "civil-service", team: "civil", visibility: "public", default_branch_committed_at: "2026-09-08T00:00:00Z" },
  { repository: "closed-service", team: "civil", visibility: "private", default_branch_committed_at: "2026-09-07T00:00:00Z" }
];

const CONTRIBUTORS: Record<string, Contributor[]> = {
  dtsse: [{ login: "ef32", name: "Tam Arah" }, { login: "nameless" }],
  civil: [{ login: "someone", name: "Some One" }]
};

/** The document the last click would have downloaded, and the name it would have carried. */
let downloaded: { content: string; filename: string } | undefined;

/** Every object URL the component released, so the release can be asserted rather than assumed. */
let revoked: string[] = [];

/** The document the component last handed to a `Blob`, which is the only synchronous way back to it in jsdom. */
let built = "";

function url(query: string): void {
  parameters = new URLSearchParams(query);
}

function mount(rows: readonly RepositoryRow[] = ROWS) {
  return render(<RepositoriesExport rows={rows} teamContributors={CONTRIBUTORS} window="2026-06-08 to 2026-08-31" />);
}

function control(): HTMLElement {
  return screen.getByRole("button", { name: "Export CSV" });
}

/** The repositories in the file, read out of its rows rather than out of the component. */
function exported(): string[] {
  return (downloaded?.content ?? "")
    .split("\r\n")
    .slice(1)
    .map((row) => row.split(",")[2] ?? "");
}

beforeEach(() => {
  url("weeks=12");
  built = "";
  downloaded = undefined;
  revoked = [];

  // jsdom's `Blob` has no synchronous reader and jsdom has no object-URL registry at all, so the document is
  // captured where it is constructed rather than read back out of a URL.
  vi.stubGlobal(
    "Blob",
    class {
      constructor(parts: string[]) {
        built = parts.join("");
      }
    }
  );
  vi.stubGlobal("URL", {
    createObjectURL: () => "blob:stubbed",
    revokeObjectURL: (released: string) => void revoked.push(released)
  });

  // The anchor is created and clicked rather than rendered, so what it was asked to download has to be read off
  // the element the component made. A detached anchor's `click` navigates nowhere in jsdom.
  const create = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
    const element = create(tag);
    if (tag === "a") {
      element.click = () => {
        downloaded = { content: built, filename: (element as HTMLAnchorElement).download };
      };
    }
    return element;
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("RepositoriesExport", () => {
  it("is named by the words a reader can see, so the accessible name is the label", () => {
    // WCAG's "label in name": the accessible name must contain the visible text, which is easiest to satisfy by
    // having no `aria-label` at all. The icon beside it is decoration and is hidden from the tree.
    mount();

    expect(control().textContent).toBe("Export CSV");
    expect(control().getAttribute("aria-label")).toBeNull();
    expect(control().querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("exports the rows the reader's filters leave, and not the estate", () => {
    // THE ONE THING THIS CONTROL CAN GET SILENTLY WRONG. The table opens filtered to public only, so an export
    // reading the same rows unfiltered would hand somebody four rows against a table showing three.
    mount();
    fireEvent.click(control());

    expect(exported()).toEqual(["pcs-api", "pcs-frontend", "civil-service"]);
    expect(exported()).not.toContain("closed-service");
  });

  it("reads the same term parameter the table filters on", () => {
    url(`weeks=12&${TERM_PARAMETER}=pcs`);
    mount();
    fireEvent.click(control());

    expect(exported()).toEqual(["pcs-api", "pcs-frontend"]);
  });

  it("matches the term against the owning team, as the table's own filter does", () => {
    url(`weeks=12&${TERM_PARAMETER}=civil`);
    mount();
    fireEvent.click(control());

    expect(exported()).toEqual(["civil-service"]);
  });

  it("honours the production toggle", () => {
    url("weeks=12&production=true");
    mount();
    fireEvent.click(control());

    expect(exported()).toEqual(["pcs-api"]);
  });

  it("honours the visibility toggles, including the private one the default hides", () => {
    url("weeks=12&private=true");
    mount();
    fireEvent.click(control());

    expect(exported()).toEqual(["closed-service"]);
  });

  it("orders the file as the table opens: most recently pushed first", () => {
    // The table's SORT is component state one level away and cannot be read from here, so the file is ordered by
    // the order the table opens on. Rows and columns match whatever the reader has clicked; only the sequence can.
    mount();
    fireEvent.click(control());

    expect(exported()).toEqual(["pcs-api", "pcs-frontend", "civil-service"]);
  });

  it("heads the file and unpacks the owning team's contributors", () => {
    mount();
    fireEvent.click(control());

    const [headings, first] = (downloaded?.content ?? "").split("\r\n");
    expect(headings).toContain("Team contributors");
    // UNQUOTED, and that is the writer being right rather than lax: a semicolon is not a CSV special character, so
    // the separator the user asked for needs no quoting and the cell stays readable to a human.
    expect(first).toContain("Tam Arah (ef32); nameless");
    expect(first).not.toContain('"');
  });

  it("opens the document with a byte-order mark, so a spreadsheet reads it as UTF-8", () => {
    mount();
    fireEvent.click(control());

    expect(downloaded?.content.startsWith("﻿")).toBe(true);
  });

  it("names the file after the reported span and the day it was taken", () => {
    mount();
    fireEvent.click(control());

    expect(downloaded?.filename).toMatch(/^repositories-2026-06-08to2026-08-31-taken-\d{4}-\d{2}-\d{2}\.csv$/);
  });

  it("releases the object URL rather than holding the estate for the life of the page", () => {
    mount();
    fireEvent.click(control());

    expect(revoked).toEqual(["blob:stubbed"]);
  });

  it("is disabled where the filters leave nothing, rather than exporting a header alone", () => {
    // The table renders its "no repository matches this filter" state here, and a file of column names with no rows
    // under it reads as an export that failed rather than as a filter that matched nothing.
    url(`weeks=12&${TERM_PARAMETER}=nothing-here`);
    mount();

    expect(control().hasAttribute("disabled")).toBe(true);
  });

  it("is enabled where the filters leave anything at all", () => {
    mount();

    expect(control().hasAttribute("disabled")).toBe(false);
  });

  it("should carry the hygiene checks when the reader has expanded the aggregate", () => {
    // THE COLUMNS FOLLOW THE TOGGLE, which is only possible because it is URL state. The file is a copy of the
    // table, so a reader looking at the four checks has to be handed them.
    url("weeks=12&hygiene=true");
    mount();
    fireEvent.click(control());

    const [headings] = (downloaded?.content ?? "").split("\r\n");
    for (const label of ["Secret scanning", "Push protection", "Vulnerability alerts", "Dependency updates"]) {
      expect(headings).toContain(label);
    }
    // The aggregate stays beside them, as it does on the page.
    expect(headings).toContain("Hygiene");
  });

  it("should carry no hygiene check when the aggregate is collapsed", () => {
    // The other half of the same promise: four columns nobody can see on the page would be the file drifting from
    // it just as surely as four missing ones would.
    mount();
    fireEvent.click(control());

    const [headings] = (downloaded?.content ?? "").split("\r\n");
    for (const label of ["Secret scanning", "Push protection", "Vulnerability alerts", "Dependency updates"]) {
      expect(headings).not.toContain(label);
    }
  });
});
