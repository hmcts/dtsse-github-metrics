import type { MergeGateReport } from "../domain/merge-gate.ts";
import type { SecurityAlertEvidence } from "../domain/security-alerts.ts";
import { prisma } from "./prisma.ts";
import { StorageError } from "./storage-error.ts";

/**
 * The last observed state of one repository. Ported from `metrics.storage`'s repository-state half.
 *
 * CURRENT STATE, not windowed evidence: a merge gate, an alert count and a production flag describe the
 * repository as it stands, and a collection REPLACES the row rather than appending to it. The windowed facts
 * live in their own tables, keyed by coverage.
 */

/** What one collection observed about a repository outside any window. */
export interface RepositoryStatePayload {
  defaultBranch: string;
  fetchedAt: Date;
  mergeGate: MergeGateReport;
  securityAlerts: SecurityAlertEvidence;
  /** Tri-state: absent means the production list could not be read, which is not the same as `false`. */
  deploysToProduction?: boolean;
}

/** Records what a collection observed, replacing whatever the last one recorded. */
export async function recordRepositoryState(organization: string, repository: string, payload: RepositoryStatePayload): Promise<void> {
  try {
    const stored = JSON.parse(JSON.stringify(payload)) as object;
    await prisma.repositoryState.upsert({
      where: { organization_repository: { organization, repository } },
      create: { organization, repository, fetchedAt: payload.fetchedAt, payload: stored },
      update: { fetchedAt: payload.fetchedAt, payload: stored }
    });
  } catch (error) {
    throw new StorageError("could not update collection cache", error);
  }
}

/** The stored state of one repository, or `undefined` when nothing has been collected for it. */
export async function storedRepositoryState(organization: string, repository: string): Promise<{ fetchedAt: Date; payload: unknown } | undefined> {
  try {
    const row = await prisma.repositoryState.findUnique({ where: { organization_repository: { organization, repository } } });
    return row === null ? undefined : { fetchedAt: row.fetchedAt, payload: row.payload };
  } catch (error) {
    throw new StorageError("could not read collection cache", error);
  }
}
