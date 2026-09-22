-- CreateTable
CREATE TABLE "security_alert_scans" (
    "organization" TEXT NOT NULL,
    "repository" TEXT NOT NULL,
    "family" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "detail" TEXT,
    "observed_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "security_alert_scans_pkey" PRIMARY KEY ("organization","repository","family")
);

-- CreateTable
CREATE TABLE "security_alerts" (
    "organization" TEXT NOT NULL,
    "repository" TEXT NOT NULL,
    "family" TEXT NOT NULL,
    "alert_number" INTEGER NOT NULL,
    "alert_type" TEXT,
    "subject" TEXT,
    "severity" TEXT,
    "path" TEXT,
    "line" INTEGER,
    "state" TEXT,
    "resolution" TEXT,
    "created_at" TIMESTAMPTZ(6),
    "resolved_at" TIMESTAMPTZ(6),
    "html_url" TEXT,

    CONSTRAINT "security_alerts_pkey" PRIMARY KEY ("organization","repository","family","alert_number")
);

-- CreateIndex
-- The estate-wide read of ONE FAMILY — every open secret-scanning alert in the organisation, which is the question
-- this feature exists to answer. The primary key cannot serve it: `family` is its third column behind `repository`,
-- so a predicate naming the organisation and the family and no repository has to scan. The per-repository read needs
-- no index of its own, because that one IS the primary key's prefix.
CREATE INDEX "security_alerts_organization_family_idx" ON "security_alerts"("organization", "family");

-- AddForeignKey
-- AN ALERT BELONGS TO A SCAN. Without this, a write could leave alerts whose repository has no scan row — alerts for
-- a repository that reads as never looked at, which is the one inconsistency that would make the absent-versus-zero
-- rule unenforceable. `ON DELETE CASCADE` is what lets the writer replace a family's alerts by replacing its scan
-- row, which is how re-running the collection changes rows instead of adding them. Declared in the schema as well as
-- here, so `prisma migrate diff` reports no drift.
ALTER TABLE "security_alerts" ADD CONSTRAINT "security_alerts_organization_repository_family_fkey" FOREIGN KEY ("organization", "repository", "family") REFERENCES "security_alert_scans"("organization", "repository", "family") ON DELETE CASCADE ON UPDATE CASCADE;

-- The rest of this file is hand-written, for the reason `20260918110000_cve_reports`' tail is: Prisma has no schema
-- expression for a CHECK constraint.
--
-- CHEAP ON PURPOSE. Migrations run on pod boot under a startup probe that allows about 155 seconds, so this creates
-- two empty tables, one index and four constraints and backfills nothing. There is no table scan in it.
--
-- NO BACKFILL, AND THE EMPTY TABLES SAY SOMETHING TRUE. Until the first `collect-alerts` runs, every repository has
-- no scan row and therefore reads UNMEASURED for all three families — which is exactly right, because nothing has
-- walked the alerts yet. There is no state in which this migration makes a repository look clean.
--
-- THE KEYS ARE NOT CASEFOLDED, unlike `cve_scans` and `repository_production`, and that is deliberate rather than an
-- omission. Those two casefold because their names are recovered from elsewhere — a Jenkins `build.git_url` spelling
-- the owner `HMCTS`, and a hand-edited approvals list. These rows are keyed by the cohort name, which comes from the
-- same organisation listing that keys `repository_state` and `org_repository`, so folding here would break the join
-- to both. The MATCHING is folded instead, where the risk actually is: `collectOrganisationAlerts` keys its map on
-- the lower-cased name and `resolveAlertScan` folds the name it looks up, because a miss there would report a
-- repository that has alerts as clean.

-- THREE STATES AND ONLY THREE. `not enabled`, `enabled and clean` and `could not be read` are the whole vocabulary,
-- and a fourth word appearing here would mean a reader had a state it has no rule for — which in this feature means
-- a refusal being rendered as something other than unmeasured. `read` with no alerts beside it is the clean case;
-- it needs no word of its own and must not get one, or two spellings of "measured" would drift apart.
ALTER TABLE "security_alert_scans"
    ADD CONSTRAINT "security_alert_scans_state_vocabulary" CHECK ("state" IN ('read', 'not-enabled', 'unmeasured'));

-- A REASON IS FOR AN ABSENCE. A `read` scan has its alerts — or has none, which is an answer and not a reason — so a
-- sentence beside it would be explaining something that needs no explaining, and a reader shown one would take the
-- measured zero for a failure.
ALTER TABLE "security_alert_scans"
    ADD CONSTRAINT "security_alert_scans_detail_only_when_absent" CHECK ("detail" IS NULL OR "state" <> 'read');

-- THE FAMILY VOCABULARY, held to the three the report contract names. `src/lib/types.ts` declares `AlertFamily` as
-- exactly these words, so a row spelled any other way is a row no page can render — including the endpoint spellings
-- `inventory/security-alerts.ts` uses for its log lines, which is the mistake this refuses.
ALTER TABLE "security_alert_scans"
    ADD CONSTRAINT "security_alert_scans_family_vocabulary" CHECK ("family" IN ('dependabot', 'code-scanning', 'secret-scanning'));

-- SEVERITY IS ONE OF FOUR WORDS OR IT IS NULL, and `unknown` is deliberately not among them — `cve_findings` carries
-- the same constraint and states the reasoning at length. NULL here is a real answer for a whole family rather than
-- an occasional gap: GitHub grades no secret-scanning alert at all, so every one of those rows is NULL by nature and
-- not by omission.
ALTER TABLE "security_alerts"
    ADD CONSTRAINT "security_alerts_severity_vocabulary" CHECK ("severity" IS NULL OR "severity" IN ('critical', 'high', 'medium', 'low'));
