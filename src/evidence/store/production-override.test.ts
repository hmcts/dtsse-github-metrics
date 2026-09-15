import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearProductionOverride, markProductionOverride, productionOverrides, reportedProduction } from "./production-override.ts";
import { StorageError } from "./storage-error.ts";

/**
 * The rule and the folding, WITHOUT POSTGRES.
 *
 * `reportedProduction` is pure, so the truth table is a table of literals — which is the point of the rule
 * living in one function: the combination of "the approvals list said" and "a person said" is decided here
 * and asserted here, rather than being an expression somewhere in the report layer that only an integration
 * test can reach.
 *
 * The three readers and writers touch Postgres, so the generated client is the one thing mocked. What that
 * leaves under test is what this module actually decides about them: that both keys are casefolded before
 * they reach the database, that a missing mark is not an error, and that a driver failure leaves as a
 * `StorageError` like every other read in this directory. `test/integration/production-override.test.ts`
 * proves the same functions against a real database and its CHECK constraints.
 */

const { findMany, upsert, deleteMany } = vi.hoisted(() => ({
  findMany: vi.fn(),
  upsert: vi.fn(),
  deleteMany: vi.fn()
}));

vi.mock("./prisma.ts", () => ({ prisma: { productionOverride: { findMany, upsert, deleteMany } } }));

/** A fixed instant, never `new Date()`: a fixture written against the clock is a suite that rots. */
const MARKED_AT = new Date("2026-09-15T09:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  findMany.mockResolvedValue([]);
  upsert.mockResolvedValue({});
  deleteMany.mockResolvedValue({ count: 1 });
});

describe("reportedProduction", () => {
  it.each([
    ["names it and nobody marked it", true, false, true],
    ["names it and somebody marked it too", true, true, true],
    ["was read and is silent, unmarked", false, false, false],
    ["was read and is silent, but somebody marked it", false, true, true],
    ["could not be read, unmarked", undefined, false, undefined],
    ["could not be read, but somebody marked it", undefined, true, true]
  ])("should report %s", (_case, approved: boolean | undefined, marked: boolean, expected: boolean | undefined) => {
    const overrides = new Set(marked ? ["pcs-api"] : []);

    expect(reportedProduction(approved, overrides, "pcs-api")).toBe(expected);
  });

  it("should leave an unread list unread rather than making it a confident false", () => {
    // The one case `approved || marked` would get wrong, and the reason this is not that expression: `false`
    // would state that the approvals list was read and does not name this repository, which nobody observed.
    expect(reportedProduction(undefined, new Set(["something-else"]), "pcs-api")).toBeUndefined();
  });

  it("should match a mark against the repository name whatever case the graph reports it in", () => {
    // GitHub names are case-insensitive and the stored keys are casefolded, so the lookup has to fold too —
    // otherwise a repository the organisation writes as `PCS-API` silently loses its badge.
    expect(reportedProduction(false, new Set(["pcs-api"]), "PCS-API")).toBe(true);
  });
});

describe("productionOverrides", () => {
  it("should read one organisation's marks, casefolding the organisation it is asked about", async () => {
    findMany.mockResolvedValue([{ repository: "pcs-api" }, { repository: "cath-service" }]);

    expect(await productionOverrides("HMCTS")).toEqual(new Set(["pcs-api", "cath-service"]));
    expect(findMany).toHaveBeenCalledWith({ where: { organization: "hmcts" }, select: { repository: true } });
  });

  it("should report an empty set for an organisation nobody has marked anything in", async () => {
    expect(await productionOverrides("hmcts")).toEqual(new Set());
  });

  it("should report a failed read as a StorageError", async () => {
    findMany.mockRejectedValue(new Error("connection terminated"));

    await expect(productionOverrides("hmcts")).rejects.toThrow(StorageError);
  });
});

describe("markProductionOverride", () => {
  it("should casefold both keys, so the operator's typing cannot make two marks of one repository", async () => {
    await markProductionOverride({
      organization: "HMCTS",
      repository: "PCS-API",
      markedBy: "somebody@hmcts.net",
      reason: "deploys to prod",
      markedAt: MARKED_AT
    });

    expect(upsert).toHaveBeenCalledWith({
      where: { organization_repository: { organization: "hmcts", repository: "pcs-api" } },
      create: { organization: "hmcts", repository: "pcs-api", markedBy: "somebody@hmcts.net", reason: "deploys to prod", markedAt: MARKED_AT },
      update: { markedBy: "somebody@hmcts.net", reason: "deploys to prod", markedAt: MARKED_AT }
    });
  });

  it("should stamp the mark with now when the caller states no instant", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(MARKED_AT);
    try {
      await markProductionOverride({ organization: "hmcts", repository: "pcs-api", markedBy: "somebody@hmcts.net", reason: "deploys to prod" });
    } finally {
      vi.useRealTimers();
    }

    expect(upsert.mock.calls[0]?.[0].create.markedAt).toEqual(MARKED_AT);
  });

  it("should report a failed write as a StorageError", async () => {
    // A blank `reason` is refused by a CHECK constraint rather than by this function, so the driver error is
    // exactly what a caller meets — and it has to arrive as the same boundary error every other write raises.
    upsert.mockRejectedValue(new Error("violates check constraint"));

    await expect(markProductionOverride({ organization: "hmcts", repository: "pcs-api", markedBy: "somebody@hmcts.net", reason: "" })).rejects.toThrow(
      StorageError
    );
  });
});

describe("clearProductionOverride", () => {
  it("should report that a mark was removed", async () => {
    expect(await clearProductionOverride("HMCTS", "PCS-API")).toBe(true);
    expect(deleteMany).toHaveBeenCalledWith({ where: { organization: "hmcts", repository: "pcs-api" } });
  });

  it("should report a repository that was never marked rather than failing", async () => {
    deleteMany.mockResolvedValue({ count: 0 });

    expect(await clearProductionOverride("hmcts", "pcs-api")).toBe(false);
  });

  it("should report a failed delete as a StorageError", async () => {
    deleteMany.mockRejectedValue(new Error("connection terminated"));

    await expect(clearProductionOverride("hmcts", "pcs-api")).rejects.toThrow(StorageError);
  });
});
