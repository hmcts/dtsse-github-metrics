import { CollectionStatus } from "../evidence/domain/availability.ts";

/**
 * Exit statuses, ported from `metrics.cli`.
 *
 * THREE-VALUED, and each value is load-bearing.
 */

export const EXIT_COMPLETE = 0;
export const EXIT_FAILED = 1;

/** A usage error, matching what an argument parser conventionally exits with. */
export const EXIT_USAGE = 2;

/**
 * A run that produced some of the evidence it was asked for, but not all of it.
 *
 * Its own status because the two outcomes it sits between are not interchangeable at fourteen repositories, let
 * alone at 1850: `0` says every configured repository was observed, `1` says nothing usable came back, and
 * neither describes twelve of fourteen. A partial run exiting `0` would let every downstream denominator be
 * read as covering the whole population when repositories are missing from it, and exiting `1` would throw
 * away evidence that was collected and is worth reporting.
 *
 * `3` rather than `2`, because a caller must be able to tell "you invoked me wrongly" from "I ran, and part of
 * the organisation would not answer".
 */
export const EXIT_INCOMPLETE = 3;

/** Maps one run's completeness onto an exit status a caller can branch on. */
export function runStatus(status: CollectionStatus): number {
  if (status === CollectionStatus.Complete) {
    return EXIT_COMPLETE;
  }
  return status === CollectionStatus.Failed ? EXIT_FAILED : EXIT_INCOMPLETE;
}
