-- WHICH TEAMS ARE CIVIL SERVANT TEAMS, one row per flagged team slug. Presence is the flag: a team with no row is
-- one nobody has said is a civil servant team. Written by `metrics civil-servant-teams` and never by a collection.
--
-- Hand-written rather than generated, for `civil_servants`' reason: Prisma has no schema expression for a CHECK
-- constraint.
CREATE TABLE "civil_servant_teams" (
    "organization" TEXT NOT NULL,
    "team" TEXT NOT NULL,
    "added_by" TEXT,
    "added_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "civil_servant_teams_pkey" PRIMARY KEY ("organization","team")
);

-- ONE ROW PER TEAM, which the primary key only delivers if the key is casefolded: the report layer keys teams on
-- the folded slug.
ALTER TABLE "civil_servant_teams"
    ADD CONSTRAINT "civil_servant_teams_casefolded" CHECK ("organization" = lower("organization") AND "team" = lower("team"));
