import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  declaredProduction,
  markProduction,
  type ProductionLayers,
  type ProductionSource,
  productionOverrides,
  reportedProduction,
  seedProduction
} from "./production-override.ts";
import { StorageError } from "./storage-error.ts";

/**
 * The rule and the folding, WITHOUT POSTGRES.
 *
 * `reportedProduction` is pure, so the truth table is a table of literals — which is the point of the rule
 * living in one function: the combination of what the approvals list said, what the configured list names and
 * what the column says is decided here and asserted here, rather than being an expression somewhere in the
 * report layer that only an integration test can reach. Three layers is 18 combinations, which is exactly why
 * they belong in one table rather than in a chain of `??`s.
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

/** The three layers, none of them naming anything, which each case below adds only what it is about. */
function layers(declared: string[] = [], marked: [string, boolean][] = []): ProductionLayers {
  return { declared: declaredProduction(declared), marked: new Map(marked) };
}

/** One row of the truth table. Every key omitted is that layer saying nothing. */
interface Case {
  /** What the approvals list said: named, read and silent, or unread. */
  approvals?: boolean;
  /** Whether `metrics.yaml`'s list names it. */
  configured?: boolean;
  /** What the column holds, where somebody has an opinion. */
  marked?: boolean;
  production?: boolean;
  source?: ProductionSource;
}

describe("reportedProduction", () => {
  it.each<[string, Case]>([
    ["names it and nobody has an opinion", { approvals: true, production: true, source: "approvals-list" }],
    ["names it and somebody forced it on", { approvals: true, marked: true, production: true, source: "marked" }],
    ["names it and somebody forced it off", { approvals: true, marked: false, production: false, source: "marked" }],
    ["was read and is silent, with no opinion", { approvals: false, production: false, source: "approvals-list" }],
    ["was read and is silent, but somebody forced it on", { approvals: false, marked: true, production: true, source: "marked" }],
    ["was read and is silent, and somebody forced it off", { approvals: false, marked: false, production: false, source: "marked" }],
    ["could not be read, with no opinion", {}],
    ["could not be read, but somebody forced it on", { marked: true, production: true, source: "marked" }],
    ["could not be read, and somebody forced it off", { marked: false, production: false, source: "marked" }],
    // The layer this table gained. It can only add, so every `false` below comes from one of the other two.
    ["the configured list names it and the approvals list is silent", { approvals: false, configured: true, production: true, source: "configured-list" }],
    ["the configured list names it and the approvals list could not be read", { configured: true, production: true, source: "configured-list" }],
    ["both lists name it, the organisation's document answering for it", { approvals: true, configured: true, production: true, source: "approvals-list" }],
    ["the configured list names it and somebody forced it off", { approvals: false, configured: true, marked: false, production: false, source: "marked" }],
    ["the configured list names it and somebody forced it on as well", { configured: true, marked: true, production: true, source: "marked" }],
    ["neither list names it and somebody forced it on", { marked: true, production: true, source: "marked" }]
  ])("should report %s", (_case, given) => {
    const stated = layers(given.configured === true ? ["pcs-api"] : [], given.marked === undefined ? [] : [["pcs-api", given.marked]]);

    const answer = reportedProduction(given.approvals, stated, "pcs-api");

    expect(answer.production).toBe(given.production);
    expect(answer.source).toBe(given.source);
  });

  it("should leave an unread list unread when neither list names it and the opinion belongs to another repository", () => {
    // The absence that must not be filled in: `false` would state that the approvals list was read and does not
    // name this repository, which nobody observed. A configured list holding OTHER names does not observe it
    // either — the list can add an answer and never a negative one.
    expect(reportedProduction(undefined, layers(["something-else"], [["something-else", true]]), "pcs-api")).toEqual({});
  });

  it("should match both lists against the repository name whatever case the graph reports it in", () => {
    // GitHub names are case-insensitive and the stored keys are casefolded, so the lookup has to fold too —
    // otherwise a repository the organisation writes as `PCS-API` silently loses its badge. The configured list
    // is typed by hand, so it can differ in case at EITHER end.
    expect(reportedProduction(false, layers([], [["pcs-api", true]]), "PCS-API")).toEqual({ production: true, source: "marked" });
    expect(reportedProduction(false, layers(["PCS-API"]), "pcs-api")).toEqual({ production: true, source: "configured-list" });
    expect(reportedProduction(undefined, layers(["pcs-api"]), "PCS-API")).toEqual({ production: true, source: "configured-list" });
  });
});

describe("declaredProduction", () => {
  it("should fold the configured names once, so the rule does not fold 290 of them per row", () => {
    expect(declaredProduction(["PCS-API", "cp-maven-parent-pom"])).toEqual(new Set(["pcs-api", "cp-maven-parent-pom"]));
  });

  it("should hold nothing for a deployment that states no list", () => {
    expect(declaredProduction([])).toEqual(new Set());
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
