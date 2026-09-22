import { describe, expect, it } from "vitest";
import { ANONYMOUS_AUTHOR, writingAuthor } from "./author.ts";
import { type Session, sealSession } from "./session.ts";

const SECRET = "a-test-session-secret-long-enough-to-be-plausible";

/** Authentication on, and the secret the cookies below are sealed under. */
const PROTECTED = { SESSION_SECRET: SECRET };

const READER: Session = { subject: "0000-1111", name: "A Reader", email: "a.reader@justice.gov.uk" };

describe("writingAuthor where authentication is enabled", () => {
  it("should name the signed-in reader when the cookie opens", async () => {
    const author = await writingAuthor(await sealSession(READER, SECRET), PROTECTED);

    expect(author).toEqual({ subject: "0000-1111", name: "A Reader" });
  });

  it("should carry the subject as the identity and the name for display, and nothing else", async () => {
    // The email is in the session and must not reach a note: the page prints a name, and an address is
    // personal data the table has no reason to hold.
    const author = await writingAuthor(await sealSession(READER, SECRET), PROTECTED);

    expect(Object.keys(author ?? {}).sort((left, right) => left.localeCompare(right))).toEqual(["name", "subject"]);
  });

  it.each([
    ["no cookie at all", undefined],
    ["an empty cookie", ""],
    ["a value that is not a sealed token", "not-a-jwe"]
  ])("should refuse the write when a request carries %s", async (_label, cookie) => {
    // THE ACCEPTANCE CRITERION: with authentication on, a caller with no valid session cannot write. A server
    // action is reachable by a direct POST, so this is the check that stands between one and the table.
    expect(await writingAuthor(cookie, PROTECTED)).toBeUndefined();
  });

  it("should refuse the write when the cookie was sealed under a different secret", async () => {
    expect(await writingAuthor(await sealSession(READER, "a-completely-different-secret"), PROTECTED)).toBeUndefined();
  });

  it("should refuse the write when a cookie has been tampered with", async () => {
    const sealed = await sealSession(READER, SECRET);

    expect(await writingAuthor(`${sealed.slice(0, -4)}AAAA`, PROTECTED)).toBeUndefined();
  });

  it("should refuse the write when no sealing secret is configured, rather than letting one through", async () => {
    // Fail closed. A deployment that lost SESSION_SECRET can verify nobody, so it may write for nobody —
    // and it must not fall back to the anonymous author, which is the `AUTH_DISABLED` case and not this one.
    expect(await writingAuthor(await sealSession(READER, SECRET), {})).toBeUndefined();
  });

  it("should refuse the write when the secret is only whitespace", async () => {
    expect(await writingAuthor(await sealSession(READER, SECRET), { SESSION_SECRET: "   " })).toBeUndefined();
  });
});

describe("writingAuthor where authentication is disabled", () => {
  it("should record the author as anonymous when AUTH_DISABLED is set exactly", async () => {
    expect(await writingAuthor(undefined, { AUTH_DISABLED: "true" })).toEqual(ANONYMOUS_AUTHOR);
  });

  it("should name the anonymous author rather than leaving either field blank", async () => {
    // Both columns are NOT NULL and refuse the blank string, so an anonymous note needs a stated value for
    // each. This is what keeps `yarn dev` and the preview environment working.
    expect(ANONYMOUS_AUTHOR.subject.trim()).not.toBe("");
    expect(ANONYMOUS_AUTHOR.name.trim()).not.toBe("");
  });

  it("should not collide with a real Entra subject", async () => {
    // Entra issues GUIDs, so a literal word cannot be mistaken for one — which is what stops an anonymous
    // note ever being attributed to a person.
    expect(ANONYMOUS_AUTHOR.subject).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/i);
  });

  it("should ignore a cookie entirely when authentication is off", async () => {
    // There is no session to read and no secret to read it with, so the cookie is not consulted: a stale
    // sealed cookie left over from a protected deployment must not name somebody in a preview environment.
    expect(await writingAuthor(await sealSession(READER, SECRET), { AUTH_DISABLED: "true" })).toEqual(ANONYMOUS_AUTHOR);
  });

  it.each(["", "false", "TRUE", "1", "yes"])("should still require a session for AUTH_DISABLED=%s", async (value) => {
    // Anything but the exact string is a typo, and a typo must not open the write path.
    expect(await writingAuthor(undefined, { AUTH_DISABLED: value, SESSION_SECRET: SECRET })).toBeUndefined();
  });
});
