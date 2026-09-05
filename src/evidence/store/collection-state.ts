import { prisma } from "./prisma.ts";
import { StorageError } from "./storage-error.ts";

/**
 * The stamp a report cache invalidates itself against.
 *
 * Replaces upstream's `source_stamp`, which `stat()`ed the two SQLite files for `(mtime, size)` and
 * compared the pair against the one a built report was made from. There is no file here, so a collection
 * bumps a revision instead and readers poll it.
 *
 * Better than the file stamp in one respect that now matters: the collector runs in a different pod from
 * the readers, and a revision in the database is visible across both where an mtime was not.
 */

const SINGLETON = 1;

/** Bumps the revision, marking every built report as describing a cache that has moved on. */
export async function stampCollection(collectedAt: Date = new Date()): Promise<bigint> {
  try {
    const state = await prisma.collectionState.upsert({
      where: { id: SINGLETON },
      create: { id: SINGLETON, revision: BigInt(1), collectedAt },
      update: { revision: { increment: BigInt(1) }, collectedAt }
    });
    return state.revision;
  } catch (error) {
    throw new StorageError("could not update collection cache", error);
  }
}

/**
 * The current revision and when it was stamped, or `undefined` before any collection has run.
 *
 * `undefined` is not an error: a cold database is a service with nothing to show yet, which reports as
 * unavailable rather than failing.
 */
export async function collectionState(): Promise<CollectionStamp | undefined> {
  try {
    const state = await prisma.collectionState.findUnique({ where: { id: SINGLETON } });
    return state === null ? undefined : { revision: state.revision, collectedAt: state.collectedAt };
  } catch (error) {
    throw new StorageError("could not read collection cache", error);
  }
}

export interface CollectionStamp {
  revision: bigint;
  collectedAt: Date;
}
