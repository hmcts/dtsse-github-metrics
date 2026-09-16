-- ONE ROW PER REPOSITORY, AND A COLUMN A PERSON EDITS. The estate is seeded into this table by `collect-org`,
-- so marking a repository as a production service is an `UPDATE` against a row that is already there — found in
-- pgAdmin by its name, and ticked. Nothing about the flag has to be composed.
--
-- Hand-written rather than generated. Prisma has no schema expression for a CHECK constraint or a trigger, and
-- a generated migration for this reshaping would have dropped the old table without carrying its rows across.
CREATE TABLE "repository_production" (
    "organization" TEXT NOT NULL,
    "repository" TEXT NOT NULL,
    -- TRI-STATE, and all three states are answers a person may state:
    --
    --   true   this IS a production service, whatever the approvals list says
    --   false  this is NOT a production service, whatever the approvals list says
    --   NULL   nobody has an opinion, so `environment-approvals.yml` answers
    --
    -- `false` is the state the previous shape could not hold. An override that can only ever add leaves no way
    -- to say "the approvals list names this and it is wrong", which is a correction somebody eventually needs.
    "production" BOOLEAN,
    -- OPTIONAL, all three. Ticking a box is the interaction this table exists for, and refusing the tick until
    -- an author and a sentence are supplied is what made the previous shape a statement to compose rather than
    -- a cell to edit. A person who wants to record why still can, in `reason`.
    "marked_by" TEXT,
    -- NULLABLE WITH NO DEFAULT, so an unmarked row reads as never marked. A `CURRENT_TIMESTAMP` default would
    -- stamp every seeded row with the instant the collector inserted it, which is not when anybody decided
    -- anything — and it would leave no way to tell a seeded row from a marked one. Maintained by the trigger
    -- at the foot of this file; nothing in the application writes it.
    "marked_at" TIMESTAMPTZ(6),
    "reason" TEXT,

    CONSTRAINT "repository_production_pkey" PRIMARY KEY ("organization","repository")
);

-- ONE ROW PER REPOSITORY, which the primary key only delivers if the key is casefolded. GitHub owner and
-- repository names are case-insensitive and the live approvals list proves people write them either way — it
-- holds `HMCTS/adoption-shared-infrastructure` among 200-odd lowercase entries — so without this, `(hmcts,
-- PCS-API)` and `(hmcts, pcs-api)` are two rows for one repository, each with its own flag, and "is this
-- production" stops having an answer. The seed lowercases what it inserts and readers fold the name they look
-- up; this is what makes that fold sufficient.
ALTER TABLE "repository_production"
    ADD CONSTRAINT "repository_production_casefolded" CHECK ("organization" = lower("organization") AND "repository" = lower("repository"));

-- CARRIED ACROSS RATHER THAN DROPPED. A row in the old table WAS the mark, so every one of them becomes
-- `production = true` with its author, instant and reason intact. The old table's own casefold constraint means
-- every key it holds already satisfies the new one, and `migrate` runs each migration inside one transaction —
-- so a carry-across that failed would leave the old table where it stands rather than half a table either side.
--
-- AAT's table holds no rows, so this is exercised against a fabricated one on a scratch database and never
-- against real data. What that proves is the mapping and the constraint; it cannot prove anything about rows
-- nobody has written.
INSERT INTO "repository_production" ("organization", "repository", "production", "marked_by", "marked_at", "reason")
SELECT "organization", "repository", true, "marked_by", "marked_at", "reason"
FROM "repository_production_override";

DROP TABLE "repository_production_override";

-- WHEN THE FLAG WAS DECIDED, stamped by the database because nothing else is in a position to. There is no
-- admin UI: the write is an `UPDATE` in pgAdmin or `psql`, and asking the person making it to also type an
-- instant is the friction this reshaping removed.
--
-- `IS DISTINCT FROM` AND NOT `<>`, which is the whole of the guard. Every interesting transition here involves
-- NULL — `NULL → true` is the first mark, `true → NULL` is somebody withdrawing an opinion — and `<>` answers
-- NULL for both, so the `WHEN` clause would be false and the stamp would never happen on the two changes that
-- matter most.
--
-- FIRES ONLY WHEN THE FLAG MOVED, so this records DECISIONS and not edits. Correcting a typo in `reason` leaves
-- `marked_at` where the flag put it, which is what makes the column readable as "when was this decided".
--
-- BEFORE UPDATE ONLY, so the seed never trips it: `INSERT … ON CONFLICT DO NOTHING` performs no update, and a
-- seeded row therefore arrives with `marked_at` NULL and keeps it until a person moves the flag.
CREATE FUNCTION "repository_production_stamp"() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    NEW."marked_at" := now();
    RETURN NEW;
END;
$$;

CREATE TRIGGER "repository_production_stamp"
    BEFORE UPDATE ON "repository_production"
    FOR EACH ROW
    WHEN (NEW."production" IS DISTINCT FROM OLD."production")
    EXECUTE FUNCTION "repository_production_stamp"();
