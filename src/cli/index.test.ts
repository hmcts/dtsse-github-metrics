import { beforeEach, describe, expect, it, vi } from "vitest";
import { EXIT_COMPLETE, EXIT_FAILED, EXIT_USAGE } from "./exit-status.ts";

/**
 * `main`'s dispatch, for the one command that has to work before anything else does.
 *
 * The rest of the CLI is covered where its work is — the collector against recorded GitHub responses, the store
 * against a real Postgres — so what is left worth asserting here is the routing, and specifically that `migrate`
 * is routed BEFORE a policy is loaded. That ordering is what lets the web pod migrate at start, when it has a
 * database and a schema but no reason yet to have read a configuration, and it is invisible from either side:
 * both `migrate` and `doctor` return zero, so only the absence of a policy read distinguishes them.
 *
 * `store/prisma.ts` is mocked because importing it opens a connection pool at module scope, which a unit run
 * has nothing to connect to.
 */

const migrate = vi.hoisted(() => vi.fn<() => Promise<string[]>>());
const loadConfiguration = vi.hoisted(() => vi.fn());

vi.mock("../evidence/store/migrate.ts", () => ({ migrate }));
vi.mock("../evidence/store/prisma.ts", () => ({ prisma: { $disconnect: vi.fn().mockResolvedValue(undefined) } }));
vi.mock("../evidence/policy/load.ts", () => ({ loadConfiguration }));

const { main } = await import("./index.ts");

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
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
    // The common case, since the web pod migrates on every start: it has to be legible as "nothing happened"
    // rather than printing an empty list of migrations.
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
