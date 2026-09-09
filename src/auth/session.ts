import { open, seal } from "./sealed.ts";

/**
 * The reader's session, held entirely in an encrypted cookie.
 *
 * No server-side store, deliberately. Sessions are the only state the web half would need one for, and a Redis
 * instance is a thing to provision, secure, monitor and pay for in exchange for logout-everywhere on a
 * read-only dashboard. The cost is that a session cannot be revoked before it expires, which is what keeps
 * `SESSION_MAX_AGE` down to a working day.
 */
export interface Session {
  subject: string;
  name: string;
  email?: string;
}

export const SESSION_COOKIE = "gm_session";

/** Eight hours: a working day, so a reader signs in once rather than being interrupted mid-afternoon. */
export const SESSION_MAX_AGE = 8 * 60 * 60;

export async function sealSession(session: Session, secret: string, now = new Date()): Promise<string> {
  return await seal({ ...session }, secret, SESSION_MAX_AGE, now);
}

export async function readSession(cookie: string | undefined, secret: string): Promise<Session | undefined> {
  const payload = await open(cookie, secret);
  if (payload === undefined) {
    return undefined;
  }
  const { subject, name, email } = payload;
  if (typeof subject !== "string" || typeof name !== "string") {
    return undefined;
  }
  return {
    subject,
    name,
    ...(typeof email === "string" ? { email } : {})
  };
}
