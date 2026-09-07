import { beforeEach, describe, expect, it, vi } from "vitest";
import { EXIT_COMPLETE, EXIT_FAILED, EXIT_USAGE } from "./exit-status.ts";

const migrate = vi.hoisted(() => vi.fn<() => Promise<string[]>>());
const loadConfiguration = vi.hoisted(() => vi.fn());
const configuredRepositories = vi.hoisted(() => vi.fn());
const collectionState = vi.hoisted(() => vi.fn());
const resolveCredentials = vi.hoisted(() => vi.fn());
const createGitHubClient = vi.hoisted(() => vi.fn());

vi.mock("../evidence/store/migrate.ts", () => ({ migrate }));
vi.mock("../evidence/store/prisma.ts", () => ({ prisma: { $disconnect: vi.fn().mockResolvedValue(undefined) } }));
vi.mock("../evidence/policy/load.ts", () => ({ loadConfiguration }));
vi.mock("../evidence/policy/repositories.ts", () => ({
  configuredRepositories,
  repositoryOwners: () => new Map(),
  sonarOrganizationName: () => "hmcts"
}));
vi.mock("../evidence/store/collection-state.ts", () => ({ collectionState, stampCollection: vi.fn() }));
vi.mock("../evidence/github/credentials.ts", () => ({ resolveCredentials }));
vi.mock("../evidence/github/client.ts", () => ({ createGitHubClient }));

const { main } = await import("./index.ts");

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

describe("main", () => {
  it("should apply pending migrations and report which ones it applied", async () => {
    migrate.mockResolvedValue(["20260905062029_init"]);

    expect(await main(["migrate"])).toBe(EXIT_COMPLETE);
    expect(migrate).toHaveBeenCalledOnce();
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining("20260905062029_init"));
  });

  it("should say the schema is up to date when there was nothing to apply", async () => {
    migrate.mockResolvedValue([]);

    expect(await main(["migrate"])).toBe(EXIT_COMPLETE);
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining("already up to date"));
  });

  it("should migrate without reading a policy", async () => {
    migrate.mockResolvedValue([]);

    await main(["migrate"]);

    expect(loadConfiguration).not.toHaveBeenCalled();
  });

  it("should fail with the migration's own message when one does not apply", async () => {
    migrate.mockRejectedValue(new Error("migration 20260905062029_init failed: relation already exists"));

    expect(await main(["migrate"])).toBe(EXIT_FAILED);
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining("relation already exists"));
  });

  it("should refuse an unknown command before it reaches any of them", async () => {
    expect(await main(["invent"])).toBe(EXIT_USAGE);
    expect(migrate).not.toHaveBeenCalled();
  });

  it("should refuse a command that needs a configuration without one", async () => {
    expect(await main(["collect"])).toBe(EXIT_USAGE);
    expect(loadConfiguration).not.toHaveBeenCalled();
  });
});

describe("doctor", () => {
  const CONFIG = {
    organization: "hmcts",
    lookback: { operational_days: 90 },
    teams: [{ identifier: "team", repositories: ["repo-a", "repo-b"] }]
  };

  /** Inside the operational window whenever this test runs, rather than a date that ages out of it. */
  function recently(): string {
    return new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  }

  function withMergeCounts(perRepository: number[]) {
    loadConfiguration.mockResolvedValue(CONFIG);
    configuredRepositories.mockReturnValue(["repo-a", "repo-b"]);
    collectionState.mockResolvedValue(undefined);
    resolveCredentials.mockResolvedValue({ token: async () => "t", describe: () => "a personal access token" });

    const counts = [...perRepository];
    createGitHubClient.mockReturnValue({
      get: vi.fn().mockResolvedValue({ default_branch: "master" }),
      graphql: vi.fn().mockImplementation(() => {
        const count = counts.shift() ?? 0;
        return Promise.resolve({
          repository: { pullRequests: { nodes: Array.from({ length: count }, () => ({ mergedAt: recently() })) } }
        });
      }),
      requestsIssued: () => 0,
      callOutcomes: () => []
    });
  }

  it("should pass when the credential can see merged pull requests", async () => {
    withMergeCounts([12, 30]);

    expect(await main(["doctor", "--config", "m.yaml"])).toBe(EXIT_COMPLETE);
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining("GitHub shows 42 merged pull requests"));
  });

  it("should fail when every repository is readable but none yields a merge", async () => {
    // The exact shape of the AAT failure: metadata reads fine, pull requests come back empty, and a collection
    // would record zero merges without anything reporting an error.
    withMergeCounts([0, 0]);

    expect(await main(["doctor", "--config", "m.yaml"])).toBe(EXIT_FAILED);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("would record none"));
  });

  it("should name the installation when it fails, since that is the usual cause", async () => {
    withMergeCounts([0, 0]);

    await main(["doctor", "--config", "m.yaml"]);

    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("pending approval"));
  });

  it("should still pass when only one repository has merges", async () => {
    withMergeCounts([0, 5]);

    expect(await main(["doctor", "--config", "m.yaml"])).toBe(EXIT_COMPLETE);
  });

  it("should not count a merge from outside the operational window", async () => {
    loadConfiguration.mockResolvedValue(CONFIG);
    configuredRepositories.mockReturnValue(["repo-a"]);
    collectionState.mockResolvedValue(undefined);
    resolveCredentials.mockResolvedValue({ token: async () => "t", describe: () => "a token" });
    createGitHubClient.mockReturnValue({
      get: vi.fn().mockResolvedValue({ default_branch: "master" }),
      graphql: vi.fn().mockResolvedValue({ repository: { pullRequests: { nodes: [{ mergedAt: "2020-01-01T00:00:00Z" }] } } }),
      requestsIssued: () => 0,
      callOutcomes: () => []
    });

    // A repository with history but none of it recent reads as nothing to report, not as a broken credential.
    expect(await main(["doctor", "--config", "m.yaml"])).toBe(EXIT_FAILED);
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining("GitHub shows 0 merged pull requests"));
  });

  it("should treat a query that throws as zero rather than crashing the command", async () => {
    loadConfiguration.mockResolvedValue(CONFIG);
    configuredRepositories.mockReturnValue(["repo-a"]);
    collectionState.mockResolvedValue(undefined);
    resolveCredentials.mockResolvedValue({ token: async () => "t", describe: () => "a token" });
    createGitHubClient.mockReturnValue({
      get: vi.fn().mockResolvedValue({ default_branch: "master" }),
      graphql: vi.fn().mockRejectedValue(new Error("GraphQL refused")),
      requestsIssued: () => 0,
      callOutcomes: () => []
    });

    expect(await main(["doctor", "--config", "m.yaml"])).toBe(EXIT_FAILED);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("reading merged pull requests failed: GraphQL refused"));
  });
});
