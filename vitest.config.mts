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
        "src/evidence/report/repositories.ts",
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
        // Where the grading decisions live, so held to the same bar as the rest of `evidence` rather than
        // falling to the global floor. Measured 99.20/99.14/96.55/100 for `domain` and 99.02/98.97/91.02/100
        // for `org`.
        "src/evidence/domain/**": { statements: 95, lines: 95, branches: 90, functions: 95 },
        "src/evidence/org/**": { statements: 95, lines: 95, branches: 90, functions: 95 },
        // `policy` reaches 100% of statements, lines and functions. Its branch floor is 82 rather than 90
        // because all seven uncovered arms are unreachable: five are the `error instanceof Error ? … :
        // String(error)` fallback in a catch that only ever receives an Error (`load.ts` 68/78/94,
        // `schema.ts` 43/295), one is a duplicate guard in `repositories.ts` for input the schema already
        // refuses, and one is a `??` fallback whose map is built from the same array it is looked up in.
        "src/evidence/policy/**": { statements: 95, lines: 95, branches: 82, functions: 95 },
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
