import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url))
    }
  },
  oxc: {
    jsx: {
      runtime: "automatic"
    }
  },
  test: {
    // `@vitest-environment jsdom` docblock, which vitest reads per test file.
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    exclude: ["node_modules", "dist", ".next", "test", "**/__fixtures__/**"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/evidence/store/generated/**",
        // Covered against a real database by `vitest.integration.config.mts`.
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
      reporter: ["lcov", "text"],
      reportsDirectory: "coverage",
      thresholds: { statements: 100, lines: 100, branches: 100, functions: 100 }
    }
  }
});
