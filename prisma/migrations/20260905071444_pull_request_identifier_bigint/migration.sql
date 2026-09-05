/*
  Warnings:

  - The primary key for the `pull_request_facts` table will be changed. If it partially fails, the table could be left without primary key constraint.

*/
-- AlterTable
ALTER TABLE "pull_request_facts" DROP CONSTRAINT "pull_request_facts_pkey",
ALTER COLUMN "identifier" SET DATA TYPE BIGINT,
ADD CONSTRAINT "pull_request_facts_pkey" PRIMARY KEY ("organization", "repository", "query_hash", "identifier");
