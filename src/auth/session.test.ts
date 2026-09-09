import { describe, expect, it } from "vitest";
import { permitted, readSession, SESSION_MAX_AGE, type Session, sealSession } from "./session.ts";

const SECRET = "a-test-session-secret-long-enough-to-be-plausible";

const READER: Session = { subject: "0000-1111", name: "A Reader", email: "a.reader@justice.gov.uk", groups: ["group-a"] };

describe("sealSession and readSession", () => {
  it("should carry a reader back out unchanged", async () => {
    expect(await readSession(await sealSession(READER, SECRET), SECRET)).toEqual(READER);
  });

  it("should carry a reader with no email address", async () => {
    const anonymous: Session = { subject: "0000-2222", name: "No Address", groups: [] };

    expect(await readSession(await sealSession(anonymous, SECRET), SECRET)).toEqual(anonymous);
  });

  it("should not put the reader's identity where a browser can read it", async () => {
    // The point of encrypting rather than signing: none of this should be legible in the cookie.
    const sealed = await sealSession(READER, SECRET);

    expect(sealed).not.toContain("A Reader");
    expect(sealed).not.toContain("justice.gov.uk");
    expect(sealed).not.toContain("group-a");
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

describe("permitted", () => {
  it("should admit any authenticated reader when no group is named", () => {
    // The tenant is the boundary in that case: the registration is AzureADMyOrg, so Entra has already refused
    // everybody outside HMCTS before the request arrives.
    expect(permitted({ ...READER, groups: [] }, [])).toBe(true);
  });

  it("should admit a reader holding a permitted group", () => {
    expect(permitted({ ...READER, groups: ["group-b", "group-a"] }, ["group-a"])).toBe(true);
  });

  it("should refuse a reader holding none of the permitted groups", () => {
    expect(permitted({ ...READER, groups: ["group-c"] }, ["group-a", "group-b"])).toBe(false);
  });

  it("should refuse a reader carrying no groups at all when a group is required", () => {
    // The shape of a registration that has not declared groupMembershipClaims: sign-in works and the claim is
    // simply absent, so this must be a refusal rather than a pass.
    expect(permitted({ ...READER, groups: [] }, ["group-a"])).toBe(false);
  });
});
