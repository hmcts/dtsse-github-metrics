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
      provider: "v8",
      reporter: ["lcov", "text"],
      reportsDirectory: "coverage-integration",
      include: ["src/evidence/store/**", "src/evidence/report/repositories.ts", "src/evidence/behaviour/fill.ts"],
      exclude: ["src/evidence/store/generated/**", "src/evidence/store/prisma.ts"],
      thresholds: {
        "src/evidence/store/coverage.ts": { statements: 85, lines: 85, branches: 90, functions: 95 }
      }
    }
  }
});
