-- CreateTable
CREATE TABLE "org_teams" (
    "organization" TEXT NOT NULL,
    "team_slug" TEXT NOT NULL,
    "parent_slug" TEXT,
    "payload" JSONB NOT NULL,
    "observed_at" TIMESTAMPTZ(6) NOT NULL,
    "last_observed_at" TIMESTAMPTZ(6) NOT NULL,
    "superseded_at" TIMESTAMPTZ(6),
    "digest" TEXT NOT NULL,

    CONSTRAINT "org_teams_pkey" PRIMARY KEY ("organization","team_slug","observed_at")
);

-- CreateTable
CREATE TABLE "org_team_memberships" (
    "organization" TEXT NOT NULL,
    "team_slug" TEXT NOT NULL,
    "login" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "observed_at" TIMESTAMPTZ(6) NOT NULL,
    "last_observed_at" TIMESTAMPTZ(6) NOT NULL,
    "superseded_at" TIMESTAMPTZ(6),
    "digest" TEXT NOT NULL,

    CONSTRAINT "org_team_memberships_pkey" PRIMARY KEY ("organization","team_slug","login","observed_at")
);

-- CreateTable
CREATE TABLE "org_team_repositories" (
    "organization" TEXT NOT NULL,
    "team_slug" TEXT NOT NULL,
    "repository" TEXT NOT NULL,
    "permission" TEXT NOT NULL,
    "observed_at" TIMESTAMPTZ(6) NOT NULL,
    "last_observed_at" TIMESTAMPTZ(6) NOT NULL,
    "superseded_at" TIMESTAMPTZ(6),
    "digest" TEXT NOT NULL,

    CONSTRAINT "org_team_repositories_pkey" PRIMARY KEY ("organization","team_slug","repository","observed_at")
);

-- CreateTable
CREATE TABLE "org_repositories" (
    "organization" TEXT NOT NULL,
    "repository" TEXT NOT NULL,
    "archived" BOOLEAN NOT NULL,
    "visibility" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "observed_at" TIMESTAMPTZ(6) NOT NULL,
    "last_observed_at" TIMESTAMPTZ(6) NOT NULL,
    "superseded_at" TIMESTAMPTZ(6),
    "digest" TEXT NOT NULL,

    CONSTRAINT "org_repositories_pkey" PRIMARY KEY ("organization","repository","observed_at")
);

-- CreateTable
CREATE TABLE "org_people" (
    "organization" TEXT NOT NULL,
    "login" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "observed_at" TIMESTAMPTZ(6) NOT NULL,
    "last_observed_at" TIMESTAMPTZ(6) NOT NULL,
    "superseded_at" TIMESTAMPTZ(6),
    "digest" TEXT NOT NULL,

    CONSTRAINT "org_people_pkey" PRIMARY KEY ("organization","login","observed_at")
);

-- CreateTable
CREATE TABLE "repository_ownership" (
    "organization" TEXT NOT NULL,
    "repository" TEXT NOT NULL,
    "owner_kind" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "rung" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "observed_at" TIMESTAMPTZ(6) NOT NULL,
    "last_observed_at" TIMESTAMPTZ(6) NOT NULL,
    "superseded_at" TIMESTAMPTZ(6),
    "digest" TEXT NOT NULL,

    CONSTRAINT "repository_ownership_pkey" PRIMARY KEY ("organization","repository","owner_kind","owner","observed_at")
);

-- CreateIndex
CREATE INDEX "org_teams_organization_superseded_at_idx" ON "org_teams"("organization", "superseded_at");

-- CreateIndex
CREATE INDEX "org_team_memberships_organization_login_superseded_at_idx" ON "org_team_memberships"("organization", "login", "superseded_at");

-- CreateIndex
CREATE INDEX "org_team_repositories_organization_repository_superseded_at_idx" ON "org_team_repositories"("organization", "repository", "superseded_at");

-- CreateIndex
CREATE INDEX "org_repositories_organization_superseded_at_idx" ON "org_repositories"("organization", "superseded_at");

-- CreateIndex
CREATE INDEX "org_people_organization_superseded_at_idx" ON "org_people"("organization", "superseded_at");

-- CreateIndex
CREATE INDEX "repository_ownership_organization_rung_superseded_at_idx" ON "repository_ownership"("organization", "rung", "superseded_at");

-- The rest of this file is hand-written, for the same reason the initial migration's tail is: Prisma has
-- no schema expression for a CHECK constraint, and none at all for a PARTIAL UNIQUE INDEX. All three
-- kinds below encode invariants the change-versioned tables are read through, so leaving them to the
-- writer's good behaviour would mean every reader carrying the doubt instead.

-- Each row spans `[observed_at, superseded_at)`, and the same rule the coverage table lives under applies
-- here: a row superseded AT OR BEFORE the instant it was first observed satisfies "this was once true"
-- while describing no span of time at all. A reader asking who was in a team last June would skip it
-- silently, and a reader counting intervals would count it. The database refuses it outright instead.
ALTER TABLE "org_teams"
    ADD CONSTRAINT "org_teams_interval_ordered" CHECK ("superseded_at" IS NULL OR "superseded_at" > "observed_at");

ALTER TABLE "org_team_memberships"
    ADD CONSTRAINT "org_team_memberships_interval_ordered" CHECK ("superseded_at" IS NULL OR "superseded_at" > "observed_at");

ALTER TABLE "org_team_repositories"
    ADD CONSTRAINT "org_team_repositories_interval_ordered" CHECK ("superseded_at" IS NULL OR "superseded_at" > "observed_at");

ALTER TABLE "org_repositories"
    ADD CONSTRAINT "org_repositories_interval_ordered" CHECK ("superseded_at" IS NULL OR "superseded_at" > "observed_at");

ALTER TABLE "org_people"
    ADD CONSTRAINT "org_people_interval_ordered" CHECK ("superseded_at" IS NULL OR "superseded_at" > "observed_at");

ALTER TABLE "repository_ownership"
    ADD CONSTRAINT "repository_ownership_interval_ordered" CHECK ("superseded_at" IS NULL OR "superseded_at" > "observed_at");

-- AT MOST ONE LIVE ROW PER KEY. This is the guarantee that lets every read be `WHERE superseded_at IS
-- NULL` with no ordering, no `DISTINCT ON` and no tie-break, and lets a writer close-then-insert without
-- first checking what it is about to duplicate.
--
-- Without it, a writer that crashed between the insert and the close — or two collections of the same
-- organisation overlapping — leaves two rows both claiming to be current. That does not read as a
-- database inconsistency to anybody looking at the dashboard; it reads as a person being in one team
-- twice at two different roles, or a repository with the same owner attributed twice at different rungs.
-- Postgres can state the invariant in one line, so it does.
CREATE UNIQUE INDEX "org_teams_live" ON "org_teams" ("organization", "team_slug") WHERE "superseded_at" IS NULL;

CREATE UNIQUE INDEX "org_team_memberships_live" ON "org_team_memberships" ("organization", "team_slug", "login") WHERE "superseded_at" IS NULL;

CREATE UNIQUE INDEX "org_team_repositories_live" ON "org_team_repositories" ("organization", "team_slug", "repository") WHERE "superseded_at" IS NULL;

CREATE UNIQUE INDEX "org_repositories_live" ON "org_repositories" ("organization", "repository") WHERE "superseded_at" IS NULL;

CREATE UNIQUE INDEX "org_people_live" ON "org_people" ("organization", "login") WHERE "superseded_at" IS NULL;

CREATE UNIQUE INDEX "repository_ownership_live" ON "repository_ownership" ("organization", "repository", "owner_kind", "owner") WHERE "superseded_at" IS NULL;

-- A remembered negative may not name an owner, and an owner may not be blank. `owner_kind = 'none'` means
-- the ladder was walked and every rung declined; it is an ANSWER, and the empty `owner` is what makes it
-- one. Allowing a `none` row to carry a handle, or a `team` row to carry an empty one, makes "the ladder
-- found nothing" indistinguishable from a row somebody half-wrote — and since an unattributed repository
-- is exactly what the next run re-walks every rung for, the cost of the confusion is paid again weekly.
ALTER TABLE "repository_ownership"
    ADD CONSTRAINT "repository_ownership_none_xor_owner" CHECK (("owner_kind" = 'none') = ("owner" = ''));
