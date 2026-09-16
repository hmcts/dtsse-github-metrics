import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { EvidenceSource, type SourceCoverage } from "../../src/evidence/domain/coverage.ts";
import {
  cachedCoverageEdges,
  findMissingCoverage,
  getSourceCoverage,
  prevailingCachedCoverage,
  recordSourceCoverage,
  recordSourceCoverageWithin,
  touchOrganisationCoverage,
  touchSourceCoverage
} from "../../src/evidence/store/coverage.ts";
import { prisma } from "../../src/evidence/store/prisma.ts";

// The interval arithmetic is unit-tested in src/evidence/store/intervals.test.ts. These cases prove the
// Postgres half: that intervals survive a round trip through timestamptz, that coalescing is applied to
// what is stored rather than only to what is returned, and that the CHECK constraint holds.

function coverage(startDay: number, endDay: number, overrides: Partial<SourceCoverage> = {}): SourceCoverage {
  return {
    organization: "hmcts",
    repository: "cath-service",
    source: EvidenceSource.PullRequests,
    queryHash: "testhash",
    startsAt: new Date(Date.UTC(2026, 7, startDay)),
    endsAt: new Date(Date.UTC(2026, 7, endDay)),
    ...overrides
  };
}

beforeEach(async () => {
  await prisma.sourceCoverage.deleteMany();
});

afterAll(async () => {
  await prisma.sourceCoverage.deleteMany();
  await prisma.$disconnect();
});

describe("recordSourceCoverage", () => {
  it("should coalesce adjacent intervals in the stored rows, not just in what it returns", async () => {
    await recordSourceCoverage(coverage(1, 3));
    await recordSourceCoverage(coverage(5, 7));
    await recordSourceCoverage(coverage(7, 8));

    const stored = await getSourceCoverage(coverage(1, 3));

    expect(stored.map((row) => [row.startsAt.getUTCDate(), row.endsAt.getUTCDate()])).toEqual([
      [1, 3],
      [5, 8]
    ]);
  });

  it("should keep each repository's coverage separate", async () => {
    await recordSourceCoverage(coverage(1, 5));
    await recordSourceCoverage(coverage(1, 9, { repository: "pcs-api" }));

    expect(await getSourceCoverage(coverage(1, 5))).toHaveLength(1);
    expect((await getSourceCoverage(coverage(1, 9, { repository: "pcs-api" })))[0]?.endsAt.getUTCDate()).toBe(9);
  });

  it("should keep coverage under a superseded query hash separate from the current one", async () => {
    // A widened query changes the hash, which is what auto-invalidates the narrower query's intervals.
    await recordSourceCoverage(coverage(1, 9, { queryHash: "old-signature" }));

    expect(await getSourceCoverage(coverage(1, 9))).toEqual([]);
    expect(await findMissingCoverage(coverage(1, 9))).toHaveLength(1);
  });

  it("should preserve an instant through a timestamptz round trip whatever offset it arrived with", async () => {
    // Upstream compared stored ISO TEXT and relied on normalising to UTC on write. Postgres stores an
    // instant, so an offset-bearing input must read back as the same moment.
    const startsAt = new Date("2026-08-01T01:00:00+01:00");
    const endsAt = new Date("2026-08-02T00:00:00Z");

    await recordSourceCoverage({ ...coverage(1, 2), startsAt, endsAt });

    const stored = await getSourceCoverage(coverage(1, 2));
    expect(stored[0]?.startsAt.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(stored[0]?.endsAt.toISOString()).toBe("2026-08-02T00:00:00.000Z");
  });

  it("should refuse a zero-width interval, so covered-but-empty cannot be recorded", async () => {
    const instant = new Date(Date.UTC(2026, 7, 1));

    await expect(recordSourceCoverage({ ...coverage(1, 2), startsAt: instant, endsAt: instant })).rejects.toThrow(/could not update collection cache/);
  });

  it("should refuse an inverted interval", async () => {
    await expect(recordSourceCoverage({ ...coverage(1, 2), startsAt: new Date(Date.UTC(2026, 7, 5)), endsAt: new Date(Date.UTC(2026, 7, 1)) })).rejects.toThrow(
      /could not update collection cache/
    );
  });

  it("should lock a series that has no rows yet, and only that series", async () => {
    // THE CASE `FOR UPDATE` COULD NOT COVER. A row lock only exists for rows that exist, so on the FIRST write
    // of a series it locked nothing: two writers both read an empty snapshot, both deleted nothing and both
    // inserted, and because `starts_at` is in the primary key two adjacent intervals both landed with the
    // coalescing invariant broken and no error anywhere.
    //
    // ASSERTED ON THE LOCK RATHER THAN ON THE OUTCOME, and deliberately. Two `recordSourceCoverage` calls raced
    // through `Promise.all` do not reliably interleave — each is a handful of fast statements, so the first
    // usually commits before the second reads — and that version of this case passed against `FOR UPDATE` too,
    // which is worse than no test. This asks a SECOND CONNECTION, while the first write is still uncommitted,
    // whether the series is locked. `pg_try_advisory_xact_lock` never waits, so a failure is a failure rather
    // than a hang.
    //
    // The key is spelled out here rather than imported, which is the point: if the separator or the column order
    // changes, this asks about a different series, `mine` comes back true, and the case fails.
    const series = (repository: string) => ["hmcts", repository, EvidenceSource.PullRequests, "testhash"].join("\u0001");

    const attempt = await prisma.$transaction(async (tx) => {
      await recordSourceCoverageWithin(tx, coverage(1, 3));
      return (
        await prisma.$queryRaw<{ mine: boolean; other: boolean }[]>`
          SELECT pg_try_advisory_xact_lock(hashtextextended(${series("cath-service")}, 0)) AS mine,
                 pg_try_advisory_xact_lock(hashtextextended(${series("pcs-api")}, 0)) AS other
        `
      )[0];
    });

    // `other` is the second half of the contract: the lock is derived from the four key columns, so a
    // collection of another repository at the same instant never waits on this one.
    expect(attempt).toEqual({ mine: false, other: true });
  });
});

/**
 * Stamping a series as used, which `prune` reads and nothing else does.
 *
 * The guard here is a WRITE-VOLUME invariant rather than a correctness one, and it is asserted because the cost
 * it removes is invisible from the outside: `accessed_at` is indexed, so every stamp is a dead tuple and a new
 * index tuple, and a whole-organisation render stamped 3,782 rows on every uncached request.
 */
describe("touchSourceCoverage", () => {
  const SIGNATURES = { pullRequests: "testhash", directCommits: "commithash" };

  it("should stamp a series nothing has read today", async () => {
    await recordSourceCoverage(coverage(1, 3), new Date(Date.UTC(2026, 7, 1, 9)));

    await touchSourceCoverage(coverage(1, 3), new Date(Date.UTC(2026, 7, 4, 9)));

    expect((await stamps())[0]?.toISOString()).toBe("2026-08-04T09:00:00.000Z");
  });

  it("should leave a series already stamped today alone", async () => {
    // Same meaning, no write: the cut-off `prune` compares against is measured in days, so a second read the
    // same day cannot change its answer.
    await recordSourceCoverage(coverage(1, 3), new Date(Date.UTC(2026, 7, 4, 9)));

    await touchSourceCoverage(coverage(1, 3), new Date(Date.UTC(2026, 7, 4, 23)));

    expect((await stamps())[0]?.toISOString()).toBe("2026-08-04T09:00:00.000Z");
  });

  it("should stamp a series last read before midnight today", async () => {
    // The boundary is UTC midnight and not a rolling twenty-four hours: a row stamped late yesterday must be
    // stamped again this morning, or a series read every day could age past the cut-off.
    await recordSourceCoverage(coverage(1, 3), new Date(Date.UTC(2026, 7, 3, 23, 59)));

    await touchSourceCoverage(coverage(1, 3), new Date(Date.UTC(2026, 7, 4, 0, 1)));

    expect((await stamps())[0]?.toISOString()).toBe("2026-08-04T00:01:00.000Z");
  });

  it("should leave the whole organisation's series alone once one render has stamped them", async () => {
    await recordSourceCoverage(coverage(1, 3), new Date(Date.UTC(2026, 7, 4, 9)));
    await recordSourceCoverage(coverage(1, 3, { repository: "pcs-api" }), new Date(Date.UTC(2026, 7, 4, 9)));

    await touchOrganisationCoverage("hmcts", SIGNATURES, new Date(Date.UTC(2026, 7, 4, 23)));

    expect(new Set((await stamps()).map((at) => at.toISOString()))).toEqual(new Set(["2026-08-04T09:00:00.000Z"]));
  });
});

async function stamps(): Promise<Date[]> {
  const rows = await prisma.sourceCoverage.findMany({ select: { accessedAt: true } });
  return rows.map((row) => row.accessedAt);
}

describe("findMissingCoverage", () => {
  it("should report the gaps a partial collection left", async () => {
    await recordSourceCoverage(coverage(1, 3));
    await recordSourceCoverage(coverage(5, 8));

    const missing = await findMissingCoverage(coverage(1, 10));

    expect(missing.map((row) => [row.startsAt.getUTCDate(), row.endsAt.getUTCDate()])).toEqual([
      [3, 5],
      [8, 10]
    ]);
  });

  it("should carry the requested key onto every gap it reports", async () => {
    const missing = await findMissingCoverage(coverage(1, 10));

    expect(missing[0]).toMatchObject({ organization: "hmcts", repository: "cath-service", source: EvidenceSource.PullRequests, queryHash: "testhash" });
  });
});

describe("prevailingCachedCoverage", () => {
  it("should report nothing when no repository has been collected under the signature", async () => {
    expect(await prevailingCachedCoverage("hmcts", EvidenceSource.PullRequests, "testhash")).toBeUndefined();
  });

  it("should report the edge most repositories reached, ignoring one that ran alone", async () => {
    for (const repository of ["a", "b", "c"]) {
      await recordSourceCoverage(coverage(1, 8, { repository }));
    }
    // A single-repository refresh reaching a day further must not move the estate's anchor.
    await recordSourceCoverage(coverage(1, 9, { repository: "d" }));

    const edge = await prevailingCachedCoverage("hmcts", EvidenceSource.PullRequests, "testhash");

    expect(edge?.toISOString()).toBe(new Date(Date.UTC(2026, 7, 8)).toISOString());
  });

  it("should ignore coverage recorded under a superseded signature", async () => {
    // A stale signature reaching further ahead would otherwise set an anchor nothing current covers.
    await recordSourceCoverage(coverage(1, 20, { repository: "a", queryHash: "old-signature" }));
    await recordSourceCoverage(coverage(1, 8, { repository: "a" }));

    const edge = await prevailingCachedCoverage("hmcts", EvidenceSource.PullRequests, "testhash");

    expect(edge?.toISOString()).toBe(new Date(Date.UTC(2026, 7, 8)).toISOString());
  });

  it("should read each source's edge independently", async () => {
    await recordSourceCoverage(coverage(1, 8));
    await recordSourceCoverage(coverage(1, 5, { source: EvidenceSource.DirectCommits }));

    expect((await prevailingCachedCoverage("hmcts", EvidenceSource.PullRequests, "testhash"))?.getUTCDate()).toBe(8);
    expect((await prevailingCachedCoverage("hmcts", EvidenceSource.DirectCommits, "testhash"))?.getUTCDate()).toBe(5);
  });
});

/**
 * The same aggregate `prevailingCachedCoverage` takes the mode of, kept per repository.
 *
 * What the report asks it is whether ONE repository was read up to where the estate's coverage ends — the
 * difference between a repository measured as having merged nothing and one whose merge history was refused. A
 * repository missing from the answer is the whole point of it, so most of these cases are about what it leaves out.
 */
describe("cachedCoverageEdges", () => {
  const SIGNATURES = { pullRequests: "testhash", directCommits: "commithash" };

  it("should report each repository's own edge, per source", async () => {
    await recordSourceCoverage(coverage(1, 8, { repository: "read-late" }));
    await recordSourceCoverage(coverage(1, 5, { repository: "read-late", source: EvidenceSource.DirectCommits, queryHash: "commithash" }));
    await recordSourceCoverage(coverage(1, 3, { repository: "read-early" }));

    const edges = await cachedCoverageEdges("hmcts", SIGNATURES);

    expect(edges.get("read-late")?.get(EvidenceSource.PullRequests)?.getUTCDate()).toBe(8);
    expect(edges.get("read-late")?.get(EvidenceSource.DirectCommits)?.getUTCDate()).toBe(5);
    expect(edges.get("read-early")?.get(EvidenceSource.PullRequests)?.getUTCDate()).toBe(3);
  });

  it("should report the furthest edge where a repository's coverage has a gap in it", async () => {
    // Two intervals that do not coalesce, which is what a run refused halfway through a window leaves. How far the
    // coverage REACHES is the question, and it is the later interval that answers it.
    await recordSourceCoverage(coverage(1, 3));
    await recordSourceCoverage(coverage(6, 9));

    const edges = await cachedCoverageEdges("hmcts", SIGNATURES);

    expect(edges.get("cath-service")?.get(EvidenceSource.PullRequests)?.getUTCDate()).toBe(9);
  });

  it("should omit a source whose only coverage is under a superseded signature", async () => {
    // A widened query changes the hash, so the intervals the narrower one covered are not coverage this build may
    // report from — and a report reading them would state figures for a window nothing current has walked.
    await recordSourceCoverage(coverage(1, 9, { queryHash: "old-signature" }));

    const edges = await cachedCoverageEdges("hmcts", SIGNATURES);

    expect(edges.get("cath-service")).toBeUndefined();
  });

  it("should omit a repository whose source was never read at all", async () => {
    // THE ANSWER THE REPORT ACTS ON. The refused walk and the stale path both leave no coverage, and this silence
    // is what says so.
    await recordSourceCoverage(coverage(1, 9));

    const edges = await cachedCoverageEdges("hmcts", SIGNATURES);

    expect(edges.get("cath-service")?.get(EvidenceSource.DirectCommits)).toBeUndefined();
    expect(edges.get("never-collected")).toBeUndefined();
  });

  it("should read only the organisation it was asked about", async () => {
    await recordSourceCoverage(coverage(1, 9, { organization: "another-org" }));

    expect(await cachedCoverageEdges("hmcts", SIGNATURES)).toEqual(new Map());
  });
});
