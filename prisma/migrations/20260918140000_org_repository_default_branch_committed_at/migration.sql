-- AlterTable
ALTER TABLE "org_repositories" ADD COLUMN     "default_branch_committed_at" TIMESTAMPTZ(6);

-- The rest of this file is hand-written.
--
-- A SECOND DATE BESIDE `pushed_at` RATHER THAN A CHANGE OF MEANING TO IT. `pushed_at` is GitHub's `pushedAt`,
-- which moves on a push to ANY ref: measured on `hmcts/pip-account-management`, 66 branches, `pushedAt`
-- 2026-09-18 against a `master` tip of 2026-08-26. This column is the tip of the default branch, which is what
-- the repositories list's date column means. The cohort's collection window and the `maintained` criterion both
-- still read `pushed_at`, deliberately — a repository with live pull requests and a stale default branch is
-- precisely the one whose merge evidence this tool measures.
--
-- No backfill, for `pushed_at`'s own reason: the value is only knowable from GitHub and the collector is the
-- only thing that talks to GitHub, so every existing row carries NULL until the next `collect-org` run. NULL is
-- rendered as the unmeasured dash rather than as a date, so the column reads as unknown between this migration
-- and that run — it never reads as "pushed today".
--
-- Deliberately NOT indexed, again for `pushed_at`'s reason: nothing filters or orders on it in SQL. The
-- repositories list sorts on it in the browser, having already read the organisation's live rows.
