import { type NextRequest, NextResponse } from "next/server";
import { exempt } from "@/auth/guard";
import { readSession, SESSION_COOKIE } from "@/auth/session";
import { authRequired } from "@/auth/settings";
import { rememberableWeeks, WEEKS_COOKIE, weeksCookie } from "@/lib/weeks";

/**
 * Remembers the span a request named, so the navigation bar cannot quietly change the window.
 *
 * Named `proxy` in `src/proxy.ts`: Next 16 deprecated the `middleware` file convention in favour of
 * this one, and the two are the same hook under two names.
 *
 * The three list links are rendered by the layout, which Next.js hands no search parameters, so they
 * carry no `?weeks=` and resolve their span from the cookie. The selector writes that cookie, which
 * covers a reader who chose a span here — but not one who arrived on a shared `/repositories?weeks=26`
 * link and clicked Contributors without touching the buttons: no cookie, so the whole page drops to
 * the service's default with nothing saying the window moved. Writing the cookie for any request that
 * named a span makes following such a link mean the same as pressing the button.
 *
 * It is written through `weeksCookie`, the same builder the selector uses, so the attributes are
 * spelled once. Nothing is written when the value could not be a span or when the cookie already
 * holds it — a `Set-Cookie` on every request would be noise on the way past.
 *
 * This does not touch what the CURRENT render reads: `resolveWeeks` takes `?weeks=` over the cookie,
 * so the page the reader asked for is the page they get, cookie or no cookie.
 */
/**
 * Sends a reader with no session to sign in, before anything renders.
 *
 * Here rather than in a layout or a per-page check, because this is the one place every request already passes
 * through: a guard in a layout is a guard somebody can forget to add to the next page, and the pages hold the
 * estate's alert counts and merge-gate posture. A 307 rather than a 401 so a browser follows it and a reader
 * simply arrives at Microsoft.
 *
 * `authRequired` is checked first and fails closed — see `src/auth/settings.ts`. `authSettings()` is not called
 * here at all: it throws when the environment is incomplete, and throwing from middleware would take out
 * `/health` along with everything else, so the deployment would look dead rather than misconfigured. The login
 * route calls it, which is where a configuration error becomes visible without costing the probes.
 */
async function guarded(request: NextRequest): Promise<NextResponse | undefined> {
  if (!authRequired() || exempt(request.nextUrl.pathname)) {
    return undefined;
  }
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    return NextResponse.redirect(new URL("/auth/login", request.nextUrl.origin), 307);
  }
  const session = await readSession(request.cookies.get(SESSION_COOKIE)?.value, secret);
  if (session !== undefined) {
    return undefined;
  }
  const login = new URL("/auth/login", request.nextUrl.origin);
  // The whole path and query, so a shared `/repositories?weeks=26` link survives the sign-in it triggers.
  login.searchParams.set("redirect", `${request.nextUrl.pathname}${request.nextUrl.search}`);
  return NextResponse.redirect(login, 307);
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const challenge = await guarded(request);
  if (challenge !== undefined) {
    return challenge;
  }

  const response = NextResponse.next();
  const asked = rememberableWeeks(request.nextUrl.searchParams.get(WEEKS_COOKIE));
  if (asked !== null && String(asked) !== request.cookies.get(WEEKS_COOKIE)?.value) {
    response.headers.append("set-cookie", weeksCookie(asked));
  }
  return response;
}

/**
 * Every route but the build's own assets.
 *
 * The pages are what carry `?weeks=`; a static chunk or an image never does, and running this for
 * each of them would be work with nothing to decide.
 */
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"]
};
