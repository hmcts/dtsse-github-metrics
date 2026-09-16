import { beforeEach, describe, expect, it, vi } from "vitest";
import { markProduction, productionOverrides, reportedProduction, seedProduction } from "./production-override.ts";
import { StorageError } from "./storage-error.ts";

/**
 * The rule and the folding, WITHOUT POSTGRES.
 *
 * `reportedProduction` is pure, so the truth table is a table of literals — which is the point of the rule
 * living in one function: the combination of "the approvals list said" and "the column says" is decided here
 * and asserted here, rather than being an expression somewhere in the report layer that only an integration
 * test can reach.
 *
 * The readers and writers touch Postgres, so the generated client is the one thing mocked. What that leaves
 * under test is what this module actually decides about them: that both keys are casefolded before they reach
 * the database, that a NULL flag is dropped rather than mapped, that an update finding no row is reported
 * rather than raised, and that a driver failure leaves as a `StorageError` like every other read in this
 * directory. `test/integration/production-override.test.ts` proves the same functions against a real database,
 * its CHECK constraint and its `marked_at` trigger.
 */

const { findMany, updateMany, executeRaw } = vi.hoisted(() => ({
  findMany: vi.fn(),
  updateMany: vi.fn(),
  executeRaw: vi.fn()
}));

vi.mock("./prisma.ts", () => ({ prisma: { repositoryProduction: { findMany, updateMany }, $executeRaw: executeRaw } }));

beforeEach(() => {
  vi.clearAllMocks();
  findMany.mockResolvedValue([]);
  updateMany.mockResolvedValue({ count: 1 });
  executeRaw.mockResolvedValue(0);
});

describe("reportedProduction", () => {
  it.each([
    ["names it and nobody has an opinion", true, undefined, true],
    ["names it and somebody forced it on", true, true, true],
    ["names it and somebody forced it off", true, false, false],
    ["was read and is silent, with no opinion", false, undefined, false],
    ["was read and is silent, but somebody forced it on", false, true, true],
    ["was read and is silent, and somebody forced it off", false, false, false],
    ["could not be read, with no opinion", undefined, undefined, undefined],
    ["could not be read, but somebody forced it on", undefined, true, true],
    ["could not be read, and somebody forced it off", undefined, false, false]
  ])("should report %s", (_case, approved: boolean | undefined, stated: boolean | undefined, expected: boolean | undefined) => {
    const overrides = new Map(stated === undefined ? [] : [["pcs-api", stated]]);

    expect(reportedProduction(approved, overrides, "pcs-api")).toBe(expected);
  });

  it("should leave an unread list unread when the opinion belongs to another repository", () => {
    // The absence that must not be filled in: `false` would state that the approvals list was read and does not
    // name this repository, which nobody observed.
    expect(reportedProduction(undefined, new Map([["something-else", true]]), "pcs-api")).toBeUndefined();
  });

  it("should match the flag against the repository name whatever case the graph reports it in", () => {
    // GitHub names are case-insensitive and the stored keys are casefolded, so the lookup has to fold too —
    // otherwise a repository the organisation writes as `PCS-API` silently loses its badge.
    expect(reportedProduction(false, new Map([["pcs-api", true]]), "PCS-API")).toBe(true);
  });
});

describe("productionOverrides", () => {
  it("should read one organisation's stated flags, casefolding the organisation it is asked about", async () => {
    findMany.mockResolvedValue([
      { repository: "pcs-api", production: true },
      { repository: "cath-service", production: false }
    ]);

    expect(await productionOverrides("HMCTS")).toEqual(
      new Map([
        ["pcs-api", true],
        ["cath-service", false]
      ])
    );
    expect(findMany).toHaveBeenCalledWith({ where: { organization: "hmcts" }, select: { repository: true, production: true } });
  });

  it("should leave a repository nobody has an opinion about out of the map entirely", async () => {
    // The seeded row for every repository in the estate. An entry mapped to `undefined` would be a second shape
    // for "no opinion", and `reportedProduction` reads a missing key as deferral.
    findMany.mockResolvedValue([
      { repository: "pcs-api", production: null },
      { repository: "cath-service", production: true }
    ]);

    expect(await productionOverrides("hmcts")).toEqual(new Map([["cath-service", true]]));
  });

  it("should report an empty map for an organisation with no rows at all", async () => {
    expect(await productionOverrides("hmcts")).toEqual(new Map());
  });

  it("should report a failed read as a StorageError", async () => {
    findMany.mockRejectedValue(new Error("connection terminated"));

    await expect(productionOverrides("hmcts")).rejects.toThrow(StorageError);
  });
});

describe("seedProduction", () => {
  it("should report how many repositories gained a row", async () => {
    executeRaw.mockResolvedValue(3);

    expect(await seedProduction("HMCTS")).toBe(3);
  });

  it("should report a failed seed as a StorageError", async () => {
    executeRaw.mockRejectedValue(new Error("connection terminated"));

    await expect(seedProduction("hmcts")).rejects.toThrow(StorageError);
  });
});

describe("markProduction", () => {
  it("should casefold both keys, so the caller's typing cannot miss the row the seed put there", async () => {
    expect(await markProduction({ organization: "HMCTS", repository: "PCS-API", production: true })).toBe(true);
    expect(updateMany).toHaveBeenCalledWith({
      where: { organization: "hmcts", repository: "pcs-api" },
      data: { production: true }
    });
  });

  it("should hand the answer back to the approvals list when the caller states no opinion", async () => {
    // `null` and not `undefined`: Prisma reads an absent key as "leave the column alone", which is the opposite
    // of what withdrawing an opinion means.
    await markProduction({ organization: "hmcts", repository: "pcs-api", production: undefined });

    expect(updateMany.mock.calls[0]?.[0].data).toEqual({ production: null });
  });

  it("should write the author and the reason where the caller states them, and omit them where it does not", async () => {
    await markProduction({ organization: "hmcts", repository: "pcs-api", production: false, markedBy: "somebody@hmcts.net", reason: "retired" });

    // `marked_at` is absent from both: the trigger stamps it, so a value here is one the database replaces.
    expect(updateMany.mock.calls[0]?.[0].data).toEqual({ production: false, markedBy: "somebody@hmcts.net", reason: "retired" });
  });

  it("should report a repository the seed has not reached rather than inserting a row for it", async () => {
    // A key absent here is a repository `collect-org` has not seen. Minting it would put a name in this table
    // that the organisation graph does not have.
    updateMany.mockResolvedValue({ count: 0 });

    expect(await markProduction({ organization: "hmcts", repository: "never-collected", production: true })).toBe(false);
  });

  it("should report a failed write as a StorageError", async () => {
    updateMany.mockRejectedValue(new Error("connection terminated"));

    await expect(markProduction({ organization: "hmcts", repository: "pcs-api", production: true })).rejects.toThrow(StorageError);
  });
});
