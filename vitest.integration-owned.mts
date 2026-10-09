/**
 * The modules that talk to Postgres, covered against a real database by `vitest.integration.config.mts` and
 * excluded from the unit run by `vitest.config.mts`. One list so each file is held at 100% by exactly one suite:
 * a file named in one config and not the other would be measured by neither, or fail the unit gate.
 */
export const INTEGRATION_OWNED = [
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
];
