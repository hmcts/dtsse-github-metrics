import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { addCivilServantTeams, civilServantTeams, removeCivilServantTeams } from "../../src/evidence/store/civil-servant-teams.ts";
import { prisma } from "../../src/evidence/store/prisma.ts";

// The folding is unit-tested in src/evidence/store/civil-servant-teams.test.ts. These cases prove the Postgres half,
// as test/integration/civil-servants.test.ts does for people.

const ORGANIZATION = "hmcts";

async function wipe(): Promise<void> {
  await prisma.civilServantTeam.deleteMany();
}

beforeEach(wipe);

afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

describe("civil_servant_teams", () => {
  it("should flag each team once, however it is spelled, and read them back folded", async () => {
    expect(await addCivilServantTeams("HMCTS", ["Bulk-Scan", "bulk-scan", "civil"], "somebody@hmcts.net")).toBe(2);

    expect(await civilServantTeams(ORGANIZATION)).toEqual(new Set(["bulk-scan", "civil"]));
  });

  it("should leave a row exactly as the first load wrote it when the file is loaded again", async () => {
    await addCivilServantTeams(ORGANIZATION, ["civil"], "first@hmcts.net");
    const before = await prisma.civilServantTeam.findUniqueOrThrow({ where: { organization_team: { organization: ORGANIZATION, team: "civil" } } });

    expect(await addCivilServantTeams(ORGANIZATION, ["civil", "probate"], "second@hmcts.net")).toBe(1);

    const after = await prisma.civilServantTeam.findUniqueOrThrow({ where: { organization_team: { organization: ORGANIZATION, team: "civil" } } });
    expect(after).toEqual(before);
  });

  it("should clear only the teams named, and report a team that was never flagged as nothing removed", async () => {
    await addCivilServantTeams(ORGANIZATION, ["civil", "probate"]);

    expect(await removeCivilServantTeams(ORGANIZATION, ["CIVIL", "nobody"])).toBe(1);
    expect(await civilServantTeams(ORGANIZATION)).toEqual(new Set(["probate"]));
  });

  it("should keep one organisation's flags out of another's", async () => {
    await addCivilServantTeams(ORGANIZATION, ["civil"]);

    expect(await civilServantTeams("elsewhere")).toEqual(new Set());
  });

  it("should refuse a mixed-case slug written by hand", async () => {
    await expect(prisma.$executeRaw`INSERT INTO civil_servant_teams (organization, team) VALUES ('hmcts', 'Bulk-Scan')`).rejects.toThrow(
      /civil_servant_teams_casefolded/
    );
  });
});
