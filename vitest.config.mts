import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// `.mts`, not `.ts`: package.json declares no `"type": "module"` (Next.js and the PostCSS/Tailwind
// configs read as CommonJS), so Vite's native config loader would treat a `.ts` config as CJS and
// warn on the ESM syntax below. The explicit module extension states it instead.
//
// The `@/*` alias is declared in tsconfig.json for the type checker and the Next.js bundler; vitest
// reads neither, so it is repeated here rather than pulled in with another plugin dependency.
export default defineConfig({
  // The React plugin is what makes a client component's hooks run: it gives the transform React's
  // own JSX pipeline rather than the bare automatic runtime below, which is what the DOM tests
  // render through `@testing-library/react`. Fast Refresh, its other half, is inert here.
  plugins: [react()],
  resolve: {
    // `server-only` is deliberately NOT resolved through its `react-server` condition here.
    //
    // Doing that globally makes React itself resolve to `react-server`, whose entry point refuses to load outside
    // an experimental channel — which broke every component test at once. The guard is therefore left armed, and
    // the modules that import `server-only` are asserted by reading their source rather than by importing them:
    // see src/lib/__tests__/api.test.ts. Behaviour that needs those modules loaded is covered in
    // test/integration/, whose own config is free to resolve them because nothing there renders a component.
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url))
    }
  },
  // Stated here because vitest reads no tsconfig at all: the `jsx` setting in tsconfig.json is for
  // `tsc` and the Next.js bundler, and the transform below would otherwise default to a runtime the
  // components are not written for. vitest 4 runs on Vite 8, where oxc has replaced esbuild as the
  // transformer — hence `oxc`, and the nested `runtime` rather than a bare string.
  oxc: {
    jsx: {
      runtime: "automatic"
    }
  },
  test: {
    // `node`, not `jsdom`, as the default: the inherited component tests render through
    // `react-dom/server`, where there is no document to want, and standing a jsdom up per file
    // would cost that for nothing. The DOM tests opt in one file at a time with a
    // `@vitest-environment jsdom` docblock, which vitest reads per test file.
    environment: "node",
    // `.tsx` as well as `.ts`: a test file that reached for JSX under a `.ts`-only pattern would be
    // collected by nothing and report as neither run nor failed.
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    exclude: ["node_modules", "dist", ".next", "test", "**/__fixtures__/**"],
    coverage: {
      provider: "v8",
      // Naming `include` is what makes untested files appear in the table at 0% rather than being
      // omitted from it — vitest 4 removed the `all` flag that used to say this.
      include: ["src/**"],
      exclude: [
        // Type-only module: `tsc` erases it entirely, so there is no runtime code to instrument and
        // v8 reports it as an unreachable 0% that no test could ever raise.
        "src/lib/types.ts",
        // Framework entry points, exercised by Playwright rather than unit tests.
        "src/instrumentation.ts",
        "src/app/**/layout.tsx",
        "src/app/**/loading.tsx"
      ],
      // `text` alone in the gate, which writes to stdout and creates no files. The `html` reporter
      // is the one worth having when a figure drops, but on a virtiofs mount it intermittently dies
      // with `ENOENT: mkdir coverage/src`, and vitest does not fail a run over a crashed reporter —
      // so the gate went green while printing a stack trace. It lives in `test:coverage:html`.
      reporter: ["lcov", "text"],
      reportsDirectory: "coverage",
      // Two standards, deliberately. The UI arrived from hmcts/github-metrics fully covered and
      // stays that way — anything less there is a regression, not a figure to be talked down. The
      // ported evidence code is held at 95% because its numeric correctness is the whole product;
      // the CLI and store plumbing are held at the workspace's usual 80%.
      thresholds: {
        "src/components/**": { statements: 100, lines: 100, branches: 100, functions: 100 },
        "src/lib/**": { statements: 100, lines: 100, branches: 100, functions: 100 },
        "src/evidence/behaviour/**": { statements: 95, lines: 95, branches: 90, functions: 95 },
        "src/evidence/assessment/**": { statements: 95, lines: 95, branches: 90, functions: 95 },
        "src/evidence/window/**": { statements: 95, lines: 95, branches: 90, functions: 95 },
        "src/evidence/report/**": { statements: 95, lines: 95, branches: 90, functions: 95 },
        "src/evidence/store/coverage.ts": { statements: 95, lines: 95, branches: 90, functions: 95 },
        statements: 80,
        lines: 80,
        branches: 75,
        functions: 80
      }
    }
  }
});
