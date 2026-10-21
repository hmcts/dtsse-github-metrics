import { beforeEach, describe, expect, it, vi } from "vitest";
import { addCivilServants, civilServants, removeCivilServants } from "./civil-servants.ts";
import { StorageError } from "./storage-error.ts";

/**
 * The folding, WITHOUT POSTGRES.
 *
 * The generated client is the one thing mocked, so what is left under test is what this module decides: that
 * every key is casefolded before it reaches the database, that blanks and repeats never do, and that a driver
 * failure leaves as a `StorageError`. `test/integration/civil-servants.test.ts` proves the same functions against
 * a real table and its CHECK constraint.
 */

const { findMany, createMany, deleteMany } = vi.hoisted(() => ({ findMany: vi.fn(), createMany: vi.fn(), deleteMany: vi.fn() }));

vi.mock("./prisma.ts", () => ({ prisma: { civilServant: { findMany, createMany, deleteMany } } }));

beforeEach(() => {
  vi.clearAllMocks();
  findMany.mockResolvedValue([]);
  createMany.mockResolvedValue({ count: 0 });
  deleteMany.mockResolvedValue({ count: 0 });
});

describe("civilServants", () => {
  it("should read one organisation's flagged logins, folding the organisation it asks for", async () => {
    findMany.mockResolvedValue([{ login: "gevans-hmcts" }, { login: "natashaalker" }]);

    expect(await civilServants("HMCTS")).toEqual(new Set(["gevans-hmcts", "natashaalker"]));
    expect(findMany).toHaveBeenCalledWith({ where: { organization: "hmcts" }, select: { login: true } });
  });

  it("should report a failed read as a storage error", async () => {
    findMany.mockRejectedValue(new Error("connection refused"));

    await expect(civilServants("hmcts")).rejects.toBeInstanceOf(StorageError);
  });
});

describe("addCivilServants", () => {
  it("should insert each login once, folded and trimmed, and never overwrite a row already there", async () => {
    createMany.mockResolvedValue({ count: 2 });

    expect(await addCivilServants("hmcts", ["GEvans-HMCTS", " gevans-hmcts ", "", "NatashaAlker"], "graham.jones@solirius.com")).toBe(2);
    expect(createMany).toHaveBeenCalledWith({
      data: [
        { organization: "hmcts", login: "gevans-hmcts", addedBy: "graham.jones@solirius.com" },
        { organization: "hmcts", login: "natashaalker", addedBy: "graham.jones@solirius.com" }
      ],
      skipDuplicates: true
    });
  });

  it("should leave the author unset where nobody named one", async () => {
    await addCivilServants("hmcts", ["js-hmcts"]);

    expect(createMany).toHaveBeenCalledWith({ data: [{ organization: "hmcts", login: "js-hmcts" }], skipDuplicates: true });
  });

  it("should make no write at all for a list of blanks", async () => {
    expect(await addCivilServants("hmcts", ["", "  "])).toBe(0);
    expect(createMany).not.toHaveBeenCalled();
  });

  it("should report a failed write as a storage error", async () => {
    createMany.mockRejectedValue(new Error("check constraint"));

    await expect(addCivilServants("hmcts", ["js-hmcts"])).rejects.toBeInstanceOf(StorageError);
  });
});

describe("removeCivilServants", () => {
  it("should delete the folded logins and report how many were flagged", async () => {
    deleteMany.mockResolvedValue({ count: 1 });

    expect(await removeCivilServants("HMCTS", ["GEvans-HMCTS", "nobody"])).toBe(1);
    expect(deleteMany).toHaveBeenCalledWith({ where: { organization: "hmcts", login: { in: ["gevans-hmcts", "nobody"] } } });
  });

  it("should make no write at all for a list of blanks", async () => {
    expect(await removeCivilServants("hmcts", [" "])).toBe(0);
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it("should report a failed delete as a storage error", async () => {
    deleteMany.mockRejectedValue(new Error("connection refused"));

    await expect(removeCivilServants("hmcts", ["js-hmcts"])).rejects.toBeInstanceOf(StorageError);
  });
});
