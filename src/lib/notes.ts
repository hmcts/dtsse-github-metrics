/**
 * What a repository note's body has to be, decided in one place for the three callers that need it.
 *
 * THE SERVER IS THE ONE THAT DECIDES. A server action is reachable by a direct POST and not only
 * through the form on the page, so `noteBody` below is what the action calls and the `maxLength` on
 * the textarea is a courtesy to a reader rather than a control. Both read the same constant, which is
 * why this module is in `src/lib/**` — importable from a component — while the write itself is not.
 *
 * The database holds the same two rules as CHECK constraints. That is deliberate duplication: these
 * give a reader a sentence, and the constraints hold against a caller nobody has written yet.
 */

/**
 * The longest note body the service accepts, in characters.
 *
 * 4000 is a choice rather than a limit of anything. A note is a paragraph or two of context — "this is
 * being decommissioned", "the suppressions are tracked in HDPI-8150" — so this leaves room for a list
 * of ticket references and a short explanation while keeping the column's worst case at roughly 16 kB
 * of UTF-8. An unbounded text field that anybody with a session can post to is the obvious abuse, and a
 * cap is cheaper than a quota.
 *
 * `repository_notes_body_stated` in the migration carries the same number. CHANGE THE TWO TOGETHER: the
 * constraint is what holds, and a constant above it would turn a long note into a database error where
 * the reader should have been told.
 *
 * COUNTED IN CHARACTERS, matching the constraint's `char_length`, so the limit a reader is told is the
 * limit they meet. A cap on bytes would refuse 1,400 emoji while accepting 4,000 letters.
 */
export const NOTE_BODY_LIMIT = 4000;

/** What a reader is told when they submit nothing, or only whitespace. */
export const NOTE_BODY_EMPTY = "A note needs something in it.";

/** What a reader is told when the body is over the cap, naming the cap and what they sent. */
export function noteBodyTooLong(length: number): string {
  return `A note can be at most ${NOTE_BODY_LIMIT} characters, and this one is ${length}.`;
}

/**
 * The body to store, or the reason it was refused.
 *
 * Exactly one key is set, which is the same shape the rest of this codebase gives an answer that might
 * not exist — a caller narrows on `body === undefined` and has the sentence to show.
 *
 * TRIMMED BEFORE EVERY TEST AND STORED TRIMMED. Leading and trailing whitespace is never meaningful in
 * a note and a textarea collects it freely, so a body is measured and stored as the words in it: this
 * is what makes "   " an empty note rather than a three-character one, and it means the stored value
 * satisfies the `btrim(body) <> ''` constraint by construction rather than by luck.
 *
 * THE LENGTH IS MEASURED AFTER THE TRIM, so a reader cannot be refused for whitespace they cannot see.
 */
export function noteBody(value: unknown): { body: string } | { reason: string } {
  const text = typeof value === "string" ? value.trim() : "";
  if (text === "") {
    return { reason: NOTE_BODY_EMPTY };
  }
  // `[...text].length`, not `text.length`: `String.length` counts UTF-16 code units, so an emoji or any
  // other astral character would count twice against a cap the reader is told is in characters — and
  // Postgres' `char_length` counts code points, so the two boundaries would disagree about the same
  // note. A body of 2,001 emoji would be refused here and accepted there, or the reverse.
  const length = [...text].length;
  if (length > NOTE_BODY_LIMIT) {
    return { reason: noteBodyTooLong(length) };
  }
  return { body: text };
}
