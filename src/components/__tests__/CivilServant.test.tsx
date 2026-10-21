/**
 * @vitest-environment jsdom
 */

/**
 * The Civil Servant badge in its own column of every contributor table and on the team cards, and the toggles on
 * `/contributors` and `/teams` that filter on it.
 *
 * The badge renders for `true` and for nothing else, so an unflagged row reads exactly as it did before the flag
 * existed. The toggles write the URL with `replaceState`, as the readiness tiles do, and the lists and the tiles
 * read it back.
 */

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const readers = new Set<() => void>();

function subscribe(notify: () => void): () => void {
  readers.add(notify);
  return () => void readers.delete(notify);
}

vi.mock("next/navigation", () => ({
  usePathname: () => "/contributors",
  useSearchParams: () => new URLSearchParams(useSyncExternalStore(subscribe, () => window.location.search))
}));

import { ActorsTable } from "@/components/ActorsTable";
import { CivilServantBadge } from "@/components/CivilServantBadge";
import { CivilServantFilter } from "@/components/CivilServantFilter";
import { ContributorName } from "@/components/ContributorName";
import { ContributorReadinessFilter } from "@/components/ContributorReadinessFilter";
import { ContributorsTable } from "@/components/ContributorsTable";
import { EntityHeader } from "@/components/EntityHeader";
import { TeamActorsTable } from "@/components/TeamActorsTable";
import { TeamReadinessFilter } from "@/components/TeamReadinessFilter";
import { TeamsList } from "@/components/TeamsList";
import { CIVIL_SERVANT_PEOPLE_TOGGLE, CIVIL_SERVANT_TEAMS_TOGGLE } from "@/lib/civil-servant";
import type { ActorRow, TeamRow } from "@/lib/types";

let restoreHistory: () => void;

beforeEach(() => {
  const original = window.history.replaceState.bind(window.history);
  window.history.replaceState = (data: unknown, unused: string, target?: string | URL | null) => {
    original(data, unused, target);
    for (const notify of [...readers]) {
      notify();
    }
  };
  restoreHistory = () => {
    window.history.replaceState = original;
  };
  window.history.replaceState(null, "", "/contributors");
});

afterEach(() => {
  cleanup();
  restoreHistory();
});

function written(): string {
  return `${window.location.pathname}${window.location.search}`;
}

describe("CivilServantBadge", () => {
  it("should render for a flagged row and for nothing else", () => {
    render(
      <>
        <CivilServantBadge civilServant />
        <CivilServantBadge civilServant={false} />
        <CivilServantBadge />
      </>
    );

    expect(screen.getAllByText("Civil Servant")).toHaveLength(1);
  });
});

describe("ContributorName", () => {
  it("should carry no badge of its own, which has a column now", () => {
    render(<ContributorName person={{ login: "GEvans-HMCTS", name: "Gareth Evans", civil_servant: true }} weeks={8} />);

    expect(screen.queryByText("Civil Servant")).toBeNull();
  });
});

describe("EntityHeader", () => {
  it("should badge a flagged contributor's or team's own page", () => {
    render(<EntityHeader kind="contributor" name="Gareth Evans" identifier={false} civilServant />);

    expect(screen.getByText("Civil Servant")).toBeTruthy();
  });
});

/** The cells of one table column, by its header's position. */
function column(header: string): HTMLElement[] {
  const headers = screen.getAllByRole("columnheader");
  const index = headers.findIndex((cell) => cell.textContent === header);
  expect(index).toBeGreaterThan(-1);
  return screen
    .getAllByRole("row")
    .slice(1)
    .map((row) => row.querySelectorAll("td")[index] as HTMLElement);
}

describe("the Civil Servant column", () => {
  const ROWS: ActorRow[] = [
    { login: "zed", repositories: 1, labels: ["green"] },
    { login: "GEvans-HMCTS", civil_servant: true, repositories: 2, labels: ["green"] }
  ];

  it("should sit between the contributor and their repositories on /contributors, centred", () => {
    render(<ActorsTable rows={ROWS} weeks={8} labelled />);

    expect(screen.getAllByRole("columnheader").map((cell) => cell.getAttribute("aria-label"))).toEqual([
      "Contributor",
      "Civil Servant",
      "Repositories",
      "Readiness"
    ]);
    expect(screen.getByRole("columnheader", { name: "Civil Servant" }).className).toContain("text-center");
    const cells = column("Civil Servant");
    expect(cells.map((cell) => cell.textContent)).toEqual(["", "Civil Servant"]);
    expect(cells[1]?.className).toContain("text-center");
  });

  it("should sort the flagged first, and the rest in the order they came", () => {
    render(<ActorsTable rows={ROWS} weeks={8} labelled />);

    fireEvent.click(within(screen.getByRole("columnheader", { name: "Civil Servant" })).getByRole("button"));

    expect(column("Civil Servant").map((cell) => cell.textContent)).toEqual(["Civil Servant", ""]);
  });

  it("should flow through to a team's contributors", () => {
    render(
      <TeamActorsTable
        rows={[
          { login: "GEvans-HMCTS", civil_servant: true, repositories: 1, contributions: 3 },
          { login: "zed", repositories: 1, contributions: 1 }
        ]}
        weeks={8}
      />
    );

    expect(screen.getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual([
      "Contributor",
      "Civil Servant",
      "Repositories in team",
      "Merges in team"
    ]);
    expect(column("Civil Servant").map((cell) => cell.textContent)).toEqual(["Civil Servant", ""]);
  });

  it("should flow through to a repository's contributors", () => {
    render(
      <ContributorsTable
        rows={[
          { login: "GEvans-HMCTS", civil_servant: true, contributions: 3, blocking: 0, metrics: [] },
          { login: "zed", contributions: 1, blocking: 0, metrics: [] }
        ]}
        weeks={8}
      />
    );

    expect(screen.getAllByRole("columnheader")[1]?.textContent).toBe("Civil Servant");
    expect(column("Civil Servant").map((cell) => cell.textContent)).toEqual(["Civil Servant", ""]);
  });
});

describe("the civil-servant toggle on /contributors", () => {
  const ROWS: ActorRow[] = [
    { login: "GEvans-HMCTS", civil_servant: true, repositories: 2, labels: ["green"] },
    { login: "zed", repositories: 1, labels: ["green"] }
  ];

  function logins(): string[] {
    return screen
      .getAllByRole("row")
      .slice(1)
      .map((row) => row.querySelector("a")?.textContent ?? "");
  }

  it("should narrow the list to the flagged people and back, through the URL", () => {
    render(
      <>
        <CivilServantFilter label={CIVIL_SERVANT_PEOPLE_TOGGLE} count={1} />
        <ActorsTable rows={ROWS} weeks={8} labelled />
      </>
    );
    const toggle = screen.getByRole("button", { name: /Civil Servants only/ });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(logins()).toEqual(["GEvans-HMCTS", "zed"]);

    fireEvent.click(toggle);

    expect(written()).toBe("/contributors?civil-servants=true");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(logins()).toEqual(["GEvans-HMCTS"]);

    fireEvent.click(toggle);

    // Off is the parameter's absence, not an empty one.
    expect(written()).toBe("/contributors");
    expect(logins()).toEqual(["GEvans-HMCTS", "zed"]);
  });

  it("should keep the filter box's term when it writes", () => {
    window.history.replaceState(null, "", "/contributors?contributor=evans");
    render(<CivilServantFilter label={CIVIL_SERVANT_PEOPLE_TOGGLE} count={1} />);

    fireEvent.click(screen.getByRole("button", { name: /Civil Servants only/ }));

    expect(written()).toBe("/contributors?contributor=evans&civil-servants=true");
  });

  it("should read only its own value as on", () => {
    window.history.replaceState(null, "", "/contributors?civil-servants=1");
    render(<ActorsTable rows={ROWS} weeks={8} labelled />);

    expect(logins()).toEqual(["GEvans-HMCTS", "zed"]);
  });
});

function count(name: string): HTMLElement {
  return screen.getByRole("button", { name });
}

describe("the readiness tiles on /contributors", () => {
  const ROWS: ActorRow[] = [
    { login: "GEvans-HMCTS", civil_servant: true, repositories: 1, labels: ["green"] },
    { login: "js-hmcts", civil_servant: true, repositories: 1, labels: ["red"] },
    { login: "zed", repositories: 1, labels: ["green"] },
    { login: "amy", repositories: 1, labels: ["amber"] }
  ];

  it("should count everybody until the toggle is on, and only the civil servants once it is", () => {
    render(
      <>
        <ContributorReadinessFilter rows={ROWS} labelled />
        <CivilServantFilter label={CIVIL_SERVANT_PEOPLE_TOGGLE} count={2} />
      </>
    );
    expect(count("Ready: 2")).toBeTruthy();
    expect(count("Ready only: 2")).toBeTruthy();
    expect(count("Review: 1")).toBeTruthy();
    expect(count("Blocked: 1")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Civil Servants only/ }));

    expect(count("Ready: 1")).toBeTruthy();
    expect(count("Ready only: 1")).toBeTruthy();
    // `amy` was the whole of Review, and she is not flagged.
    expect(count("Review: 0")).toBeTruthy();
    expect(count("Blocked: 1")).toBeTruthy();
  });
});

describe("/teams", () => {
  function team(name: string, labels: Record<string, number>, civilServant = false): TeamRow {
    return { team: name, repositories: 1, unavailable: 0, actors: 1, labels, ...(civilServant ? { civil_servant: true as const } : {}) };
  }

  const TEAMS: TeamRow[] = [team("civil", { green: 1 }, true), team("platform", { green: 1 }), team("probate", { red: 1 }, true)];

  function cards(): string[] {
    return screen.getAllByRole("link").map((link) => link.textContent ?? "");
  }

  it("should badge a flagged team just right of its name, centred on it", () => {
    render(<TeamsList rows={TEAMS} weeks={8} />);

    const name = screen.getByRole("link", { name: "civil" });
    const line = name.parentElement as HTMLElement;
    expect(line.className).toContain("items-center");
    expect(line.lastElementChild?.textContent).toBe("Civil Servant");
    expect(screen.getByRole("link", { name: "platform" }).parentElement?.textContent).toBe("platform");
  });

  it("should narrow the cards and the tiles to the flagged teams", () => {
    render(
      <>
        <TeamReadinessFilter rows={TEAMS} />
        <CivilServantFilter label={CIVIL_SERVANT_TEAMS_TOGGLE} count={2} />
        <TeamsList rows={TEAMS} weeks={8} />
      </>
    );
    expect(cards()).toEqual(["civil", "platform", "probate"]);
    expect(count("Ready: 2")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Civil Servant teams only/ }));

    expect(written()).toBe("/contributors?civil-servants=true");
    expect(cards()).toEqual(["civil", "probate"]);
    expect(count("Ready: 1")).toBeTruthy();
    expect(count("Blocked: 1")).toBeTruthy();
  });
});
