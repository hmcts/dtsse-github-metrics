import type { NextRequest } from "next/server";
import { clearedSignInCookie, SIGN_IN_COOKIE, sessionCookie } from "@/auth/cookies";
import { completeSignIn, readSignIn, SignInFailed } from "@/auth/entra";
import { safeReturnTo } from "@/auth/guard";
import { redirectTo } from "@/auth/redirect";
import { sealSession } from "@/auth/session";
import { authRequired, authSettings } from "@/auth/settings";

export const dynamic = "force-dynamic";

/**
 * Where Entra returns the reader, and the only place a session is ever created.
 *
 * Failures are deliberately vague to the browser and specific to the log. A reader can do nothing with the
 * detail of why a state check failed, and an attacker probing the callback should not be told which of the
 * state, the nonce or the code was the one that gave them away.
 */
export async function GET(request: NextRequest): Promise<Response> {
  if (!authRequired()) {
    return redirectTo("/repositories");
  }

  const settings = authSettings();
  const signIn = await readSignIn(request.cookies.get(SIGN_IN_COOKIE)?.value, settings.sessionSecret);

  if (signIn === undefined) {
    // No sign-in in flight. Most often somebody used the back button onto a spent callback, or took longer than
    // SIGN_IN_MAX_AGE; starting again is the right answer to both.
    console.warn("a callback arrived with no sign-in in flight, so it was sent back to start again");
    return redirectTo("/auth/login");
  }

  /**
   * The registered redirect URI, NOT `request.nextUrl`.
   *
   * `authorizationCodeGrant` derives the token request's `redirect_uri` from the URL it is handed —
   * `redirectUri = stripParams(currentUrl)` — and a route handler's `nextUrl` carries the server's own listen
   * address, which in Kubernetes is the pod name. Handing it `nextUrl` posts
   * `redirect_uri=http://<pod-name>:3000/auth/callback`, which matches neither the authorization request nor the
   * registration, and Entra answers AADSTS50011. The query has to come along because that is where the code and
   * state are.
   */
  const callbackUrl = new URL(`${settings.redirectUri}${request.nextUrl.search}`);

  let session: Awaited<ReturnType<typeof completeSignIn>>;
  try {
    session = await completeSignIn(settings, callbackUrl, signIn);
  } catch (error) {
    console.warn(`a sign-in could not be completed: ${error instanceof SignInFailed ? error.message : String(error)}`);
    return signInRefused();
  }

  console.info(`${session.name} signed in`);
  const response = redirectTo(safeReturnTo(signIn.returnTo));
  response.headers.append("set-cookie", sessionCookie(await sealSession(session, settings.sessionSecret)));
  response.headers.append("set-cookie", clearedSignInCookie());
  return response;
}

/**
 * A refusal a reader can act on.
 *
 * The link matters: two dashboard links opened at once both start a sign-in, the second overwrites the one
 * `gm_sign_in` cookie, and the first tab's callback then fails its state check. Reloading replays a spent code
 * and fails again, so without a way back that tab is simply stuck.
 */
function signInRefused(): Response {
  const body =
    "We could not complete your sign-in.\n\n" +
    "This usually means the attempt took too long, or another sign-in was started in a different tab.\n\n" +
    "Start again: /auth/login\n";
  const response = new Response(body, { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } });
  // The sign-in is spent either way, and leaving it would let a refused attempt be replayed until it expired.
  response.headers.append("set-cookie", clearedSignInCookie());
  return response;
}
