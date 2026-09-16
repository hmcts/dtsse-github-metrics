-- Drops the six secondary indexes on the org-graph tables that no query can be made to choose.
--
-- A NEW MIGRATION AND NOT AN EDIT to `20260916120000_org_graph`. An applied migration's checksum is part of
-- the `_prisma_migrations` row Prisma verifies on every deploy, so editing one that has already run makes
-- `migrate deploy` refuse to start against the deployed database. What the schema is is stated by the
-- sequence, not by any one file in it.
--
-- Every query against these six tables is `WHERE organization = ? AND superseded_at IS NULL`, either from a
-- reader in `store/org-graph.ts` or from the `UPDATE … FROM unnest(…)` that `stampByKey` builds, which joins
-- on the table's own key columns. That leaves the six in two groups:
--
-- STRICTLY DOMINATED by the corresponding `_live` partial unique — `org_teams`, `org_repositories` and
-- `org_people`. Each of these was `(organization, superseded_at)`, and each table already carries a
-- `UNIQUE (organization, <key>) WHERE superseded_at IS NULL`. The partial index leads on `organization`, and
-- its predicate IS the other half of the query's, so it answers everything the dropped index could and is
-- smaller: it holds only the live rows, where the dropped one held every row of the history too.
--
-- SERVING AN ACCESS PATH THAT DOES NOT EXIST — `org_team_memberships` on `(organization, login,
-- superseded_at)`, `org_team_repositories` on `(organization, repository, superseded_at)` and
-- `repository_ownership` on `(organization, rung, superseded_at)`. Each was built for a question ("which
-- teams is this person in", "which teams reach this repository", "count the attributions by rung") that
-- nothing asks: no query filters any of these tables by a login, a bare repository or a rung, and the
-- reconcile path joins on the full key, which the `_live` unique covers.
--
-- THE COST IS ON THE WRITE. An index is maintained on every insert, so each of these charged one index tuple
-- per row written on all six reconciles, plus its share of the page cache, to answer nothing. Dropping them
-- cannot slow a read that was never using them.
--
-- The `_live` partial uniques and the CHECK constraints are untouched: those are invariants the readers are
-- written against, not access paths.

-- DropIndex
DROP INDEX "org_teams_organization_superseded_at_idx";

-- DropIndex
DROP INDEX "org_team_memberships_organization_login_superseded_at_idx";

-- DropIndex
DROP INDEX "org_team_repositories_organization_repository_superseded_at_idx";

-- DropIndex
DROP INDEX "org_repositories_organization_superseded_at_idx";

-- DropIndex
DROP INDEX "org_people_organization_superseded_at_idx";

-- DropIndex
DROP INDEX "repository_ownership_organization_rung_superseded_at_idx";
