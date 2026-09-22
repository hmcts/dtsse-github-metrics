-- A FREE-TEXT NOTE A PERSON LEAVES AGAINST A REPOSITORY, and the first table in this database that the WEB
-- process writes to. Every other table is written by `collect` and read by the pages; this one is written by a
-- reader who is signed in, which is why the constraints below are stated in the database rather than left to the
-- one caller that exists today. Hand-written for that reason: Prisma has no schema expression for a CHECK.
--
-- WHAT THIS TABLE HOLDS THAT NOTHING ELSE CAN. Every figure the dashboard reports is derived from GitHub, Sonar
-- or the CVE containers, so a re-collection reproduces it. A note is the opposite — "this is being
-- decommissioned", "the suppressions are tracked in HDPI-8150" — context that exists nowhere else and that
-- nothing can recover. It is therefore DURABLE in the sense `prune` uses: see the invariant at the head of
-- `prisma/schema.prisma` and test/integration/prune-never-touches-durable.test.ts.
CREATE TABLE "repository_notes" (
    -- A UUID RATHER THAN A SEQUENCE, because this identifier is the one value that travels to the browser and
    -- back: the edit and delete controls submit it in a form. A serial would publish how many notes the estate
    -- holds and let a caller walk them by arithmetic; `gen_random_uuid()` is in core Postgres from 13 and the
    -- deployed server is 16, so this needs no extension.
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization" TEXT NOT NULL,
    "repository" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    -- WHO, AS TWO COLUMNS AND NOT ONE. `author_subject` is the Entra subject claim, which identifies a person
    -- for ever; `author_name` is what they were called when they wrote the note, which is what a reader sees.
    -- A display name changes — people marry, and a tenant re-syncs — and a note attributed to a name alone
    -- would silently change hands, while a subject alone is a GUID nobody recognises. Storing both means the
    -- record of WHO survives a rename even though the page still reads naturally.
    --
    -- NOT NULL, both. Where `AUTH_DISABLED=true` there is no session and the author is recorded as anonymous —
    -- a stated value, not a blank — so there is no note without an author. See `ANONYMOUS_AUTHOR` in
    -- `src/auth/author.ts`.
    "author_subject" TEXT NOT NULL,
    "author_name" TEXT NOT NULL,
    -- BOTH STAMPED BY THE DATABASE, so the two instants come off one clock. `created_at` is set by this default
    -- and never written again; `updated_at` starts equal to it and is moved by the trigger at the foot of this
    -- file. Nothing in the application sends either value, which is what makes "the author and `created_at` are
    -- preserved on edit" structural rather than a rule the editing statement has to remember.
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "repository_notes_pkey" PRIMARY KEY ("id")
);

-- THE BODY IS NEITHER BLANK NOR UNBOUNDED, which are the two ways a text column reachable by anybody with a
-- session goes wrong. A blank note is a row that says nothing and cannot be told from a mis-click; an unbounded
-- one is the abuse this table would otherwise invite, since the web process will insert whatever a form posts.
--
-- 4000 CHARACTERS is the cap, and it is a deliberate choice rather than a limit of anything. A note is a
-- paragraph or two of context — the examples this table was asked for are one sentence each — so 4000 leaves
-- room for a list of ticket references and a short explanation while keeping the column's worst case at roughly
-- 16 kB of UTF-8. It is stated TWICE ON PURPOSE: here, because this is the boundary that holds against a caller
-- nobody has written yet, and in `NOTE_BODY_LIMIT` in `src/lib/notes.ts`, which is what lets the form refuse a
-- long note with a message instead of a database error. The two must be changed together; the unit suite
-- asserts the constant and this constraint carries the same number.
--
-- `char_length` AND NOT `octet_length`, so the limit a reader is told is the limit they meet: the form counts
-- characters, and a cap on bytes would refuse a note of 1,400 emoji while accepting 4,000 letters.
ALTER TABLE "repository_notes"
    ADD CONSTRAINT "repository_notes_body_stated" CHECK (btrim("body") <> '' AND char_length("body") <= 4000);

-- THE AUTHOR IS NAMED. Both columns are NOT NULL already; these refuse the blank string as well, which NOT NULL
-- satisfies while answering nobody. The anonymous case is a VALUE — see the column comments — so there is no
-- legitimate write this refuses.
ALTER TABLE "repository_notes"
    ADD CONSTRAINT "repository_notes_attributed" CHECK (btrim("author_subject") <> '' AND btrim("author_name") <> '');

-- CASEFOLDED, the same constraint `repository_production` carries and for the same reason. GitHub owner and
-- repository names are case-insensitive and people write them either way, so without this a note left on
-- `(hmcts, PCS-API)` would be invisible on the page for `(hmcts, pcs-api)` — present in the table, absent from
-- the only place it is read. The store folds what it writes and what it looks up; this is what makes that fold
-- sufficient rather than a habit.
ALTER TABLE "repository_notes"
    ADD CONSTRAINT "repository_notes_casefolded" CHECK ("organization" = lower("organization") AND "repository" = lower("repository"));

-- THE ONE READ THIS TABLE SERVES, indexed as it is made: one repository's notes, oldest first. The primary key
-- is a UUID and answers nothing about a repository, so without this every page render is a sequential scan.
-- `created_at` is in the index rather than left to a sort because it IS the stated order — the list reads as a
-- log — so the index returns the rows in the order the page prints them.
--
-- NAMED AS PRISMA WOULD NAME IT, which is what keeps `migrate diff` against this schema empty. A hand-chosen
-- name here reads better and costs a permanent one-line drift, which is the thing that makes a real drift hard
-- to spot.
CREATE INDEX "repository_notes_organization_repository_created_at_idx" ON "repository_notes" ("organization", "repository", "created_at");

-- WHEN THE BODY LAST MOVED, stamped here so the application cannot back-date an edit. `created_at` is untouched
-- by this, which is the half of the acceptance that says who wrote a note stays on the record.
--
-- UNCONDITIONAL, unlike `repository_production_stamp`'s `WHEN` clause. That trigger guards on the flag having
-- actually changed because it records a DECISION and a corrected typo is not one. Here the only update is an
-- edit of the body, and a reader who re-saves the same words has still touched the note — so there is no second
-- column whose change should leave the instant standing.
CREATE FUNCTION "repository_notes_stamp"() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    NEW."updated_at" := now();
    RETURN NEW;
END;
$$;

CREATE TRIGGER "repository_notes_stamp"
    BEFORE UPDATE ON "repository_notes"
    FOR EACH ROW
    EXECUTE FUNCTION "repository_notes_stamp"();
