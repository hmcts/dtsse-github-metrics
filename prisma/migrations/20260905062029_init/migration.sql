-- CreateTable
CREATE TABLE "repository_state" (
    "organization" TEXT NOT NULL,
    "repository" TEXT NOT NULL,
    "fetched_at" TIMESTAMPTZ(6) NOT NULL,
    "payload" JSONB NOT NULL,

    CONSTRAINT "repository_state_pkey" PRIMARY KEY ("organization","repository")
);

-- CreateTable
CREATE TABLE "source_coverage" (
    "organization" TEXT NOT NULL,
    "repository" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "query_hash" TEXT NOT NULL,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "ends_at" TIMESTAMPTZ(6) NOT NULL,
    "accessed_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "source_coverage_pkey" PRIMARY KEY ("organization","repository","source","query_hash","starts_at")
);

-- CreateTable
CREATE TABLE "pull_request_facts" (
    "organization" TEXT NOT NULL,
    "repository" TEXT NOT NULL,
    "query_hash" TEXT NOT NULL,
    "identifier" INTEGER NOT NULL,
    "merged_at" TIMESTAMPTZ(6) NOT NULL,
    "payload" JSONB NOT NULL,

    CONSTRAINT "pull_request_facts_pkey" PRIMARY KEY ("organization","repository","query_hash","identifier")
);

-- CreateTable
CREATE TABLE "direct_commit_facts" (
    "organization" TEXT NOT NULL,
    "repository" TEXT NOT NULL,
    "query_hash" TEXT NOT NULL,
    "sha" TEXT NOT NULL,
    "committed_at" TIMESTAMPTZ(6) NOT NULL,
    "payload" JSONB NOT NULL,

    CONSTRAINT "direct_commit_facts_pkey" PRIMARY KEY ("organization","repository","query_hash","sha")
);

-- CreateTable
CREATE TABLE "alert_observations" (
    "organization" TEXT NOT NULL,
    "repository" TEXT NOT NULL,
    "family" TEXT NOT NULL,
    "fetched_at" TIMESTAMPTZ(6) NOT NULL,
    "payload" JSONB NOT NULL,

    CONSTRAINT "alert_observations_pkey" PRIMARY KEY ("organization","repository","family","fetched_at")
);

-- CreateTable
CREATE TABLE "sonar_project_map" (
    "sonar_organization" TEXT NOT NULL,
    "project_key" TEXT NOT NULL,
    "repository" TEXT,
    "analysis_at" TIMESTAMPTZ(6),
    "revision" TEXT,
    "method" TEXT,
    "resolved_at" TIMESTAMPTZ(6) NOT NULL,
    "detail" TEXT,

    CONSTRAINT "sonar_project_map_pkey" PRIMARY KEY ("sonar_organization","project_key")
);

-- CreateTable
CREATE TABLE "collection_state" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "revision" BIGINT NOT NULL DEFAULT 1,
    "collected_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "collection_state_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "source_coverage_accessed_at_idx" ON "source_coverage"("accessed_at");

-- CreateIndex
CREATE INDEX "pull_request_facts_organization_repository_query_hash_merge_idx" ON "pull_request_facts"("organization", "repository", "query_hash", "merged_at");

-- CreateIndex
CREATE INDEX "direct_commit_facts_organization_repository_query_hash_comm_idx" ON "direct_commit_facts"("organization", "repository", "query_hash", "committed_at");

-- The rest of this file is hand-written: Prisma has no schema expression for a CHECK constraint, and
-- these two encode invariants the porting notes call out explicitly.

-- A coverage row records a half-open interval. A zero-width or inverted one would silently satisfy
-- "this window is covered" while carrying no evidence, so the database refuses it outright.
ALTER TABLE "source_coverage"
    ADD CONSTRAINT "source_coverage_interval_ordered" CHECK ("ends_at" > "starts_at");

-- Exactly one of `repository` / `detail` is always set. A resolved project names its repository; an
-- unresolved one carries the reason somebody paid the quota to discover. Allowing both to be null
-- would make a remembered negative indistinguishable from a row nobody has filled in yet, and the
-- next run would re-pay for it.
ALTER TABLE "sonar_project_map"
    ADD CONSTRAINT "sonar_project_map_resolved_xor_detail" CHECK (("repository" IS NULL) <> ("detail" IS NULL));

-- `collection_state` is a single row whose `revision` the report cache polls. The primary key already
-- defaults to 1; this stops a second row ever existing, so a poller cannot read one stamp while a
-- writer bumps another.
ALTER TABLE "collection_state"
    ADD CONSTRAINT "collection_state_singleton" CHECK ("id" = 1);
