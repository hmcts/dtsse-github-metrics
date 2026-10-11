/**
 * @vitest-environment jsdom
 */

/**
 * The team cards as the filters above them narrow them: the term in the filter box and the readiness tiles' group.
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

let parameters = new URLSearchParams();

vi.mock("next/navigation", () => ({ useSearchParams: () => parameters }));

import { TeamsList } from "@/components/TeamsList";
import type { TeamRow } from "@/lib/types";

const ROWS: TeamRow[] = [
  { team: "civil", repositories: 3, unavailable: 0, actors: 4, labels: { green: 3 } },
  { team: "family", repositories: 2, unavailable: 0, actors: 2, labels: { green: 1, red: 1 } },
  { team: "probate", repositories: 1, unavailable: 0, actors: 1, labels: { cannot_assess: 1 } },
  { team: "crime", repositories: 1, unavailable: 0, actors: 1, labels: { not_assessed: 1 } }
];

function teams(): string[] {
  return screen.getAllByRole("link").map((link) => link.textContent ?? "");
}

afterEach(() => {
  cleanup();
  parameters = new URLSearchParams();
});

describe("TeamsList readiness filter", () => {
  it("lists every team under no filter, the ungraded one included", () => {
    render(<TeamsList rows={ROWS} weeks={8} />);
    expect(teams()).toEqual(["civil", "family", "probate", "crime"]);
  });

  it("narrows to a group and to a subgroup", () => {
    parameters = new URLSearchParams("readiness=review");
    render(<TeamsList rows={ROWS} weeks={8} />);
    expect(teams()).toEqual(["family"]);

    cleanup();
    parameters = new URLSearchParams("readiness=green");
    render(<TeamsList rows={ROWS} weeks={8} />);
    expect(teams()).toEqual(["civil"]);
  });

  it("applies the term and the group together, and says so when they leave nothing", () => {
    parameters = new URLSearchParams("readiness=cannot_assess&team=civil");
    render(<TeamsList rows={ROWS} weeks={8} />);
    expect(screen.getByText("No team matches this filter.")).toBeTruthy();
  });
});
