import { EmptyState } from "@/components/EmptyState";
import { instant } from "@/lib/format";
import { NOTE_BODY_LIMIT } from "@/lib/notes";
import type { RepositoryNote } from "@/lib/types";

/**
 * One repository's notes, with the controls to add, edit and delete one.
 *
 * THE ONLY INTERACTIVE WRITE IN THE APPLICATION, and it is built with no client JavaScript at all. Every
 * control here is a `<form>` posting a server action, and the edit form is revealed by a `<details>` element
 * rather than by state — so the section works before hydration, works with scripting off, and needs no
 * `"use client"`. That also keeps it a server component the unit suite can render to static markup, which is
 * how every other page test in this repository works.
 *
 * THE ACTIONS ARRIVE AS PROPS rather than being imported. They live under `src/app/`, and `src/components/**`
 * does not import from there — the dependency runs the other way. Passing them in is the framework's own
 * pattern for it and has a second benefit worth more here: this component has no write path of its own, so a
 * test renders it with functions that do nothing.
 *
 * A BODY IS RENDERED AS TEXT AND NEVER AS MARKUP. This is the one place in the service that prints something a
 * person typed back to other people, so it is the one place an injected `<script>` would land. React escapes
 * an interpolated string, so `{note.body}` is safe by construction — and `dangerouslySetInnerHTML` must not
 * appear here for any reason, including rendering a link somebody pasted. `whitespace-pre-wrap` is what makes
 * the paragraph breaks a writer typed survive, which is the reason the temptation to render markup arises.
 */
export function RepositoryNotes({ repository, notes, create, edit, remove }: RepositoryNotesProps) {
  return (
    <div className="space-y-4">
      {/* AN EMPTY LIST IS AN ANSWER AND NOT A GAP. A repository nobody has written about has no notes, so
          this says that in words rather than drawing a dash — the dash is for a figure nobody measured, and
          nothing measures a note. The form below stays available either way, which is the point of putting
          the empty state above it rather than instead of it. */}
      {notes.length === 0 ? (
        <EmptyState
          message={`Nobody has left a note on ${repository}.`}
          detail="Notes carry the context GitHub cannot be asked for — a decommissioning, or where a suppression is tracked."
        />
      ) : (
        <ol className="space-y-3">
          {notes.map((note) => (
            <Note key={note.id} repository={repository} note={note} edit={edit} remove={remove} />
          ))}
        </ol>
      )}

      <form action={create} className="space-y-2">
        <input type="hidden" name="repository" value={repository} />
        <label htmlFor="new-note" className="block text-sm text-slate-400">
          Add a note
        </label>
        <Body id="new-note" />
        <div className="flex items-center gap-3">
          <Submit label="Add note" />
          {/* The cap stated where a writer can see it before they hit it, rather than only in the refusal.
              `maxLength` above stops a browser exceeding it; this is for somebody planning a long note. */}
          <span className="text-xs text-slate-500">at most {NOTE_BODY_LIMIT} characters</span>
        </div>
      </form>
    </div>
  );
}

export interface RepositoryNotesProps {
  repository: string;
  notes: readonly RepositoryNote[];
  /** The three server actions, passed in for the reason `RepositoryNotes` gives. */
  create: NoteAction;
  edit: NoteAction;
  remove: NoteAction;
}

/** What a `<form action>` takes: React allows a void or a promised return. */
export type NoteAction = (form: FormData) => void | Promise<void>;

/**
 * One note: what it says, who said it, when — and the two controls.
 *
 * THE AUTHOR IS `author_name` AND NEVER `author_subject`. The subject is an Entra GUID stored so that a note
 * does not change hands when somebody's display name does; it identifies a person to the tenant and means
 * nothing to a reader, so it is not printed anywhere on this page.
 *
 * `updated_at` IS SHOWN ONLY WHERE IT HAS MOVED. Both instants are stamped by the database and a new note
 * carries two equal ones, so printing both unconditionally would label every note "edited" the moment it was
 * written. The comparison is on the strings because they are both UTC ISO-8601 from the same column type —
 * `lib/api.ts` converts them together — so equal instants are equal text.
 */
function Note({ repository, note, edit, remove }: { repository: string; note: RepositoryNote; edit: NoteAction; remove: NoteAction }) {
  const editId = `note-${note.id}`;
  return (
    <li className="bg-slate-900 border border-slate-800 rounded-lg p-4 space-y-3">
      {/* `whitespace-pre-wrap` so the line breaks a writer typed survive, and `break-words` so a pasted URL
          with no spaces in it wraps instead of widening the panel past the viewport. */}
      <p className="text-sm text-slate-200 whitespace-pre-wrap break-words">{note.body}</p>

      <p className="text-xs text-slate-500">
        {note.author_name} — {instant(note.created_at)}
        {note.updated_at === note.created_at ? null : <span> (edited {instant(note.updated_at)})</span>}
      </p>

      <div className="flex items-center gap-3">
        {/* A `<details>` rather than a toggle, so revealing the form costs no JavaScript and the browser
            supplies the disclosure semantics a screen reader announces. */}
        <details className="flex-1">
          <summary className="text-xs text-slate-400 cursor-pointer">Edit</summary>
          <form action={edit} className="mt-2 space-y-2">
            <input type="hidden" name="repository" value={repository} />
            <input type="hidden" name="id" value={note.id} />
            <label htmlFor={editId} className="sr-only">
              Edit this note
            </label>
            {/* The current body as the starting value, so an edit is a correction rather than a retype. */}
            <Body id={editId} value={note.body} />
            <Submit label="Save note" />
          </form>
        </details>

        {/* ITS OWN FORM, and not a second button inside the edit form. Two submits in one form would post the
            textarea's contents to whichever action was pressed, so a delete would carry a body and an edit
            could be triggered by the delete button's default. Separate forms keep each action's fields to
            exactly what it needs. */}
        <form action={remove}>
          <input type="hidden" name="repository" value={repository} />
          <input type="hidden" name="id" value={note.id} />
          <button type="submit" className="text-xs text-slate-400 hover:text-red-400">
            Delete
          </button>
        </form>
      </div>
    </li>
  );
}

/**
 * The textarea every form here uses, so the cap and the styling are written once.
 *
 * `maxLength` IS A COURTESY AND NOT A CONTROL. A browser stops typing past it, which saves a reader composing
 * something that will be refused — but the action re-checks with `noteBody` and the table has a CHECK
 * constraint, because a direct POST honours neither this attribute nor any other thing rendered here.
 *
 * `required` likewise: it spares a reader an empty submission and decides nothing.
 */
function Body({ id, value }: { id: string; value?: string }) {
  return (
    <textarea
      id={id}
      name="body"
      rows={3}
      required
      maxLength={NOTE_BODY_LIMIT}
      defaultValue={value}
      className="w-full bg-slate-950 border border-slate-800 rounded-md px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600"
      placeholder="Context that is not derivable from GitHub"
    />
  );
}

/** The one submit button style, so the add and save controls cannot drift apart. */
function Submit({ label }: { label: string }) {
  return (
    <button type="submit" className="bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium rounded-md px-3 py-1.5">
      {label}
    </button>
  );
}
