import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/evidence/store/prisma.ts";
import { clearProductionOverride, markProductionOverride, productionOverrides, reportedProduction } from "../../src/evidence/store/production-override.ts";

// The rule is pure and unit-tested in src/evidence/store/production-override.test.ts. These cases prove the
// Postgres half: that a mark round-trips, that re-marking replaces the provenance instead of accumulating a
// second row, that the two CHECK constraints hold, and — the case this table exists for — that a collection
// rewriting `repository_state` wholesale leaves the mark standing.
//
// The last case here is the operator's own path. There is no admin UI, so the way a flag is set today is an
// `INSERT` in `psql`, and a statement documented in a pull request body and nowhere else is a statement that
// stops working silently. It runs here with its values bound rather than inlined, which is the only
// difference between it and what an operator pastes.

const ORGANIZATION = "hmcts";
const MARKED_AT = new Date(Date.UTC(2026, 8, 15, 9));

function mark(repository: string, overrides: Partial<Parameters<typeof markProductionOverride>[0]> = {}) {
  return {
    organization: ORGANIZATION,
    repository,
    markedBy: "somebody@hmcts.net",
    reason: "deploys to production through a pipeline the approvals list does not cover",
    markedAt: MARKED_AT,
    ...overrides
  };
}

async function wipe(): Promise<void> {
  await prisma.productionOverride.deleteMany();
  await prisma.repositoryState.deleteMany();
}

beforeEach(wipe);

afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

describe("markProductionOverride", () => {
  it("should round-trip a mark, casefolding what the caller typed", async () => {
    await markProductionOverride(mark("PCS-API", { organization: "HMCTS" }));

    expect(await productionOverrides(ORGANIZATION)).toEqual(new Set(["pcs-api"]));
    const stored = await prisma.productionOverride.findUnique({ where: { organization_repository: { organization: "hmcts", repository: "pcs-api" } } });
    expect(stored).toMatchObject({ markedBy: "somebody@hmcts.net", markedAt: MARKED_AT });
    expect(stored?.reason).toContain("approvals list does not cover");
  });

  it("should replace a mark rather than accumulating a second one for the same repository", async () => {
    await markProductionOverride(mark("pcs-api"));
    await markProductionOverride(mark("pcs-api", { markedBy: "somebody-else@hmcts.net", reason: "still production, and now correctly attributed" }));

    expect(await prisma.productionOverride.count()).toBe(1);
    const stored = await prisma.productionOverride.findUnique({ where: { organization_repository: { organization: ORGANIZATION, repository: "pcs-api" } } });
    expect(stored?.markedBy).toBe("somebody-else@hmcts.net");
  });

  it("should read only the organisation it was asked about", async () => {
    await markProductionOverride(mark("pcs-api"));
    await markProductionOverride(mark("some-service", { organization: "another-org" }));

    expect(await productionOverrides(ORGANIZATION)).toEqual(new Set(["pcs-api"]));
    expect(await productionOverrides("another-org")).toEqual(new Set(["some-service"]));
  });
});

describe("clearProductionOverride", () => {
  it("should remove a mark and report that it did", async () => {
    await markProductionOverride(mark("pcs-api"));

    expect(await clearProductionOverride(ORGANIZATION, "PCS-API")).toBe(true);
    expect(await productionOverrides(ORGANIZATION)).toEqual(new Set());
  });

  it("should report a repository that was never marked rather than failing", async () => {
    expect(await clearProductionOverride(ORGANIZATION, "pcs-api")).toBe(false);
  });
});

describe("the production override table", () => {
  it("should survive a collection replacing the repository state it describes", async () => {
    // THE WHOLE REASON THIS IS A TABLE. `recordRepositoryState` upserts the entire payload, so a mark kept in
    // that jsonb document would live until the next `collect` walked the repository and no further. Written
    // through Prisma directly rather than through the collector, because what is being asserted is that the
    // two rows are independent — no collector code has to cooperate for that to hold.
    await markProductionOverride(mark("pcs-api"));
    await prisma.repositoryState.upsert({
      where: { organization_repository: { organization: ORGANIZATION, repository: "pcs-api" } },
      create: { organization: ORGANIZATION, repository: "pcs-api", fetchedAt: MARKED_AT, payload: { deploysToProduction: false } },
      update: { fetchedAt: MARKED_AT, payload: { deploysToProduction: false } }
    });

    expect(await productionOverrides(ORGANIZATION)).toEqual(new Set(["pcs-api"]));
    // And the combination the report layer will make: the approvals list was read and is silent, the mark
    // stands, so the repository reports as production.
    expect(reportedProduction(false, await productionOverrides(ORGANIZATION), "pcs-api")).toBe(true);
  });

  it("should refuse a mark nobody stands behind", async () => {
    const anonymous = prisma.productionOverride.create({
      data: { organization: ORGANIZATION, repository: "pcs-api", markedBy: "  ", reason: "deploys to production", markedAt: MARKED_AT }
    });

    await expect(anonymous).rejects.toThrow();
  });

  it("should refuse a mark with no reason, which is the folklore this table exists to prevent", async () => {
    const unexplained = prisma.productionOverride.create({
      data: { organization: ORGANIZATION, repository: "pcs-api", markedBy: "somebody@hmcts.net", reason: "", markedAt: MARKED_AT }
    });

    await expect(unexplained).rejects.toThrow();
  });

  it("should refuse an uncasefolded key, so one repository cannot hold two marks", async () => {
    // The primary key alone would let `(hmcts, PCS-API)` sit beside `(hmcts, pcs-api)`, each with its own
    // author and its own reason, and "who marked this and why" would stop having an answer.
    const shouted = prisma.productionOverride.create({
      data: { organization: ORGANIZATION, repository: "PCS-API", markedBy: "somebody@hmcts.net", reason: "deploys to production", markedAt: MARKED_AT }
    });

    await expect(shouted).rejects.toThrow();
  });

  it("should accept the statement an operator runs in psql, and stamp the instant itself", async () => {
    // The documented operator statement, structurally verbatim: `lower()` on both keys so a name typed in any
    // case satisfies the casefold constraint, `marked_at` omitted so the column default supplies it, and
    // `ON CONFLICT` so re-marking is a correction rather than an error. Only the five values are bound.
    await prisma.$executeRaw`
      INSERT INTO repository_production_override (organization, repository, marked_by, reason)
      VALUES (lower(${ORGANIZATION}), lower(${"PCS-API"}), ${"somebody@hmcts.net"}, ${"deploys to production, and the approvals list does not name it"})
      ON CONFLICT (organization, repository) DO UPDATE
        SET marked_by = EXCLUDED.marked_by, reason = EXCLUDED.reason, marked_at = now()
    `;

    expect(await productionOverrides(ORGANIZATION)).toEqual(new Set(["pcs-api"]));
    // Compared loosely against this process's clock rather than exactly: the instant comes from Postgres, and
    // the assertion is that the column default supplied one at all rather than that two clocks agree.
    const stored = await prisma.productionOverride.findUnique({ where: { organization_repository: { organization: ORGANIZATION, repository: "pcs-api" } } });
    expect(Math.abs((stored?.markedAt.getTime() ?? 0) - Date.now())).toBeLessThan(60 * 60 * 1000);
  });
});
