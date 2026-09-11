import { beforeEach, describe, expect, it, vi } from "vitest";
import { builtReport, builtSpanCount, CACHEABLE_SPANS, forgetBuiltReports } from "./cache.ts";

/**
 * The decision logic behind which built report a reader is served.
 *
 * WITHOUT POSTGRES, deliberately. `test/integration/report-rows.test.ts` proves the same rules against a real
 * database and real rows; these cases prove the rules themselves, which means the revision is a value a test
 * hands over rather than a row somebody has to write first. That is what makes "the revision moved mid-build"
 * and "the build rejected" expressible at all.
 *
 * `collectionState` is the only collaborator, so it is the only thing mocked. The build is a plain function, so
 * how many times it ran is a count rather than an inference from timings.
 */

const { collectionState } = vi.hoisted(() => ({ collectionState: vi.fn() }));

// `server-only` exists to fail a client-side import at build time, and it refuses a plain node import outright.
// Stubbed here rather than aliased in `vitest.config.mts`, so the guard keeps protecting the build everywhere
// else — the integration config takes the same approach for the same reason.
vi.mock("server-only", () => ({}));
vi.mock("../store/collection-state.ts", () => ({ collectionState }));

const ORGANIZATION = "hmcts";

/** The stamp `collectionState` answers with, or `undefined` for a database nothing has collected into. */
function atRevision(revision: bigint | undefined): void {
  collectionState.mockResolvedValue(revision === undefined ? undefined : { revision, collectedAt: new Date(0) });
}

/**
 * A build that counts its calls and returns a FRESH array each time.
 *
 * Fresh, because identity is how a served entry is told from a rebuilt one: returning one array for every call
 * would make `toBe` pass whether the build ran again or not, and the call count is then the only real assertion.
 */
function countingBuild(rows: unknown[] = [{ repository: "alpha" }]) {
  return vi.fn(() => Promise.resolve([...rows]));
}

beforeEach(() => {
  forgetBuiltReports();
  collectionState.mockReset();
  atRevision(1n);
});

describe("builtReport", () => {
  it("should build on the first read of a span", async () => {
    const build = countingBuild();

    expect(await builtReport(ORGANIZATION, 4, build)).toEqual([{ repository: "alpha" }]);
    expect(build).toHaveBeenCalledTimes(1);
  });

  it("should serve a second read of one span without building again", async () => {
    const build = countingBuild();

    const first = await builtReport(ORGANIZATION, 4, build);
    const second = await builtReport(ORGANIZATION, 4, build);

    expect(build).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it("should not serve one span's report for another", async () => {
    const four = await builtReport(ORGANIZATION, 4, countingBuild([{ repository: "four" }]));
    const twelve = await builtReport(ORGANIZATION, 12, countingBuild([{ repository: "twelve" }]));

    expect(twelve).not.toBe(four);
    expect(twelve).toEqual([{ repository: "twelve" }]);
  });

  it("should not serve one organisation's report for another", async () => {
    // The key names the estate as well as the span: two deployments pointed at one database must not read each
    // other's rows, and the cohort is per organisation.
    const ours = await builtReport(ORGANIZATION, 4, countingBuild([{ repository: "ours" }]));
    const theirs = await builtReport("other", 4, countingBuild([{ repository: "theirs" }]));

    expect(theirs).not.toBe(ours);
    expect(theirs).toEqual([{ repository: "theirs" }]);
  });

  it("should still hold one span after another span has been read", async () => {
    // The failure a single held entry had: reading a second span EVICTED the first, so a reader switching from
    // four weeks to twelve made the next reader of four weeks pay for a full rebuild though nothing had changed.
    const build = countingBuild();
    const first = await builtReport(ORGANIZATION, 4, build);
    await builtReport(ORGANIZATION, 12, countingBuild());
    await builtReport(ORGANIZATION, 26, countingBuild());

    expect(await builtReport(ORGANIZATION, 4, build)).toBe(first);
    expect(build).toHaveBeenCalledTimes(1);
  });

  it("should hold every offered span at once, so no reader meets a cold one", async () => {
    for (const weeks of CACHEABLE_SPANS) {
      await builtReport(ORGANIZATION, weeks, countingBuild());
    }

    expect(builtSpanCount()).toBe(CACHEABLE_SPANS.length);
  });

  it("should rebuild once the revision moves, rather than serving the previous collection's figures", async () => {
    const build = countingBuild();
    const before = await builtReport(ORGANIZATION, 4, build);

    atRevision(2n);

    expect(await builtReport(ORGANIZATION, 4, build)).not.toBe(before);
    expect(build).toHaveBeenCalledTimes(2);
  });

  it("should drop every superseded span when the revision moves, not only the one being read", async () => {
    // Without the prune, a process that never restarts accumulates one set of entries per daily collection.
    await builtReport(ORGANIZATION, 4, countingBuild());
    await builtReport(ORGANIZATION, 12, countingBuild());
    expect(builtSpanCount()).toBe(2);

    atRevision(2n);
    await builtReport(ORGANIZATION, 4, countingBuild());

    // Only the span just rebuilt: the twelve-week entry described the previous revision and went with it.
    expect(builtSpanCount()).toBe(1);
  });

  it("should hold a report built against an uncollected database, so a cold estate is cached too", async () => {
    // `collectionState` answers `undefined` before any collection has run. That is a revision like any other
    // here — a preview environment serves an empty estate and must not rebuild it on every request.
    atRevision(undefined);
    const build = countingBuild([]);

    await builtReport(ORGANIZATION, 4, build);
    await builtReport(ORGANIZATION, 4, build);

    expect(build).toHaveBeenCalledTimes(1);
  });

  it("should rebuild when the first collection lands on a database that had none", async () => {
    atRevision(undefined);
    const build = countingBuild();
    await builtReport(ORGANIZATION, 4, build);

    atRevision(1n);
    await builtReport(ORGANIZATION, 4, build);

    expect(build).toHaveBeenCalledTimes(2);
  });

  it("should not hold a span no page offers, so a query string cannot grow the cache without bound", async () => {
    // `?weeks=` is reader-controlled. A span off the selector's list is answered and forgotten rather than held.
    const build = countingBuild();

    await builtReport(ORGANIZATION, 7, build);

    expect(builtSpanCount()).toBe(0);
    await builtReport(ORGANIZATION, 7, build);
    expect(build).toHaveBeenCalledTimes(2);
  });

  it("should not evict an offered span to answer one nobody offers", async () => {
    // The uncacheable path must return before it touches the map: pruning on the way past would let `?weeks=7`
    // empty a cache it is then not added to.
    const build = countingBuild();
    const held = await builtReport(ORGANIZATION, 4, build);

    await builtReport(ORGANIZATION, 7, countingBuild());

    expect(await builtReport(ORGANIZATION, 4, build)).toBe(held);
    expect(build).toHaveBeenCalledTimes(1);
  });

  it("should not cache a rejection, so one database error is not served for the life of the process", async () => {
    // The pod restarts only when Flux rolls it, so a cached rejection means until somebody notices.
    const failing = vi.fn(() => Promise.reject(new Error("connection reset")));

    await expect(builtReport(ORGANIZATION, 4, failing)).rejects.toThrow("connection reset");

    expect(builtSpanCount()).toBe(0);
    await expect(builtReport(ORGANIZATION, 4, countingBuild())).resolves.toEqual([{ repository: "alpha" }]);
  });

  it("should reject both callers waiting on one failed build", async () => {
    // Two readers sharing a build share its outcome, and the second must not be left awaiting a promise the
    // first already dropped from the map.
    const failing = vi.fn(() => Promise.reject(new Error("connection reset")));

    const [left, right] = await Promise.allSettled([builtReport(ORGANIZATION, 4, failing), builtReport(ORGANIZATION, 4, failing)]);

    expect(left.status).toBe("rejected");
    expect(right.status).toBe("rejected");
    expect(failing).toHaveBeenCalledTimes(1);
  });

  it("should share one in-flight build between two concurrent readers rather than running it twice", async () => {
    // On a pod capped at one CPU, two readers arriving on a cold span must not start two builds that then
    // compete for the same core. This is also what makes the warmer safe beside live traffic.
    //
    // The build is held OPEN across both calls, because that is the only window in which the second reader can
    // find an entry whose promise has not settled — a build that resolves immediately would be a cache hit on
    // the finished value and would prove nothing about sharing one in flight.
    let land: (rows: unknown[]) => void = () => undefined;
    const pending = new Promise<unknown[]>((resolve) => {
      land = resolve;
    });
    const build = vi.fn(() => pending);

    // `builtReport` awaits the revision before it reaches the map, so both calls must be started and only then
    // awaited: settling the first would let it populate the cache before the second ever looked.
    const first = builtReport(ORGANIZATION, 8, build);
    const second = builtReport(ORGANIZATION, 8, build);
    await Promise.resolve();
    land([{ repository: "alpha" }]);

    expect(await second).toBe(await first);
    expect(build).toHaveBeenCalledTimes(1);
  });
});

describe("forgetBuiltReports", () => {
  it("should empty the cache, so the next read builds again", async () => {
    const build = countingBuild();
    await builtReport(ORGANIZATION, 4, build);

    forgetBuiltReports();

    expect(builtSpanCount()).toBe(0);
    await builtReport(ORGANIZATION, 4, build);
    expect(build).toHaveBeenCalledTimes(2);
  });
});
