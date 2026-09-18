import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // `server-only` throws on import outside a React Server Component, which is the point of it — but it also
      // stops a test importing the report layer at all. Aliased to an empty module so the guard keeps protecting
      // the build while these cases can still reach the code the config already collects coverage for.
      "server-only": fileURLToPath(new URL("./test/integration/server-only-stub.ts", import.meta.url))
    }
  },
  test: {
    environment: "node",
    include: ["test/integration/**/*.test.ts"],
    globalSetup: ["./test/integration/setup.ts"],
    pool: "forks",
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 30_000,
    coverage: {
      // On for every run rather than behind `--coverage`, because the thresholds below only apply when coverage
      // is collected and the pipeline invokes the script by name with no way to add a flag.
      enabled: true,
      provider: "v8",
      reporter: ["lcov", "text"],
      reportsDirectory: "coverage-integration",
      // The two modules of `report/**` that read Postgres, which after VIBE-569 is all that is left of
      // `report/repositories.ts` needing a database: `estate.ts` is the one read every span is derived from and
      // `reports.ts` is the orchestration above it. Everything else the split produced is a pure function of what
      // those two hand it and is held at 95/90 by the unit config, which no longer exempts any of it.
      include: ["src/evidence/store/**", "src/evidence/report/estate.ts", "src/evidence/report/reports.ts", "src/evidence/behaviour/fill.ts"],
      // `**/*.test.ts` because `src/evidence/store/**` matches the unit tests sitting beside the store, which
      // this run does not execute: they were being reported at 0% and pulling the aggregate down.
      exclude: ["src/evidence/store/generated/**", "src/evidence/store/prisma.ts", "**/*.test.ts"],
      // Set just below what the suite achieves today, so the numbers hold without being raised past what the
      // code reaches: 89.11/89.60/84.71/94.24 overall, `estate.ts` at 100/100/100/100 and `reports.ts` at
      // 97.67/97.56/95.65/100 — the two files whose only gate is this run, since the unit config exempts them.
      // Re-measured with `repositoryTrend` in `reports.ts` (VIBE-592); the four floors below were already met.
      //
      // THE AGGREGATE MOVED UP NINE POINTS WITHOUT A CASE BEING ADDED, which is what the decomposition bought:
      // `report/repositories.ts` was measured here at 78.96/78.20/68.00/79.56 because two thirds of it was pure
      // aggregation this run reaches only incidentally. That two thirds is now unit-tested at 95/90, and what is
      // left is the reading, which these cases were always about.
      //
      // The branch floor has the most room of the four deliberately: `database-url.ts` takes a different arm
      // depending on whether `DATABASE_URL` is set, so the aggregate moves by about a third of a point between a
      // laptop and the pipeline, which sets one.
      thresholds: {
        "src/evidence/store/coverage.ts": { statements: 85, lines: 85, branches: 90, functions: 95 },
        "src/evidence/report/estate.ts": { statements: 98, lines: 98, branches: 95, functions: 100 },
        "src/evidence/report/reports.ts": { statements: 95, lines: 95, branches: 90, functions: 100 },
        statements: 88,
        lines: 88,
        branches: 82,
        functions: 93
      }
    }
  }
});
