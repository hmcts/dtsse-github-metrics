import { describe, expect, it } from "vitest";
import { NOTE_BODY_EMPTY, NOTE_BODY_LIMIT, noteBody, noteBodyTooLong } from "../notes.ts";

/** The body in an accepted answer, or `undefined` where it was refused, so a case reads as one expression. */
function accepted(value: unknown): string | undefined {
  const answer = noteBody(value);
  return "body" in answer ? answer.body : undefined;
}

/** The reason in a refusal, or `undefined` where it was accepted. */
function refused(value: unknown): string | undefined {
  const answer = noteBody(value);
  return "reason" in answer ? answer.reason : undefined;
}

describe("NOTE_BODY_LIMIT", () => {
  it("should carry the same number as the database constraint", () => {
    // `repository_notes_body_stated` in the 20260922090000_repository_notes migration checks
    // `char_length(body) <= 4000`. The two are duplicated deliberately — the constraint is what holds, and
    // this is what lets the form say so — which means a change to one that misses the other turns a refusal a
    // reader could read into a database error. This test is what makes that a failing build.
    expect(NOTE_BODY_LIMIT).toBe(4000);
  });
});

describe("noteBody", () => {
  it("should accept a note and store it as written when it carries words", () => {
    expect(accepted("The suppressions are tracked in HDPI-8150.")).toBe("The suppressions are tracked in HDPI-8150.");
  });

  it("should keep the line breaks a writer typed, because the page renders them", () => {
    expect(accepted("Being decommissioned.\n\nTracked in HDPI-8150.")).toBe("Being decommissioned.\n\nTracked in HDPI-8150.");
  });

  it("should trim the surrounding whitespace a textarea collects", () => {
    expect(accepted("  \n a note \n  ")).toBe("a note");
  });

  it.each([
    ["an empty string", ""],
    ["a single space", " "],
    ["only whitespace", " \n\t  "]
  ])("should refuse the note when the body is %s", (_label, value) => {
    expect(refused(value)).toBe(NOTE_BODY_EMPTY);
  });

  it.each([
    ["nothing was submitted", undefined],
    ["the field was absent", null],
    ["an uploaded file arrived instead of text", new Blob(["a note"])],
    ["a number arrived", 42]
  ])("should refuse the note when %s", (_label, value) => {
    // `FormData.get` returns `string | File | null`, and a crafted multipart body is how a `File` reaches a
    // field the form declares as a textarea. Anything but a string is treated as absent rather than cast.
    expect(refused(value)).toBe(NOTE_BODY_EMPTY);
  });

  it("should accept a note of exactly the cap, which is a length and not a ceiling to stay under", () => {
    expect(accepted("a".repeat(NOTE_BODY_LIMIT))).toHaveLength(NOTE_BODY_LIMIT);
  });

  it("should refuse a note one character over the cap, naming the cap and the length", () => {
    const reason = refused("a".repeat(NOTE_BODY_LIMIT + 1));

    expect(reason).toBe(noteBodyTooLong(NOTE_BODY_LIMIT + 1));
    expect(reason).toContain(String(NOTE_BODY_LIMIT));
    expect(reason).toContain(String(NOTE_BODY_LIMIT + 1));
  });

  it("should measure the length after trimming, so invisible whitespace cannot fail a note", () => {
    // A body at the cap surrounded by spaces is a body at the cap. Measuring before the trim would refuse a
    // note for characters the writer cannot see and the table would never have stored.
    expect(accepted(`  ${"a".repeat(NOTE_BODY_LIMIT)}  `)).toHaveLength(NOTE_BODY_LIMIT);
  });

  it("should count an astral character once, as Postgres char_length does", () => {
    // `String.length` counts UTF-16 code units, so each of these is 2 — a body of NOTE_BODY_LIMIT emoji would
    // be refused here while the CHECK constraint accepted it, and the two boundaries would disagree about the
    // same note. Counting code points is what keeps the cap the reader is told the cap they meet.
    const emoji = "\u{1F600}".repeat(NOTE_BODY_LIMIT);

    expect(emoji.length).toBe(NOTE_BODY_LIMIT * 2);
    expect(accepted(emoji)).toBe(emoji);
  });

  it("should refuse astral characters over the cap, counted as characters rather than code units", () => {
    expect(refused("\u{1F600}".repeat(NOTE_BODY_LIMIT + 1))).toBe(noteBodyTooLong(NOTE_BODY_LIMIT + 1));
  });

  it("should not interpret markup in a body, because nothing downstream does either", () => {
    // Stored verbatim. React escapes it on the way out and `RepositoryNotes` never uses
    // dangerouslySetInnerHTML, so sanitising here would silently alter a note somebody wrote about HTML.
    const script = "<script>alert('x')</script>";

    expect(accepted(script)).toBe(script);
  });
});
