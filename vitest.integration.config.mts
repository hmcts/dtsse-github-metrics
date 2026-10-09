import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { INTEGRATION_OWNED } from "./vitest.integration-owned.mts";

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
      // The modules that talk to Postgres, which `vitest.config.mts` excludes from the unit run.
      include: INTEGRATION_OWNED,
      thresholds: { statements: 100, lines: 100, branches: 100, functions: 100 }
    }
  }
});
