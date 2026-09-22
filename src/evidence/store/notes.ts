import { prisma } from "./prisma.ts";
import { StorageError } from "./storage-error.ts";

/**
 * The repository notes table, and the ONLY WRITE PATH THE WEB PROCESS HAS.
 *
 * Every other module in this folder is written by `collect` and read by the pages. This one is written by a
 * reader who is signed in, which makes it the whole of the surface that the serving half of this service can
 * change — so the boundary is worth stating: these four functions are it, the table they name is the only one
 * they touch, and nothing here reaches GitHub, Cosmos or SonarCloud. The web pod gains no credential for any
 * of that, and did not need one, because a note comes from the person writing it.
 *
 * IT IS NOT REPORT EVIDENCE, and that is a layering decision rather than a filing one. `report/estate.ts`
 * builds a repository's row from the caches and is held per `collection_state.revision` — a note written now
 * must appear on the next render, not after the next collection, so threading it through the estate read
 * would have made every new note invisible for up to a day. Notes are their own concern, read on their own
 * path, and the pages are `force-dynamic`.
 *
 * `prune` MAY NOT TOUCH THIS TABLE. The reason is the strongest version of `repository_production`'s: GitHub
 * was never asked, and nothing was collected — a note is prose somebody typed, so a deleted row is
 * recoverable from nobody's memory but theirs. Enforced by
 * test/integration/prune-never-touches-durable.test.ts.
 *
 * NO AUTHORISATION IS DECIDED HERE, deliberately. Who may write is a question about a session, which this
 * layer cannot see and must not guess at; `src/auth/author.ts` answers it and the server action refuses
 * before it ever reaches these functions. What this layer owes the caller is that a write is scoped to one
 * repository's notes and that a failure arrives as a `StorageError` rather than a driver error escaping into
 * a render — the same contract every other store module keeps.
 *
 * VALIDATION IS NOT HERE EITHER, and the table is why that is safe rather than trusting: `noteBody` in
 * `src/lib/notes.ts` gives the reader a sentence, and the CHECK constraints in the migration are what
 * actually hold. A blank or over-long body reaching this module fails in Postgres and surfaces as a
 * `StorageError`, which is the correct outcome for a caller that skipped the check.
 */

/** One stored note, as the table holds it. Instants are `Date`s here and strings at the contract. */
export interface StoredNote {
  id: string;
  body: string;
  authorName: string;
  authorSubject: string;
  createdAt: Date;
  updatedAt: Date;
}

/** A note as a caller states it: where it belongs, what it says, and who is saying it. */
export interface NewNote {
  organization: string;
  repository: string;
  body: string;
  authorSubject: string;
  authorName: string;
}

/**
 * The columns every read here selects, written once so a new column cannot reach a page unnoticed.
 *
 * Narrow on purpose rather than for cost — the table is small. `organization` and `repository` are left out
 * because the caller supplied both, so returning them would be echoing the question back.
 */
const COLUMNS = {
  id: true,
  body: true,
  authorName: true,
  authorSubject: true,
  createdAt: true,
  updatedAt: true
} as const;

/**
 * One repository's notes, oldest first.
 *
 * ORDERED BY `created_at` ASCENDING, which is the order the ticket states and the order a log reads in: the
 * first thing anybody said about the repository is the first thing on the page, and a new note appears at the
 * bottom where a reader who has read the others will look for it.
 *
 * TIE-BROKEN ON `id`, which is not decoration. Two notes written in the same microsecond — a double-submitted
 * form, or a test seeding a fixture — are otherwise ordered by whatever the index returns, so the page could
 * reorder between two renders with nothing having changed. The tie-break is arbitrary but STABLE, which is
 * the property that matters; there is no meaning in a UUID's order and none is claimed.
 *
 * AN EMPTY LIST IS AN ANSWER. A repository nobody has written about has no notes, which is a measured nothing
 * and not an absence — so this returns `[]` and the page draws its empty state, rather than the dash that
 * `absent means unmeasured` would require. There is no "notes could not be read" state short of a
 * `StorageError`.
 *
 * CASEFOLDED, matching the table's CHECK constraint and `productionOverrides`' precedent. GitHub owner and
 * repository names are case-insensitive, so a note left under one spelling has to be found under the other —
 * the fold is a correction rather than a convenience.
 */
export async function repositoryNotes(organization: string, repository: string): Promise<StoredNote[]> {
  try {
    return await prisma.repositoryNote.findMany({
      where: { organization: organization.toLowerCase(), repository: repository.toLowerCase() },
      select: COLUMNS,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }]
    });
  } catch (error) {
    throw new StorageError("could not read the repository notes", error);
  }
}

/**
 * Stores one note and returns it as stored.
 *
 * NEITHER INSTANT IS SENT. Both columns default to `now()`, so the two come off the database's clock rather
 * than the web pod's — which is what keeps `created_at` and `updated_at` comparable on a note whose edit
 * lands on a different replica. Passing a `Date` here would be a value the default no longer applied to and a
 * clock the caller controls.
 *
 * THE ID IS THE DATABASE'S TOO, and it is returned because the caller needs it: it is what the edit and
 * delete controls submit.
 *
 * Casefolds both keys rather than trusting the caller, so the `_casefolded` constraint is left guarding a
 * hand-written statement rather than this one.
 */
export async function addRepositoryNote(note: NewNote): Promise<StoredNote> {
  try {
    return await prisma.repositoryNote.create({
      data: {
        organization: note.organization.toLowerCase(),
        repository: note.repository.toLowerCase(),
        body: note.body,
        authorSubject: note.authorSubject,
        authorName: note.authorName
      },
      select: COLUMNS
    });
  } catch (error) {
    throw new StorageError("could not store the repository note", error);
  }
}

/**
 * Whether a string could be an identifier this table issued.
 *
 * A SHAPE TEST AND NOT AN EXISTENCE TEST, and it is here because `id` is a `uuid` column rather than text.
 * Postgres refuses to cast `not-a-uuid` and raises, so without this a tampered or stale form field would
 * arrive as a `StorageError` and a 500 — where the truthful answer is the one a missing note already gets:
 * there is no such note. The two callers below therefore report `false` rather than failing.
 *
 * Deliberately NOT a validation of the identifier's version or variant. Anything of this shape is handed to
 * Postgres, which is the thing that decides whether a row exists; a stricter pattern here would only be a
 * second opinion about a value the database issued.
 */
const NOTE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Replaces one note's body, reporting whether there was a note to replace.
 *
 * THE AUTHOR AND `created_at` ARE NOT IN THE `data`, so they cannot move: this states the body and nothing
 * else, and `updated_at` is stamped by the trigger. That is the acceptance criterion held structurally rather
 * than by a statement that remembers to leave two columns alone — there is no arm of this call that could
 * rewrite them, so no future edit to it can start to.
 *
 * ANY AUTHENTICATED READER MAY EDIT ANY NOTE, which is a decision and not an omission: this is a small
 * internal team, and a note nobody can tidy up is worse than one anybody can. Hence no author predicate here.
 * If that is ever narrowed, the `where` below is where the subject would join — and `author_subject` is
 * already stored for it.
 *
 * `updateMany` RATHER THAN `update`, for the reason `markProduction` gives: it reports a count instead of
 * throwing for a row that is not there. A note deleted by somebody else between a page render and this
 * submission is an ordinary race on a shared list, not a fault, and `false` lets the caller say so.
 */
export async function editRepositoryNote(id: string, body: string): Promise<boolean> {
  if (!NOTE_ID.test(id)) {
    return false;
  }
  try {
    const { count } = await prisma.repositoryNote.updateMany({ where: { id }, data: { body } });
    return count > 0;
  } catch (error) {
    throw new StorageError("could not update the repository note", error);
  }
}

/**
 * Deletes one note, reporting whether there was one to delete.
 *
 * `deleteMany` for `editRepositoryNote`'s reason: two readers deleting the same note is a race with an
 * obvious right answer — it is gone — and the second caller should be told that rather than shown an error.
 */
export async function deleteRepositoryNote(id: string): Promise<boolean> {
  if (!NOTE_ID.test(id)) {
    return false;
  }
  try {
    const { count } = await prisma.repositoryNote.deleteMany({ where: { id } });
    return count > 0;
  } catch (error) {
    throw new StorageError("could not delete the repository note", error);
  }
}
