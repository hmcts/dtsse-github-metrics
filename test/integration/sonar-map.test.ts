import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { SonarResolutionMethod } from "../../src/evidence/domain/sonar.ts";
import { prisma } from "../../src/evidence/store/prisma.ts";
import { recordSonarMapping, storedSonarMappings } from "../../src/evidence/store/sonar-map.ts";

/**
 * The durable project map, against the constraint that gives its rows meaning.
 *
 * WHY THESE CASES NEED POSTGRES. `sonar_project_map` carries a CHECK — `(repository IS NULL) <> (detail IS NULL)`
 * — and that constraint is the whole contract of the table: a row is either an attribution or a REMEMBERED
 * NEGATIVE, and never a half-written thing that would teach the next run to skip a question nobody answered.
 * TypeScript cannot see it. Neither can it see the supersede rule's effect on `resolved_at`, which is what makes
 * a paced run converge instead of re-resolving the same projects for ever.
 *
 * The map cost 10 to 30 minutes of quota-paced commit searches to build, which is why `prune` may not touch it —
 * asserted in `prune-never-touches-durable.test.ts` rather than here.
 */

const ORGANIZATION = "hmcts";
const REVISION = "671d77770bda9760854fcf0bc5e086eed92bfb3a";
const RESOLVED_AT = new Date(Date.UTC(2026, 8, 17, 2));
const ANALYSED_AT = new Date(Date.UTC(2026, 8, 16, 10));

async function wipe(): Promise<void> {
  await prisma.sonarProjectMap.deleteMany();
}

beforeEach(wipe);

afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

describe("recordSonarMapping", () => {
  it("should store an attribution with the evidence it was resolved from", async () => {
    const written = await recordSonarMapping(ORGANIZATION, {
      projectKey: "hmcts.cath",
      resolvedAt: RESOLVED_AT,
      mapping: {
        projectKey: "hmcts.cath",
        repository: "cath-service",
        method: SonarResolutionMethod.AnalysisRevision,
        analysisAt: ANALYSED_AT,
        revision: REVISION,
        resolvedAt: RESOLVED_AT
      }
    });

    expect(written).toBe(true);
    expect(await storedSonarMappings(ORGANIZATION)).toEqual([
      {
        projectKey: "hmcts.cath",
        repository: "cath-service",
        method: SonarResolutionMethod.AnalysisRevision,
        analysisAt: ANALYSED_AT,
        revision: REVISION,
        resolvedAt: RESOLVED_AT
      }
    ]);
  });

  it("should store a remembered negative, which is what stops the next run re-paying the quota", async () => {
    await recordSonarMapping(ORGANIZATION, {
      projectKey: "hmcts.orphan",
      resolvedAt: RESOLVED_AT,
      detail: "no commit in hmcts matches any of the 5 most recently analysed revisions"
    });

    const [stored] = await storedSonarMappings(ORGANIZATION);
    expect(stored?.repository).toBeUndefined();
    expect(stored?.detail).toContain("no commit in hmcts matches");
  });

  it("should never write a row that is neither an attribution nor a reason, which the table would refuse", async () => {
    // The check constraint would reject it, and failing the whole run over a caller's omission is worse than
    // recording what the caller knew. A NULL pair is also the one row that would read as a remembered negative
    // while remembering nothing.
    await recordSonarMapping(ORGANIZATION, { projectKey: "hmcts.silent", resolvedAt: RESOLVED_AT });

    const [stored] = await storedSonarMappings(ORGANIZATION);
    expect(stored?.detail).toBe("no reason was recorded for this project being unresolved");
  });

  it("should replace an attribution when a newer analysis resolved a different repository", async () => {
    await recordSonarMapping(ORGANIZATION, {
      projectKey: "hmcts.cath",
      resolvedAt: RESOLVED_AT,
      mapping: {
        projectKey: "hmcts.cath",
        repository: "old-name",
        method: SonarResolutionMethod.AnalysisRevision,
        analysisAt: ANALYSED_AT,
        resolvedAt: RESOLVED_AT
      }
    });

    const later = new Date(ANALYSED_AT.getTime() + 86_400_000);
    const written = await recordSonarMapping(ORGANIZATION, {
      projectKey: "hmcts.cath",
      resolvedAt: later,
      mapping: { projectKey: "hmcts.cath", repository: "cath-service", method: SonarResolutionMethod.AnalysisRevision, analysisAt: later, resolvedAt: later }
    });

    expect(written).toBe(true);
    expect((await storedSonarMappings(ORGANIZATION))[0]?.repository).toBe("cath-service");
  });

  it("should keep an attribution when a run that could not find it again offers a negative, and still move the watermark", async () => {
    // A REFUSED WRITE STILL MOVES `resolved_at`, and that is what makes a paced run converge: the skip watermark
    // is when the row was last WRITTEN, so leaving it untouched would make this run look like it never asked and
    // the next run re-pay the same searches, every run, for ever.
    await recordSonarMapping(ORGANIZATION, {
      projectKey: "hmcts.cath",
      resolvedAt: RESOLVED_AT,
      mapping: {
        projectKey: "hmcts.cath",
        repository: "cath-service",
        method: SonarResolutionMethod.AnalysisRevision,
        analysisAt: ANALYSED_AT,
        resolvedAt: RESOLVED_AT
      }
    });

    const asked = new Date(RESOLVED_AT.getTime() + 604_800_000);
    const written = await recordSonarMapping(ORGANIZATION, { projectKey: "hmcts.cath", resolvedAt: asked, detail: "no commit matched this week" });

    expect(written).toBe(false);
    const [stored] = await storedSonarMappings(ORGANIZATION);
    expect(stored?.repository).toBe("cath-service");
    expect(stored?.detail).toBeUndefined();
    expect(stored?.resolvedAt).toEqual(asked);
  });

  it("should answer for one SonarCloud organisation only, since the two names may differ from GitHub's", async () => {
    await recordSonarMapping(ORGANIZATION, { projectKey: "hmcts.cath", resolvedAt: RESOLVED_AT, detail: "unresolved" });
    await recordSonarMapping("somebody-else", { projectKey: "other.cath", resolvedAt: RESOLVED_AT, detail: "unresolved" });

    expect((await storedSonarMappings(ORGANIZATION)).map((row) => row.projectKey)).toEqual(["hmcts.cath"]);
  });
});
