/**
 * @vitest-environment jsdom
 */

/**
 * That the summary wheels, the table's controls and the export beside them are looking at the same query — and
 * that reaching it costs no request.
 *
 * THE SEAM NO OTHER TEST CAN SEE. Every other file in this directory hands `useSearchParams` a fixed object and
 * mounts once per URL, which asserts each component against a query somebody typed rather than against one the
 * other component wrote. The defect this covers lived exactly there: `RepositoriesTable` WRITES the expand
 * parameter, `RepositoriesExport` READS it, and between them sits Next's history integration. `EstateSummary` is
 * the third party to it and the sharpest case of all — a wheel WRITES a parameter that neither of the other two
 * has a control for, and both of them read it.
 *
 * SO THE HOOK IS MODELLED ON THE REAL ONE rather than stubbed flat. Next patches `window.history.replaceState`
 * and dispatches its own `ACTION_RESTORE` — a client-only reducer action, no fetch — so `useSearchParams`
 * reports what was written without a navigation. See `client/components/app-router.js` and the "Native History
 * API" section of `next/dist/docs/01-app/01-getting-started/04-linking-and-navigating.md`. The mock below is
 * that behaviour and nothing else: write the history, notify the readers.
 *
 * WHAT THIS FILE CANNOT PROVE is that Next's own patch does what its documentation says, since mounting the
 * genuine app-router needs a server payload jsdom cannot produce. That half was checked against a running
 * `next dev` with the network panel open, and is recorded in the pull request rather than here.
 *
 * `replaced` is the canary for the defect itself: nothing here calls the router, and a `router.replace` put back
 * into either component would refetch the whole estate for state the browser is already holding.
 */

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EstateSummary } from "@/components/EstateSummary";
import { RepositoriesExport } from "@/components/RepositoriesExport";
import { RepositoriesTable } from "@/components/RepositoriesTable";
import { EXPAND_LABEL } from "@/lib/rows";
import type { Contributor, RepositoryRow } from "@/lib/types";

/** Anything a `replaceState` should wake, which is every component reading the query. */
const readers = new Set<() => void>();

function subscribe(notify: () => void): () => void {
  readers.add(notify);
  return () => void readers.delete(notify);
}

/** What the stubbed router was asked to navigate to. Must stay empty: that is the point of the change. */
let replaced: string[] = [];

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: (target: string) => void replaced.push(target) }),
  usePathname: () => "/repositories",
  // Next's own integration, in the two lines of it this seam depends on: the hook reports `window.location`, and
  // a `replaceState` is what moves it on.
  useSearchParams: () => new URLSearchParams(useSyncExternalStore(subscribe, () => window.location.search))
}));

/**
 * Two public repositories whose hygiene signals differ on every check, so a file carrying the wrong rows or the
 * wrong columns cannot pass by printing the same answer twice.
 */
const ROWS: RepositoryRow[] = [
  {
    repository: "pcs-api",
    team: "dtsse",
    visibility: "public",
    default_branch_committed_at: "2026-09-10T00:00:00Z",
    production: true,
    // The two rows differ on the wheels' dimensions as well as on hygiene, so a wedge that filtered the wrong
    // dimension — or nothing at all — cannot pass by leaving both rows in.
    owner_kind: "team",
    unmaintained: false,
    assurance: {
      grade: "partial",
      criteria: [{ criterion: "automated-hygiene", outcome: "unmet", detail: "not configured: push protection" }],
      hygiene: { secret_scanning: true, push_protection: false, dependabot_security_updates: false, update_configuration: true }
    }
  },
  {
    repository: "pcs-frontend",
    team: "dtsse",
    visibility: "public",
    default_branch_committed_at: "2026-09-09T00:00:00Z",
    owner_kind: "person",
    unmaintained: true,
    assurance: { grade: "unknown", criteria: [], hygiene: { secret_scanning: false } }
  }
];

const CONTRIBUTORS: Record<string, Contributor[]> = { dtsse: [{ login: "ef32", name: "Tam Arah" }] };

const CHECKS = ["Secret scanning", "Push protection", "Vulnerability alerts", "Dependency updates"];

/** The document the last click would have downloaded. */
let downloaded = "";

/** The document last handed to a `Blob`, which is the only synchronous way back to it in jsdom. */
let built = "";

function url(query: string): void {
  window.history.replaceState(null, "", `/repositories?${query}`);
}

/**
 * Next's patch, in the one line of it that matters here: write the history, then wake the readers.
 *
 * Installed rather than assumed, because a `replaceState` that notified nobody is precisely the failure this
 * file exists to rule out — the URL would move and the page would not follow. The real patch does this in a
 * `startTransition`; here it is synchronous, which is the same order of events one tick earlier.
 */
function patchHistory(): () => void {
  const original = window.history.replaceState.bind(window.history);
  window.history.replaceState = (data: unknown, unused: string, target?: string | URL | null) => {
    original(data, unused, target);
    for (const notify of [...readers]) {
      notify();
    }
  };
  return () => {
    window.history.replaceState = original;
  };
}

let restoreHistory: () => void;

function written(): string {
  return `${window.location.pathname}${window.location.search}`;
}

/** The page as `/repositories` assembles it: the export is the table's action, so both read one query. */
function mount() {
  return render(
    <RepositoriesTable rows={ROWS} weeks={12} action={<RepositoriesExport rows={ROWS} teamContributors={CONTRIBUTORS} window="2026-06-08 to 2026-08-31" />} />
  );
}

/** The whole page, wheels included: three components over one query, which is what the summary added to it. */
function mountWithWheels() {
  return render(
    <>
      <EstateSummary rows={ROWS} />
      <RepositoriesTable rows={ROWS} weeks={12} action={<RepositoriesExport rows={ROWS} teamContributors={CONTRIBUTORS} window="2026-06-08 to 2026-08-31" />} />
    </>
  );
}

/** One wheel's legend entry, which is the wedge's own control and the half of it jsdom can aim at. */
function slice(wheel: string, label: string): HTMLElement {
  return within(screen.getByRole("group", { name: `${wheel} filter` })).getByRole("button", { name: new RegExp(label) });
}

function expander(): HTMLElement {
  return screen.getByRole("button", { name: EXPAND_LABEL });
}

/** The repositories the table is currently drawing, read off the link in each row's second cell. */
function rowNames(): string[] {
  return screen.getAllByRole("row").flatMap((line) => {
    const link = within(line).queryAllByRole("link", { name: /^pcs-/ })[0];
    return link === undefined ? [] : [link.textContent ?? ""];
  });
}

/** The column names the table is currently drawing, read off each header's own accessible name. */
function headerNames(): (string | null)[] {
  return screen.getAllByRole("columnheader").map((cell) => cell.getAttribute("aria-label"));
}

/** The headings of the file a click on Export would produce. */
function exportedHeadings(): string {
  fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
  return downloaded.split("\r\n")[0] ?? "";
}

/** The repositories in that file, read out of its rows. */
function exportedRepositories(): string[] {
  fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
  return downloaded
    .split("\r\n")
    .slice(1)
    .map((row) => row.split(",")[2] ?? "");
}

beforeEach(() => {
  replaced = [];
  built = "";
  downloaded = "";
  url("weeks=12");
  restoreHistory = patchHistory();

  // jsdom has no synchronous blob reader and no object-URL registry, so the document is captured where it is
  // constructed and the anchor's click is replaced with a recorder. Same approach as `RepositoriesExport.test.tsx`.
  vi.stubGlobal(
    "Blob",
    class {
      constructor(parts: string[]) {
        built = parts.join("");
      }
    }
  );
  vi.stubGlobal("URL", { createObjectURL: () => "blob:stubbed", revokeObjectURL: () => undefined });
  // `ResponsiveContainer` constructs one on mount and jsdom has none, so the wheels would throw before a legend
  // entry existed to click. It reports nothing, which leaves each ring an empty sized box — the legend is outside
  // the container and is what these cases aim at. `charts/__tests__/SummaryPieChart.test.tsx` is where an
  // observation is reported and the wedges themselves are clicked.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  );
  const create = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
    const element = create(tag);
    if (tag === "a") {
      element.click = () => {
        downloaded = built;
      };
    }
    return element;
  });
});

afterEach(() => {
  cleanup();
  restoreHistory();
  readers.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the estate table and its export over one query", () => {
  it("should draw the four checks on the click, without asking the server for anything", () => {
    // THE REPORTED DEFECT, in the two assertions it needs: the columns appear, and no request was made to make
    // them appear. Every answer they print comes from `hygieneSignals(row)`, which is already in props.
    mount();
    expect(headerNames()).not.toContain("Push protection");

    fireEvent.click(expander());

    expect(headerNames().slice(headerNames().indexOf("Hygiene"), headerNames().indexOf("Secrets") + 1)).toEqual(["Hygiene", ...CHECKS, "Secrets"]);
    expect(replaced).toEqual([]);
  });

  it("should hand the export the four checks the reader has just opened", () => {
    // WHY THE TOGGLE IS IN THE URL AT ALL. The export cannot see component state, so a file whose columns follow
    // the page is only possible with the state in the query — which is why this change kept the URL and dropped
    // only the navigation.
    mount();
    for (const label of CHECKS) {
      expect(exportedHeadings()).not.toContain(label);
    }

    fireEvent.click(expander());

    for (const label of CHECKS) {
      expect(exportedHeadings()).toContain(label);
    }
    // The aggregate stays beside them, on the page and in the file.
    expect(exportedHeadings()).toContain("Hygiene");
  });

  it("should take the columns away again on the second click, in the file as on the page", () => {
    mount();
    fireEvent.click(expander());
    expect(headerNames()).toContain("Push protection");

    fireEvent.click(expander());

    expect(headerNames()).not.toContain("Push protection");
    expect(exportedHeadings()).not.toContain("Push protection");
    expect(written()).toBe("/repositories?weeks=12");
  });

  it("should narrow the file with the toggle that narrowed the table, and still not navigate", () => {
    // The filters are the same seam as the expansion and were the same defect. `pcs-frontend` is not a production
    // service, so one click has to take it out of the table AND out of the file.
    mount();
    expect(exportedRepositories()).toEqual(["pcs-api", "pcs-frontend"]);

    fireEvent.click(within(screen.getByRole("group", { name: "Repository filters" })).getByRole("button", { name: /Production/ }));

    expect(exportedRepositories()).toEqual(["pcs-api"]);
    expect(written()).toBe("/repositories?weeks=12&production=true");
    expect(replaced).toEqual([]);
  });

  it("should narrow the table and the file to a clicked slice, without asking the server for anything", () => {
    // THE WHOLE POINT OF THE WHEELS BEING BACK. The distribution is a chart; narrowing the list on a click is what
    // makes it a control, and it costs no request because `filterRepositories` runs over the rows in props.
    mountWithWheels();
    expect(exportedRepositories()).toEqual(["pcs-api", "pcs-frontend"]);

    fireEvent.click(slice("Code owner", "Individual"));

    expect(rowNames()).toEqual(["pcs-frontend"]);
    expect(exportedRepositories()).toEqual(["pcs-frontend"]);
    expect(written()).toBe("/repositories?weeks=12&owner=individual");
    expect(replaced).toEqual([]);
  });

  it("should widen the table again on a second click of the same slice", () => {
    mountWithWheels();

    fireEvent.click(slice("Maintained", "Unmaintained"));
    expect(rowNames()).toEqual(["pcs-frontend"]);

    fireEvent.click(slice("Maintained", "Unmaintained"));

    expect(rowNames()).toEqual(["pcs-api", "pcs-frontend"]);
    expect(written()).toBe("/repositories?weeks=12");
    expect(replaced).toEqual([]);
  });

  it("should stack a slice with the toggles rather than replacing what they filtered", () => {
    // Four kinds of control, one query, one AND: `pcs-api` is the production service AND the team-owned row, so
    // both narrowings leave it and a wedge that overwrote the toggle would leave the other one too.
    mountWithWheels();

    fireEvent.click(within(screen.getByRole("group", { name: "Repository filters" })).getByRole("button", { name: /Production/ }));
    fireEvent.click(slice("Code owner", "Team"));

    expect(rowNames()).toEqual(["pcs-api"]);
    expect(written()).toBe("/repositories?weeks=12&production=true&owner=team");
    expect(replaced).toEqual([]);
  });

  it("should leave the wheels' own figures alone when a toggle narrows the table under them", () => {
    // The wheels are drawn over the public estate and say so beside themselves, so they must not move with the
    // table's filters — a figure that changed under a control it does not name is worse than one whose denominator
    // is stated.
    mountWithWheels();
    expect(slice("Maintained", "Maintained").textContent).toContain("1");

    fireEvent.click(slice("Maintained", "Unmaintained"));

    expect(rowNames()).toEqual(["pcs-frontend"]);
    expect(slice("Maintained", "Maintained").textContent).toContain("1");
  });

  it("should show the slice a shared link names as pressed when the page opens on one", () => {
    url("weeks=12&owner=individual");
    mountWithWheels();

    expect(slice("Code owner", "Individual").getAttribute("aria-pressed")).toBe("true");
    expect(rowNames()).toEqual(["pcs-frontend"]);
  });

  it("should keep the expansion and the filters in one query rather than overwriting one with the other", () => {
    // Two controls, two parameters, no navigation between them: each reads the live `window.location.search`, so
    // the second click cannot write over what the first left. A shared link carries both.
    mount();

    fireEvent.click(expander());
    fireEvent.click(within(screen.getByRole("group", { name: "Repository filters" })).getByRole("button", { name: /Production/ }));

    expect(written()).toBe("/repositories?weeks=12&hygiene=true&production=true");
    expect(headerNames()).toContain("Push protection");
    expect(exportedRepositories()).toEqual(["pcs-api"]);
    expect(exportedHeadings()).toContain("Push protection");
  });
});
