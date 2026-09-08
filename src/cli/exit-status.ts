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

/**
 * The exit status a COLLECTION should leave, which depends on who is waiting for it.
 *
 * Both readings of a partial run are right. A person wants to know that twelve of fourteen repositories answered,
 * which is what `EXIT_INCOMPLETE` says. Kubernetes has no third state: a CronJob exiting 3 is Failed, it retries to
 * its backoff limit, and anything watching pod status alerts. Across an estate this size something always refuses —
 * a disabled alert family, a permission not granted — so partial is the NORMAL outcome, and a daily job reporting
 * failure every day is an alert that means nothing.
 *
 * `toleratePartial` therefore belongs to the caller rather than to the run: the collection is unchanged and the
 * true status still reaches Application Insights as `collector.exit_status`. Nothing tolerates `Failed`, because
 * nothing usable came back and that is worth waking somebody for.
 */
export function collectionStatus(status: CollectionStatus, toleratePartial: boolean): number {
  if (status === CollectionStatus.Partial && toleratePartial) {
    return EXIT_COMPLETE;
  }
  return runStatus(status);
}
