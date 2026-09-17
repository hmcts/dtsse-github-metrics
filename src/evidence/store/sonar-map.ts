import type { SonarResolutionMethod, StoredSonarMapping } from "../domain/sonar.ts";
import { prisma } from "./prisma.ts";
import { StorageError } from "./storage-error.ts";

/**
 * The durable `project → repository` map. Ported from `metrics.storage`'s observations half.
 *
 * NEVER PRUNED, and that is the invariant this table exists inside rather than a property of this module:
 * rebuilding it costs tens of minutes of commit-search quota, so `prune` may not touch it. Asserted in
 * test/integration/prune-never-touches-durable.test.ts.
 *
 * A ROW IS EITHER AN ATTRIBUTION OR A REMEMBERED NEGATIVE, and the table's
 * `(repository IS NULL) <> (detail IS NULL)` CHECK constraint says exactly that: a row with no repository and a
 * reason is somebody having paid the quota to learn that this project cannot be attributed, and it is what
 * stops the next run paying again. THAT IS WHY `resolvedDetail` BELOW REFUSES TO WRITE NEITHER: a half-written
 * row — no repository and no reason — would be indistinguishable from a negative that has been remembered,
 * except that it would teach the next run to skip a question nobody ever answered.
 */

/** One answer to store: the attribution, or the reason there is none. */
export interface SonarMappingAnswer {
  projectKey: string;
  resolvedAt: Date;
  mapping?: StoredSonarMapping;
  detail?: string;
}

/**
 * The detail column for one answer, which is present exactly where the repository is not.
 *
 * An unresolved answer that arrived with no reason is given one rather than written as a NULL pair. The check
 * constraint would refuse the row outright, which is the right failure — but it would fail the whole run over a
 * caller's omission, and the honest fallback says as much as the caller knew.
 */
function resolvedDetail(answer: SonarMappingAnswer): string | null {
  if (answer.mapping !== undefined) {
    return null;
  }
  return answer.detail ?? "no reason was recorded for this project being unresolved";
}

/**
 * Upserts one project's answer, reporting whether the answer itself was written.
 *
 * Written per project as each one resolves rather than once at the end of a run, because the run is paced
 * against a per-minute quota and may be stopped by a rate limit or by a human at any point: every row already
 * paid for is kept.
 *
 * A REFUSED WRITE STILL MOVES `resolved_at`, WHICH IS WHY THE REFUSAL IS NOT SILENT. The skip watermark
 * `alreadyAnswered` reads is when the row was last WRITTEN, so leaving it untouched would make the run that
 * just asked the question look like it never asked: a project whose newest analysis names no findable commit
 * resolves from an older one, this write is refused as not superseding, and the next run sees that same newer
 * analysis still standing above the watermark and re-runs the whole search — every run, for ever, against the
 * scarcest quota there is. Touching the instant records "asked, and the stored answer stood", which converges.
 * The answer itself is left exactly as it was.
 */
export async function recordSonarMapping(sonarOrganization: string, answer: SonarMappingAnswer): Promise<boolean> {
  const identity = { sonarOrganization_projectKey: { sonarOrganization, projectKey: answer.projectKey } };
  try {
    const stored = await prisma.sonarProjectMap.findUnique({ where: identity, select: { analysisAt: true } });
    const incoming = answer.mapping?.analysisAt;
    if (stored !== null && !supersedes(stored.analysisAt, incoming)) {
      await prisma.sonarProjectMap.update({ where: identity, data: { resolvedAt: answer.resolvedAt } });
      return false;
    }
    const row = {
      repository: answer.mapping?.repository ?? null,
      analysisAt: answer.mapping?.analysisAt ?? null,
      revision: answer.mapping?.revision ?? null,
      method: answer.mapping?.method ?? null,
      resolvedAt: answer.resolvedAt,
      detail: resolvedDetail(answer)
    };
    await prisma.sonarProjectMap.upsert({
      where: identity,
      create: { sonarOrganization, projectKey: answer.projectKey, ...row },
      update: row
    });
    return true;
  } catch (error) {
    throw new StorageError("could not store the sonar project map", error);
  }
}

/**
 * Whether an incoming answer supersedes the analysis a stored row was resolved from.
 *
 * A STORED ROW WITH NO ANALYSIS INSTANT IS ITSELF A NEGATIVE, and anything supersedes it: a project that could
 * not be attributed last time is worth another answer whenever one is offered. What the second arm refuses is
 * the reverse — an answer carrying no analysis instant, which every negative is, cannot displace a stored
 * ATTRIBUTION. That is what keeps a project's known repository from being erased by a run that merely failed to
 * find it again, and it is why a negative arriving for an attributed project only moves the watermark.
 */
function supersedes(stored: Date | null, incoming: Date | undefined): boolean {
  if (stored === null) {
    return true;
  }
  return incoming !== undefined && incoming.getTime() > stored.getTime();
}

/** Every row of one SonarCloud organisation's map, attributions and remembered negatives alike. */
export async function storedSonarMappings(sonarOrganization: string): Promise<StoredSonarMapping[]> {
  try {
    const rows = await prisma.sonarProjectMap.findMany({ where: { sonarOrganization }, orderBy: { projectKey: "asc" } });
    return rows.map((row) => ({
      projectKey: row.projectKey,
      ...(row.repository === null ? {} : { repository: row.repository }),
      ...(row.analysisAt === null ? {} : { analysisAt: row.analysisAt }),
      ...(row.revision === null ? {} : { revision: row.revision }),
      ...(row.method === null ? {} : { method: row.method as SonarResolutionMethod }),
      resolvedAt: row.resolvedAt,
      ...(row.detail === null ? {} : { detail: row.detail })
    }));
  } catch (error) {
    throw new StorageError("could not read the sonar project map", error);
  }
}
