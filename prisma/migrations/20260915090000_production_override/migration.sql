-- CreateTable
CREATE TABLE "repository_production_override" (
    "organization" TEXT NOT NULL,
    "repository" TEXT NOT NULL,
    "marked_by" TEXT NOT NULL,
    "marked_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT NOT NULL,

    CONSTRAINT "repository_production_override_pkey" PRIMARY KEY ("organization","repository")
);

-- The rest of this file is hand-written, for the reason the initial migration's tail is: Prisma has no
-- schema expression for a CHECK constraint.
--
-- No backfill and no data change anywhere else. Every repository this table would name is one somebody
-- has yet to name, and the only writer is a person — so an empty table on the day this lands says exactly
-- what is true, which is that nobody has marked anything yet. `production` is reported the same as it was
-- until the first row exists.
--
-- Nothing here is indexed beyond the primary key. The reader selects one organisation's rows, which is a
-- prefix scan of a table holding a handful of hand-written entries against an estate of 3,277
-- repositories; an index to help that would be maintained for nothing.

-- PROVENANCE IS NOT OPTIONAL. Both columns are NOT NULL already; these two refuse the blank string as
-- well, because an empty `marked_by` satisfies NOT NULL while answering nobody. Six months after a
-- repository is badged Production against an approvals list that does not name it, the only account of why
-- is this row — and a flag with no author and no reason is folklore that the next person has to either
-- trust or undo blind. The database is the cheapest place to insist, and this is the one write it can
-- insist about: there is no admin UI to validate the input, so an operator's `INSERT` reaches the table
-- directly.
ALTER TABLE "repository_production_override"
    ADD CONSTRAINT "repository_production_override_attributed" CHECK (btrim("marked_by") <> '' AND btrim("reason") <> '');

-- ONE MARK PER REPOSITORY, which the primary key only delivers if the key is casefolded. GitHub owner and
-- repository names are case-insensitive and the live approvals list proves people write them either way —
-- it holds `HMCTS/adoption-shared-infrastructure` among 200-odd lowercase entries — so without this,
-- `(hmcts, PCS-API)` and `(hmcts, pcs-api)` are two rows marking one repository, each with its own author
-- and its own reason, and "who marked this and why" stops having an answer. Readers fold the name they
-- look up; this is what makes that fold sufficient.
ALTER TABLE "repository_production_override"
    ADD CONSTRAINT "repository_production_override_casefolded" CHECK ("organization" = lower("organization") AND "repository" = lower("repository"));
