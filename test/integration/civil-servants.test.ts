import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { addCivilServants, civilServants, removeCivilServants } from "../../src/evidence/store/civil-servants.ts";
import { prisma } from "../../src/evidence/store/prisma.ts";

// The folding is unit-tested in src/evidence/store/civil-servants.test.ts. These cases prove the Postgres half:
// that a second load of the same list changes nothing, including who added a row and when, and that the casefold
// CHECK refuses a mixed-case login from a hand-written statement, which is the one writer the store cannot fold.

const ORGANIZATION = "hmcts";

async function wipe(): Promise<void> {
  await prisma.civilServant.deleteMany();
}

beforeEach(wipe);

afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

describe("civil_servants", () => {
  it("should flag each login once, however it is spelled, and read them back folded", async () => {
    expect(await addCivilServants("HMCTS", ["GEvans-HMCTS", "gevans-hmcts", "NatashaAlker"], "somebody@hmcts.net")).toBe(2);

    expect(await civilServants(ORGANIZATION)).toEqual(new Set(["gevans-hmcts", "natashaalker"]));
  });

  it("should leave a row exactly as the first load wrote it when the list is loaded again", async () => {
    await addCivilServants(ORGANIZATION, ["GEvans-HMCTS"], "first@hmcts.net");
    const before = await prisma.civilServant.findUniqueOrThrow({ where: { organization_login: { organization: ORGANIZATION, login: "gevans-hmcts" } } });

    expect(await addCivilServants(ORGANIZATION, ["gevans-hmcts", "js-hmcts"], "second@hmcts.net")).toBe(1);

    const after = await prisma.civilServant.findUniqueOrThrow({ where: { organization_login: { organization: ORGANIZATION, login: "gevans-hmcts" } } });
    expect(after).toEqual(before);
    expect(after.addedBy).toBe("first@hmcts.net");
  });

  it("should clear only the logins named, and report a login that was never flagged as nothing removed", async () => {
    await addCivilServants(ORGANIZATION, ["GEvans-HMCTS", "js-hmcts"]);

    expect(await removeCivilServants(ORGANIZATION, ["GEVANS-HMCTS", "nobody"])).toBe(1);
    expect(await civilServants(ORGANIZATION)).toEqual(new Set(["js-hmcts"]));
  });

  it("should keep one organisation's flags out of another's", async () => {
    await addCivilServants(ORGANIZATION, ["GEvans-HMCTS"]);

    expect(await civilServants("elsewhere")).toEqual(new Set());
  });

  it("should refuse a mixed-case login written by hand", async () => {
    await expect(prisma.$executeRaw`INSERT INTO civil_servants (organization, login) VALUES ('hmcts', 'GEvans-HMCTS')`).rejects.toThrow(
      /civil_servants_casefolded/
    );
  });
});
