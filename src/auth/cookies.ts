import { SESSION_COOKIE, SESSION_MAX_AGE } from "./session.ts";

/**
 * Cookie attributes for the two cookies the sign-in uses, spelled once each.
 *
 * `Secure` is unconditional. The dashboard is only ever reached over HTTPS through the front door, and making
 * it conditional on an environment variable would mean the one deployment that got the variable wrong sent the
 * session in clear — the case the attribute exists for. Local development over http://localhost is exempt in
 * every browser's implementation, so nothing is lost by not having a switch.
 */
const SHARED = ["path=/", "HttpOnly", "Secure"];

/**
 * `SameSite=Lax`, not `Strict`.
 *
 * Entra returns the reader to the callback by a cross-site redirect, and `Strict` withholds cookies on exactly
 * that navigation — so the state cookie would be missing at the moment it is checked and every sign-in would
 * fail the state comparison. `Lax` sends cookies on a top-level GET, which is what the callback is.
 */
export function sessionCookie(value: string): string {
  return [`${SESSION_COOKIE}=${value}`, ...SHARED, `max-age=${SESSION_MAX_AGE}`, "SameSite=Lax"].join("; ");
}

export function clearedSessionCookie(): string {
  return [`${SESSION_COOKIE}=`, ...SHARED, "max-age=0", "SameSite=Lax"].join("; ");
}

export const SIGN_IN_COOKIE = "gm_sign_in";

/** Ten minutes: long enough for somebody to complete a Microsoft sign-in, short enough that a stale one dies. */
export const SIGN_IN_MAX_AGE = 600;

export function signInCookie(value: string): string {
  return [`${SIGN_IN_COOKIE}=${value}`, ...SHARED, `max-age=${SIGN_IN_MAX_AGE}`, "SameSite=Lax"].join("; ");
}

export function clearedSignInCookie(): string {
  return [`${SIGN_IN_COOKIE}=`, ...SHARED, "max-age=0", "SameSite=Lax"].join("; ");
}
