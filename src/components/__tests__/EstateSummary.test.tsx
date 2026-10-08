/**
 * @vitest-environment jsdom
 */

/**
 * That the estate summary draws one group per cohort, each over its own denominator.
 *
 * THE DENOMINATORS ARE THE CLAIM. A group's heading states how many repositories its wheels were counted over,
 * and the public group's empty state must not take the all-repositories group down with it — an estate with
 * nothing public in it still has a readiness distribution to show.
 *
 * The all cohort is exercised with a wheel defined here rather than one from `ESTATE_DIMENSIONS`, so these cases
 * hold whichever wheels the cohort happens to carry.
 */

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EstateSummary } from "@/components/EstateSummary";
import { ESTATE_DIMENSIONS, type EstateDimension } from "@/lib/rows";
import type { RepositoryRow } from "@/lib/types";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => undefined }),
  usePathname: () => "/repositories",
  useSearchParams: () => new URLSearchParams()
}));

/** A wheel over every row: public or not, split on whether the row is production. */
const EVERYWHERE: EstateDimension = {
  parameter: "everywhere",
  title: "Everywhere",
  hint: "Every row, split on production.",
  cohort: "all",
  slices: [
    { key: "live", label: "Live", state: "green", holds: (row) => row.production === true },
    { key: "other", label: "Other", state: "none", holds: (row) => row.production !== true }
  ]
};

const DIMENSIONS: readonly EstateDimension[] = [EVERYWHERE, ...ESTATE_DIMENSIONS];

const MIXED: RepositoryRow[] = [
  { repository: "open", team: "dtsse", visibility: "public", production: true },
  { repository: "inner", team: "dtsse", visibility: "internal", production: true },
  { repository: "closed", team: "dtsse", visibility: "private" }
];

/** One group's panel, found by its heading. */
function group(heading: string): HTMLElement {
  const found = screen.getByRole("heading", { name: heading }).closest("section");
  if (found === null) {
    throw new Error(`no panel holds ${heading}`);
  }
  return found;
}

beforeEach(() => {
  // `ResponsiveContainer` constructs one on mount and jsdom has none; the legends these cases read sit outside it.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("EstateSummary", () => {
  it("should draw an all-repositories group and a public group, each stating its own count", () => {
    render(<EstateSummary rows={MIXED} weeks={4} dimensions={DIMENSIONS} />);

    expect(within(group("Estate summary: all repositories")).getByText(/^3 repositories;/)).toBeTruthy();
    expect(within(group("Estate summary: public repositories")).getByText(/^1 public repository;/)).toBeTruthy();
  });

  it("should put each wheel in its own cohort's group and count it over that cohort", () => {
    render(<EstateSummary rows={MIXED} weeks={4} dimensions={DIMENSIONS} />);

    const all = group("Estate summary: all repositories");
    const everywhere = within(all).getByRole("group", { name: "Everywhere filter" });
    expect(within(everywhere).getByRole("button", { name: /Live/ }).textContent).toContain("2");
    expect(within(everywhere).getByRole("button", { name: /Other/ }).textContent).toContain("1");
    expect(within(all).queryByRole("group", { name: "Code owner filter" })).toBeNull();

    const publicGroup = group("Estate summary: public repositories");
    expect(within(publicGroup).getByRole("group", { name: "Code owner filter" })).toBeTruthy();
    expect(within(publicGroup).queryByRole("group", { name: "Everywhere filter" })).toBeNull();
  });

  it("should show the public empty state without hiding the all-repositories group", () => {
    const nothingPublic = MIXED.filter((row) => row.visibility !== "public");
    render(<EstateSummary rows={nothingPublic} weeks={4} dimensions={DIMENSIONS} />);

    expect(within(group("Estate summary: public repositories")).getByText("No public repository is reported for this organisation.")).toBeTruthy();
    expect(within(group("Estate summary: all repositories")).getByText(/^2 repositories;/)).toBeTruthy();
    expect(screen.getByRole("group", { name: "Everywhere filter" })).toBeTruthy();
  });

  it("should draw no group for a cohort with no wheel in it", () => {
    render(<EstateSummary rows={MIXED} weeks={4} dimensions={ESTATE_DIMENSIONS.filter((dimension) => dimension.cohort === "public")} />);

    expect(screen.queryByRole("heading", { name: "Estate summary: all repositories" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Estate summary: public repositories" })).toBeTruthy();
  });

  it("should draw the four brought-back wheels in the all-repositories group, in order, over every row", () => {
    render(<EstateSummary rows={MIXED} weeks={4} />);
    const everywhere = group("Estate summary: all repositories");

    expect(
      within(everywhere)
        .getAllByRole("heading", { level: 3 })
        .map((heading) => heading.textContent)
    ).toEqual(["AI readiness (4 weeks)", "Enforces review", "Enforces CI", "Test coverage"]);
    // Nothing is graded on these rows, so every one lands in each wheel's unmeasured slice — all three of them.
    expect(within(screen.getByRole("group", { name: "Enforces review filter" })).getByRole("button", { name: /Unknown/ }).textContent).toContain("3");
  });
});
