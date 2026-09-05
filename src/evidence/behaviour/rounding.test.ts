import { describe, expect, it } from "vitest";
import { roundHalfEven } from "./rounding.ts";

/**
 * The cases that matter are the ties, because those are exactly where Python and JavaScript disagree.
 *
 * A double is only a tie when its exact binary expansion ends in a half — so `8.25` and `0.125` are ties
 * and must round to even, while `2.675` (really 2.67499999999999982…) and `8.35` (really
 * 8.34999999999999964…) are not, and must follow their true value DOWN even though both look like ties
 * written out. Getting that second group wrong is the subtler bug: a naive
 * `Math.round(value * 100) / 100` reads `2.675` as a tie and rounds it up, away from the number the
 * double actually holds.
 */
describe("roundHalfEven", () => {
  it.each([
    // Exact ties: round to the even neighbour, as Python does.
    [8.25, 1, 8.2],
    [8.75, 1, 8.8],
    [0.125, 2, 0.12],
    [0.375, 2, 0.38],
    [2.5, 0, 2],
    [3.5, 0, 4],
    [0.5, 0, 0],
    [1.5, 0, 2],
    // Not ties, whatever they look like written down: follow the true binary value.
    [2.675, 2, 2.67],
    [8.35, 1, 8.3],
    [66.65, 1, 66.7],
    [1.005, 2, 1.0],
    // Ordinary cases.
    [33.333333333333336, 1, 33.3],
    [66.66666666666667, 1, 66.7],
    [100, 1, 100],
    [0, 3, 0],
    [12.3456, 3, 12.346]
  ])("should round %f to %i decimals as %f", (value, digits, expected) => {
    expect(roundHalfEven(value, digits)).toBeCloseTo(expected, 10);
  });

  it.each([
    [-8.25, 1, -8.2],
    [-2.5, 0, -2],
    [-2.675, 2, -2.67]
  ])("should round the negative %f to %i decimals as %f, symmetrically", (value, digits, expected) => {
    expect(roundHalfEven(value, digits)).toBeCloseTo(expected, 10);
  });

  it("should differ from Math.round on an exact tie, which is the whole point", () => {
    expect(roundHalfEven(8.25, 1)).toBe(8.2);
    expect(Math.round(8.25 * 10) / 10).toBe(8.3);
  });

  it("should not invent a tie where scaling would have created one", () => {
    // `2.675 * 100` is 267.49999999999997, and a scaled comparison can read that as a half.
    expect(roundHalfEven(2.675, 2)).toBe(2.67);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])("should pass %f through unchanged", (value) => {
    expect(roundHalfEven(value, 2)).toBe(value);
  });

  it("should handle a value below the smallest normal double", () => {
    expect(roundHalfEven(Number.MIN_VALUE, 3)).toBe(0);
  });
});
