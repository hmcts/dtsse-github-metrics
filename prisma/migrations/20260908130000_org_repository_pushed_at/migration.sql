-- AlterTable
ALTER TABLE "org_repositories" ADD COLUMN     "pushed_at" TIMESTAMPTZ(6);

-- The rest of this file is hand-written.
--
-- No backfill, and that is the honest answer rather than a missing step. `pushed_at` is only knowable from
-- GitHub, and the collector is the only thing that talks to GitHub — so every existing row carries NULL until
-- the next `collect-org` run fills it in. The cohort's activity window treats NULL as "not known to be
-- active", so between this migration and that run the window selects nothing rather than silently selecting
-- everything: an empty cohort is a visible failure and a full one is not.
--
-- Deliberately NOT added to any index. The window filters a single organisation's live rows, which is one
-- already-indexed read of a few thousand rows reduced in memory; an index on a column that changes on every
-- push would be maintained constantly to save a scan nobody is waiting on.
