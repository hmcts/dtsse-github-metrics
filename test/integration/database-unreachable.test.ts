import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EvidenceSource } from "../../src/evidence/domain/coverage.ts";
import { PrismaClient } from "../../src/evidence/store/generated/client.js";
import { StorageError } from "../../src/evidence/store/storage-error.ts";

/**
 * Every store read and write against a database that is not there, which is what the `StorageError` contract is for.
 *
 * Every caller degrades a storage failure to "nothing collected" rather than crashing — a cache that cannot be read
 * is a report that says so, not a service that falls over — and that contract is only real if each function wraps
 * what the driver threw. `cve-store.test.ts` reaches the arms by hiding one table at a time; this reaches all of
 * them at once by pointing the process's one client at a port nothing listens on, which is the outage a deployed
 * pod actually meets.
 *
 * THE CLIENT IS PLANTED BEFORE THE STORE IS IMPORTED. `prisma.ts` keeps the process's client on `globalThis` and
 * builds one only where none is there, so a client set first is the one every store module is handed — the same
 * path a second bundled copy of the module takes in production. Hence the dynamic imports below: a static import
 * would be hoisted above the line that plants it.
 */

const UNREACHABLE = "postgresql://hmcts@127.0.0.1:1/never_listening";

const unreachable = new PrismaClient({ adapter: new PrismaPg(new pg.Pool({ connectionString: UNREACHABLE, connectionTimeoutMillis: 2_000 })) });

const KEY = { organization: "hmcts", repository: "pcs-api", source: EvidenceSource.PullRequests, queryHash: "hash" };
const COVERAGE = { ...KEY, startsAt: new Date(Date.UTC(2026, 8, 1)), endsAt: new Date(Date.UTC(2026, 8, 2)) };
const HASHES = { pullRequests: "hash", directCommits: "hash" };
const WHEN = new Date(Date.UTC(2026, 8, 2));
const NOTE_ID = "11111111-2222-3333-4444-555555555555";

type Call = () => Promise<unknown>;

let calls: [string, Call][];

beforeAll(async () => {
  (globalThis as unknown as { prisma?: PrismaClient }).prisma = unreachable;
  const { prisma } = await import("../../src/evidence/store/prisma.ts");
  const alerts = await import("../../src/evidence/store/alerts.ts");
  const collectionState = await import("../../src/evidence/store/collection-state.ts");
  const coverage = await import("../../src/evidence/store/coverage.ts");
  const descriptions = await import("../../src/evidence/store/descriptions.ts");
  const facts = await import("../../src/evidence/store/facts.ts");
  const notes = await import("../../src/evidence/store/notes.ts");
  const graph = await import("../../src/evidence/store/org-graph.ts");
  const production = await import("../../src/evidence/store/production-override.ts");
  const prune = await import("../../src/evidence/store/prune.ts");
  const repositoryState = await import("../../src/evidence/store/repository-state.ts");
  const sonarMap = await import("../../src/evidence/store/sonar-map.ts");

  expect(prisma).toBe(unreachable);

  calls = [
    ["storedRepositoryAlertScans", () => alerts.storedRepositoryAlertScans("hmcts", "pcs-api")],
    ["storedAlertCounts", () => alerts.storedAlertCounts("hmcts")],
    ["stampCollection", () => collectionState.stampCollection(WHEN)],
    ["stampRevision", () => collectionState.stampRevision()],
    ["collectionState", () => collectionState.collectionState()],
    ["getSourceCoverage", () => coverage.getSourceCoverage(KEY)],
    ["touchSourceCoverage", () => coverage.touchSourceCoverage(KEY, WHEN)],
    ["prevailingCachedCoverage", () => coverage.prevailingCachedCoverage("hmcts", EvidenceSource.PullRequests, "hash")],
    ["cachedCoverageEdges", () => coverage.cachedCoverageEdges("hmcts", HASHES)],
    ["touchOrganisationCoverage", () => coverage.touchOrganisationCoverage("hmcts", HASHES, WHEN)],
    ["censusOfDescriptions", () => descriptions.censusOfDescriptions()],
    ["reduceStoredDescriptions", () => descriptions.reduceStoredDescriptions([], { dryRun: true, batchSize: 10 })],
    ["cacheDirectCommitFacts", () => facts.cacheDirectCommitFacts(COVERAGE, [], true)],
    ["loadCachedPullRequestFacts", () => facts.loadCachedPullRequestFacts(KEY, COVERAGE.startsAt, COVERAGE.endsAt)],
    ["loadCachedDirectCommitFacts", () => facts.loadCachedDirectCommitFacts(KEY, COVERAGE.startsAt, COVERAGE.endsAt)],
    ["loadCachedFactsForOrganisation", () => facts.loadCachedFactsForOrganisation("hmcts", HASHES, COVERAGE.startsAt, COVERAGE.endsAt)],
    ["authorshipForOrganisation", () => facts.authorshipForOrganisation("hmcts", COVERAGE.startsAt)],
    ["storedRepositoryStates", () => facts.storedRepositoryStates("hmcts")],
    ["repositoryNotes", () => notes.repositoryNotes("hmcts", "pcs-api")],
    ["deleteRepositoryNote", () => notes.deleteRepositoryNote(NOTE_ID)],
    ["recordOrgTeams", () => graph.recordOrgTeams("hmcts", WHEN, [], true)],
    ["recordOrgTeamMemberships", () => graph.recordOrgTeamMemberships("hmcts", WHEN, [], new Set())],
    ["recordOrgTeamRepositories", () => graph.recordOrgTeamRepositories("hmcts", WHEN, [], new Set())],
    ["recordOrgRepositories", () => graph.recordOrgRepositories("hmcts", WHEN, [], true)],
    ["recordOrgPeople", () => graph.recordOrgPeople("hmcts", WHEN, [], true)],
    ["recordRepositoryOwnership", () => graph.recordRepositoryOwnership("hmcts", WHEN, [], new Set())],
    ["liveOrgRepositories", () => graph.liveOrgRepositories("hmcts")],
    ["liveOrgPeople", () => graph.liveOrgPeople("hmcts")],
    ["liveOrgTeamMemberships", () => graph.liveOrgTeamMemberships("hmcts")],
    ["liveRepositoryOwnership", () => graph.liveRepositoryOwnership("hmcts")],
    ["productionOverrides", () => production.productionOverrides("hmcts")],
    ["seedProduction", () => production.seedProduction("hmcts")],
    ["markProduction", () => production.markProduction({ organization: "hmcts", repository: "pcs-api", production: true })],
    ["pruneCache", () => prune.pruneCache(WHEN)],
    [
      "recordRepositoryState",
      () =>
        repositoryState.recordRepositoryState("hmcts", "pcs-api", {
          defaultBranch: "main",
          fetchedAt: WHEN,
          securityAlerts: { dependabot: {}, codeScanning: {}, secretScanning: {} }
        })
    ],
    ["storedRepositoryState", () => repositoryState.storedRepositoryState("hmcts", "pcs-api")],
    ["recordSonarMapping", () => sonarMap.recordSonarMapping("hmcts", { projectKey: "hmcts.cath", resolvedAt: WHEN, detail: "unresolved" })],
    ["storedSonarMappings", () => sonarMap.storedSonarMappings("hmcts")]
  ];
});

afterAll(async () => {
  await unreachable.$disconnect();
});

describe("a store with no database behind it", () => {
  it("should report every failure as a storage error rather than let a driver error escape", async () => {
    for (const [name, call] of calls) {
      await expect(call(), name).rejects.toThrow(StorageError);
    }
  });
});
