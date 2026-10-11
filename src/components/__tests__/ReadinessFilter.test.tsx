/**
 * @vitest-environment jsdom
 */

/**
 * The readiness tiles' clicks, which write the URL the lists on `/teams` and `/contributors` read back.
 *
 * `replaced` must stay empty, as it must for the estate wheels: a router navigation here would refetch the window
 * to filter rows the page already holds.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const readers = new Set<() => void>();

function subscribe(notify: () => void): () => void {
  readers.add(notify);
  return () => void readers.delete(notify);
}

let replaced: string[] = [];

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: (target: string) => void replaced.push(target) }),
  usePathname: () => "/teams",
  useSearchParams: () => new URLSearchParams(useSyncExternalStore(subscribe, () => window.location.search))
}));

import { ReadinessFilter } from "@/components/ReadinessFilter";
import { classify, readinessTiles } from "@/lib/readiness";

const TILES = readinessTiles([classify(["green"]), classify(["green", "red"]), classify(["cannot_assess"])]);

let restoreHistory: () => void;

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

function url(query: string): void {
  window.history.replaceState(null, "", query === "" ? "/teams" : `/teams?${query}`);
}

function written(): string {
  return `${window.location.pathname}${window.location.search}`;
}

function button(name: string): HTMLElement {
  return screen.getByRole("button", { name });
}

beforeEach(() => {
  replaced = [];
  url("weeks=12");
  restoreHistory = patchHistory();
});

afterEach(() => {
  cleanup();
  restoreHistory();
  readers.clear();
});

describe("ReadinessFilter", () => {
  it("draws a count per group and per subgroup, Cannot assess with none beneath it", () => {
    render(<ReadinessFilter tiles={TILES} />);

    expect(button("Ready only: 1")).toBeTruthy();
    expect(button("Review: 1")).toBeTruthy();
    expect(button("Ready + Blocked: 1")).toBeTruthy();
    expect(button("Cannot assess: 1")).toBeTruthy();
    // Four group counts and seven subgroup counts.
    expect(screen.getAllByRole("button")).toHaveLength(11);
  });

  it("filters on a group, keeping the rest of the query, and clears on a second click", () => {
    render(<ReadinessFilter tiles={TILES} />);

    fireEvent.click(button("Review: 1"));
    expect(written()).toBe("/teams?weeks=12&readiness=review");
    expect(button("Review: 1").getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(button("Review: 1"));
    expect(written()).toBe("/teams?weeks=12");
    expect(replaced).toEqual([]);
  });

  it("filters on a subgroup, fading the tiles and the siblings outside it", () => {
    render(<ReadinessFilter tiles={TILES} />);

    fireEvent.click(button("Ready + Blocked: 1"));
    expect(written()).toBe("/teams?weeks=12&readiness=green-red");
    expect(button("Ready + Blocked: 1").getAttribute("aria-pressed")).toBe("true");
    expect(button("Ready + Blocked: 1").style.opacity).toBe("1");
    expect(button("Caution only: 0").style.opacity).toBe("0.35");
    expect(button("Ready: 1").parentElement?.style.opacity).toBe("0.35");
    expect(button("Review: 1").parentElement?.style.opacity).toBe("1");
  });

  it("dims a count of zero and treats a key naming nothing as no filter", () => {
    url("readiness=purple");
    render(<ReadinessFilter tiles={TILES} />);

    expect(button("Blocked: 0").style.opacity).toBe("0.38");
    expect(screen.getAllByRole("button").filter((entry) => entry.getAttribute("aria-pressed") === "true")).toEqual([]);

    fireEvent.click(button("Blocked: 0"));
    expect(written()).toBe("/teams?readiness=blocked");
  });
});
