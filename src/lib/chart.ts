/**
 * The slice arithmetic a readiness distribution is drawn from.
 *
 * Kept out of the component because this is the part that has to be checkable: a legend that silently
 * drops a category is indistinguishable from a category with no members, and only one of those is true
 * of the data.
 *
 * A zero-count category stays in the returned slices. `TeamsList` dims an empty one rather than
 * omitting it, so the reader sees the full label set whatever this window holds.
 */

import { distributionState, RAG_HEX, RAG_LABEL, RAG_STATES } from "@/lib/rag";

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
