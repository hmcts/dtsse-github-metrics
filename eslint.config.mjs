// The Sonar rules this project is scanned with, run through their ESLint ports so a Sonar issue fails `yarn lint`
// (and so CI) before the SonarCloud scan ever sees it. Biome remains the project's linter; this config enables the
// Sonar rules and nothing else.
//
// WHICH RULES: every rule in `sonar-rules.json`, the committed snapshot of the SonarCloud quality profile that
// `yarn lint:sonar:sync` refreshes, that has a known ESLint equivalent. `eslint-plugin-sonarjs` is SonarSource's own
// port and names the Sonar key of each of its rules; `BORROWED` maps the rest. Rules with no equivalent are left to
// the SonarCloud scan, which still runs.
//
// WHERE: as `sonar-project.properties` scopes the scan. MAIN rules on `sonar.sources` less `sonar.exclusions` and the
// tests, TEST rules on `sonar.test.inclusions`, ALL rules on both.
//
// Run it through `yarn lint:sonar` rather than bare `eslint`: `scripts/lint-sonar.mjs` also honours `// NOSONAR`,
// which ESLint has never heard of.
import { readFileSync } from "node:fs";
import path from "node:path";
import sonarjs from "eslint-plugin-sonarjs";
import unicorn from "eslint-plugin-unicorn";
import tseslint from "typescript-eslint";

const root = import.meta.dirname;

/**
 * Sonar rules `eslint-plugin-sonarjs` does not carry, with the ESLint rule Sonar's own implementation wraps.
 *
 * THE OPTIONS ARE WHAT MAKE THE PORTS AGREE WITH SONARCLOUD. Each port read at its defaults is stricter than the rule
 * Sonar runs, and a gate that fails on code SonarCloud passes is a gate people learn to bypass. Measured against a
 * Sonar-clean master on 2026-10-21, the defaults raised 15 findings Sonar did not; these options remove all 15:
 *
 *   S6606  `Boolean(a || b)` and `name.trim() || fallback`, where the falsy fallthrough is the point
 *   S7721  small arrow helpers inside a function, which Sonar leaves alone
 *   S7749  `2_000` and `0x7ff`, which Sonar does not ask to be regrouped
 *   S7763  `export { NAME }` of a constant the module also uses itself
 */
const BORROWED = {
  S107: { rule: "max-params", options: [{ max: 7 }] },
  S6551: { rule: "@typescript-eslint/no-base-to-string", options: [{ checkUnknown: true }] },
  S6582: { rule: "@typescript-eslint/prefer-optional-chain" },
  S6606: {
    rule: "@typescript-eslint/prefer-nullish-coalescing",
    options: [{ ignoreBooleanCoercion: true, ignorePrimitives: { string: true, number: true, boolean: true, bigint: true } }]
  },
  S6644: { rule: "no-unneeded-ternary", options: [{ defaultAssignment: false }] },
  S7721: { rule: "unicorn/consistent-function-scoping", options: [{ checkArrowFunctions: false }] },
  S7737: { rule: "unicorn/no-object-as-default-parameter" },
  S7749: { rule: "unicorn/numeric-separators-style", options: [{ onlyIfContainsSeparator: true, number: { minimumDigits: 0 } }] },
  S7755: { rule: "unicorn/prefer-at" },
  S7763: { rule: "unicorn/prefer-export-from", options: [{ checkUsedVariables: false }] },
  S7765: { rule: "unicorn/prefer-includes" },
  S7776: { rule: "unicorn/prefer-set-has" },
  S7778: { rule: "unicorn/prefer-single-call" },
  S7780: { rule: "unicorn/prefer-string-raw" },
  S7781: { rule: "unicorn/prefer-string-replace-all" },
  S7784: { rule: "unicorn/prefer-structured-clone" }
};

/** Sonar key → the ESLint rule and its options. */
const catalogue = new Map();
for (const [name, rule] of Object.entries(sonarjs.rules)) {
  const key = rule.meta?.docs?.url?.match(/S\d+/)?.[0];
  if (key !== undefined) {
    catalogue.set(key, { rule: `sonarjs/${name}`, options: [] });
  }
}
for (const [key, entry] of Object.entries(BORROWED)) {
  catalogue.set(key, { options: [], ...entry });
}

/** ESLint rule → its Sonar key, so a finding can be reported under the key SonarCloud would use. */
export const sonarKeyOf = new Map([...catalogue].map(([key, entry]) => [entry.rule, key]));

const { rules: profile } = JSON.parse(readFileSync(path.join(root, "sonar-rules.json"), "utf8"));

const rulesFor = (...scopes) =>
  Object.fromEntries(
    Object.entries(profile)
      .filter(([key, scope]) => catalogue.has(key) && scopes.includes(scope))
      .map(([key]) => [catalogue.get(key).rule, ["error", ...catalogue.get(key).options]])
  );

const properties = Object.fromEntries(
  readFileSync(path.join(root, "sonar-project.properties"), "utf8")
    .split("\n")
    .filter((line) => line.includes("=") && !line.trimStart().startsWith("#"))
    .map((line) => [line.slice(0, line.indexOf("=")).trim(), line.slice(line.indexOf("=") + 1).trim()])
);
const list = (value) => (value ?? "").split(",").filter(Boolean);

/** The directories the scan reads, which is what `yarn lint:sonar` lints when it is given no paths. */
export const sources = list(properties["sonar.sources"]);

const typescript = sources.map((source) => `${source}/**/*.{ts,tsx,mts}`);
const tests = list(properties["sonar.test.inclusions"]);
const excluded = list(properties["sonar.exclusions"]);

export default [
  { ignores: excluded },
  {
    files: typescript,
    languageOptions: { parser: tseslint.parser, parserOptions: { projectService: true, tsconfigRootDir: root } },
    linterOptions: { reportUnusedDisableDirectives: "off" },
    plugins: { sonarjs, unicorn, "@typescript-eslint": tseslint.plugin }
  },
  { files: typescript, ignores: tests, rules: rulesFor("MAIN", "ALL") },
  { files: tests, ignores: list(properties["sonar.test.exclusions"]), rules: rulesFor("TEST", "ALL") }
];
