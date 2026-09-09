import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * Replaces the upstream test of the same name, which stubbed `fetch` to exercise an HTTP client.
 *
 * There is no HTTP client any more: `api.ts` calls the ported evidence code in-process, which means importing it
 * opens a Postgres pool. So this file asserts the module's SHAPE — the boundary properties the pages and the build
 * depend on — and the behaviour that needs a database is asserted in `test/integration/` against a real one.
 *
 * The not-found signal is exercised there too, through the pages' own path.
 */
async function source(): Promise<string> {
  return readFile("src/lib/api.ts", "utf8");
}

describe("api.ts", () => {
  it("should be server-only, so a client component importing it fails at build time", async () => {
    // A clear message instead of an opaque bundling error out of `pg` or `@prisma/client`.
    expect((await source()).startsWith('import "server-only";')).toBe(true);
  });

  it("should reach for no HTTP client at all", async () => {
    // The absence of `fetch` here is the point of the port: the loopback hop to a FastAPI service, its CORS policy
    // and its second serialisation boundary all went away together.
    // Stripped of comments first: the module's own documentation names `API_URL` to say it went away, and that
    // sentence is worth keeping.
    const code = (await source()).replace(/\/\*\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

    expect(code).not.toContain("fetch(");
    expect(code).not.toContain("API_URL");
    expect(code).not.toContain("process.env.API_URL");
  });

  it("should read the policy document from METRICS_CONFIG", async () => {
    expect(await source()).toContain("METRICS_CONFIG");
  });

  it("should still export every getter the pages import", async () => {
    // The pages were carried over verbatim, so this list is their contract rather than this file's choice.
    const text = await source();

    for (const getter of ["getWindows", "getOverview", "getRepositories", "getRepository", "getTrend", "getActors", "getActor", "getTeams", "getTeam"]) {
      expect(text).toContain(`export async function ${getter}`);
    }
    // Re-exported rather than declared, so a page-level test can construct the real type without importing this
    // module and the Postgres pool behind it.
    expect(text).toContain('export { isNotFound, RepositoryUnknownError } from "@/lib/not-found"');
  });

  it("should select a team's repositories by every owner, not just the primary one", async () => {
    // 390 repositories on the estate are shared, and the report layer's `teamRows` counts each of them for every
    // team that owns it. A `row.team === team` filter here listed one repository beside a card that said two, and
    // left the readiness legend — which comes from `teamRows` — able to filter to an empty table.
    // Asserted on the source because importing this module opens a Postgres pool; the behaviour of the fold itself
    // is exercised in `rows.test.ts`.
    const code = (await source()).replace(/\/\*\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

    expect(code).toContain("owners(row).includes(team)");
    expect(code).not.toContain("row.team === team");
  });

  it("should read ownership by the same fold the report layer counts it by", async () => {
    // The count on /teams and the list on /teams/<team> come from two files, and the only thing keeping them from
    // drifting is that both fold an absent `teams` to the primary owner rather than to "owned by nobody".
    const report = await readFile("src/evidence/report/repositories.ts", "utf8");
    const rows = await readFile("src/lib/rows.ts", "utf8");

    expect(rows).toContain("row.teams ?? [row.team]");
    expect(report).toContain("row.teams ??");
  });

  it("should signal a missing name by type rather than by an HTTP status", async () => {
    // The pages branch on `isNotFound` to render Next's own not-found; there is no response to carry a 404.
    const text = await source();
    const signal = await readFile("src/lib/not-found.ts", "utf8");

    expect(text).toContain("RepositoryUnknownError");
    expect(signal).toContain("class RepositoryUnknownError");
    // No status on either side: there is no response to carry one.
    expect(signal).not.toContain("readonly status");
    expect(text).not.toContain("readonly status");
  });
});
