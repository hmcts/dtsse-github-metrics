import { beforeEach, describe, expect, it, vi } from "vitest";
import { addCivilServantTeams, civilServantTeams, removeCivilServantTeams } from "./civil-servant-teams.ts";
import { StorageError } from "./storage-error.ts";

/**
 * The folding, WITHOUT POSTGRES, as `civil-servants.test.ts` does it for people.
 * `test/integration/civil-servant-teams.test.ts` proves the same functions against a real table and its CHECK.
 */

const { findMany, createMany, deleteMany } = vi.hoisted(() => ({ findMany: vi.fn(), createMany: vi.fn(), deleteMany: vi.fn() }));

vi.mock("./prisma.ts", () => ({ prisma: { civilServantTeam: { findMany, createMany, deleteMany } } }));

beforeEach(() => {
  vi.clearAllMocks();
  findMany.mockResolvedValue([]);
  createMany.mockResolvedValue({ count: 0 });
  deleteMany.mockResolvedValue({ count: 0 });
});

describe("civilServantTeams", () => {
  it("should read one organisation's flagged teams, folding the organisation it asks for", async () => {
    findMany.mockResolvedValue([{ team: "bulk-scan" }, { team: "civil" }]);

    expect(await civilServantTeams("HMCTS")).toEqual(new Set(["bulk-scan", "civil"]));
    expect(findMany).toHaveBeenCalledWith({ where: { organization: "hmcts" }, select: { team: true } });
  });

  it("should report a failed read as a storage error", async () => {
    findMany.mockRejectedValue(new Error("connection refused"));

    await expect(civilServantTeams("hmcts")).rejects.toBeInstanceOf(StorageError);
  });
});

describe("addCivilServantTeams", () => {
  it("should insert each team once, folded and trimmed, and never overwrite a row already there", async () => {
    createMany.mockResolvedValue({ count: 2 });

    expect(await addCivilServantTeams("hmcts", ["Bulk-Scan", " bulk-scan ", "", "civil"], "graham.jones@solirius.com")).toBe(2);
    expect(createMany).toHaveBeenCalledWith({
      data: [
        { organization: "hmcts", team: "bulk-scan", addedBy: "graham.jones@solirius.com" },
        { organization: "hmcts", team: "civil", addedBy: "graham.jones@solirius.com" }
      ],
      skipDuplicates: true
    });
  });

  it("should leave the author unset where nobody named one", async () => {
    await addCivilServantTeams("hmcts", ["civil"]);

    expect(createMany).toHaveBeenCalledWith({ data: [{ organization: "hmcts", team: "civil" }], skipDuplicates: true });
  });

  it("should make no write at all for a list of blanks", async () => {
    expect(await addCivilServantTeams("hmcts", ["", "  "])).toBe(0);
    expect(createMany).not.toHaveBeenCalled();
  });

  it("should report a failed write as a storage error", async () => {
    createMany.mockRejectedValue(new Error("check constraint"));

    await expect(addCivilServantTeams("hmcts", ["civil"])).rejects.toBeInstanceOf(StorageError);
  });
});

describe("removeCivilServantTeams", () => {
  it("should delete the folded teams and report how many were flagged", async () => {
    deleteMany.mockResolvedValue({ count: 1 });

    expect(await removeCivilServantTeams("HMCTS", ["Bulk-Scan", "nobody"])).toBe(1);
    expect(deleteMany).toHaveBeenCalledWith({ where: { organization: "hmcts", team: { in: ["bulk-scan", "nobody"] } } });
  });

  it("should make no write at all for a list of blanks", async () => {
    expect(await removeCivilServantTeams("hmcts", [" "])).toBe(0);
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it("should report a failed delete as a storage error", async () => {
    deleteMany.mockRejectedValue(new Error("connection refused"));

    await expect(removeCivilServantTeams("hmcts", ["civil"])).rejects.toBeInstanceOf(StorageError);
  });
});
