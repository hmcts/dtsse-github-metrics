import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/evidence/store/prisma.ts";
import { markProduction, productionOverrides, reportedProduction, seedProduction } from "../../src/evidence/store/production-override.ts";

// The rule is pure and unit-tested in src/evidence/store/production-override.test.ts. These cases prove the
// Postgres half, which is where the whole design of this table lives: that the seed gives every live repository
// a row to be marked on, that the seed CANNOT change a flag somebody has set, that the casefold CHECK holds,
// and that `marked_at` is stamped when the flag moves and only then.
//
// The statement a person runs is exercised here verbatim. There is no admin UI, so marking a repository is an
// `UPDATE` in pgAdmin or `psql`, and a statement documented in a pull-request body and nowhere else is a
// statement that stops working silently. It runs below with its values bound rather than inlined, which is the
// only difference between it and what a person types.

const ORGANIZATION = "hmcts";
const OBSERVED = new Date(Date.UTC(2026, 8, 15, 9));

/** One live repository in the organisation graph, which is what the seed reads. */
async function graphRepository(repository: string, observedAt: Date = OBSERVED, supersededAt?: Date): Promise<void> {
  await prisma.orgRepository.create({
    data: {
      organization: ORGANIZATION,
      repository,
      archived: false,
      visibility: "PUBLIC",
      payload: { defaultBranch: "main" },
      observedAt,
      lastObservedAt: observedAt,
      ...(supersededAt === undefined ? {} : { supersededAt }),
      digest: `${repository}-${observedAt.toISOString()}-digest`
    }
  });
}

/** The row's whole state, so a case can assert what the seed left alone as well as what it added. */
async function stored(repository: string) {
  return await prisma.repositoryProduction.findUnique({
    where: { organization_repository: { organization: ORGANIZATION, repository } }
  });
}

async function wipe(): Promise<void> {
  await prisma.repositoryProduction.deleteMany();
  await prisma.orgRepository.deleteMany();
  await prisma.repositoryState.deleteMany();
}

beforeEach(wipe);

afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

describe("seedProduction", () => {
  it("should give every live repository a row with no opinion on it", async () => {
    await graphRepository("pcs-api");
    await graphRepository("cath-service");

    expect(await seedProduction("HMCTS")).toBe(2);
    // NULL and not `false`: a seeded row states nothing, so the approvals list still answers for both.
    expect(await stored("pcs-api")).toMatchObject({ production: null, markedBy: null, markedAt: null, reason: null });
    expect(await productionOverrides(ORGANIZATION)).toEqual(new Map());
  });

  it("should add nothing on a second run over an unchanged estate", async () => {
    await graphRepository("pcs-api");
    await seedProduction(ORGANIZATION);

    expect(await seedProduction(ORGANIZATION)).toBe(0);
    expect(await prisma.repositoryProduction.count()).toBe(1);
  });

  it("should add a row for a repository the previous run had never seen", async () => {
    await graphRepository("pcs-api");
    await seedProduction(ORGANIZATION);
    await graphRepository("cath-service");

    expect(await seedProduction(ORGANIZATION)).toBe(1);
    expect(await prisma.repositoryProduction.count()).toBe(2);
  });

  it("should leave a flag somebody has set exactly as they set it", async () => {
    // THE PROPERTY THE WHOLE SHAPE RESTS ON. `ON CONFLICT DO NOTHING` means the seed can only ever ADD keys, so
    // "the import never overrides a person" is a fact about the statement rather than a rule somebody has to
    // remember. Asserted over both directions of the flag AND over the stamp, since a seed that touched the row
    // at all would restamp it and lose when the decision was made.
    await graphRepository("pcs-api");
    await graphRepository("cath-service");
    await seedProduction(ORGANIZATION);
    await markProduction({ organization: ORGANIZATION, repository: "pcs-api", production: true, markedBy: "somebody@hmcts.net", reason: "deploys to prod" });
    await markProduction({ organization: ORGANIZATION, repository: "cath-service", production: false });
    const marked = await stored("pcs-api");

    expect(await seedProduction(ORGANIZATION)).toBe(0);
    expect(await stored("pcs-api")).toMatchObject({ production: true, markedBy: "somebody@hmcts.net", markedAt: marked?.markedAt });
    expect(await stored("cath-service")).toMatchObject({ production: false });
    expect(await productionOverrides(ORGANIZATION)).toEqual(
      new Map([
        ["pcs-api", true],
        ["cath-service", false]
      ])
    );
  });

  it("should read the live estate and not the superseded versions of it", async () => {
    // The graph is change-versioned, so one repository holds a row per interval and only the open one is the
    // estate. A seed reading them all would add nothing extra — the key is the same — but one reading ONLY the
    // superseded rows would give a row to a repository that no longer exists.
    await graphRepository("pcs-api", new Date(Date.UTC(2026, 7, 1)), new Date(Date.UTC(2026, 8, 1)));
    await graphRepository("pcs-api");
    await graphRepository("archived-away", new Date(Date.UTC(2026, 7, 1)), new Date(Date.UTC(2026, 8, 1)));

    expect(await seedProduction(ORGANIZATION)).toBe(1);
    expect(await prisma.repositoryProduction.findMany({ select: { repository: true } })).toEqual([{ repository: "pcs-api" }]);
  });

  it("should fold two spellings of one repository into the single row the constraint allows", async () => {
    // `org_repositories` carries no casefold constraint, and GitHub names are case-insensitive, so the graph can
    // hold `PCS-API` beside `pcs-api`. Both lower to one key: without the `DISTINCT` applied AFTER `lower()` this
    // statement would offer the same key twice, and without `lower()` at all the casefold CHECK would refuse it.
    await graphRepository("pcs-api");
    await graphRepository("PCS-API");

    expect(await seedProduction(ORGANIZATION)).toBe(1);
    expect(await prisma.repositoryProduction.findMany({ select: { repository: true } })).toEqual([{ repository: "pcs-api" }]);
  });

  it("should seed only the organisation it was asked about", async () => {
    await graphRepository("pcs-api");
    await prisma.orgRepository.create({
      data: {
        organization: "another-org",
        repository: "some-service",
        archived: false,
        visibility: "PUBLIC",
        payload: {},
        observedAt: OBSERVED,
        lastObservedAt: OBSERVED,
        digest: "another-digest"
      }
    });

    expect(await seedProduction(ORGANIZATION)).toBe(1);
    expect(await prisma.repositoryProduction.count()).toBe(1);
  });
});

describe("marking a repository", () => {
  beforeEach(async () => {
    await graphRepository("pcs-api");
    await seedProduction(ORGANIZATION);
  });

  it("should force production on when a person runs the documented UPDATE", async () => {
    // The statement, structurally verbatim: one column, on a row that is already there, found by its two keys.
    // Only the values are bound.
    await prisma.$executeRaw`
      UPDATE repository_production SET production = true
      WHERE organization = ${ORGANIZATION} AND repository = ${"pcs-api"}
    `;

    expect(await productionOverrides(ORGANIZATION)).toEqual(new Map([["pcs-api", true]]));
    // And the combination the report layer makes: the approvals list was read and is silent, the column says
    // otherwise, so the repository reports as production.
    expect(reportedProduction(false, await productionOverrides(ORGANIZATION), "pcs-api")).toBe(true);
  });

  it("should force production off even where the approvals list names the repository", async () => {
    // The state the previous shape could not hold. An override that can only ever add leaves no way to correct
    // an approvals list that is wrong about a repository.
    await markProduction({ organization: ORGANIZATION, repository: "PCS-API", production: false });

    expect(reportedProduction(true, await productionOverrides(ORGANIZATION), "pcs-api")).toBe(false);
  });

  it("should hand the answer back to the approvals list when the flag is set to NULL again", async () => {
    await markProduction({ organization: ORGANIZATION, repository: "pcs-api", production: true });
    await markProduction({ organization: ORGANIZATION, repository: "pcs-api", production: undefined });

    expect(await productionOverrides(ORGANIZATION)).toEqual(new Map());
    expect(reportedProduction(false, await productionOverrides(ORGANIZATION), "pcs-api")).toBe(false);
    expect(reportedProduction(undefined, await productionOverrides(ORGANIZATION), "pcs-api")).toBeUndefined();
  });

  it("should report a repository the seed has not reached rather than inserting a row for it", async () => {
    expect(await markProduction({ organization: ORGANIZATION, repository: "never-collected", production: true })).toBe(false);
    expect(await prisma.repositoryProduction.count()).toBe(1);
  });

  it("should survive a collection replacing the repository state it describes", async () => {
    // Why this is a table of its own. `recordRepositoryState` upserts the entire payload, so a flag kept in that
    // jsonb document would live until the next `collect` walked the repository and no further.
    await markProduction({ organization: ORGANIZATION, repository: "pcs-api", production: true });
    await prisma.repositoryState.upsert({
      where: { organization_repository: { organization: ORGANIZATION, repository: "pcs-api" } },
      create: { organization: ORGANIZATION, repository: "pcs-api", fetchedAt: OBSERVED, payload: { deploysToProduction: false } },
      update: { fetchedAt: OBSERVED, payload: { deploysToProduction: false } }
    });

    expect(await productionOverrides(ORGANIZATION)).toEqual(new Map([["pcs-api", true]]));
  });
});

describe("the marked_at trigger", () => {
  beforeEach(async () => {
    await graphRepository("pcs-api");
    await seedProduction(ORGANIZATION);
  });

  it("should stamp the instant the flag first moved off NULL", async () => {
    expect(await stored("pcs-api")).toMatchObject({ markedAt: null });

    await markProduction({ organization: ORGANIZATION, repository: "pcs-api", production: true });

    // Compared loosely against this process's clock rather than exactly: the instant comes from Postgres, and
    // the assertion is that the trigger supplied one at all rather than that two clocks agree.
    const marked = await stored("pcs-api");
    expect(Math.abs((marked?.markedAt?.getTime() ?? 0) - Date.now())).toBeLessThan(60 * 60 * 1000);
  });

  it("should stamp a withdrawal, which is a decision like any other", async () => {
    // `NULL` is the transition `<>` would answer NULL for, so the guard has to be `IS DISTINCT FROM` — without
    // it, taking an opinion back would leave the stamp of the opinion behind.
    await markProduction({ organization: ORGANIZATION, repository: "pcs-api", production: true });
    const first = (await stored("pcs-api"))?.markedAt;
    await markProduction({ organization: ORGANIZATION, repository: "pcs-api", production: undefined });

    expect((await stored("pcs-api"))?.markedAt?.getTime()).toBeGreaterThanOrEqual(first?.getTime() ?? 0);
    expect(await stored("pcs-api")).toMatchObject({ production: null });
  });

  it("should leave the stamp alone when an update changes the reason and not the flag", async () => {
    // Otherwise the column records EDITS rather than DECISIONS, and "when was this decided" stops having an
    // answer the moment somebody fixes a typo in the reason.
    await markProduction({ organization: ORGANIZATION, repository: "pcs-api", production: true, reason: "deploys to prod" });
    const decided = (await stored("pcs-api"))?.markedAt;

    await markProduction({ organization: ORGANIZATION, repository: "pcs-api", production: true, reason: "deploys to production through the shared pipeline" });

    expect((await stored("pcs-api"))?.markedAt).toEqual(decided);
    expect((await stored("pcs-api"))?.reason).toContain("shared pipeline");
  });
});

describe("the production table's constraint", () => {
  it("should refuse an uncasefolded key, so one repository cannot hold two answers", async () => {
    // The primary key alone would let `(hmcts, PCS-API)` sit beside `(hmcts, pcs-api)`, each with its own flag,
    // and "is this a production service" would stop having an answer.
    const shouted = prisma.repositoryProduction.create({ data: { organization: ORGANIZATION, repository: "PCS-API", production: true } });

    await expect(shouted).rejects.toThrow();
  });
});
