import { describe, expect, it } from "vitest";
import { readSession, SESSION_MAX_AGE, type Session, sealSession } from "./session.ts";
import { authSettings, sessionSecret } from "./settings.ts";

const SECRET = "a-test-session-secret-long-enough-to-be-plausible";

const READER: Session = { subject: "0000-1111", name: "A Reader", email: "a.reader@justice.gov.uk" };

describe("sealSession and readSession", () => {
  it("should carry a reader back out unchanged", async () => {
    expect(await readSession(await sealSession(READER, SECRET), SECRET)).toEqual(READER);
  });

  it("should carry a reader with no email address", async () => {
    const anonymous: Session = { subject: "0000-2222", name: "No Address" };

    expect(await readSession(await sealSession(anonymous, SECRET), SECRET)).toEqual(anonymous);
  });

  it("should not put the reader's identity where a browser can read it", async () => {
    // The point of encrypting rather than signing: none of this should be legible in the cookie.
    const sealed = await sealSession(READER, SECRET);

    expect(sealed).not.toContain("A Reader");
    expect(sealed).not.toContain("justice.gov.uk");
  });

  it("should refuse a cookie sealed under a different secret", async () => {
    expect(await readSession(await sealSession(READER, "a-completely-different-secret"), SECRET)).toBeUndefined();
  });

  it("should refuse a tampered cookie rather than trusting part of it", async () => {
    const sealed = await sealSession(READER, SECRET);
    const tampered = `${sealed.slice(0, -4)}AAAA`;

    expect(await readSession(tampered, SECRET)).toBeUndefined();
  });

  it("should refuse a cookie that has expired", async () => {
    const issued = new Date(Date.now() - (SESSION_MAX_AGE + 60) * 1000);

    expect(await readSession(await sealSession(READER, SECRET, issued), SECRET)).toBeUndefined();
  });

  it.each([
    ["nothing", undefined],
    ["an empty string", ""],
    ["a value that is not a token at all", "not-a-jwe"]
  ])("should refuse %s", async (_label, cookie) => {
    expect(await readSession(cookie, SECRET)).toBeUndefined();
  });
});

describe("sealing and verifying across the two readers", () => {
  it("should verify a cookie the callback sealed, given an untrimmed environment value", async () => {
    // The endless-loop bug end to end: the callback seals with authSettings().sessionSecret and the guard
    // verifies with sessionSecret(). Both must resolve the same key from the same untrimmed vault value.
    const env = {
      ENTRA_TENANT_ID: "t",
      ENTRA_CLIENT_ID: "c",
      ENTRA_CLIENT_SECRET: "s",
      ENTRA_REDIRECT_URI: "https://metrics.example/auth/callback",
      SESSION_SECRET: "  a-vault-secret-with-surrounding-space\n"
    };

    const sealed = await sealSession(READER, authSettings(env).sessionSecret);

    expect(await readSession(sealed, sessionSecret(env) as string)).toEqual(READER);
  });
});
