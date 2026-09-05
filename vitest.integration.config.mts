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
      reportsDirectory: "coverage-integration"
    }
  }
});
