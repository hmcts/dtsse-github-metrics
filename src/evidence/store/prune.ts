import { prisma } from "./prisma.ts";
import { StorageError } from "./storage-error.ts";

/**
 * Deleting cache rows nothing reads any more, ported from `metrics.storage.prune_cache`.
 *
 * THE FOUR TABLES NAMED HERE ARE THE WHOLE OF WHAT `prune` MAY TOUCH. `alert_observations` holds a history
 * GitHub cannot be asked for again — it serves only the present, so an alert closed since the last run is
 * unrecoverable — and `sonar_project_map` holds answers costing tens of minutes of quota-paced search
 * calls, including the remembered negatives that stop the next run re-paying. Upstream kept them in a
 * separate SQLite file and `prune` simply never opened it; one Postgres database has no such boundary, so
 * the invariant lives here and in test/integration/prune-never-touches-durable.test.ts.
 *
 * Facts are deleted by the age of the coverage series that collected them rather than by their own dates:
 * a fact's dates say when a merge happened, not whether anything still reads it.
 *
 * A FACT WITH NO COVERAGE ROW AT ALL IS NOT AN ORPHAN, and that distinction is the whole of the predicate
 * below. `fillCachedSource` caches the mutable edge with `complete: false`, which stores the facts for reuse
 * while deliberately NOT claiming the interval — so an uncovered fact is the normal product of every run's
 * trailing days. Deleting facts by mere absence of coverage deleted exactly those. It was usually masked,
 * because the stable half of the same series carries a coverage row and the anti-join was not
 * interval-scoped; it was not masked when the whole requested window is the mutable edge — a short `--days`,
 * or a newly added repository — where the run's own facts were deleted moments after being cached.
 *
 * So a fact goes only when its series is BOTH present and entirely stale: every interval under
 * `(organization, repository, query_hash)` sits before the cut-off, which is exactly the case where the
 * coverage delete below leaves nothing behind for a report to read them through.
 */
export async function pruneCache(unusedSince: Date): Promise<number> {
  try {
    return await prisma.$transaction(async (tx) => {
      // FACTS FIRST, while the coverage rows that decide their fate are still here to be read: the predicate
      // asks whether a series survives the cut-off, which a deleted series can no longer answer.
      //
      // Raw SQL because Prisma's query API has no cross-table `EXISTS`. That is NOT what makes this safe
      // against a concurrent collection, as the comment here used to claim — the non-atomicity was on the
      // WRITER's side, and no single statement here could have fixed it. Two changes do: facts and their
      // coverage row now commit in one transaction (see `facts.ts`), and `prune` runs under the collector
      // lock, so it cannot overlap a collection at all. The cut-off is the only bound value; the structure
      // is written literally, never assembled as a nested `Prisma.Sql` — see the note in `facts.ts` about
      // what an interpolated fragment silently became.
      await tx.$executeRaw`
        DELETE FROM pull_request_facts f
        WHERE EXISTS (
          SELECT 1 FROM source_coverage c
          WHERE c.organization = f.organization AND c.repository = f.repository AND c.query_hash = f.query_hash
        )
        AND NOT EXISTS (
          SELECT 1 FROM source_coverage c
          WHERE c.organization = f.organization AND c.repository = f.repository AND c.query_hash = f.query_hash
            AND c.accessed_at >= ${unusedSince}
        )
      `;
      await tx.$executeRaw`
        DELETE FROM direct_commit_facts f
        WHERE EXISTS (
          SELECT 1 FROM source_coverage c
          WHERE c.organization = f.organization AND c.repository = f.repository AND c.query_hash = f.query_hash
        )
        AND NOT EXISTS (
          SELECT 1 FROM source_coverage c
          WHERE c.organization = f.organization AND c.repository = f.repository AND c.query_hash = f.query_hash
            AND c.accessed_at >= ${unusedSince}
        )
      `;
      const { count } = await tx.sourceCoverage.deleteMany({ where: { accessedAt: { lt: unusedSince } } });
      return count;
    });
  } catch (error) {
    throw new StorageError("could not update collection cache", error);
  }
}
