// Runs the Sonar rules in `eslint.config.mjs` and fails on any finding, which is what makes a Sonar issue fail
// `yarn lint` instead of turning up in the PR's SonarCloud analysis.
//
//   yarn lint:sonar                   every file the scan reads
//   yarn lint:sonar src/cli/index.ts  just these files (the Claude Code hook's use)
//
// A RUNNER RATHER THAN BARE `eslint`, for two things SonarCloud does that ESLint does not:
//
//   - `// NOSONAR` on a line suppresses every finding on it. Do not reach for it to get a build through: an issue
//     that looks like a false positive is for a person to accept in SonarCloud, where it is visible.
//   - S6551 leaves `String(error)` alone on a `catch` clause's own variable, where the port's `checkUnknown` (which
//     it needs for everything else) flags it.
//
// AND IT REFUSES TO RUN ON TWO TYPESCRIPTS. `eslint-plugin-sonarjs` depends on `typescript` itself, and a copy other
// than the one typescript-eslint builds the program with reads that program's type flags with the wrong constants:
// on 2026-10-21 Yarn resolved it to 6.0.3 beside the project's 5.9.3, and S4782 reported eleven `?` properties as
// also typed `undefined` when none was. The `eslint-plugin-sonarjs/typescript` resolution in `package.json` pins it
// to the project's version; move it whenever the `typescript` devDependency moves.
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { ESLint } from "eslint";
import { sonarKeyOf, sources } from "../eslint.config.mjs";

const root = path.resolve(import.meta.dirname, "..");
const targets = process.argv.slice(2);

const fromRoot = createRequire(path.join(root, "package.json"));
const typescriptOf = (entry) => realpathSync(createRequire(entry).resolve("typescript"));
const sonarTypescript = typescriptOf(fromRoot.resolve("eslint-plugin-sonarjs"));
const parserTypescript = typescriptOf(createRequire(fromRoot.resolve("typescript-eslint")).resolve("@typescript-eslint/typescript-estree"));
if (sonarTypescript !== parserTypescript) {
  console.error(`eslint-plugin-sonarjs loads ${sonarTypescript}\nbut typescript-eslint loads ${parserTypescript}`);
  console.error('Pin them to one version with the "eslint-plugin-sonarjs/typescript" resolution in package.json.');
  process.exit(2);
}

const eslint = new ESLint({ cwd: root, warnIgnored: false });
const results = await eslint.lintFiles(targets.length > 0 ? targets : sources);

function caughtStringified(message, source) {
  const name = message.ruleId === "@typescript-eslint/no-base-to-string" && message.message.match(/^'(\w+)' may use/)?.[1];
  return Boolean(name) && new RegExp(String.raw`catch\s*\(\s*${name}\b`).test(source);
}

const findings = results.flatMap((result) => {
  const source = result.source ?? readFileSync(result.filePath, "utf8");
  const lines = source.split("\n");
  return result.messages
    .filter((message) => message.fatal || (!lines[message.line - 1]?.includes("NOSONAR") && !caughtStringified(message, source)))
    .map((message) => ({
      file: path.relative(root, result.filePath),
      line: message.line,
      column: message.column,
      key: message.fatal ? "parse" : (sonarKeyOf.get(message.ruleId) ?? message.ruleId),
      rule: message.ruleId ?? "",
      text: message.message.replaceAll(/\s+/g, " ")
    }));
});

const byCodePoint = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
for (const finding of findings.toSorted((left, right) => byCodePoint(left.file, right.file) || left.line - right.line)) {
  console.log(`${finding.file}:${finding.line}:${finding.column}  ${finding.key.padEnd(6)}  ${finding.text}  [${finding.rule}]`);
}
if (findings.length > 0) {
  console.log(`\n${findings.length} Sonar finding(s), each of which the SonarCloud scan would report on the PR.`);
}
// `exitCode` rather than `process.exit`, which cuts off whatever is still buffered for a pipe.
process.exitCode = findings.length > 0 ? 1 : 0;
