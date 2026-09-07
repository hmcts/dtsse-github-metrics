import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

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
