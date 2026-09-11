import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Configuration } from "../policy/schema.ts";
import { CACHEABLE_SPANS } from "./cache.ts";
import { startReportWarmer, warmEverySpan } from "./warmer.ts";

/**
 * When the warmer builds, and what it does when a build fails.
 *
 * WITHOUT POSTGRES, deliberately. `test/integration/report-rows.test.ts` proves the warm populates the cache
 * against a real database; these cases prove the scheduling decisions, which means "the revision has not moved"
 * and "one span throws" are values a test hands over rather than states somebody has to arrange in a database.
 *
 * `repositoryRows` is mocked, so which spans were warmed is the argument list rather than a set of cache entries,
 * and a span failing is one `mockRejectedValueOnce` rather than a broken configuration.
 */

const { collectionState, repositoryRows } = vi.hoisted(() => ({ collectionState: vi.fn(), repositoryRows: vi.fn() }));

// See `./cache.test.ts` for why `server-only` is stubbed here rather than aliased in the config.
vi.mock("server-only", () => ({}));
vi.mock("../store/collection-state.ts", () => ({ collectionState }));
vi.mock("./repositories.ts", () => ({ repositoryRows }));

/** Nothing here reads the configuration — it is passed through to the mocked builder. */
const CONFIGURATION = { organization: "hmcts" } as unknown as Configuration;

/** The stamp `collectionState` answers with, or `undefined` for a database nothing has collected into. */
function atRevision(revision: bigint | undefined): void {
  collectionState.mockResolvedValue(revision === undefined ? undefined : { revision, collectedAt: new Date(0) });
}

/** The spans one run of the warmer asked for, in the order it asked. */
function warmedSpans(): number[] {
  return repositoryRows.mock.calls.map(([, weeks]) => weeks as number);
}

/** Lets the poll's timer fire and its build settle, without sleeping through a real interval. */
async function tick(milliseconds: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(milliseconds);
}

beforeEach(() => {
  vi.useFakeTimers();
  collectionState.mockReset();
  repositoryRows.mockReset();
  repositoryRows.mockResolvedValue([{ repository: "alpha" }]);
  atRevision(1n);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("warmEverySpan", () => {
  it("should build every offered span, so the first reader of each pays for none of it", async () => {
    await warmEverySpan(CONFIGURATION);

    expect(warmedSpans()).toEqual([...CACHEABLE_SPANS]);
  });

  it("should build the spans one at a time, because the pod has one CPU to share with live readers", async () => {
    // Five builds in parallel would compete with each other and with whatever request arrived during them.
    //
    // Proven by counting how many builds are IN FLIGHT AT ONCE, which is the thing that actually matters and
    // the only framing that fails under `Promise.all`. Comparing start order against completion order does not:
    // five concurrent builds that each await the same number of microtasks still finish in the order they
    // started, so that assertion passes either way.
    let inFlight = 0;
    let peak = 0;
    repositoryRows.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      // Two microtask hops, so a concurrent implementation has a window in which every build is inside here.
      await Promise.resolve();
      await Promise.resolve();
      inFlight -= 1;
      return [];
    });

    await warmEverySpan(CONFIGURATION);

    expect(peak).toBe(1);
  });

  it("should warm the remaining spans even when one of them fails", async () => {
    // The spans are independent builds. A failure on the first is no reason to leave the other four cold.
    repositoryRows.mockRejectedValueOnce(new Error("connection reset"));

    await warmEverySpan(CONFIGURATION);

    expect(warmedSpans()).toEqual([...CACHEABLE_SPANS]);
  });

  it("should resolve rather than reject when a span fails, so a blip never crash-loops the pod", async () => {
    // The warmer is an optimisation. A database error during it must leave the pod serving pages slowly, not
    // take down a container whose readiness probe was passing.
    repositoryRows.mockRejectedValue(new Error("connection reset"));

    await expect(warmEverySpan(CONFIGURATION)).resolves.toBeUndefined();
  });

  it("should name the span and the reason when one fails", async () => {
    repositoryRows.mockRejectedValueOnce(new Error("connection reset"));

    await warmEverySpan(CONFIGURATION);

    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("could not warm the 1-week report: connection reset"));
  });

  it("should report a thrown non-Error rather than logging it as undefined", async () => {
    // A driver that rejects with a string or an object has no `.message`, and reading one would put `undefined`
    // in the log where the reason belongs — the failure would be recorded as having no cause at all.
    repositoryRows.mockRejectedValueOnce("the pool is draining");

    await warmEverySpan(CONFIGURATION);

    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("could not warm the 1-week report: the pool is draining"));
  });
});

describe("startReportWarmer", () => {
  it("should warm every span as soon as it starts, so a pod roll costs no reader a cold build", async () => {
    const warmer = startReportWarmer(CONFIGURATION, 1000);
    try {
      await warmer.settled();

      expect(warmedSpans()).toEqual([...CACHEABLE_SPANS]);
    } finally {
      warmer.stop();
    }
  });

  it("should warm again when the revision moves, which is what the 15:00 collection does", async () => {
    // The collector is a CronJob in another pod, so the revision in the database is the only signal that
    // reaches here. Without the poll the next reader of each span pays a cold build.
    const warmer = startReportWarmer(CONFIGURATION, 1000);
    try {
      await warmer.settled();
      repositoryRows.mockClear();

      atRevision(2n);
      await tick(1000);
      await warmer.settled();

      expect(warmedSpans()).toEqual([...CACHEABLE_SPANS]);
    } finally {
      warmer.stop();
    }
  });

  it("should not warm again while the revision stands still", async () => {
    // The poll runs for the life of the pod, so what it does on an unchanged revision IS the steady state. It
    // must be the single-row read and nothing else: re-warming would walk five spans a minute for ever, and on
    // one CPU that is work taken from whatever reader arrived.
    const warmer = startReportWarmer(CONFIGURATION, 1000);
    try {
      await warmer.settled();
      repositoryRows.mockClear();

      await tick(5000);
      await warmer.settled();

      expect(warmedSpans()).toEqual([]);
    } finally {
      warmer.stop();
    }
  });

  it("should still poll the revision while it stands still, which is the whole steady-state cost", async () => {
    const warmer = startReportWarmer(CONFIGURATION, 1000);
    try {
      await warmer.settled();
      collectionState.mockClear();

      await tick(3000);

      expect(collectionState).toHaveBeenCalledTimes(3);
    } finally {
      warmer.stop();
    }
  });

  it("should warm the first collection to land on a database that had none", async () => {
    // A preview environment boots with an empty database and its CronJob disabled. The warm at boot builds an
    // empty estate; the poll has to notice when a collection finally arrives.
    atRevision(undefined);
    const warmer = startReportWarmer(CONFIGURATION, 1000);
    try {
      await warmer.settled();
      repositoryRows.mockClear();

      atRevision(1n);
      await tick(1000);
      await warmer.settled();

      expect(warmedSpans()).toEqual([...CACHEABLE_SPANS]);
    } finally {
      warmer.stop();
    }
  });

  it("should keep polling after a revision read fails, rather than giving up for the life of the pod", async () => {
    // A refused connection during one poll must not stop the warmer: the next collection would then never be
    // noticed, and every reader after it would pay a cold build with nothing saying why.
    collectionState.mockRejectedValueOnce(new Error("connection reset"));
    const warmer = startReportWarmer(CONFIGURATION, 1000);
    try {
      await warmer.settled();
      expect(warmedSpans()).toEqual([]);

      atRevision(2n);
      await tick(1000);
      await warmer.settled();

      expect(warmedSpans()).toEqual([...CACHEABLE_SPANS]);
    } finally {
      warmer.stop();
    }
  });

  it("should say why when the revision cannot be read", async () => {
    collectionState.mockRejectedValueOnce(new Error("connection reset"));
    const warmer = startReportWarmer(CONFIGURATION, 1000);
    try {
      await warmer.settled();

      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("could not check the collection revision: connection reset"));
    } finally {
      warmer.stop();
    }
  });

  it("should report a thrown non-Error from the revision read, for the reason the warm does", async () => {
    collectionState.mockRejectedValueOnce("the pool is draining");
    const warmer = startReportWarmer(CONFIGURATION, 1000);
    try {
      await warmer.settled();

      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("could not check the collection revision: the pool is draining"));
    } finally {
      warmer.stop();
    }
  });

  it("should stop warming once it is stopped, so a shutdown does not build against a closing pool", async () => {
    const warmer = startReportWarmer(CONFIGURATION, 1000);
    await warmer.settled();
    repositoryRows.mockClear();

    warmer.stop();
    atRevision(2n);
    await tick(5000);

    expect(warmedSpans()).toEqual([]);
  });

  it("should abandon a poll that was already queued when it was stopped", async () => {
    // `stop` clears the interval, so normally no further poll is scheduled. The guard is for the poll ALREADY
    // in the event queue when a shutdown begins — it must not go on to build against a pool that is closing.
    // Reached by holding the interval's callback and calling it after `stop`, which is exactly that ordering.
    let fire: () => void = () => undefined;
    vi.spyOn(globalThis, "setInterval").mockImplementation((callback: TimerHandler) => {
      fire = callback as () => void;
      return { unref: () => undefined } as unknown as ReturnType<typeof setInterval>;
    });
    const warmer = startReportWarmer(CONFIGURATION, 1000);
    await warmer.settled();
    repositoryRows.mockClear();
    collectionState.mockClear();

    warmer.stop();
    atRevision(2n);
    fire();
    await warmer.settled();

    // It returned before even reading the revision, which is the cheapest possible way to do nothing.
    expect(collectionState).not.toHaveBeenCalled();
    expect(warmedSpans()).toEqual([]);
  });

  it("should not hold the process open on its interval alone", async () => {
    // A CLI or a test importing this must still be able to exit, so the timer is unreferenced: the server is
    // kept alive by its listening socket rather than by the poll.
    const unref = vi.fn();
    vi.spyOn(globalThis, "setInterval").mockReturnValue({ unref } as unknown as ReturnType<typeof setInterval>);

    const warmer = startReportWarmer(CONFIGURATION, 1000);
    try {
      expect(unref).toHaveBeenCalled();
    } finally {
      warmer.stop();
    }
  });
});
