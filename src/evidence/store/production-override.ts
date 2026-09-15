import { prisma } from "./prisma.ts";
import { StorageError } from "./storage-error.ts";

/**
 * Repositories somebody has marked as production services BY HAND.
 *
 * The organisation states production approval in one document — `environment-approvals.yml` in
 * `cnp-jenkins-config`, read by `inventory/production.ts` — and that document is the pipeline's, not this
 * dashboard's. Some services deploy to production without appearing in it, and until now there was nothing
 * to say so: a `Production` badge could only come from a list this project does not own.
 *
 * A ROW HERE IS THE MARK. There is no boolean column and no negative override, because `false` is not a
 * thing a person needs to state: the approvals list already says `false` for every repository it was read
 * and does not name, and the one answer nobody may state is the tri-state's third — see
 * `reportedProduction` below.
 *
 * THE IMPORT CANNOT OVERWRITE IT, which is why this is a table and not a field in
 * `repository_state.payload`. A collection replaces that payload wholesale on every run, so a mark stored
 * there would survive exactly until the next `collect` walked the repository. Nothing the collector writes
 * reaches this table.
 *
 * `prune` may not touch it either, for a reason unlike the one the other durable tables have. Theirs is
 * that GitHub serves only the present; this table's is that GitHub was never asked at all — the fact came
 * from a person, and a deleted row is recoverable only from that person's memory.
 *
 * THERE IS NO ADMIN UI AND NONE IS PLANNED, so the way a mark is made today is one statement in `psql`
 * against the deployed database. It is written here rather than only in the pull request that added the
 * table, because a statement documented where nobody looks is a statement that stops working silently:
 *
 * ```sql
 * INSERT INTO repository_production_override (organization, repository, marked_by, reason)
 * VALUES (lower('hmcts'), lower('pcs-api'), 'somebody@hmcts.net', 'deploys to production through …')
 * ON CONFLICT (organization, repository) DO UPDATE
 *   SET marked_by = EXCLUDED.marked_by, reason = EXCLUDED.reason, marked_at = now();
 * ```
 *
 * `lower()` on both keys, so a name typed in any case satisfies the casefold constraint rather than being
 * refused by it; `marked_at` omitted, so the column default stamps it; `ON CONFLICT`, so correcting a mark
 * is not an error. Reversing one is `DELETE FROM repository_production_override WHERE organization =
 * 'hmcts' AND repository = 'pcs-api';`, and it takes the reason with it.
 *
 * A mark is not visible the instant it is written. Built reports are held per `collection_state.revision`
 * and invalidated by nothing else, so a badge appears when the next collection bumps that revision —
 * within a day — or immediately after `UPDATE collection_state SET revision = revision + 1 WHERE id = 1;`,
 * which is the same statement `stampRevision` makes and is safe to make by hand.
 */

/** One hand-written mark, as an operator or a caller states it. */
export interface ProductionMark {
  organization: string;
  repository: string;
  /** Who is stating this — an email, or whatever identifies them to their colleagues. */
  markedBy: string;
  /** Why this repository is a production service though the approvals list does not name it. */
  reason: string;
  /** When it was stated. Defaults to now, which is the only honest answer for a mark being made. */
  markedAt?: Date;
}

/**
 * The casefolded names of one organisation's marked repositories.
 *
 * A `Set` and not the rows: no report reads `marked_by` or `reason`, and lifting them into the report layer
 * would put a person's name on a page nobody asked to publish it on. Both are there to be read in `psql` by
 * whoever is asking why a repository carries the badge.
 *
 * CASEFOLDED, matching `inventory/production.ts`: the stored keys are lowercase already, held so by a CHECK
 * constraint, and `reportedProduction` folds the name it looks up. GitHub owner and repository names are
 * case-insensitive, so the fold is a correction rather than a convenience — an operator typing `PCS-API`
 * means the same repository the graph calls `pcs-api`.
 */
export async function productionOverrides(organization: string): Promise<Set<string>> {
  try {
    const rows = await prisma.productionOverride.findMany({
      where: { organization: organization.toLowerCase() },
      select: { repository: true }
    });
    return new Set(rows.map((row) => row.repository));
  } catch (error) {
    throw new StorageError("could not read the production overrides", error);
  }
}

/**
 * Marks one repository as a production service, replacing any mark already made for it.
 *
 * Casefolds both keys rather than trusting the caller, so the `_casefolded` CHECK constraint is left
 * guarding the one writer that cannot be made to behave — an operator's `INSERT` in `psql`.
 *
 * ONE STATEMENT. Prisma compiles an upsert on the primary key to a single `INSERT … ON CONFLICT DO UPDATE`
 * and takes no interactive transaction, which matters because nothing in this project sets
 * `transactionOptions` and Prisma's default interactive-transaction timeout is five seconds.
 *
 * Re-marking overwrites the provenance rather than appending to it. This is a flag and not a history: what
 * a reader needs is who stands behind the mark NOW, and a second row for the same repository is the exact
 * ambiguity the casefolded key exists to refuse.
 */
export async function markProductionOverride(mark: ProductionMark): Promise<void> {
  const key = { organization: mark.organization.toLowerCase(), repository: mark.repository.toLowerCase() };
  const stated = { markedBy: mark.markedBy, reason: mark.reason, markedAt: mark.markedAt ?? new Date() };
  try {
    await prisma.productionOverride.upsert({
      where: { organization_repository: key },
      create: { ...key, ...stated },
      update: stated
    });
  } catch (error) {
    throw new StorageError("could not update the production overrides", error);
  }
}

/**
 * Removes one repository's mark, reporting whether there was one to remove.
 *
 * `deleteMany` rather than `delete`, so clearing a mark that is not there is not an error: an operator
 * undoing something they are not sure happened should be told it had not, and the reported `false` says so
 * without a stack trace.
 *
 * Removing a mark DISCARDS ITS PROVENANCE — the reason and the author go with the row. That is the honest
 * shape for a flag with no history: what a reader needs is the current answer, and keeping a tombstone
 * would mean every read filtering for one.
 */
export async function clearProductionOverride(organization: string, repository: string): Promise<boolean> {
  try {
    const { count } = await prisma.productionOverride.deleteMany({
      where: { organization: organization.toLowerCase(), repository: repository.toLowerCase() }
    });
    return count > 0;
  } catch (error) {
    throw new StorageError("could not update the production overrides", error);
  }
}

/**
 * What a repository's `production` field reports, given what the approvals list said and what a person did.
 *
 * THE ONE RULE, kept here beside the loader that produces the set so that the report layer has a single
 * call to make and no fold to remember.
 *
 * | approvals list           | marked by hand | reported          |
 * | ----------------------- | -------------- | ----------------- |
 * | names it (`true`)        | no             | `true`            |
 * | names it (`true`)        | yes            | `true`            |
 * | read, silent (`false`)   | no             | `false`           |
 * | read, silent (`false`)   | yes            | `true`            |
 * | unread (`undefined`)     | no             | `undefined`       |
 * | unread (`undefined`)     | yes            | `true`            |
 *
 * The last two rows are the load-bearing ones, and they are why this is not `approved || marked`. A mark
 * TURNS AN ANSWER ON and never off: it cannot make an unread list into a confident `false`, because
 * `undefined` here means nobody could say — the distinction `inventory/production.ts` refuses to collapse
 * and that `RepositoryRow.production` carries all the way to an absent JSON key. An unmarked repository is
 * reported exactly as it is reported today, so the marks are the only behaviour this changes.
 */
export function reportedProduction(deploysToProduction: boolean | undefined, overrides: ReadonlySet<string>, repository: string): boolean | undefined {
  return overrides.has(repository.toLowerCase()) ? true : deploysToProduction;
}
