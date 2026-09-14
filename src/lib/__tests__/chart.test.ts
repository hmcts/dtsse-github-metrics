import { describe, expect, it } from "vitest";
import { activeSlices, bandSlices, distributionSlices, type PieSlice, totalValue } from "@/lib/chart";
import { RAG_HEX, RAG_STATES } from "@/lib/rag";
import { type Band, REVIEW_BANDS } from "@/lib/tone";
import type { RepositoryRow } from "@/lib/types";

/** A band key of nothing in particular, for the counting `bandSlices` does over any item type. */
type Side = "left" | "middle" | "right";

const slices: PieSlice[] = [
  { key: "green", name: "Ready", value: 3, color: "#4ade80" },
  { key: "amber", name: "Caution", value: 0, color: "#fbbf24" },
  { key: "red", name: "Blocked", value: 1, color: "#f87171" }
];

function row(fields: Partial<RepositoryRow>): RepositoryRow {
  return { repository: "hmcts/api", team: "platform", ...fields };
}

/** The counts a builder returned, keyed on the words its legend reads. */
function counts(built: readonly PieSlice[]): Record<string, number> {
  return Object.fromEntries(built.map((slice) => [slice.name, slice.value]));
}

describe("distributionSlices", () => {
  it("names one slice per readiness state, in RAG order, with the report palette", () => {
    const built = distributionSlices({ green: 2, amber: 1, red: 0, cannot_assess: 1 });
    expect(built.map((slice) => slice.value)).toEqual([2, 1, 0, 1, 0]);
    expect(built.map((slice) => slice.color)).toEqual(RAG_STATES.map((state) => RAG_HEX[state]));
  });

  it("keys each slice on its state rather than on the words the legend reads", () => {
    // The key is what a filtered link carries, so it has to survive the labels being reworded.
    expect(distributionSlices({}).map((slice) => slice.key)).toEqual([...RAG_STATES]);
  });

  it("keeps a zero-count label as a slice, so the legend still lists it", () => {
    const built = distributionSlices({ green: 4 });
    expect(built).toHaveLength(RAG_STATES.length);
    expect(built.filter((slice) => slice.value === 0)).toHaveLength(4);
  });

  it("sums every key that resolves to one state into a single slice", () => {
    const built = distributionSlices({ not_assessed: 2, something_else: 3, green: 1 });
    const ungraded = built.find((slice) => slice.name === "Not assessed");
    expect(ungraded?.value).toBe(5);
  });

  it("counts nothing for an empty distribution", () => {
    expect(totalValue(distributionSlices({}))).toBe(0);
  });

  it("counts the repositories the span could not report at all as not assessed", () => {
    // The service distributes the reported repositories only, so a donut drawn beside one over the
    // whole estate has to be told how many it left out or it totals the smaller number.
    const built = distributionSlices({ green: 2, amber: 1 }, 3);
    expect(counts(built)["Not assessed"]).toBe(3);
    expect(totalValue(built)).toBe(6);
  });

  it("adds nothing where the caller distributes labels rather than an estate", () => {
    expect(counts(distributionSlices({ green: 2 }))["Not assessed"]).toBe(0);
  });
});

describe("bandSlices", () => {
  it("returns one slice per band, in the table order, with the band words and marks", () => {
    const built = bandSlices(REVIEW_BANDS, [row({ required_approving_reviews: 1 })], (repository) =>
      repository.required_approving_reviews === 1 ? "required" : "unknown"
    );
    expect(built.map((slice) => slice.name)).toEqual(REVIEW_BANDS.map((band) => band.name));
    expect(built.map((slice) => slice.color)).toEqual(REVIEW_BANDS.map((band) => band.mark));
  });

  it("keys each slice on the band's own key rather than on the words its legend reads", () => {
    // The key is what a link carries, so it has to survive a legend being reworded.
    const built = bandSlices(REVIEW_BANDS, [row({ required_approving_reviews: 1 })], () => "required");
    expect(built.map((slice) => slice.key)).toEqual(REVIEW_BANDS.map((band) => band.key));
  });

  it("counts each item under the band its classifier returns, including the bands nothing fell in", () => {
    // Over a plain item rather than a `RepositoryRow`, which is what the item type is generic for:
    // the counting is the helper's one job and the four builders below only supply a classifier.
    const bands: readonly Band<Side>[] = [
      { key: "left", name: "Left", mark: "#000000" },
      { key: "middle", name: "Middle", mark: "#111111" },
      { key: "right", name: "Right", mark: "#222222" }
    ];
    const items: readonly Side[] = ["left", "right", "left"];
    const built = bandSlices(bands, items, (item) => item);

    expect(counts(built)).toEqual({ Left: 2, Middle: 0, Right: 1 });
    expect(totalValue(built)).toBe(3);
  });
});

describe("totalValue", () => {
  it("adds every slice, including the empty ones", () => {
    expect(totalValue(slices)).toBe(4);
  });
});

describe("activeSlices", () => {
  it("drops only the slices with no members", () => {
    expect(activeSlices(slices).map((slice) => slice.name)).toEqual(["Ready", "Blocked"]);
  });
});
