import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Session, sealSession } from "@/auth/session";
import { NOTE_BODY_LIMIT } from "@/lib/notes";

const SECRET = "a-test-session-secret-long-enough-to-be-plausible";

const READER: Session = { subject: "0000-1111", name: "A Reader" };

/**
 * The write seam and the two Next.js hooks, mocked so the actions run without Postgres or a request.
 *
 * `@/lib/api` is mocked BY PATH rather than stubbed function by function, so nothing in this file can reach
 * the real one — which would open a connection pool. What the cases below assert is whether those three
 * functions were called at all, because "an unauthenticated caller cannot write" is exactly the claim that
 * `addNote` was never reached.
 */
const api = vi.hoisted(() => ({ addNote: vi.fn(), updateNote: vi.fn(), removeNote: vi.fn() }));
const next = vi.hoisted(() => ({ cookie: undefined as string | undefined, revalidated: [] as string[] }));

vi.mock("@/lib/api", () => api);

vi.mock("next/headers", () => ({
  cookies: () => Promise.resolve({ get: (name: string) => (name === "gm_session" && next.cookie !== undefined ? { value: next.cookie } : undefined) })
}));

vi.mock("next/cache", () => ({
  revalidatePath: (path: string) => {
    next.revalidated.push(path);
  }
}));

const { createNote, deleteNote, editNote } = await import("./notes.ts");

/** A form carrying the named fields, which is what a server action receives. */
function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    data.set(name, value);
  }
  return data;
}

/** Whether any of the three write functions was called. The whole of "did this caller write anything". */
function wrote(): boolean {
  return api.addNote.mock.calls.length + api.updateNote.mock.calls.length + api.removeNote.mock.calls.length > 0;
}

beforeEach(() => {
  api.addNote.mockReset();
  api.updateNote.mockReset();
  api.removeNote.mockReset();
  next.cookie = undefined;
  next.revalidated = [];
  vi.stubEnv("SESSION_SECRET", SECRET);
  vi.stubEnv("AUTH_DISABLED", undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Signs the request in, by giving it a cookie the configured secret opens. */
async function signedIn(): Promise<void> {
  next.cookie = await sealSession(READER, SECRET);
}

describe("createNote", () => {
  it("should store the note against the signed-in reader when a session is present", async () => {
    await signedIn();

    await createNote(form({ repository: "pcs-api", body: "Being decommissioned." }));

    expect(api.addNote).toHaveBeenCalledWith("pcs-api", "Being decommissioned.", { subject: "0000-1111", name: "A Reader" });
  });

  it("should show the reader the list they just changed", async () => {
    await signedIn();

    await createNote(form({ repository: "pcs-api", body: "a note" }));

    expect(next.revalidated).toEqual(["/repositories/pcs-api"]);
  });

  it("should record the author as anonymous when authentication is disabled", async () => {
    vi.stubEnv("AUTH_DISABLED", "true");

    await createNote(form({ repository: "pcs-api", body: "a note" }));

    expect(api.addNote).toHaveBeenCalledWith("pcs-api", "a note", { subject: "anonymous", name: "Anonymous" });
  });

  it("should write nothing when the request carries no session and authentication is enabled", async () => {
    // THE ACCEPTANCE CRITERION, at the boundary a direct POST actually reaches. The proxy would have
    // redirected a browser long before here, so a caller arriving without a cookie is posting straight to the
    // action — and this is the check that refuses it.
    await createNote(form({ repository: "pcs-api", body: "a note" }));

    expect(wrote()).toBe(false);
  });

  it("should write nothing when the session cookie was sealed under another secret", async () => {
    next.cookie = await sealSession(READER, "a-completely-different-secret");

    await createNote(form({ repository: "pcs-api", body: "a note" }));

    expect(wrote()).toBe(false);
  });

  it("should refuse before reading the form, so an unauthenticated caller cannot even be told what was wrong", async () => {
    await createNote(form({}));

    expect(wrote()).toBe(false);
    expect(next.revalidated).toEqual([]);
  });

  it.each([
    ["the body is empty", { repository: "pcs-api", body: "" }],
    ["the body is only whitespace", { repository: "pcs-api", body: "   \n " }],
    ["no repository was named", { body: "a note" }],
    ["the repository field is blank", { repository: "  ", body: "a note" }]
  ])("should write nothing when %s", async (_label, fields) => {
    await signedIn();

    await createNote(form(fields));

    expect(wrote()).toBe(false);
  });

  it("should write nothing when the body is over the cap", async () => {
    await signedIn();

    await createNote(form({ repository: "pcs-api", body: "a".repeat(NOTE_BODY_LIMIT + 1) }));

    expect(wrote()).toBe(false);
  });

  it("should store a body at exactly the cap", async () => {
    await signedIn();
    const body = "a".repeat(NOTE_BODY_LIMIT);

    await createNote(form({ repository: "pcs-api", body }));

    expect(api.addNote).toHaveBeenCalledWith("pcs-api", body, expect.anything());
  });

  it("should store the body verbatim rather than escaping it, because the renderer escapes", async () => {
    await signedIn();
    const script = "<script>alert('x')</script>";

    await createNote(form({ repository: "pcs-api", body: script }));

    expect(api.addNote).toHaveBeenCalledWith("pcs-api", script, expect.anything());
  });
});

describe("editNote", () => {
  it("should replace the body of the named note when a session is present", async () => {
    await signedIn();

    await editNote(form({ repository: "pcs-api", id: "a-note-id", body: "Corrected." }));

    expect(api.updateNote).toHaveBeenCalledWith("a-note-id", "Corrected.");
  });

  it("should let any signed-in reader edit a note somebody else wrote", async () => {
    // A DECISION AND NOT AN OMISSION: no author predicate is passed, so nothing here compares the session's
    // subject with the note's. A note nobody can tidy up is worse than one anybody can.
    next.cookie = await sealSession({ subject: "9999-8888", name: "Somebody Else" }, SECRET);

    await editNote(form({ repository: "pcs-api", id: "a-note-id", body: "Corrected." }));

    expect(api.updateNote).toHaveBeenCalledWith("a-note-id", "Corrected.");
  });

  it("should write nothing when the request carries no session", async () => {
    await editNote(form({ repository: "pcs-api", id: "a-note-id", body: "Corrected." }));

    expect(wrote()).toBe(false);
  });

  it.each([
    ["no note was named", { repository: "pcs-api", body: "Corrected." }],
    ["no repository was named", { id: "a-note-id", body: "Corrected." }],
    ["the body is empty", { repository: "pcs-api", id: "a-note-id", body: "" }]
  ])("should write nothing when %s", async (_label, fields) => {
    await signedIn();

    await editNote(form(fields));

    expect(wrote()).toBe(false);
  });

  it("should show the reader the list they just changed", async () => {
    await signedIn();

    await editNote(form({ repository: "pcs-api", id: "a-note-id", body: "Corrected." }));

    expect(next.revalidated).toEqual(["/repositories/pcs-api"]);
  });
});

describe("deleteNote", () => {
  it("should delete the named note when a session is present", async () => {
    await signedIn();

    await deleteNote(form({ repository: "pcs-api", id: "a-note-id" }));

    expect(api.removeNote).toHaveBeenCalledWith("a-note-id");
  });

  it("should let any signed-in reader delete a note somebody else wrote", async () => {
    next.cookie = await sealSession({ subject: "9999-8888", name: "Somebody Else" }, SECRET);

    await deleteNote(form({ repository: "pcs-api", id: "a-note-id" }));

    expect(api.removeNote).toHaveBeenCalledWith("a-note-id");
  });

  it("should delete nothing when the request carries no session", async () => {
    await deleteNote(form({ repository: "pcs-api", id: "a-note-id" }));

    expect(wrote()).toBe(false);
  });

  it("should carry no body, so a delete cannot rewrite what it removes", async () => {
    await signedIn();

    await deleteNote(form({ repository: "pcs-api", id: "a-note-id", body: "ignored" }));

    expect(api.removeNote).toHaveBeenCalledWith("a-note-id");
    expect(api.updateNote).not.toHaveBeenCalled();
  });

  it.each([
    ["no note was named", { repository: "pcs-api" }],
    ["no repository was named", { id: "a-note-id" }]
  ])("should delete nothing when %s", async (_label, fields) => {
    await signedIn();

    await deleteNote(form(fields));

    expect(wrote()).toBe(false);
  });

  it("should show the reader the list they just changed", async () => {
    await signedIn();

    await deleteNote(form({ repository: "pcs-api", id: "a-note-id" }));

    expect(next.revalidated).toEqual(["/repositories/pcs-api"]);
  });
});
