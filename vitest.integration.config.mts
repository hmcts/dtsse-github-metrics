import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// DB-backed tests, kept in a separate config from the unit suite because they need a real Postgres
// and cannot run concurrently against it. No React plugin: nothing here renders a component.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url))
    }
  },
  test: {
    environment: "node",
    include: ["test/integration/**/*.test.ts"],
    globalSetup: ["./test/integration/setup.ts"],
    // One shared database, so fixtures in a concurrent `beforeAll` would wipe each other. vitest 4
    // removed `poolOptions` and flattened its contents to top level, so the old
    // `poolOptions.forks.singleFork` is now `maxWorkers: 1` beside `fileParallelism: false`.
    pool: "forks",
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      reporter: ["lcov", "text"],
      reportsDirectory: "coverage-integration",
      // Only the modules that reach Postgres. They are excluded from the unit run's coverage — measured
      // there they read 0%, because that run has no database — so this is where they are held to a
      // number, and without it excluding them there would have quietly dropped their gate entirely.
      //
      // 85 rather than the 95 the pure numeric modules carry: what is uncovered here is error branches
      // that need a database to misbehave on cue, and the honest way to reach them is a fault-injection
      // harness rather than a higher number.
      include: ["src/evidence/store/**", "src/evidence/report/repositories.ts", "src/evidence/behaviour/fill.ts"],
      exclude: ["src/evidence/store/generated/**", "src/evidence/store/prisma.ts"],
      thresholds: {
        "src/evidence/store/coverage.ts": { statements: 85, lines: 85, branches: 90, functions: 95 }
      }
    }
  }
});
