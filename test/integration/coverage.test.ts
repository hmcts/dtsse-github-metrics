import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { EvidenceSource, type SourceCoverage } from "../../src/evidence/domain/coverage.ts";
import {
  cachedCoverageEdges,
  findMissingCoverage,
  getSourceCoverage,
  prevailingCachedCoverage,
  recordSourceCoverage
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
});

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
