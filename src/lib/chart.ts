/**
 * The slice arithmetic every ring on the site is drawn from: a readiness distribution, and the estate's wheels.
 *
 * Kept out of the components because this is the part that has to be checkable: a legend that silently
 * drops a category is indistinguishable from a category with no members, and only one of those is true
 * of the data.
 *
 * A zero-count category stays in the returned slices. `TeamsList` and `SummaryPieChart` both dim an empty one
 * rather than omitting it, so the reader sees the full label set whatever this window holds.
 */

import { distributionState, RAG_HEX, RAG_LABEL, RAG_STATES } from "@/lib/rag";
import type { EstateDimension } from "@/lib/rows";
import type { RepositoryRow } from "@/lib/types";

export interface PieSlice {
  /**
   * What the slice is, in the vocabulary its dimension is filtered by: a `RAGState`.
   *
   * Separate from `name` because the words move and the key must not — a link shared with
   * `?label=green` in it has to keep working when somebody rewords the legend.
   */
  key: string;
  /** The label shown in the legend and in the hover card. */
  name: string;
  value: number;
  /** A colour value, not a class: a mark is set from a string rather than a Tailwind utility. */
  color: string;
}

/**
 * Turn a label distribution from the service into the five readiness slices, in RAG order.
 *
 * Counts are summed per state rather than per key, so the service's `not_assessed` and any key it
 * adds later that resolves to `none` land in one slice instead of two slices of the same colour.
 *
 * `unreportable` is how many repositories the span could not be reported for at all. The service
 * distributes only the repositories it has an evidence block for — `service.label_counts` counts the
 * rest nowhere — so a caller distributing every configured repository passes that figure here and the
 * two total the same estate. It lands in the ungraded slice, which is what an unreportable repository
 * is: nothing was read, so nothing labelled it. Defaults to 0 for a caller distributing one team's or
 * one page's labels rather than the estate's.
 */
export function distributionSlices(labels: Record<string, number>, unreportable = 0): PieSlice[] {
  return RAG_STATES.map((readiness) => ({
    key: readiness,
    name: RAG_LABEL[readiness],
    value:
      Object.entries(labels)
        .filter(([key]) => distributionState(key) === readiness)
        .reduce((total, [, count]) => total + count, 0) + (readiness === "none" ? unreportable : 0),
    color: RAG_HEX[readiness]
  }));
}

/**
 * One estate wheel's slices, counted over the rows it is drawn for.
 *
 * COUNTED HERE AND NOT IN THE COMPONENT, which is `distributionSlices`' reason and the sharper one for these: the
 * figures are the claim. A slice that quietly counted nothing and a slice with no members look identical in a
 * ring, and only one of them is a fact about the estate — so the arithmetic is a pure function a fixture can be
 * held against, and `estate.test.ts` holds it against the four measured distributions.
 *
 * THE PALETTE RESOLVES HERE. A slice declares which `RAGState` it is, `rag.ts` owns the hex, and this is the one
 * place the two meet — so the wheels have no colour scheme of their own and a wedge matches the table cell under
 * it. The four hexes were validated against the dark surface they are drawn on (`bg-slate-900`, `#0f172a`): all
 * four clear 3:1 contrast, the worst adjacent pair is amber against green at ΔE 7.3 simulated protanopia and 19.6
 * unsimulated, which is the floor band — legal because every slice also carries its word and its count in the
 * legend and the wedges are separated by a gap, so colour is never the only thing telling two of them apart.
 *
 * EVERY SLICE IS RETURNED, including one counted at zero: `SummaryPieChart` dims an empty slice in the legend
 * rather than dropping it, so a reader sees the whole set of answers the report can give whatever this estate
 * holds.
 */
export function dimensionSlices(dimension: EstateDimension, rows: readonly RepositoryRow[]): PieSlice[] {
  return dimension.slices.map((slice) => ({
    key: slice.key,
    name: slice.label,
    value: rows.filter((row) => slice.holds(row)).length,
    color: RAG_HEX[slice.state]
  }));
}

/** The whole a wheel's slices are shares of, which is its cohort where the slices are total over it. */
export function totalValue(slices: readonly PieSlice[]): number {
  return slices.reduce((total, slice) => total + slice.value, 0);
}

/**
 * The slices recharts is given: the ones that have members.
 *
 * A zero-count slice is kept out of the RING and stays in the legend. With `paddingAngle` on, a zero-width wedge
 * draws as a stray tick beside the one before it, which reads as a fifth answer nobody reported.
 */
export function activeSlices(slices: readonly PieSlice[]): PieSlice[] {
  return slices.filter((slice) => slice.value > 0);
}
