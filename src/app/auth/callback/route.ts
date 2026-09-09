import { type NextRequest, NextResponse } from "next/server";
import { clearedSignInCookie, SIGN_IN_COOKIE, sessionCookie } from "@/auth/cookies";
import { completeSignIn, readSignIn, SignInFailed } from "@/auth/entra";
import { safeReturnTo } from "@/auth/guard";
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
    return NextResponse.redirect(new URL("/repositories", request.nextUrl.origin));
  }

  const settings = authSettings();
  const signIn = await readSignIn(request.cookies.get(SIGN_IN_COOKIE)?.value, settings.sessionSecret);

  if (signIn === undefined) {
    // No sign-in in flight. Most often somebody used the back button onto a spent callback, or took longer than
    // SIGN_IN_MAX_AGE; starting again is the right answer to both.
    console.warn("a callback arrived with no sign-in in flight, so it was sent back to start again");
    return NextResponse.redirect(new URL("/auth/login", request.nextUrl.origin));
  }

  let session: Awaited<ReturnType<typeof completeSignIn>>;
  try {
    session = await completeSignIn(settings, request.nextUrl, signIn);
  } catch (error) {
    console.warn(`a sign-in could not be completed: ${error instanceof SignInFailed ? error.message : String(error)}`);
    return signInRefused(request, "We could not complete your sign-in.");
  }

  console.info(`${session.name} signed in`);
  const response = NextResponse.redirect(new URL(safeReturnTo(signIn.returnTo), request.nextUrl.origin));
  response.headers.append("set-cookie", sessionCookie(await sealSession(session, settings.sessionSecret)));
  response.headers.append("set-cookie", clearedSignInCookie());
  return response;
}

function signInRefused(request: NextRequest, detail: string): Response {
  const response = new NextResponse(detail, { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } });
  // The sign-in is spent either way, and leaving it would let a refused attempt be replayed until it expired.
  response.headers.append("set-cookie", clearedSignInCookie());
  return response;
}
