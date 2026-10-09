import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { INTEGRATION_OWNED } from "./vitest.integration-owned.mts";

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
      // Covered against a real database by `vitest.integration.config.mts`.
      exclude: ["src/evidence/store/generated/**", ...INTEGRATION_OWNED],
      reporter: ["lcov", "text"],
      reportsDirectory: "coverage",
      thresholds: { statements: 100, lines: 100, branches: 100, functions: 100 }
    }
  }
});
