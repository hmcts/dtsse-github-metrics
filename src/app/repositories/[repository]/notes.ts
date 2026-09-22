"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { type Author, SESSION_COOKIE, writingAuthor } from "@/auth/author";
import { addNote, removeNote, updateNote } from "@/lib/api";
import { noteBody } from "@/lib/notes";

/**
 * The three server actions that write a repository note — the whole write surface of this application.
 *
 * `"use server"` AT THE TOP OF THE FILE MAKES EVERY EXPORT REMOTELY CALLABLE, which is why this file holds
 * three functions and nothing else. A helper exported from here would be a POST endpoint; the two that are not
 * actions are declared below the exports and are deliberately not exported. For the same reason the read seam
 * — `src/lib/api.ts`, whose every export reaches Postgres — must never carry this directive.
 *
 * EVERY ACTION VERIFIES THE SESSION ITSELF, and the duplication with `src/proxy.ts` is the point rather than an
 * oversight. A server action is reachable by a direct POST carrying an action id, not only by submitting the
 * form on the page, so an action that trusted the middleware would be trusting that nothing ever changes about
 * which paths are exempt. `authorised` below is the one gate, called first in all three.
 *
 * REFUSALS ARE SILENT AND RETURN NOTHING. An unauthenticated caller gets no write and no message, because
 * there is no reader to show one to: a person who is signed out was redirected to Entra by the proxy long
 * before reaching here, so a caller arriving without a session is posting directly and is owed nothing. It is
 * a `return` rather than a `throw` so a refusal cannot surface as a server error in the logs of a service whose
 * errors are worth reading.
 *
 * THE FORM VALUES ARE READ AS `unknown`. `FormData.get` returns `string | File | null`, and a `File` is what a
 * crafted multipart body sends for a field the form declares as a textarea — so every value below goes through
 * a narrowing that treats anything but a string as absent, rather than being cast.
 */

/**
 * Adds a note to one repository, attributed to whoever is signed in.
 *
 * The repository comes from a hidden field rather than from the URL, because an action has no route parameters:
 * it is a POST to the page it was rendered on, and the path it revalidates is built from the same value. That
 * value is UNTRUSTED — anybody may post any repository name — and it needs no check, which is worth stating so
 * nobody adds a wrong one. A note is written against the name given, `addNote` casefolds it, and the page for
 * that name lists it. Writing a note against a repository that does not exist creates a row nobody will ever
 * read; it does not disclose anything, because the write path returns nothing and the read path is a different
 * request that the proxy guards on its own.
 */
export async function createNote(form: FormData): Promise<void> {
  const author = await authorised();
  if (author === undefined) {
    return;
  }
  const repository = text(form.get("repository"));
  if (repository === undefined) {
    return;
  }
  const checked = noteBody(form.get("body"));
  if (!("body" in checked)) {
    return;
  }
  await addNote(repository, checked.body, author);
  refresh(repository);
}

/**
 * Replaces one note's body, leaving its author and `created_at` where they are.
 *
 * ANY AUTHENTICATED READER MAY EDIT ANY NOTE — a decision, not an omission. This is a small internal team and a
 * note nobody can tidy up is worse than one anybody can, so there is no comparison between the session's
 * subject and the note's. The subject is stored, so narrowing this later is a `where` clause and not a
 * migration.
 */
export async function editNote(form: FormData): Promise<void> {
  const author = await authorised();
  if (author === undefined) {
    return;
  }
  const repository = text(form.get("repository"));
  const id = text(form.get("id"));
  if (repository === undefined || id === undefined) {
    return;
  }
  const checked = noteBody(form.get("body"));
  if (!("body" in checked)) {
    return;
  }
  // The result says whether a note was there to edit. Nothing is done with it: a note somebody else deleted
  // between this page rendering and this submission is an ordinary race on a shared list, and the re-render
  // below shows the list as it now is, which is the honest answer to "where did my note go".
  await updateNote(id, checked.body);
  refresh(repository);
}

/** Deletes one note. Any authenticated reader may delete any note, for `editNote`'s reason. */
export async function deleteNote(form: FormData): Promise<void> {
  const author = await authorised();
  if (author === undefined) {
    return;
  }
  const repository = text(form.get("repository"));
  const id = text(form.get("id"));
  if (repository === undefined || id === undefined) {
    return;
  }
  await removeNote(id);
  refresh(repository);
}

/**
 * Who is writing, or `undefined` where nobody may.
 *
 * NOT EXPORTED, because this file's `"use server"` would make it an endpoint. It is the only place the session
 * cookie is read on the write path, so the three actions above share one gate rather than each making the same
 * three calls — which is what stops one of them being written without it.
 */
async function authorised(): Promise<Author | undefined> {
  return await writingAuthor((await cookies()).get(SESSION_COOKIE)?.value);
}

/**
 * Shows the reader the list they just changed.
 *
 * The repository page is `force-dynamic`, so nothing caches its data and the next render reads the new note
 * from Postgres regardless. What this clears is the CLIENT ROUTER's copy of the page: without it the browser
 * can redraw the route it already holds, and a note that is in the database does not appear until a reload.
 */
function refresh(repository: string): void {
  revalidatePath(`/repositories/${repository}`);
}

/** One form value as a non-empty string, or `undefined` for a missing one, a blank one, or an uploaded file. */
function text(value: FormDataEntryValue | null): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}
