import "server-only";
import type { Configuration } from "../policy/schema.ts";
import { collectionState } from "../store/collection-state.ts";
import { CACHEABLE_SPANS } from "./cache.ts";
import { repositoryRows } from "./repositories.ts";

/**
 * Building every span before a reader asks for one, and again once a collection lands.
 *
 * The cache makes the second reader of a span free. This is what makes the FIRST one free, which matters
 * because the three readers who pay a cold build are the ones nobody chose: whoever arrives first after a pod
 * roll, whoever arrives first after the 15:00 collection, and whoever picks a span the others do not read.
 * Without a warmer the fix for slowness is "be the second reader".
 *
 * SEQUENTIAL, NOT CONCURRENT. The pod is capped at one CPU, and five builds in parallel would compete with
 * each other and with whatever live request arrived during them — measured in the AAT pod, a single cold build
 * is already throttled for 0.6 s of its 1.2 s of CPU. Sequential warming costs the same total work spread over
 * a longer wall clock, which is exactly the trade to make against a live reader.
 *
 * POLLED RATHER THAN PUSHED. The collector is a CronJob in a different pod and has no way to call this, so the
 * revision in the database is the only signal that crosses the gap — which is the same reason `collection_state`
 * exists at all. The poll is cheap: one primary-key read of a single-row table, which measured at under a
 * millisecond, so a minute's interval costs nothing worth tuning and bounds how long after a collection the
 * first reader can still meet a cold span.
 *
 * A FAILING WARM IS LOGGED AND FORGIVEN. It is an optimisation, and a database blip during it must leave the
 * pod serving pages slowly rather than crash-looping a container whose readiness probe was passing.
 */

/** How often the revision is checked. One row by primary key, so this is cheap enough to be frequent. */
const POLL_INTERVAL_MILLISECONDS = 60_000;

export interface Warmer {
  /** Stops the poll, for a test and for a graceful shutdown. */
  stop: () => void;
  /** The warm currently running, so a test can await one rather than sleep through it. */
  settled: () => Promise<void>;
}

/**
 * Builds every span once, in order, ignoring any single span's failure.
 *
 * Every span is attempted even after one fails: the spans are independent builds, and a failure on 26 weeks is
 * no reason to leave 1, 4, 8 and 12 cold.
 */
export async function warmEverySpan(configuration: Configuration): Promise<void> {
  for (const weeks of CACHEABLE_SPANS) {
    const started = Date.now();
    try {
      const rows = await repositoryRows(configuration, weeks);
      console.info(`warmed the ${weeks}-week report: ${rows.length} repositories in ${Date.now() - started}ms`);
    } catch (error) {
      console.warn(`could not warm the ${weeks}-week report: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/**
 * Warms every span now, and again whenever the collection revision moves.
 *
 * The first warm is deliberately NOT awaited by the caller. It runs while the server is already accepting
 * requests, so a pod comes ready on the schedule its probes expect and a reader arriving during the warm shares
 * the build in flight rather than waiting for the whole set — the cache holds promises for exactly this.
 *
 * Each warm records the revision it built, so a poll that sees the same revision does nothing: the steady state
 * is one cheap single-row read a minute, and work happens only on the poll after a collection lands.
 */
export function startReportWarmer(configuration: Configuration, intervalMilliseconds = POLL_INTERVAL_MILLISECONDS): Warmer {
  let lastWarmed: string | undefined;
  let running: Promise<void> = Promise.resolve();
  let stopped = false;

  async function warm(revision: string): Promise<void> {
    lastWarmed = revision;
    await warmEverySpan(configuration);
  }

  async function poll(): Promise<void> {
    if (stopped) {
      return;
    }
    try {
      const state = await collectionState();
      const revision = state === undefined ? "none" : String(state.revision);
      if (revision !== lastWarmed) {
        console.info(`collection revision ${revision} landed: rebuilding every span`);
        running = warm(revision);
        await running;
      }
    } catch (error) {
      console.warn(`could not check the collection revision: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  running = poll();
  const timer = setInterval(() => void poll(), intervalMilliseconds);
  // Unreferenced, so the interval alone never holds the process open: a CLI or a test importing this must still
  // be able to exit, and the server is kept alive by its listening socket rather than by this.
  timer.unref();

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
    settled: () => running
  };
}
