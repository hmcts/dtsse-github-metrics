/**
 * The slice arithmetic the donut chart is drawn from.
 *
 * Kept out of the component because recharts renders in the browser and this is the part that has to
 * be checkable: a chart that silently drops a category is indistinguishable from a category with no
 * members, and only one of those is true of the data.
 *
 * A zero-count category stays in the returned slices. The chart hands recharts only the non-zero
 * ones — a zero-width wedge draws as a stray tick once `paddingAngle` is on — but the legend lists
 * every slice, dimmed when empty, so the reader sees the full label set whatever this window holds.
 */

import { distributionState, RAG_HEX, RAG_LABEL, RAG_STATES } from "@/lib/rag";
import type { Band } from "@/lib/tone";

export interface PieSlice {
  /**
   * What the slice is, in the vocabulary its dimension is filtered by: a `RAGState` or a band key.
   *
   * Separate from `name` because the words move and the key must not — the legend reads "Within
   * allowance" over a band keyed `within`, and a link shared with `?unreviewed=within` in it has to
   * keep working when somebody rewords the legend.
   */
  key: string;
  /** The label shown in the legend and in the hover card. */
  name: string;
  value: number;
  /** A colour value, not a class: recharts takes fills as strings. */
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
 * rest nowhere — so a caller drawing this beside a donut over every configured repository passes
 * that figure here and the two total the same estate. It lands in the ungraded slice, which is what
 * an unreportable repository is: nothing was read, so nothing labelled it. Defaults to 0 for a
 * caller distributing one team's or one page's labels rather than the estate's.
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
 * Turn a band table and the rows it grades into one slice per band, in the table's own order.
 *
 * The band table in `lib/tone.ts` is the whole definition of a donut — the words, the marks and the
 * order they read in — so this counts and does nothing else. Every band comes back, including the
 * ones nothing fell in: a legend that lists only the bands this span happened to populate would read
 * as though the missing ones were impossible rather than empty.
 *
 * Generic over the item so the counting can be tested without a `RepositoryRow`, and so a later
 * donut over some other list needs no second copy of this.
 */
export function bandSlices<Key extends string, Item>(bands: readonly Band<Key>[], items: readonly Item[], band: (item: Item) => Key): PieSlice[] {
  return bands.map((entry) => ({
    key: entry.key,
    name: entry.name,
    value: items.filter((item) => band(item) === entry.key).length,
    color: entry.mark
  }));
}

/**
 * THE FIVE ESTATE DONUTS ARE GONE, and this note is what is left of them.
 *
 * `reviewSlices`, `checksSlices`, `unreviewedSlices`, `coverageSlices` and `securitySlices` were removed on
 * 2026-09-14 with the charts on `/repositories`. Four of the five drew ways-of-working dimensions, which
 * `/teams` now reports per team as counts over stated denominators; the fifth, coverage, read a field the report
 * layer has never emitted and so drew an all-unknown circle.
 *
 * `bandSlices` and `distributionSlices` survive because `TeamsList` and the team page's readiness legend read
 * them. The band TABLES in `lib/tone.ts` survive too and are still used — `reviewBand`, `checksBand` and the
 * rest grade a repository's own page — so nothing there was orphaned by this.
 */

export function totalValue(slices: readonly PieSlice[]): number {
  return slices.reduce((total, slice) => total + slice.value, 0);
}

/** The slices recharts is given: the ones that have members. */
export function activeSlices(slices: readonly PieSlice[]): PieSlice[] {
  return slices.filter((slice) => slice.value > 0);
}
