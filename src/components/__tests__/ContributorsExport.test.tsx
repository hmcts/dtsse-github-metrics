/**
 * @vitest-environment jsdom
 */

/**
 * What the contributors export hands the reader: the people the tiles and filters leave, by GitHub username.
 *
 * The cells are asserted in `lib/__tests__/export.test.ts`. What is only visible from a browser is the join — that
 * clicking the Ready tile and exporting gives the people the tile counted — and the stubs are `RepositoriesExport`'s.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContributorsExport } from "@/components/ContributorsExport";
import type { ActorRow } from "@/lib/types";

let parameters = new URLSearchParams();

vi.mock("next/navigation", () => ({ useSearchParams: () => parameters }));

/** One person in each of Ready, Review and Blocked, with Ready's two subgroups split and one civil servant. */
const ROWS: ActorRow[] = [
  { login: "blocked", repositories: 1, labels: ["red"] },
  { login: "mixed", repositories: 2, labels: ["green", "red"], civil_servant: true },
  { login: "careful", repositories: 3, labels: ["green", "amber"] },
  { login: "ready", name: "Rea Dy", repositories: 4, labels: ["green"] }
];

let downloaded: { content: string; filename: string } | undefined;
let built = "";
let revoked: string[] = [];

function mount(rows: readonly ActorRow[] = ROWS) {
  return render(<ContributorsExport rows={rows} labelled window="2026-08-10 to 2026-11-02" />);
}

function control(): HTMLElement {
  return screen.getByRole("button", { name: "Export CSV" });
}

/** The usernames in the file, read out of its first column. */
function exported(query: string): string[] {
  // Unmounted first, so a case that exports twice reads one button rather than two.
  cleanup();
  parameters = new URLSearchParams(query);
  mount();
  fireEvent.click(control());
  return (downloaded?.content ?? "")
    .split("\r\n")
    .slice(1)
    .map((row) => row.split(",")[0] ?? "");
}

beforeEach(() => {
  parameters = new URLSearchParams();
  built = "";
  revoked = [];
  downloaded = undefined;
  vi.stubGlobal(
    "Blob",
    class {
      constructor(parts: string[]) {
        built = parts.join("");
      }
    }
  );
  vi.stubGlobal("URL", { createObjectURL: () => "blob:stubbed", revokeObjectURL: (released: string) => void revoked.push(released) });
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

describe("ContributorsExport", () => {
  it("exports everybody in the order the table opens on, without a tile selected", () => {
    expect(exported("weeks=12")).toEqual(["ready", "careful", "mixed", "blocked"]);
    expect(downloaded?.filename).toMatch(/^contributors-2026-08-10to2026-11-02-taken-\d{4}-\d{2}-\d{2}\.csv$/);
  });

  it("exports the people a readiness tile counts, and names the file after it", () => {
    expect(exported("weeks=12&readiness=ready")).toEqual(["ready", "careful"]);
    expect(downloaded?.filename).toMatch(/^contributors-ready-2026-08-10to2026-11-02-taken-/);
    expect(exported("weeks=12&readiness=review")).toEqual(["mixed"]);
  });

  it("exports the people a subgroup counts, and names the file after the subgroup", () => {
    expect(exported("weeks=12&readiness=green-amber")).toEqual(["careful"]);
    expect(downloaded?.filename).toMatch(/^contributors-green-amber-2026-08-10to2026-11-02-taken-/);
  });

  it("reads a stale readiness key as unfiltered, and leaves it out of the file name", () => {
    expect(exported("weeks=12&readiness=bogus")).toEqual(["ready", "careful", "mixed", "blocked"]);
    expect(downloaded?.filename).toMatch(/^contributors-2026-08-10to2026-11-02-taken-/);
  });

  it("opens the document with a byte-order mark, so a spreadsheet reads it as UTF-8", () => {
    exported("");
    expect(downloaded?.content.startsWith("\uFEFF")).toBe(true);
  });

  it("releases the object URL once the download has been handed over", () => {
    exported("");
    expect(revoked).toEqual(["blob:stubbed"]);
  });

  it("follows the term and the civil-servant toggle", () => {
    expect(exported("contributor=rea")).toEqual(["ready"]);
    expect(exported("civil-servants=true")).toEqual(["mixed"]);
  });

  it("is disabled where the filters leave nobody", () => {
    parameters = new URLSearchParams("contributor=nobody");
    mount();
    expect(control()).toHaveProperty("disabled", true);
  });

  it("is enabled where the filters leave anybody", () => {
    mount();
    expect(control()).toHaveProperty("disabled", false);
  });
});
