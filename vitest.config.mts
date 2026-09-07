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
        "src/app/**/loading.tsx",
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
        statements: 80,
        lines: 80,
        branches: 75,
        functions: 80
      }
    }
  }
});
