/**
 * @vitest-environment jsdom
 */

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RepositoryNotes } from "@/components/RepositoryNotes";
import { NOTE_BODY_LIMIT } from "@/lib/notes";
import type { RepositoryNote } from "@/lib/types";

/**
 * The actions do nothing here, which is the reason they are props rather than imports.
 *
 * A form's `action` is a server function in the running application; what this suite is about is what the
 * section RENDERS — the list, the author line, and the controls' hidden fields — so three no-ops are the
 * whole of the dependency.
 */
const NOTHING = () => undefined;

const WRITTEN = "2026-09-20T09:30:00.000Z";

function note(over: Partial<RepositoryNote> = {}): RepositoryNote {
  return {
    id: "11111111-2222-3333-4444-555555555555",
    body: "The suppressions are tracked in HDPI-8150.",
    author_name: "A Reader",
    author_subject: "0000-1111",
    created_at: WRITTEN,
    // Equal to `created_at` by default: a note nobody has edited carries two equal instants, which is what
    // the table's two defaults produce.
    updated_at: WRITTEN,
    ...over
  };
}

function mount(notes: readonly RepositoryNote[]) {
  return render(<RepositoryNotes repository="pcs-api" notes={notes} create={NOTHING} edit={NOTHING} remove={NOTHING} />);
}

/** The list item for one note, which is where the body, the author line and the two controls live. */
function item(index = 0): HTMLElement {
  const row = screen.getAllByRole("listitem")[index];
  // Asserted rather than asserted-away: a missing row is a rendering failure, and `?.` on every use below
  // would let a case pass having found nothing.
  expect(row).toBeDefined();
  return row as HTMLElement;
}

afterEach(cleanup);

describe("RepositoryNotes with no notes", () => {
  it("should say nobody has left a note when the list is empty", () => {
    // ABSENT IS NOT ZERO, and here neither is an error: a repository nobody has written about has no notes,
    // which the section states in words rather than as a dash or a failure.
    mount([]);

    expect(screen.getByText(/Nobody has left a note on pcs-api\./)).toBeTruthy();
  });

  it("should draw no list at all when there is nothing to list", () => {
    mount([]);

    expect(screen.queryByRole("list")).toBeNull();
  });

  it("should still offer the field to add one", () => {
    // The empty state sits above the form rather than instead of it: a repository with no notes is precisely
    // the one somebody is about to write the first note on.
    mount([]);

    expect(screen.getByLabelText("Add a note")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add note" })).toBeTruthy();
  });
});

describe("RepositoryNotes listing", () => {
  it("should print the body, the author and when it was written", () => {
    mount([note()]);
    const only = item();

    expect(only.textContent).toContain("The suppressions are tracked in HDPI-8150.");
    expect(only.textContent).toContain("A Reader");
    expect(only.textContent).toContain("2026-09-20T09:30Z");
  });

  it("should never print the author's subject, which identifies a person and means nothing to a reader", () => {
    mount([note()]);

    expect(document.body.textContent).not.toContain("0000-1111");
  });

  it("should print the anonymous author as a name when authentication was disabled", () => {
    mount([note({ author_name: "Anonymous", author_subject: "anonymous" })]);

    expect(item().textContent).toContain("Anonymous");
  });

  it("should list the notes in the order it was given, which is oldest first", () => {
    // The order is the store's — `created_at` ascending — and this component must not re-sort it. A second
    // ordering here is how the page and the JSON behind it would come to disagree.
    mount([note({ id: "aaaaaaaa-0000-0000-0000-000000000001", body: "First." }), note({ id: "aaaaaaaa-0000-0000-0000-000000000002", body: "Second." })]);

    expect(screen.getAllByRole("listitem").map((row) => row.textContent?.includes("First."))).toEqual([true, false]);
  });

  it("should say nothing about an edit when a note has never been edited", () => {
    mount([note()]);

    expect(item().textContent).not.toContain("edited");
  });

  it("should say when a note was edited, and leave the original instant standing", () => {
    mount([note({ updated_at: "2026-09-21T14:05:00.000Z" })]);
    const only = item();

    expect(only.textContent).toContain("2026-09-20T09:30Z");
    expect(only.textContent).toContain("edited 2026-09-21T14:05Z");
  });

  it("should render a body as text rather than as markup", () => {
    // THE ONE PLACE THIS SERVICE PRINTS SOMETHING A PERSON TYPED BACK TO OTHER PEOPLE. React escapes an
    // interpolated string, so the tags arrive as characters; a `dangerouslySetInnerHTML` here would put a
    // script in the document instead, and this is the assertion that would catch one being added.
    mount([note({ body: "<script>alert('x')</script>" })]);

    expect(item().textContent).toContain("<script>alert('x')</script>");
    expect(document.querySelector("script")).toBeNull();
  });

  it("should render an image tag in a body as text rather than fetching it", () => {
    mount([note({ body: "<img src=x onerror=alert(1)>" })]);

    expect(item().textContent).toContain("<img src=x onerror=alert(1)>");
    expect(document.querySelector("img")).toBeNull();
  });

  it("should keep the line breaks a writer typed", () => {
    // Held by CSS rather than by turning the text into markup, which is what `whitespace-pre-wrap` is for.
    mount([note({ body: "Being decommissioned.\n\nTracked in HDPI-8150." })]);

    expect(item().querySelector(".whitespace-pre-wrap")?.textContent).toBe("Being decommissioned.\n\nTracked in HDPI-8150.");
  });
});

describe("RepositoryNotes controls", () => {
  it("should offer an edit control carrying the note's identifier and the repository", () => {
    mount([note()]);
    const edit = within(item()).getByLabelText("Edit this note").closest("form") as HTMLFormElement;

    expect(new FormData(edit).get("id")).toBe("11111111-2222-3333-4444-555555555555");
    expect(new FormData(edit).get("repository")).toBe("pcs-api");
  });

  it("should start an edit from the current body, so a correction is not a retype", () => {
    mount([note()]);

    expect(within(item()).getByLabelText<HTMLTextAreaElement>("Edit this note").value).toBe("The suppressions are tracked in HDPI-8150.");
  });

  it("should keep the edit form collapsed until a reader opens it, without any JavaScript", () => {
    mount([note()]);

    expect(item().querySelector("details")?.hasAttribute("open")).toBe(false);
  });

  it("should offer a delete control in a form of its own, carrying no body", () => {
    // Two submits in one form would post the textarea to whichever was pressed, so a delete would carry a
    // body and could be triggered by the wrong default. Separate forms keep each action's fields to its own.
    mount([note()]);
    const remove = within(item()).getByRole("button", { name: "Delete" }).closest("form") as HTMLFormElement;

    expect(new FormData(remove).get("id")).toBe("11111111-2222-3333-4444-555555555555");
    expect(new FormData(remove).get("body")).toBeNull();
  });

  it("should carry the repository on the add form, because an action has no route parameters", () => {
    mount([]);
    const add = screen.getByLabelText("Add a note").closest("form") as HTMLFormElement;

    expect(new FormData(add).get("repository")).toBe("pcs-api");
  });

  it("should state the cap where a writer can see it before they reach it", () => {
    mount([]);

    expect(screen.getByText(`at most ${NOTE_BODY_LIMIT} characters`)).toBeTruthy();
  });

  it("should hold every textarea to the cap, as a courtesy rather than as the control", () => {
    // `maxLength` stops a browser typing past it. The action re-checks and the table has a CHECK constraint,
    // because a direct POST honours no attribute rendered here.
    mount([note()]);

    for (const field of screen.getAllByRole("textbox")) {
      expect(field.getAttribute("maxlength")).toBe(String(NOTE_BODY_LIMIT));
    }
  });

  it("should give every note its own edit field, so two notes cannot share one label", () => {
    mount([note({ id: "aaaaaaaa-0000-0000-0000-000000000001" }), note({ id: "aaaaaaaa-0000-0000-0000-000000000002" })]);
    const ids = screen.getAllByRole("textbox").map((field) => field.getAttribute("id"));

    expect(new Set(ids).size).toBe(ids.length);
  });
});
