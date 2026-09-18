-- CreateTable
CREATE TABLE "cve_scans" (
    "organization" TEXT NOT NULL,
    "repository" TEXT NOT NULL,
    "codebase_type" TEXT NOT NULL,
    "source_database" TEXT NOT NULL,
    "reported_at" TIMESTAMPTZ(6) NOT NULL,
    "build_tag" TEXT,
    "collected_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "cve_scans_pkey" PRIMARY KEY ("organization","repository","codebase_type")
);

-- CreateTable
CREATE TABLE "cve_findings" (
    "organization" TEXT NOT NULL,
    "repository" TEXT NOT NULL,
    "codebase_type" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "package" TEXT NOT NULL,
    "suppressed" BOOLEAN NOT NULL,
    "severity" TEXT,
    "score" DOUBLE PRECISION,

    CONSTRAINT "cve_findings_pkey" PRIMARY KEY ("organization","repository","codebase_type","identifier","package","suppressed")
);

-- CreateIndex
-- The watermark read: `MAX(reported_at)` per database, which is how the next run knows where to start.
CREATE INDEX "cve_scans_source_database_reported_at_idx" ON "cve_scans"("source_database", "reported_at");

-- CreateIndex
-- The estate read groups every finding by repository, severity and suppressed-ness in one statement. The
-- primary key already leads with these two columns, so this index is for the counting read that does NOT
-- narrow by `codebase_type` — it is the whole repository's position that a row reports, not one language's.
CREATE INDEX "cve_findings_organization_repository_idx" ON "cve_findings"("organization", "repository");

-- The rest of this file is hand-written, for the reason `20260915090000_production_override`'s tail is:
-- Prisma has no schema expression for a CHECK constraint.
--
-- NO BACKFILL, AND THE EMPTY TABLES SAY SOMETHING TRUE. Until the first collection runs, every repository
-- reads UNMEASURED — which is exactly right, because nothing has read the reports yet. There is no state in
-- which this migration makes a repository look clean.

-- CASEFOLDED KEYS. The only name available for a published report is parsed out of `build.git_url`, and
-- every one of the 158,641 `master` documents in the `jenkins` database spells the owner `HMCTS` while the
-- organisation graph spells it `hmcts`. Without this, `(HMCTS, pcs-api)` and `(hmcts, pcs-api)` are two
-- rows answering for one repository and a report row would find neither reliably. Readers fold the name
-- they look up; these constraints are what make that fold sufficient.
ALTER TABLE "cve_scans"
    ADD CONSTRAINT "cve_scans_casefolded" CHECK ("organization" = lower("organization") AND "repository" = lower("repository"));

ALTER TABLE "cve_findings"
    ADD CONSTRAINT "cve_findings_casefolded" CHECK ("organization" = lower("organization") AND "repository" = lower("repository"));

-- SEVERITY IS ONE OF FOUR WORDS OR IT IS NULL, and `unknown` is deliberately NOT among them. A finding
-- whose report stated no severity is NULL here; `unknown` is a counting bucket in the report layer and must
-- never become a stored value, or a later reader cannot tell "the report said nothing" from "the report
-- said a word we did not recognise" — and both would then be one step from being read as `low`.
ALTER TABLE "cve_findings"
    ADD CONSTRAINT "cve_findings_severity_vocabulary" CHECK ("severity" IS NULL OR "severity" IN ('critical', 'high', 'medium', 'low'));

-- AddForeignKey
-- A FINDING BELONGS TO A SCAN. Without this, a write could leave findings with no scan row — counts for a
-- repository that reads as never scanned, which is the one inconsistency that would make the
-- absent-versus-zero rule unenforceable. `ON DELETE CASCADE` is what lets the writer replace a repository's
-- findings by replacing its scan row. Declared in the schema rather than only here, so `prisma migrate diff`
-- reports no drift.
ALTER TABLE "cve_findings"
    ADD CONSTRAINT "cve_findings_organization_repository_codebase_type_fkey"
    FOREIGN KEY ("organization", "repository", "codebase_type")
    REFERENCES "cve_scans" ("organization", "repository", "codebase_type")
    ON DELETE CASCADE ON UPDATE CASCADE;
