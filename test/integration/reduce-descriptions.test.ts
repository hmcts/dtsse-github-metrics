import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { describedBy, referencePatterns } from "../../src/evidence/behaviour/collect.ts";
import { loadConfiguration } from "../../src/evidence/policy/load.ts";
import { censusOfDescriptions, reduceStoredDescriptions } from "../../src/evidence/store/descriptions.ts";
import { prisma } from "../../src/evidence/store/prisma.ts";

/**
 * The one-off that reduces descriptions cached before they were reduced, against a real table.
 *
 * WHY THESE CASES ARE INTEGRATION CASES. The whole of what could go wrong is in the SQL: whether the update
 * removes the text and adds the answers in ONE statement, whether `payload ? 'body'` selects a row whose body is
 * the empty string, and whether a second run finds anything left to do. None of that is observable against a
 * mocked client.
 *
 * THE PATTERNS COME FROM `metrics.yaml`, read through the loader, rather than being written out here. That the
 * reviewed file is what grades the estate is part of the contract — a copy of the two patterns in this file would
 * pass while the command applied something else entirely.
 *
 * THE EXPECTED VALUES COME FROM `describedBy`, which is the assertion that matters: what the backfill writes for
 * a row must be what a collection would have written for the same pull request. A hand-written 34 would agree
 * with the derivation today and quietly stop agreeing the day the derivation changed.
 */

const ORGANIZATION = "hmcts";
const QUERY_HASH = "testhash";

let patterns: readonly RegExp[];

beforeAll(async () => {
  patterns = referencePatterns((await loadConfiguration("metrics.yaml")).traceability);
});

beforeEach(async () => {
  await prisma.pullRequestFact.deleteMany();
});

afterAll(async () => {
  await prisma.pullRequestFact.deleteMany();
  await prisma.$disconnect();
});

/** The stored shape of a merge, less whatever a case is about. */
async function insert(identifier: number, payload: Record<string, unknown>, repository = "pcs-api"): Promise<void> {
  await prisma.pullRequestFact.create({
    data: {
      organization: ORGANIZATION,
      repository,
      queryHash: QUERY_HASH,
      identifier: BigInt(identifier),
      mergedAt: new Date(Date.UTC(2026, 8, 1)),
      authorLogin: "someone",
      payload: { identifier, repository, number: identifier, draft: false, reviews: [], checks: [], ...payload }
    }
  });
}

async function stored(identifier: number): Promise<Record<string, unknown>> {
  const row = await prisma.pullRequestFact.findFirstOrThrow({ where: { identifier: BigInt(identifier) }, select: { payload: true } });
  return row.payload as Record<string, unknown>;
}

async function reduce(dryRun = false, batchSize = 500) {
  return await reduceStoredDescriptions(patterns, { dryRun, batchSize });
}

describe("reducing the descriptions of rows cached before the answers existed", () => {
  it("should replace an old row's text with exactly what the derivation says about it", async () => {
    const title = "Measure backfill progress on ledger offsets";
    const body = "This fixes the counter, see VIBE-571 for the measurement.";
    await insert(101, { title, body });

    const reduction = await reduce();

    expect(reduction).toEqual({ scanned: 1, changed: 1 });
    const payload = await stored(101);
    expect(payload).toMatchObject(describedBy({ title, body }, patterns));
    expect(payload.bodyLength).toBe(body.trim().length);
    expect(payload.hasTicketReference).toBe(true);
    // Both keys gone, in the same statement that added the two above: there is no run and no crash that leaves a
    // row holding neither the description nor an answer about it.
    expect("body" in payload).toBe(false);
    expect("title" in payload).toBe(false);
    // Everything else the fact carried is untouched.
    expect(payload).toMatchObject({ identifier: 101, number: 101, draft: false, reviews: [], checks: [] });
  });

  it("should grade a reference in the title, which is the join the derivation makes", async () => {
    await insert(102, { title: "VIBE-571 reduce the stored descriptions", body: "No reference in the body at all." });

    await reduce();

    expect(await stored(102)).toMatchObject({ hasTicketReference: true });
  });

  it("should read an empty description as a length of zero rather than as no length", async () => {
    // THE CASE THAT IS EASY TO GET WRONG. A pull request opened with no description at all was answered by
    // GitHub, and the answer is zero — which `descriptionQuality` counts in its denominator as too short. Absent
    // means something else entirely: a row nothing has ever measured, which the metric leaves out.
    await insert(103, { title: "Bump a dependency", body: "" });

    await reduce();

    const payload = await stored(103);
    expect(payload.bodyLength).toBe(0);
    expect("bodyLength" in payload).toBe(true);
    expect(payload.hasTicketReference).toBe(false);
    expect("body" in payload).toBe(false);
    expect((await censusOfDescriptions()).unmeasurable).toBe(0);
  });

  it("should read a whitespace-only description as zero, because whitespace is not a description", async () => {
    await insert(104, { title: "Tidy up", body: "   \n\t  " });

    await reduce();

    expect(await stored(104)).toMatchObject({ bodyLength: 0 });
  });

  it("should leave a row that has already been reduced completely alone", async () => {
    const reduced = { identifier: 105, repository: "pcs-api", number: 105, draft: false, reviews: [], checks: [], bodyLength: 41, hasTicketReference: false };
    await insert(105, { bodyLength: 41, hasTicketReference: false });

    const reduction = await reduce();

    expect(reduction).toEqual({ scanned: 0, changed: 0 });
    expect(await stored(105)).toEqual(reduced);
  });

  it("should keep the answer a row already carries rather than regrading it", async () => {
    // A stored answer was graded against the patterns of its day, and an edited pattern list regrades nothing
    // already cached — see `behaviour/collect.ts`. So a row holding both the text and an answer loses the text
    // and keeps the answer.
    await insert(106, { title: "No reference here", body: "and none here either", bodyLength: 999, hasTicketReference: true });

    await reduce();

    expect(await stored(106)).toMatchObject({ bodyLength: 999, hasTicketReference: true });
    expect("body" in (await stored(106))).toBe(false);
  });

  it("should write nothing at all in a dry run, having derived every row", async () => {
    await insert(107, { title: "Something", body: "A description long enough to be described." });

    const reduction = await reduce(true);

    expect(reduction).toEqual({ scanned: 1, changed: 0 });
    expect(await stored(107)).toMatchObject({ body: "A description long enough to be described." });
    expect((await censusOfDescriptions()).carryingDescription).toBe(1);
  });

  it("should find nothing left to do when it is run again", async () => {
    await insert(108, { title: "First", body: "A description with #4321 in it." });
    await insert(109, { title: "Second", body: "" });

    const first = await reduce();
    const before = [await stored(108), await stored(109)];
    const second = await reduce();

    expect(first).toEqual({ scanned: 2, changed: 2 });
    expect(second).toEqual({ scanned: 0, changed: 0 });
    expect([await stored(108), await stored(109)]).toEqual(before);
  });

  it("should walk the whole table in batches smaller than it", async () => {
    // The walk is by primary key across repositories, so the batch boundary has to fall inside a repository and
    // between two of them. A cursor that only ordered by identifier would skip rows here.
    for (const [identifier, repository] of [
      [201, "pcs-api"],
      [202, "pcs-api"],
      [203, "pcs-frontend"],
      [204, "pcs-frontend"],
      [205, "sptribs-case-api"]
    ] as const) {
      await insert(identifier, { title: `Change ${identifier}`, body: `A description for ${identifier}.` }, repository);
    }

    const reduction = await reduce(false, 2);

    expect(reduction).toEqual({ scanned: 5, changed: 5 });
    const census = await censusOfDescriptions();
    expect(census).toEqual({ rows: 5, carryingDescription: 0, derived: 5, unmeasurable: 0 });
  });

  it("should count what it would change before anything is written", async () => {
    await insert(301, { title: "Old", body: "Still carrying its description." });
    await insert(302, { bodyLength: 12, hasTicketReference: false });
    await insert(303, { title: "Title but no body key" });

    expect(await censusOfDescriptions()).toEqual({ rows: 3, carryingDescription: 2, derived: 1, unmeasurable: 0 });
  });
});
