import { readSession, SESSION_COOKIE } from "./session.ts";
import { authRequired, type Environment, sessionSecret } from "./settings.ts";

/**
 * Who is making a write, or the refusal of one.
 *
 * THIS IS THE GATE ON THE ONLY WRITE PATH IN THE APPLICATION, and it exists as a module rather than as a
 * check inside the server action for the reason `guard.ts` gives about its own two functions: it is the kind
 * of thing that is wrong quietly. A missing check here is not a broken page, it is an unauthenticated caller
 * writing to the estate's database, and nothing about the page would look different.
 *
 * WHY THE PROXY IS NOT ENOUGH. `src/proxy.ts` already refuses every non-exempt request without a session, and
 * a server action is a POST to the page's own route, so it passes through that guard too. This is deliberately
 * a SECOND check and not a duplicated one: React server functions are reachable by a direct POST carrying an
 * action id rather than only through the form on the page, so the framework's own guidance is to verify
 * authentication inside every one of them. Two refusals on one path is the correct number when the cost of the
 * first being bypassed is a write.
 *
 * It is NOT a second implementation. Every decision below is made by the existing auth module — `authRequired`
 * for whether a session is needed, `sessionSecret` for the key, `readSession` for opening the cookie — so
 * there is one answer to "is this reader signed in" and one place the sealing secret is trimmed. What is new
 * here is only the question: not "may this request be served" but "whose name goes on this row".
 *
 * FAIL CLOSED, on `authRequired`'s own terms. `undefined` is returned for every case that is not a reader
 * this service can name: no secret configured, no cookie, a cookie that does not open. The caller writes
 * nothing when it gets `undefined`.
 */

/** Who a note is attributed to: the identity that persists, and the name a reader sees. */
export interface Author {
  /** The Entra subject claim. Stable for the life of the account, and never shown to anybody. */
  subject: string;
  /** What to print. A display name, so it can change without the note changing hands. */
  name: string;
}

/**
 * The author recorded where authentication is switched off.
 *
 * `AUTH_DISABLED=true` is `yarn dev`, a preview environment, and the pipeline's throwaway AAT release — none
 * of which can complete an Entra sign-in, so there is no session and no name to read. A note written there is
 * attributed to ANONYMOUS, which is a stated value rather than a blank or an invented one: the row still
 * satisfies the table's `_attributed` constraint, the page still prints an author, and what it prints is true.
 *
 * `subject` is the literal string rather than an empty one or a generated identifier. It is not a subject any
 * tenant issues — Entra's are GUIDs — so it cannot collide with a real person, and every anonymous note
 * sharing one subject is honest: they are not distinguishable, and pretending otherwise by minting an
 * identifier per note would claim they came from different people.
 */
export const ANONYMOUS_AUTHOR: Author = { subject: "anonymous", name: "Anonymous" };

/**
 * The author to record for this request, or `undefined` if there is nobody to record.
 *
 * `undefined` MEANS REFUSE, and it is the only signal a caller needs: the two states that are not a refusal —
 * a signed-in reader, and authentication being off — both produce an `Author`, so a caller has one branch to
 * write and cannot accidentally treat the anonymous case as a failure or the failed case as anonymous.
 *
 * THE SEALED COOKIE IS PASSED IN rather than read from `next/headers` here, which is the same shape
 * `readSession` keeps and for the same two reasons: this module stays testable without a request, and it stays
 * importable by anything that already holds the value. The server action is where `cookies()` is awaited.
 *
 * `env` defaults to `process.env` for `authRequired`'s reason and is threaded through to both of the settings
 * calls below, so a test states an environment rather than mutating the process's.
 */
export async function writingAuthor(cookie: string | undefined, env: Environment = process.env): Promise<Author | undefined> {
  if (!authRequired(env)) {
    return ANONYMOUS_AUTHOR;
  }
  const secret = sessionSecret(env);
  if (secret === undefined) {
    return undefined;
  }
  const session = await readSession(cookie, secret);
  if (session === undefined) {
    return undefined;
  }
  // The subject is the identity and the name is for display, so a renamed person keeps their notes. `name` is
  // a required field on `Session` — `readSession` refuses a payload without one — so there is no fallback to
  // write here, and inventing one from the email would print a local part at a reader.
  return { subject: session.subject, name: session.name };
}

/** The cookie name a caller reads before calling `writingAuthor`, re-exported so it imports one module. */
export { SESSION_COOKIE };
