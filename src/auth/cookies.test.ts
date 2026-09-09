import { describe, expect, it } from "vitest";
import { clearedSessionCookie, clearedSignInCookie, SIGN_IN_COOKIE, sessionCookie, signInCookie } from "./cookies.ts";
import { SESSION_COOKIE, SESSION_MAX_AGE } from "./session.ts";

/**
 * The attributes rather than the values, because the attributes are the part that protects the cookie and the
 * part a refactor can silently drop.
 */
describe.each([
  ["session", () => sessionCookie("a-value"), SESSION_COOKIE],
  ["sign-in", () => signInCookie("a-value"), SIGN_IN_COOKIE]
])("%s cookie", (_label, build, name) => {
  it("should name the cookie and carry the value", () => {
    expect(build()).toContain(`${name}=a-value`);
  });

  it("should be unreadable to scripts", () => {
    expect(build()).toContain("HttpOnly");
  });

  it("should never be sent in clear", () => {
    expect(build()).toContain("Secure");
  });

  it("should be sent on the redirect back from Entra, which SameSite=Strict would withhold", () => {
    // Strict withholds cookies on a cross-site navigation, which is exactly what the callback is — so the
    // sign-in would fail its own state check every time.
    expect(build()).toContain("SameSite=Lax");
    expect(build()).not.toContain("SameSite=Strict");
  });

  it("should apply to the whole site", () => {
    expect(build()).toContain("path=/");
  });
});

describe("session cookie", () => {
  it("should last a working day", () => {
    expect(sessionCookie("a-value")).toContain(`max-age=${SESSION_MAX_AGE}`);
    expect(SESSION_MAX_AGE).toBe(8 * 60 * 60);
  });
});

describe("sign-in cookie", () => {
  it("should be short-lived, since it only spans one Microsoft sign-in", () => {
    expect(signInCookie("a-value")).toContain("max-age=600");
  });
});

describe.each([
  ["session", clearedSessionCookie, SESSION_COOKIE],
  ["sign-in", clearedSignInCookie, SIGN_IN_COOKIE]
])("clearing the %s cookie", (_label, clear, name) => {
  it("should expire it immediately", () => {
    expect(clear()).toContain("max-age=0");
    expect(clear()).toContain(`${name}=`);
  });

  it("should keep the attributes, or the browser keeps the cookie it was told to drop", () => {
    // A Set-Cookie that does not match the original's path and flags does not replace it.
    expect(clear()).toContain("path=/");
    expect(clear()).toContain("HttpOnly");
    expect(clear()).toContain("Secure");
  });
});
