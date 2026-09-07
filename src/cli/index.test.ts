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

  function doctorEnvironment(issueCounts: number[]) {
    loadConfiguration.mockResolvedValue(CONFIG);
    configuredRepositories.mockReturnValue(["repo-a", "repo-b"]);
    collectionState.mockResolvedValue(undefined);
    resolveCredentials.mockResolvedValue({ token: async () => "t", describe: () => "a personal access token" });

    const counts = [...issueCounts];
    createGitHubClient.mockReturnValue({
      get: vi.fn().mockResolvedValue({ default_branch: "master" }),
      graphql: vi.fn().mockImplementation(() => Promise.resolve({ search: { issueCount: counts.shift() ?? 0 } })),
      requestsIssued: () => 0,
      callOutcomes: () => []
    });
  }

  it("should pass when search can see merged pull requests", async () => {
    doctorEnvironment([12, 30]);

    expect(await main(["doctor", "--config", "m.yaml"])).toBe(EXIT_COMPLETE);
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining("search reports 42 merged pull requests"));
  });

  it("should fail when every repository is readable but search sees nothing", async () => {
    // The exact shape of the AAT failure: metadata reads fine, search is served an empty result, and a collection
    // would therefore record zero merges without anything reporting an error.
    doctorEnvironment([0, 0]);

    expect(await main(["doctor", "--config", "m.yaml"])).toBe(EXIT_FAILED);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("search returned nothing for any configured repository"));
  });

  it("should name the installation when it fails, since that is the usual cause", async () => {
    doctorEnvironment([0, 0]);

    await main(["doctor", "--config", "m.yaml"]);

    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("pending approval"));
  });

  it("should still pass when only one repository has merges", async () => {
    doctorEnvironment([0, 5]);

    expect(await main(["doctor", "--config", "m.yaml"])).toBe(EXIT_COMPLETE);
  });

  it("should treat a search that throws as zero rather than failing the command", async () => {
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
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("search failed: GraphQL refused"));
  });
});
