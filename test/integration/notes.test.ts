import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { addRepositoryNote, deleteRepositoryNote, editRepositoryNote, repositoryNotes } from "../../src/evidence/store/notes.ts";
import { prisma } from "../../src/evidence/store/prisma.ts";
import { StorageError } from "../../src/evidence/store/storage-error.ts";
import { NOTE_BODY_LIMIT } from "../../src/lib/notes.ts";

/**
 * The repository notes store, and the guarantees the TABLE gives rather than the ones TypeScript does.
 *
 * Three things here can only be proved against a real database, which is why this is an integration test and
 * not a unit one: the two instants are stamped by Postgres and by nothing in the codebase, `updated_at` is
 * moved by a trigger that no TypeScript signature mentions, and the body's length and blankness are held by
 * CHECK constraints that a caller skipping `noteBody` would meet instead of a message.
 */

const HMCTS = "hmcts";

async function wipe(): Promise<void> {
  await prisma.repositoryNote.deleteMany();
}

beforeEach(wipe);

afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

/** One note on `pcs-api`, so a case states only what it is about. */
async function leave(body: string, author = { subject: "0000-1111", name: "A Reader" }) {
  return await addRepositoryNote({ organization: HMCTS, repository: "pcs-api", body, authorSubject: author.subject, authorName: author.name });
}

describe("addRepositoryNote", () => {
  it("should store a note with the author the caller stated", async () => {
    const stored = await leave("The suppressions are tracked in HDPI-8150.");

    expect(stored.body).toBe("The suppressions are tracked in HDPI-8150.");
    expect(stored.authorName).toBe("A Reader");
    expect(stored.authorSubject).toBe("0000-1111");
  });

  it("should stamp both instants from the database, equal on a note nobody has edited", async () => {
    // Both columns default to `now()` in one statement, so a new note carries two equal instants — which is
    // what lets the page show "edited" only where the second has actually moved.
    const stored = await leave("a note");

    expect(stored.createdAt.getTime()).toBe(stored.updatedAt.getTime());
  });

  it("should issue an identifier the caller did not supply", async () => {
    const stored = await leave("a note");

    expect(stored.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("should record the anonymous author where authentication is disabled", async () => {
    // The `_attributed` constraint refuses a blank author, so the anonymous case has to be a stated value.
    // This is the write `yarn dev` and the preview environment make.
    const stored = await leave("a note", { subject: "anonymous", name: "Anonymous" });

    expect(stored.authorName).toBe("Anonymous");
  });

  it("should keep many notes on one repository rather than replacing the last", async () => {
    await leave("First.");
    await leave("Second.");

    expect(await repositoryNotes(HMCTS, "pcs-api")).toHaveLength(2);
  });

  it("should casefold the keys it writes, so a note is found under either spelling", async () => {
    await addRepositoryNote({ organization: "HMCTS", repository: "PCS-API", body: "a note", authorSubject: "s", authorName: "n" });

    expect(await repositoryNotes("hmcts", "pcs-api")).toHaveLength(1);
  });

  it("should store a body at exactly the cap", async () => {
    const stored = await leave("a".repeat(NOTE_BODY_LIMIT));

    expect(stored.body).toHaveLength(NOTE_BODY_LIMIT);
  });

  it("should refuse a body over the cap, which is the constraint and not the caller holding", async () => {
    // `noteBody` is what gives a reader a sentence. This is what holds when a caller skips it — the boundary
    // that stands against code nobody has written yet, and the reason the cap is stated in the migration too.
    await expect(leave("a".repeat(NOTE_BODY_LIMIT + 1))).rejects.toThrow(StorageError);
  });

  it.each([
    ["an empty body", ""],
    ["a body of only whitespace", "   "]
  ])("should refuse %s", async (_label, body) => {
    await expect(leave(body)).rejects.toThrow(StorageError);
  });

  it.each([
    ["a blank author subject", { subject: "", name: "A Reader" }],
    ["a blank author name", { subject: "0000-1111", name: "" }],
    ["a whitespace author name", { subject: "0000-1111", name: "  " }]
  ])("should refuse %s, because a note with no author answers nobody", async (_label, author) => {
    await expect(leave("a note", author)).rejects.toThrow(StorageError);
  });
});

describe("repositoryNotes", () => {
  it("should return an empty list for a repository nobody has written about", async () => {
    // ABSENT IS NOT AN ERROR AND NOT A DASH. No notes is a measured nothing, so the page draws its empty
    // state rather than failing or reporting the repository as unmeasured.
    expect(await repositoryNotes(HMCTS, "never-mentioned")).toEqual([]);
  });

  it("should order the notes oldest first, which is the order the page prints them in", async () => {
    await leave("First.");
    await leave("Second.");
    await leave("Third.");

    expect((await repositoryNotes(HMCTS, "pcs-api")).map((note) => note.body)).toEqual(["First.", "Second.", "Third."]);
  });

  it("should return only the notes of the repository asked for", async () => {
    await leave("On pcs-api.");
    await addRepositoryNote({ organization: HMCTS, repository: "cath-service", body: "On cath-service.", authorSubject: "s", authorName: "n" });

    expect((await repositoryNotes(HMCTS, "pcs-api")).map((note) => note.body)).toEqual(["On pcs-api."]);
  });

  it("should return only the organisation asked for", async () => {
    await leave("On hmcts.");
    await addRepositoryNote({ organization: "hmcts-test", repository: "pcs-api", body: "On hmcts-test.", authorSubject: "s", authorName: "n" });

    expect((await repositoryNotes(HMCTS, "pcs-api")).map((note) => note.body)).toEqual(["On hmcts."]);
  });

  it("should find a note whatever case the repository is asked for in", async () => {
    await leave("a note");

    expect(await repositoryNotes("HMCTS", "PCS-API")).toHaveLength(1);
  });
});

describe("editRepositoryNote", () => {
  it("should replace the body and report that it found the note", async () => {
    const stored = await leave("Frist.");

    expect(await editRepositoryNote(stored.id, "First.")).toBe(true);
    expect((await repositoryNotes(HMCTS, "pcs-api"))[0]?.body).toBe("First.");
  });

  it("should leave the author and created_at alone, and move updated_at", async () => {
    // THE ACCEPTANCE CRITERION, and it holds structurally: the statement names only `body`, and `updated_at`
    // is moved by the trigger. Neither the author nor the creation instant is reachable from this call.
    const stored = await leave("Frist.");

    await editRepositoryNote(stored.id, "First.");
    const [edited] = await repositoryNotes(HMCTS, "pcs-api");

    expect(edited?.authorSubject).toBe(stored.authorSubject);
    expect(edited?.authorName).toBe(stored.authorName);
    expect(edited?.createdAt.getTime()).toBe(stored.createdAt.getTime());
    expect(edited?.updatedAt.getTime()).toBeGreaterThan(stored.updatedAt.getTime());
  });

  it("should report that there was nothing to edit when the note has gone", async () => {
    // An ordinary race on a shared list: somebody deleted the note between the page rendering and this
    // submission. `false` rather than a throw, so the caller can re-render instead of erroring.
    expect(await editRepositoryNote("11111111-2222-3333-4444-555555555555", "First.")).toBe(false);
  });

  it.each([
    ["not a uuid at all", "not-a-uuid"],
    ["an empty identifier", ""],
    ["a number", "42"]
  ])("should report no such note rather than failing when the identifier is %s", async (_label, id) => {
    // `id` is a `uuid` column, so Postgres refuses the cast and would raise. A tampered or stale form field
    // is answered with the truth — there is no such note — instead of a 500.
    expect(await editRepositoryNote(id, "First.")).toBe(false);
  });

  it("should refuse an edit that would empty the body", async () => {
    const stored = await leave("First.");

    await expect(editRepositoryNote(stored.id, "   ")).rejects.toThrow(StorageError);
  });

  it("should refuse an edit over the cap", async () => {
    const stored = await leave("First.");

    await expect(editRepositoryNote(stored.id, "a".repeat(NOTE_BODY_LIMIT + 1))).rejects.toThrow(StorageError);
  });

  it("should edit only the note named, leaving the others where they are", async () => {
    const first = await leave("First.");
    await leave("Second.");

    await editRepositoryNote(first.id, "Corrected.");

    expect((await repositoryNotes(HMCTS, "pcs-api")).map((note) => note.body)).toEqual(["Corrected.", "Second."]);
  });
});

describe("deleteRepositoryNote", () => {
  it("should remove the note and report that it found one", async () => {
    const stored = await leave("a note");

    expect(await deleteRepositoryNote(stored.id)).toBe(true);
    expect(await repositoryNotes(HMCTS, "pcs-api")).toEqual([]);
  });

  it("should report that there was nothing to delete when the note has already gone", async () => {
    expect(await deleteRepositoryNote("11111111-2222-3333-4444-555555555555")).toBe(false);
  });

  it("should report no such note rather than failing on an identifier that is not a uuid", async () => {
    expect(await deleteRepositoryNote("not-a-uuid")).toBe(false);
  });

  it("should delete only the note named", async () => {
    const first = await leave("First.");
    await leave("Second.");

    await deleteRepositoryNote(first.id);

    expect((await repositoryNotes(HMCTS, "pcs-api")).map((note) => note.body)).toEqual(["Second."]);
  });
});

describe("the notes table itself", () => {
  it("should refuse a key that is not casefolded, whatever wrote it", async () => {
    // The store folds what it writes, so this is what guards the one writer that cannot be made to behave: a
    // hand-written statement in pgAdmin. Without it a note left under one spelling is invisible under the other.
    await expect(
      prisma.$executeRaw`INSERT INTO repository_notes (organization, repository, body, author_subject, author_name) VALUES ('hmcts', 'PCS-API', 'a note', 's', 'n')`
    ).rejects.toThrow();
  });

  it("should hold the same cap the application states", async () => {
    // `NOTE_BODY_LIMIT` and `repository_notes_body_stated` are the same number in two places, which is
    // deliberate — and this is what fails the build if one of them moves without the other.
    await expect(
      prisma.$executeRaw`INSERT INTO repository_notes (organization, repository, body, author_subject, author_name) VALUES ('hmcts', 'pcs-api', ${"a".repeat(NOTE_BODY_LIMIT + 1)}, 's', 'n')`
    ).rejects.toThrow();
    await expect(
      prisma.$executeRaw`INSERT INTO repository_notes (organization, repository, body, author_subject, author_name) VALUES ('hmcts', 'pcs-api', ${"a".repeat(NOTE_BODY_LIMIT)}, 's', 'n')`
    ).resolves.toBe(1);
  });
});
