/**
 * One boundary error for every storage failure, ported from `metrics.storage.StorageError`.
 *
 * Every caller degrades this to "nothing collected" rather than crashing: a cache that cannot be read is
 * a report that says so, not a service that falls over. Wrapping matters for the same reason it did
 * upstream — a bare driver error escaping from a read would take down the cache warm-up and every
 * offline command with it.
 */
export class StorageError extends Error {
  constructor(message: string, cause?: unknown) {
    super(cause instanceof Error ? `${message}: ${cause.message}` : message, cause === undefined ? undefined : { cause });
    this.name = "StorageError";
  }
}
