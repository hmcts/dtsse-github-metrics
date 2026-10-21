/**
 * @vitest-environment jsdom
 */

/**
 * The civil-servant badge wherever a person is named, and the `/contributors` toggle that filters on it.
 *
 * The badge renders for `true` and for nothing else, so an unflagged person reads exactly as they did before the
 * flag existed. The toggle writes the URL with `replaceState`, as the readiness tiles do, and `ActorsTable` reads
 * it back.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
import { EntityHeader } from "@/components/EntityHeader";
import type { ActorRow } from "@/lib/types";

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
  it("should render for a flagged person and for nobody else", () => {
    render(
      <>
        <CivilServantBadge civilServant />
        <CivilServantBadge civilServant={false} />
        <CivilServantBadge />
      </>
    );

    expect(screen.getAllByText("Civil servant")).toHaveLength(1);
  });
});

describe("ContributorName", () => {
  it("should badge a named civil servant on the line beside their login", () => {
    render(<ContributorName person={{ login: "GEvans-HMCTS", name: "Gareth Evans", civil_servant: true }} weeks={8} />);

    const login = screen.getByText("GEvans-HMCTS");
    expect(login.parentElement?.textContent).toBe("GEvans-HMCTSCivil servant");
    // The link's own block stays the link alone, for `link-in-text-block`.
    expect(screen.getByRole("link").parentElement?.textContent).toBe("Gareth Evans");
  });

  it("should give an unnamed civil servant a second line holding only the badge", () => {
    render(<ContributorName person={{ login: "js-hmcts", civil_servant: true }} weeks={8} />);

    expect(screen.getAllByText("js-hmcts")).toHaveLength(1);
    expect(screen.getByText("Civil servant")).toBeTruthy();
  });

  it("should draw nobody else any differently, with no second line where there is no name", () => {
    const { container } = render(<ContributorName person={{ login: "zed" }} weeks={8} />);

    expect(screen.queryByText("Civil servant")).toBeNull();
    expect(container.children).toHaveLength(1);
  });
});

describe("EntityHeader", () => {
  it("should badge a contributor's own page when they are flagged", () => {
    render(<EntityHeader kind="contributor" name="Gareth Evans" identifier={false} civilServant />);

    expect(screen.getByText("Civil servant")).toBeTruthy();
  });
});

describe("the civil-servant toggle", () => {
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
        <CivilServantFilter count={1} />
        <ActorsTable rows={ROWS} weeks={8} labelled />
      </>
    );
    const toggle = screen.getByRole("button", { name: /Civil servants only/ });
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
    render(<CivilServantFilter count={1} />);

    fireEvent.click(screen.getByRole("button", { name: /Civil servants only/ }));

    expect(written()).toBe("/contributors?contributor=evans&civil-servants=true");
  });

  it("should read only its own value as on", () => {
    window.history.replaceState(null, "", "/contributors?civil-servants=1");
    render(<ActorsTable rows={ROWS} weeks={8} labelled />);

    expect(logins()).toEqual(["GEvans-HMCTS", "zed"]);
  });
});
