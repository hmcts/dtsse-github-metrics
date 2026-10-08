import { describe, expect, it } from "vitest";
import { dimensionSlices, distributionSlices, type PieSlice } from "@/lib/chart";
import { RAG_HEX, RAG_STATES, STRONG_GOOD_HEX } from "@/lib/rag";
import type { EstateDimension } from "@/lib/rows";

/** The counts a builder returned, keyed on the words its legend reads. */
function counts(built: readonly PieSlice[]): Record<string, number> {
  return Object.fromEntries(built.map((slice) => [slice.name, slice.value]));
}

/** Every slice added, the empty ones included, which is the estate the legend accounts for. */
function total(built: readonly PieSlice[]): number {
  return built.reduce((sum, slice) => sum + slice.value, 0);
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
    expect(total(distributionSlices({}))).toBe(0);
  });

  it("counts the repositories the span could not report at all as not assessed", () => {
    // The service distributes the reported repositories only, so a legend drawn beside one over the
    // whole estate has to be told how many it left out or it totals the smaller number.
    const built = distributionSlices({ green: 2, amber: 1 }, 3);
    expect(counts(built)["Not assessed"]).toBe(3);
    expect(total(built)).toBe(6);
  });

  it("adds nothing where the caller distributes labels rather than an estate", () => {
    expect(counts(distributionSlices({ green: 2 }))["Not assessed"]).toBe(0);
  });
});

describe("dimensionSlices", () => {
  const DIMENSION: EstateDimension = {
    parameter: "review",
    title: "Enforces review",
    hint: "How many approvals the gate requires.",
    cohort: "all",
    slices: [
      { key: "multiple", label: "Multiple", state: "green", hex: STRONG_GOOD_HEX, holds: (row) => (row.required_approving_reviews ?? 0) >= 2 },
      { key: "required", label: "Enforced", state: "green", holds: (row) => row.required_approving_reviews === 1 }
    ]
  };

  it("draws a slice in its own hex where it states one, and in its state's hex otherwise", () => {
    const built = dimensionSlices(DIMENSION, [{ repository: "a", team: "t", required_approving_reviews: 2 }]);

    expect(built.map((slice) => slice.color)).toEqual([STRONG_GOOD_HEX, RAG_HEX.green]);
    expect(built.map((slice) => slice.value)).toEqual([1, 0]);
  });
});
