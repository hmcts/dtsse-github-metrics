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
      include: ["src/**"],
      exclude: [
        "src/evidence/store/generated/**",
        "src/lib/types.ts",
        "src/evidence/store/**",
        // The two modules of `report/**` that read Postgres, and the only two left after VIBE-569 split the
        // aggregation layer out of `report/repositories.ts`. `estate.ts` is the one read every span is derived
        // from and `reports.ts` is the orchestration above it; everything else under `report/**` — `spans.ts`,
        // `measured.ts`, `contract/**`, `rows/**`, `overview.ts`, `teams.ts`, `repository-evidence.ts` — is a pure
        // function of what those two hand it, and is held at the bar below. `vitest.integration.config.mts` covers
        // these two against a real database.
        "src/evidence/report/estate.ts",
        "src/evidence/report/reports.ts",
        "src/evidence/behaviour/fill.ts",
        // The preview copy's SQL, which `vitest.integration.config.mts` covers against a real database.
        "src/preview/database.ts"
      ],
      reporter: ["lcov", "text"],
      reportsDirectory: "coverage",
      thresholds: {
        "src/components/**": { statements: 100, lines: 100, branches: 100, functions: 100 },
        "src/lib/**": { statements: 100, lines: 100, branches: 100, functions: 100 },
        "src/evidence/behaviour/**": { statements: 95, lines: 95, branches: 80, functions: 95 },
        "src/evidence/assessment/**": { statements: 95, lines: 95, branches: 80, functions: 95 },
        "src/evidence/window/**": { statements: 95, lines: 95, branches: 80, functions: 95 },
        "src/evidence/report/**": { statements: 95, lines: 95, branches: 80, functions: 95 },
        // The published-CVE parsers, held at the same bar rather than falling to the global floor. They are what
        // decides whether a repository reads unmeasured or clean, which is the one mistake in this feature that a
        // reader cannot detect from the page.
        "src/evidence/cve/**": { statements: 95, lines: 95, branches: 80, functions: 95 },
        // The alert-detail walk and its three-state resolution, held at the same bar for the same reason: this is
        // the code that decides whether a repository nobody could read is reported as unmeasured or as clean, and
        // the second is the one mistake in this feature a reader cannot detect from the page.
        "src/evidence/alerts/**": { statements: 95, lines: 95, branches: 80, functions: 95 },
        // Where the grading decisions live, so held to the same bar as the rest of `evidence` rather than
        // falling to the global floor. Measured 99.20/99.14/96.55/100 for `domain` and 99.02/98.97/91.02/100
        // for `org`.
        "src/evidence/domain/**": { statements: 95, lines: 95, branches: 80, functions: 95 },
        "src/evidence/org/**": { statements: 95, lines: 95, branches: 80, functions: 95 },
        // The guards that keep the preview copy's destructive statements off AAT.
        "src/preview/**": { statements: 100, lines: 100, branches: 95, functions: 100 },
        "src/evidence/policy/**": { statements: 95, lines: 95, branches: 80, functions: 95 },
        // Measured 94.15/94.28/89.23/96.52 across the suite. The old 80/75 left hundreds of covered lines
        // free to go dark before it tripped.
        statements: 93,
        lines: 93,
        branches: 88,
        functions: 95
      }
    }
  }
});
