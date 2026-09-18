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
        "src/instrumentation.ts",
        "src/app/**/layout.tsx",
        "src/evidence/store/**",
        // The two modules of `report/**` that read Postgres, and the only two left after VIBE-569 split the
        // aggregation layer out of `report/repositories.ts`. `estate.ts` is the one read every span is derived
        // from and `reports.ts` is the orchestration above it; everything else under `report/**` — `spans.ts`,
        // `measured.ts`, `contract/**`, `rows/**`, `overview.ts`, `teams.ts`, `repository-evidence.ts` — is a pure
        // function of what those two hand it, and is held at the bar below. `vitest.integration.config.mts` covers
        // these two against a real database.
        "src/evidence/report/estate.ts",
        "src/evidence/report/reports.ts",
        // The Cosmos driver call, excluded for `store/**`'s reason: a test of it is a test of `@azure/cosmos`.
        // IT HOLDS NOTHING ELSE, and that is the point of how small it is — `cve/credentials.ts` resolves the
        // account, `cve/documents.ts` holds the query and the per-document guard, `cve/reports.ts` parses a report
        // and `cve/collect.ts` folds the stream. All four are tested at the bar below. What is exempt here is
        // `new CosmosClient(...)` and the loop that pumps its pages, and nothing that decides anything.
        "src/evidence/cve/cosmos.ts",
        "src/evidence/behaviour/fill.ts",
        "src/lib/api.ts"
      ],
      reporter: ["lcov", "text"],
      reportsDirectory: "coverage",
      thresholds: {
        "src/components/**": { statements: 100, lines: 100, branches: 100, functions: 100 },
        "src/lib/**": { statements: 100, lines: 100, branches: 100, functions: 100 },
        "src/evidence/behaviour/**": { statements: 95, lines: 95, branches: 90, functions: 95 },
        "src/evidence/assessment/**": { statements: 95, lines: 95, branches: 90, functions: 95 },
        "src/evidence/window/**": { statements: 95, lines: 95, branches: 90, functions: 95 },
        "src/evidence/report/**": { statements: 95, lines: 95, branches: 90, functions: 95 },
        // The published-CVE parsers, held at the same bar rather than falling to the global floor. They are what
        // decides whether a repository reads unmeasured or clean, which is the one mistake in this feature that a
        // reader cannot detect from the page.
        "src/evidence/cve/**": { statements: 95, lines: 95, branches: 90, functions: 95 },
        // Where the grading decisions live, so held to the same bar as the rest of `evidence` rather than
        // falling to the global floor. Measured 99.20/99.14/96.55/100 for `domain` and 99.02/98.97/91.02/100
        // for `org`.
        "src/evidence/domain/**": { statements: 95, lines: 95, branches: 90, functions: 95 },
        "src/evidence/org/**": { statements: 95, lines: 95, branches: 90, functions: 95 },
        // `policy` reaches 100% of statements, lines and functions. Its branch floor is 80 rather than 90
        // because all seven uncovered arms are unreachable: five are the `error instanceof Error ? … :
        // String(error)` fallback in a catch that only ever receives an Error (`load.ts` 68/78/94,
        // `schema.ts` 51/318), one is a duplicate guard in `repositories.ts` for input the schema already
        // refuses, and one is a `??` fallback whose map is built from the same array it is looked up in.
        //
        // 80 AND NOT 82 BECAUSE THE DENOMINATOR SHRANK, not because an arm went dark. The seven are the same
        // seven; removing the `practices:` block, the `sonar_projects:` cross-check and `sonarOrganizationName`
        // took four COVERED branches out of policy, which moved 34/41 to 30/37 — from 82.92% to 81.08% with
        // nothing uncovered that was covered before. Raising coverage here means reaching one of the seven,
        // which is what "unreachable" says cannot be done.
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
