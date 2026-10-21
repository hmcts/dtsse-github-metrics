-- WHICH GITHUB LOGINS BELONG TO CIVIL SERVANTS, one row per flagged login. Presence is the flag: a login with no
-- row is one nobody has said anything about. Written by `metrics civil-servants` and never by a collection.
--
-- Hand-written rather than generated, for `repository_production`'s reason: Prisma has no schema expression for a
-- CHECK constraint.
CREATE TABLE "civil_servants" (
    "organization" TEXT NOT NULL,
    "login" TEXT NOT NULL,
    -- OPTIONAL, as `repository_production.marked_by` is. Refusing a row without an author is friction for a list
    -- somebody loads from a file.
    "added_by" TEXT,
    "added_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "civil_servants_pkey" PRIMARY KEY ("organization","login")
);

-- ONE ROW PER PERSON, which the primary key only delivers if the key is casefolded. GitHub logins are
-- case-insensitive, and the logins this is seeded from come from three walks that spell them as they found them.
ALTER TABLE "civil_servants"
    ADD CONSTRAINT "civil_servants_casefolded" CHECK ("organization" = lower("organization") AND "login" = lower("login"));
