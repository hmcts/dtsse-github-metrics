/**
 * @vitest-environment jsdom
 */

/**
 * The wheel's hover card and its clicks — the two halves of it that need a browser.
 *
 * `components/__tests__/charts.test.ts` asserts what a server render puts on the page and stops there, because
 * `react-dom/server` measures nothing and recharts draws from a measured width. The wedges therefore do not exist
 * in that renderer, and neither does the card they are hovered for.
 *
 * That card is not decoration: it is where a slice's count and its share of the whole are read, and the share is
 * the only figure this component derives. So the chart is given a width here through a stubbed `ResizeObserver`,
 * its opening animation is run out on fake timers, and each wedge is hovered in turn with the events a pointer
 * would send.
 *
 * The timers are faked rather than waited out. recharts reveals the wedges over an animation, so real time gives a
 * nondeterministic count part-way through it — three seconds of fake time reaches the settled ring every run, and
 * in milliseconds.
 *
 * THE CLICKS ARE HERE FOR A SHARPER REASON THAN THE CARD. A wheel is the filter control for the dimension it
 * draws, and where a click leaves the URL — and that it leaves the URL rather than the router — is only decidable
 * from a browser. `replaced` is the canary: it must stay empty, because a `router.replace` put back here would
 * refetch the whole estate to answer a question `filterRepositories` answers over the rows already in props.
 */

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SummaryPieChart } from "@/components/charts/SummaryPieChart";
import type { PieSlice } from "@/lib/chart";

/** Anything a `replaceState` should wake, which is every component reading the query. */
const readers = new Set<() => void>();

function subscribe(notify: () => void): () => void {
  readers.add(notify);
  return () => void readers.delete(notify);
}

/** What the stubbed router was asked to navigate to. Must stay empty: that is the point of the component. */
let replaced: string[] = [];

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: (target: string) => void replaced.push(target) }),
  usePathname: () => "/repositories",
  // Next's own integration, in the two lines this seam depends on: the hook reports `window.location`, and a
  // `replaceState` is what moves it on. See `components/__tests__/repositories-url-state.test.tsx`.
  useSearchParams: () => new URLSearchParams(useSyncExternalStore(subscribe, () => window.location.search))
}));

/** The dimension these cases filter on, which is a real one so the test cannot pass on a parameter nothing reads. */
const PARAMETER = "owner";

/** A distribution whose shares are not round, so a wrong divisor is visible, with one slice at zero. */
const SLICES: PieSlice[] = [
  { key: "team", name: "Team", value: 5, color: "#4ade80" },
  { key: "individual", name: "Individual", value: 0, color: "#fbbf24" },
  { key: "nobody", name: "Nobody", value: 3, color: "#f87171" }
];

/** Longer than the opening animation, so every wedge has reached its final angle. */
const SETTLED_MILLISECONDS = 3000;

/**
 * The size a browser would measure, which jsdom never does.
 *
 * `ResponsiveContainer` renders nothing at all until an observation arrives — its initial dimension is negative
 * and it waits for one — so without this the chart is a sized empty div and every assertion below would pass
 * vacuously against markup with no wedges in it.
 */
class ObservedAt400By175 {
  constructor(private readonly report: ResizeObserverCallback) {}

  observe(target: Element): void {
    const entry = { target, contentRect: { width: 400, height: 175 } };
    this.report([entry as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
  }

  unobserve(): void {}

  disconnect(): void {}
}

const noResizeObserver = globalThis.ResizeObserver;

/** Next's patch, in the one line of it that matters: write the history, then wake the readers. */
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

/** Put the page at a query string. */
function url(query: string): void {
  window.history.replaceState(null, "", query === "" ? "/repositories" : `/repositories?${query}`);
}

function written(): string {
  return `${window.location.pathname}${window.location.search}`;
}

beforeAll(() => {
  Object.assign(globalThis, { ResizeObserver: ObservedAt400By175 });
});

afterAll(() => {
  Object.assign(globalThis, { ResizeObserver: noResizeObserver });
});

beforeEach(() => {
  replaced = [];
  url("weeks=12");
  restoreHistory = patchHistory();
  // `performance` and the animation frame as well as the timers: react-smooth drives the wedges from
  // `requestAnimationFrame` and reads the clock for its easing, so faking the timers alone would leave the
  // animation running in real time and the ring half-drawn.
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame", "performance", "Date"]
  });
});

afterEach(() => {
  cleanup();
  restoreHistory();
  readers.clear();
  vi.useRealTimers();
});

/** Render the wheel and run its opening animation out, so the ring is settled before it is read. */
async function drawn(data: readonly PieSlice[] = SLICES): Promise<HTMLElement> {
  const { container } = render(<SummaryPieChart title="Code owner" data={data} parameter={PARAMETER} />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(SETTLED_MILLISECONDS);
  });
  return container;
}

/** One legend entry as the control it is, found by the words on it. */
function entry(label: string): HTMLElement {
  return within(screen.getByRole("group", { name: "Code owner filter" })).getByRole("button", { name: new RegExp(label) });
}

/** The drawn wedges, keyed by the colour each was filled with rather than by their draw order. */
function wedges(container: HTMLElement): Record<string, Element> {
  return Object.fromEntries(
    [...container.querySelectorAll(".recharts-pie-sector")].map((sector) => [sector.querySelector("path")?.getAttribute("fill") ?? "unfilled", sector])
  );
}

/** One wedge by its fill, refusing rather than hovering nothing if the ring did not draw it. */
function wedge(container: HTMLElement, colour: string): Element {
  const drawn = wedges(container)[colour];
  if (drawn === undefined) {
    throw new Error(`no wedge was drawn in ${colour}`);
  }
  return drawn;
}

/** What the hover card says right now, or the empty string when there is no card. */
function card(container: HTMLElement): string {
  return container.querySelector(".recharts-tooltip-wrapper")?.textContent ?? "";
}

describe("the summary wheel's hover card", () => {
  it("should draw one wedge per counted slice when one of them is counted at zero", async () => {
    const container = await drawn();

    // Individual was counted at zero: it stays in the legend, dimmed, but a zero-width wedge with `paddingAngle`
    // on draws as a stray tick, so it is not in the ring.
    expect(Object.keys(wedges(container)).sort()).toEqual(["#4ade80", "#f87171"]);
    expect(screen.getByText("Individual")).toBeTruthy();
  });

  it("should name the hovered slice with its count and its share when a wedge is hovered", async () => {
    const container = await drawn();

    fireEvent.mouseOver(wedge(container, "#4ade80"));

    // 5 of 8, in the same words `percentageOf` prints in the figures beside the chart.
    expect(card(container)).toContain("Team");
    expect(card(container)).toContain("5");
    expect(card(container)).toContain("62.5%");
  });

  it("should answer for the wedge under the pointer when a second one is hovered", async () => {
    const container = await drawn();

    fireEvent.mouseOver(wedge(container, "#4ade80"));
    fireEvent.mouseOver(wedge(container, "#f87171"));

    expect(card(container)).toContain("Nobody");
    expect(card(container)).toContain("37.5%");
    expect(card(container)).not.toContain("Team");
  });

  it("should carry the slice's colour on a mark rather than on the words when a wedge is hovered", async () => {
    const container = await drawn();

    fireEvent.mouseOver(wedge(container, "#f87171"));

    // The text wears a text colour and a dot beside it carries identity: a word set in its series colour is one
    // value doing two jobs, and these hexes are tuned for a fill on the panel rather than for type on the card.
    const hover = container.querySelector(".recharts-tooltip-wrapper") as HTMLElement;
    expect(within(hover).getByText("Nobody").getAttribute("style")).toBeNull();
    expect(hover.innerHTML).toContain("background-color: rgb(248, 113, 113)");
  });

  it("should take the card away when the pointer leaves, rather than leaving a figure up", async () => {
    const container = await drawn();

    fireEvent.mouseOver(wedge(container, "#4ade80"));
    expect(card(container)).toContain("Team");

    fireEvent.mouseLeave(container.querySelector(".recharts-wrapper") as Element);

    expect(card(container)).toBe("");
  });

  it("should say it has no data when nothing at all was counted", async () => {
    const container = await drawn([
      { key: "team", name: "Team", value: 0, color: "#4ade80" },
      { key: "nobody", name: "Nobody", value: 0, color: "#f87171" }
    ]);

    expect(wedges(container)).toEqual({});
    expect(screen.getByText("No data")).toBeTruthy();
  });

  it("should draw a single slice as one whole wedge when it is the only one counted", async () => {
    const container = await drawn([{ key: "team", name: "Team", value: 4, color: "#4ade80" }]);

    expect(Object.keys(wedges(container))).toEqual(["#4ade80"]);
    fireEvent.mouseOver(wedge(container, "#4ade80"));
    expect(card(container)).toContain("100%");
  });
});

describe("the summary wheel as a filter control", () => {
  it("should write the slice's key and not its words when a legend entry is clicked", async () => {
    url("weeks=26&repository=e");
    await drawn();

    fireEvent.click(entry("Team"));

    // `team`, the key, not `Team`: the legend can be reworded without breaking a shared link.
    expect(written()).toBe("/repositories?weeks=26&repository=e&owner=team");
  });

  it("should filter from the ring itself when a wedge is clicked", async () => {
    const container = await drawn();

    fireEvent.click(wedge(container, "#f87171"));

    expect(written()).toBe("/repositories?weeks=12&owner=nobody");
  });

  it("should drop the parameter rather than empty it when the active slice is clicked again", async () => {
    url("weeks=12&owner=team");
    await drawn();

    expect(entry("Team").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(entry("Team"));

    expect(written()).toBe("/repositories?weeks=12");
  });

  it("should clear the filter from the ring too when the active wedge is clicked", async () => {
    url("weeks=12&owner=nobody");
    const container = await drawn();

    fireEvent.click(wedge(container, "#f87171"));

    expect(written()).toBe("/repositories?weeks=12");
  });

  it("should replace one selection with another when a second slice of the same wheel is clicked", async () => {
    url("weeks=12&owner=team");
    await drawn();

    fireEvent.click(entry("Nobody"));

    // One wheel is one dimension: two slices of it cannot both be filtered on, so the second click overwrites.
    expect(written()).toBe("/repositories?weeks=12&owner=nobody");
  });

  it("should filter on a slice counted at zero as readily as on a populated one", async () => {
    await drawn();

    // Dimmed but not disabled: "which repositories are owned by an individual" is a question worth asking of an
    // estate where the answer is none, and the empty table says so.
    fireEvent.click(entry("Individual"));

    expect(written()).toBe("/repositories?weeks=12&owner=individual");
  });

  it("should press only the active slice's entry when the URL names one", async () => {
    url("weeks=12&owner=individual");
    await drawn();

    expect(entry("Individual").getAttribute("aria-pressed")).toBe("true");
    expect(entry("Team").getAttribute("aria-pressed")).toBe("false");
    expect(entry("Nobody").getAttribute("aria-pressed")).toBe("false");
  });

  it("should tick the active slice's entry as well as filling it, so colour is not the only signal", async () => {
    url("weeks=12&owner=nobody");
    await drawn();

    // The estate table's toggles' rule. `aria-hidden` on the tick, because `aria-pressed` above is already the
    // accessible answer and the two channels are deliberately separate.
    expect(entry("Nobody").querySelector("svg[aria-hidden='true']")).toBeTruthy();
    expect(entry("Team").querySelector("svg[aria-hidden='true']")).toBeNull();
  });

  it("should issue no navigation for any click, on the wedge or on the legend", async () => {
    // THE DEFECT THIS COMPONENT WAS REBUILT TO AVOID. Every answer a click changes is derived from rows already in
    // props, so a router navigation would re-run the server component and refetch the estate for nothing.
    const container = await drawn();

    fireEvent.click(wedge(container, "#4ade80"));
    fireEvent.click(entry("Nobody"));
    fireEvent.click(entry("Nobody"));

    expect(replaced).toEqual([]);
    expect(written()).toBe("/repositories?weeks=12");
  });
});
