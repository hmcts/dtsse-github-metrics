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
      // The modules that talk to Postgres. `vitest.config.mts` excludes exactly these from the unit run.
      include: [
        "src/evidence/store/alerts.ts",
        "src/evidence/store/collection-state.ts",
        "src/evidence/store/collector-lock.ts",
        "src/evidence/store/coverage.ts",
        "src/evidence/store/cve.ts",
        "src/evidence/store/descriptions.ts",
        "src/evidence/store/facts.ts",
        "src/evidence/store/migrate.ts",
        "src/evidence/store/notes.ts",
        "src/evidence/store/org-graph.ts",
        "src/evidence/store/prisma.ts",
        "src/evidence/store/production-override.ts",
        "src/evidence/store/prune.ts",
        "src/evidence/store/repository-state.ts",
        "src/evidence/store/sonar-map.ts",
        "src/evidence/report/estate.ts",
        "src/evidence/report/reports.ts",
        "src/evidence/behaviour/fill.ts",
        "src/preview/database.ts"
      ],
      thresholds: { statements: 100, lines: 100, branches: 100, functions: 100 }
    }
  }
});
