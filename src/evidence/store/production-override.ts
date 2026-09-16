import { prisma } from "./prisma.ts";
import { StorageError } from "./storage-error.ts";

/**
 * Whether a repository is a production service, as far as a PERSON is concerned.
 *
 * The organisation states production approval in one document — `environment-approvals.yml` in
 * `cnp-jenkins-config`, read by `inventory/production.ts` — and that document is the pipeline's, not this
 * dashboard's. Some services deploy to production without appearing in it, and some appear in it wrongly, so
 * `metrics.yaml` carries a second list this repository maintains and `repository_production` holds one row per
 * repository and a `production` column somebody edits. `reportedProduction` is where all three meet.
 *
 * A TRI-STATE, and all three states are answers:
 *
 *   `true`   this IS a production service, whatever either list says
 *   `false`  this is NOT a production service, whatever either list says
 *   NULL     nobody has an opinion, so the two lists answer
 *
 * `false` is what a set of marked names cannot express, and it is the ONLY WAY TO SAY NO now that two lists can
 * say yes. An override that can only ever ADD leaves no way to say "a list names this and it is wrong", and NULL
 * is what keeps an UNREAD approvals list unread rather than letting anything turn it into a confident `false` —
 * see `reportedProduction`.
 *
 * THE IMPORT CANNOT OVERWRITE THE FLAG, and that is STRUCTURAL rather than a rule to remember: the collection's
 * only contact with this table is `seedProduction`, an `INSERT … ON CONFLICT DO NOTHING`, so it can add keys and
 * do nothing else. The only writer of `production` is `markProduction`, which is a caller stating a flag.
 *
 * PROVENANCE IS OPTIONAL, which is a deliberate trade and not an oversight. `marked_by` and `reason` were
 * mandatory and non-blank, and refusing the tick until both were supplied is exactly what made the flag a
 * statement to compose rather than a cell to edit. The audit trail this gives up is the sentence explaining WHY;
 * `marked_at` still records when, stamped by the database, and both optional columns are there for whoever wants
 * to record more.
 *
 * `prune` may not touch the table either, for a reason unlike the one the other durable tables have. Theirs is
 * that GitHub serves only the present; this table's is that GitHub was never asked at all — the flag came from a
 * person, and a deleted row is recoverable only from that person's memory.
 *
 * THERE IS NO ADMIN UI AND NONE IS PLANNED, so the way the flag is set is one `UPDATE` against a row the seed
 * has already put there — in pgAdmin, by finding the repository and editing the cell, or in `psql`:
 *
 * ```sql
 * UPDATE repository_production SET production = true
 * WHERE organization = 'hmcts' AND repository = 'pcs-api';
 * ```
 *
 * `production = false` forces the badge OFF even where BOTH lists name the repository — which is how an entry in
 * `metrics.yaml`'s `production_repositories` is retired, rather than by deleting the name — and `production = NULL`
 * hands the answer back to the lists. `marked_by` and `reason` are optional and may be set in the same statement —
 * `SET production = true, marked_by = 'somebody@hmcts.net', reason = '…'` — but nothing refuses the tick without
 * them, which is the point of the shape.
 *
 * `marked_at` IS STAMPED BY A TRIGGER and must not be set by hand. It moves only when `production` moves, so it
 * reads as when the flag was DECIDED: NULL on a row nobody has touched, and unchanged by an `UPDATE` that only
 * corrects the reason.
 *
 * An `UPDATE` naming a repository the seed has not reached reports `UPDATE 0` and changes nothing. That is the
 * honest answer — a repository absent from the organisation graph is one `collect-org` has not seen — and it is
 * why `markProduction` below reports whether it found a row rather than quietly inserting one.
 *
 * A change is not visible the instant it is written. Built reports are held per `collection_state.revision` and
 * invalidated by nothing else, so a badge appears when the next collection bumps that revision — within a day —
 * or immediately after `UPDATE collection_state SET revision = revision + 1 WHERE id = 1;`, which is the same
 * statement `stampRevision` makes and is safe to make by hand.
 */

/** One repository's flag, as a caller states it. */
export interface ProductionMark {
  organization: string;
  repository: string;
  /** `true` forces production on, `false` forces it off, `undefined` defers to the two lists. */
  production: boolean | undefined;
  /** Who is stating this — an email, or whatever identifies them to their colleagues. */
  markedBy?: string;
  /** Why. Optional, and read by no report: it is there for the next person who asks. */
  reason?: string;
}

/**
 * What each of one organisation's repositories has been said about, as `repository → production`.
 *
 * A `Map` AND NOT A `Set`, because a set cannot hold three states: a name absent from a set and a name mapped to
 * `false` are the difference between "the lists answer" and "the lists are wrong". Rows whose flag is NULL are
 * LEFT OUT rather than mapped to `undefined`, so the map holds only the repositories somebody has an opinion
 * about — a handful of entries against an estate of 3,277 — and `reportedProduction` can read a missing key as
 * deferral without distinguishing two kinds of absence.
 *
 * `marked_by` and `reason` are not selected. No report reads them, and lifting them into the report layer would
 * put a person's name on a page nobody asked to publish it on.
 *
 * THE NULLS ARE DROPPED HERE RATHER THAN BY A PREDICATE, and the two columns selected are why that costs nothing
 * worth avoiding: the table is keyed `(organization, repository)`, so this is a prefix scan returning two narrow
 * values per repository against an estate whose fact payloads the same read moves in tens of megabytes. Prisma
 * types the column `boolean | null` whatever the `where` clause says, so a `production IS NOT NULL` predicate
 * would not remove the narrowing below — it would only make one arm of it unreachable.
 *
 * CASEFOLDED, matching `inventory/production.ts`: the stored keys are lowercase already, held so by a CHECK
 * constraint, and `reportedProduction` folds the name it looks up. GitHub owner and repository names are
 * case-insensitive, so the fold is a correction rather than a convenience.
 */
export async function productionOverrides(organization: string): Promise<Map<string, boolean>> {
  try {
    const rows = await prisma.repositoryProduction.findMany({
      where: { organization: organization.toLowerCase() },
      select: { repository: true, production: true }
    });
    const stated = new Map<string, boolean>();
    for (const row of rows) {
      // A NULL flag is LEFT OUT rather than mapped, so an absent key is the one shape "nobody has an opinion"
      // takes and `reportedProduction` needs no second test to recognise it.
      if (row.production !== null) {
        stated.set(row.repository, row.production);
      }
    }
    return stated;
  } catch (error) {
    throw new StorageError("could not read the production overrides", error);
  }
}

/**
 * Gives every live repository a row to be marked on, and never touches a row that is already there.
 *
 * ONE STATEMENT FOR THE WHOLE ESTATE, not a write per repository. At 3,277 repositories a loop would be 3,277
 * round trips at the end of every `collect-org` to insert, on almost every run, nothing at all.
 *
 * `ON CONFLICT DO NOTHING` IS WHAT MAKES "THE IMPORT NEVER OVERRIDES A PERSON" STRUCTURAL. The statement can add
 * keys and can do nothing else: there is no `DO UPDATE` arm to get wrong, so no future change to the collector
 * can quietly start rewriting a flag somebody set. That property is the whole reason the seed is shaped this way
 * rather than as an upsert of the current estate.
 *
 * READ FROM `org_repositories` WHERE `superseded_at IS NULL`, which is the live estate as `collect-org` last left
 * it — the same predicate every other reader of the graph uses. `DISTINCT` because the change-versioned key is
 * `(organization, repository, observed_at)`, so one repository can hold several rows and only one of them is live;
 * the partial unique index makes that one, and the `DISTINCT` costs nothing to be sure of it.
 *
 * SCOPED TO ONE ORGANISATION, because a collection is: a run against `hmcts` has observed nothing about anybody
 * else's estate and has no business seeding rows for it.
 *
 * The keys are already lowercase in the graph, and `lower()` is applied anyway so the casefold constraint refuses
 * nothing this writes.
 */
export async function seedProduction(organization: string): Promise<number> {
  try {
    return await prisma.$executeRaw`
      INSERT INTO repository_production (organization, repository)
      SELECT DISTINCT lower(organization), lower(repository)
      FROM org_repositories
      WHERE organization = ${organization.toLowerCase()} AND superseded_at IS NULL
      ON CONFLICT (organization, repository) DO NOTHING
    `;
  } catch (error) {
    throw new StorageError("could not seed the production overrides", error);
  }
}

/**
 * Moves one repository's flag, reporting whether there was a row to move it on.
 *
 * AN `UPDATE` AND NEVER AN UPSERT, which is the same statement a person runs by hand and for the same reason:
 * the seed owns which repositories exist here, so a caller naming one it has not reached is naming a repository
 * `collect-org` has not seen. Inserting it would mint a key the graph does not have; reporting `false` says what
 * is true and leaves the caller to notice.
 *
 * Casefolds both keys rather than trusting the caller, so the `_casefolded` CHECK constraint is left guarding the
 * one writer that cannot be made to behave — a hand-written statement in pgAdmin.
 *
 * `marked_at` IS NOT WRITTEN HERE. The trigger stamps it when `production` moves, so passing an instant would be
 * a value the database immediately replaces.
 */
export async function markProduction(mark: ProductionMark): Promise<boolean> {
  const stated = {
    production: mark.production ?? null,
    ...(mark.markedBy === undefined ? {} : { markedBy: mark.markedBy }),
    ...(mark.reason === undefined ? {} : { reason: mark.reason })
  };
  try {
    const { count } = await prisma.repositoryProduction.updateMany({
      where: { organization: mark.organization.toLowerCase(), repository: mark.repository.toLowerCase() },
      data: stated
    });
    return count > 0;
  } catch (error) {
    throw new StorageError("could not update the production overrides", error);
  }
}

/** Which of the three layers settled a repository's answer. Absent where none of them could. */
export type ProductionSource = "approvals-list" | "configured-list" | "marked";

/**
 * One repository's answer and where it came from.
 *
 * Both keys absent is the whole of "nobody could say", so nothing here is ever `null` and a caller spreads the
 * two straight onto a row for `stripAbsent` to drop. A source without an answer cannot happen: a layer that
 * answered is a layer that said `true` or `false`.
 */
export interface ProductionAnswer {
  production?: boolean;
  source?: ProductionSource;
}

/**
 * The two layers that name repositories, as the rule looks them up: casefolded on both sides.
 *
 * `declared` is `metrics.yaml`'s `production_repositories` folded once per report build rather than per row —
 * 290 names against 1,892 repositories over five spans is the arithmetic that makes a per-row fold worth
 * avoiding — and `marked` is `productionOverrides`' map, whose keys the CHECK constraint already holds lowercase.
 */
export interface ProductionLayers {
  declared: ReadonlySet<string>;
  marked: ReadonlyMap<string, boolean>;
}

/** `metrics.yaml`'s list in the shape `reportedProduction` reads it. Folded, for the reason `ProductionLayers` gives. */
export function declaredProduction(repositories: readonly string[]): ReadonlySet<string> {
  return new Set(repositories.map((repository) => repository.toLowerCase()));
}

/**
 * What a repository's `production` field reports, given two lists and what a person said.
 *
 * THE ONE RULE, kept here beside the loader that produces the map so that the report layer has a single call to
 * make and no fold to remember. THREE LAYERS, most authoritative last:
 *
 *   1. the approvals list — `environment-approvals.yml`, the deployment pipeline's own document
 *   2. `metrics.yaml`'s `production_repositories` — this repository's list, for the services that document cannot name
 *   3. `repository_production.production` — the column somebody edits
 *
 * | approvals list         | configured list | the column | reported    | source          |
 * | ---------------------- | --------------- | ---------- | ----------- | --------------- |
 * | names it (`true`)      | either          | NULL       | `true`      | approvals-list  |
 * | read, silent (`false`) | names it        | NULL       | `true`      | configured-list |
 * | read, silent (`false`) | silent          | NULL       | `false`     | approvals-list  |
 * | unread (`undefined`)   | names it        | NULL       | `true`      | configured-list |
 * | unread (`undefined`)   | silent          | NULL       | `undefined` | absent          |
 * | either                 | either          | `true`     | `true`      | marked          |
 * | either                 | either          | `false`    | `false`     | marked          |
 *
 * THE TWO LISTS ARE A UNION and the column is not: either list naming a repository is enough, because each is a
 * statement that somebody deploys it and neither is a claim about what the other holds. The column then decides in
 * BOTH DIRECTIONS over both of them, which is what makes `false` the only way to say no.
 *
 * WHAT NO LAYER MAY DO IS INVENT AN ANSWER. A repository nobody has an opinion about and neither list names is
 * reported exactly as the approvals list reports it, INCLUDING the `undefined` that says the list could not be
 * read — the distinction `inventory/production.ts` refuses to collapse and that `RepositoryRow.production` carries
 * all the way to an absent JSON key. The configured list cannot turn that absence into a `false`: it holds names,
 * so its silence about a repository is not a reading of one.
 *
 * THE SOURCE IS REPORTED BECAUSE THE COLUMN NOW MEANS THREE THINGS. A reader meeting "Yes" has a fair question —
 * which of the three said so — and with a hand-maintained list expected to accumulate `false` overrides beneath
 * it, that question is the one somebody will ask first. The approvals list is named where it says `true` even if
 * the configured list also names the repository: it is the organisation's own document, so it is the stronger
 * provenance for the same answer, and the configured list is named only where it is the layer that added one.
 */
export function reportedProduction(deploysToProduction: boolean | undefined, layers: ProductionLayers, repository: string): ProductionAnswer {
  const folded = repository.toLowerCase();
  const marked = layers.marked.get(folded);
  if (marked !== undefined) {
    return { production: marked, source: "marked" };
  }
  if (deploysToProduction === true) {
    return { production: true, source: "approvals-list" };
  }
  if (layers.declared.has(folded)) {
    return { production: true, source: "configured-list" };
  }
  // The approvals list read and silent about a repository nobody has listed anywhere is a `false` somebody
  // observed. An UNREAD one is not, and stays absent.
  return deploysToProduction === undefined ? {} : { production: false, source: "approvals-list" };
}
