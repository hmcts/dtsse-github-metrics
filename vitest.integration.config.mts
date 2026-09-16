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
      include: ["src/evidence/store/**", "src/evidence/report/repositories.ts", "src/evidence/behaviour/fill.ts"],
      // `**/*.test.ts` because `src/evidence/store/**` matches the unit tests sitting beside the store, which
      // this run does not execute: they were being reported at 0% and pulling the aggregate down.
      exclude: ["src/evidence/store/generated/**", "src/evidence/store/prisma.ts", "**/*.test.ts"],
      // Set just below what the suite achieves today, so the numbers hold without being raised past what the
      // code reaches: 79.43/79.38/69.86/82.84 overall, and 78.96/78.20/68.00/79.56 for `repositories.ts` — the
      // one file whose only gate is this run, since the unit config exempts it.
      //
      // The branch floor has the most room of the four deliberately: `database-url.ts` takes a different arm
      // depending on whether `DATABASE_URL` is set, so the aggregate is 69.86 on a laptop and 69.58 in the
      // pipeline, which sets one.
      thresholds: {
        "src/evidence/store/coverage.ts": { statements: 85, lines: 85, branches: 90, functions: 95 },
        "src/evidence/report/repositories.ts": { statements: 78, lines: 78, branches: 67, functions: 79 },
        statements: 79,
        lines: 79,
        branches: 69,
        functions: 82
      }
    }
  }
});
