#!/usr/bin/env bash
# Claude Code PostToolUse hook: after Claude edits a TypeScript file, run the Sonar rules over it (the same check
# `yarn lint:sonar` makes in CI) and hand any findings back to Claude, so a Sonar issue is fixed as it is written
# instead of turning up in the PR's SonarCloud analysis.
#
# Exit 2 with the findings on stderr is what Claude Code feeds back to the model. Anything this hook cannot check —
# a non-TypeScript file, or a checkout whose `yarn install` has not brought in ESLint yet — exits 0 and stays silent.
set -uo pipefail

cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}" || exit 0

file="$(node -e 'let s = ""; process.stdin.on("data", (c) => (s += c)).on("end", () => { try { process.stdout.write(JSON.parse(s).tool_input?.file_path ?? "") } catch {} })')"
case "$file" in
  *.ts | *.tsx | *.mts) ;;
  *) exit 0 ;;
esac
[ -f "$file" ] && [ -d node_modules/eslint-plugin-sonarjs ] || exit 0

if ! findings="$(node scripts/lint-sonar.mjs "$file" 2>&1)"; then
  printf 'Sonar rules failed on %s. Fix these before moving on (CI runs the same check through yarn lint):\n%s\n' "$file" "$findings" >&2
  exit 2
fi
