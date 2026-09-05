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
 * Facts are deleted by absence of coverage rather than by their own age: a fact is reachable only through
 * the coverage series that collected it, so once the series is gone the rows are unreadable whatever their
 * dates say.
 */
export async function pruneCache(unusedSince: Date): Promise<number> {
  try {
    return await prisma.$transaction(async (tx) => {
      const { count } = await tx.sourceCoverage.deleteMany({ where: { accessedAt: { lt: unusedSince } } });

      // Prisma has no cross-table `NOT EXISTS` in its query API, and expressing this as a read-then-delete
      // would race a concurrent collection writing new facts. Raw SQL, with no interpolated values.
      await tx.$executeRaw`
        DELETE FROM pull_request_facts f
        WHERE NOT EXISTS (
          SELECT 1 FROM source_coverage c
          WHERE c.organization = f.organization AND c.repository = f.repository AND c.query_hash = f.query_hash
        )
      `;
      await tx.$executeRaw`
        DELETE FROM direct_commit_facts f
        WHERE NOT EXISTS (
          SELECT 1 FROM source_coverage c
          WHERE c.organization = f.organization AND c.repository = f.repository AND c.query_hash = f.query_hash
        )
      `;
      return count;
    });
  } catch (error) {
    throw new StorageError("could not update collection cache", error);
  }
}
