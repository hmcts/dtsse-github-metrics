import { NextResponse } from "next/server";

/**
 * Redirects that do not name this service's own host.
 *
 * `NextResponse.redirect` needs an absolute URL, and a route handler emits whatever it is given VERBATIM — only
 * middleware responses get relativised on the way out. There is no correct absolute URL to give it here: a route
 * handler's `request.nextUrl` is built from the server's own listen address, not from the `Host` header, and in
 * Kubernetes that is the pod name. Measured: with `Host: github-metrics.aat.platform.hmcts.net` the emitted
 * `Location` was still the listen address, so a reader would be sent to `https://<pod-name>:3000/repositories`
 * and get a dead end.
 *
 * A relative `Location` is legal and the browser resolves it against the address it actually asked for, which is
 * the one that works. `X-Forwarded-Proto` is honoured for the scheme but the host is not, so there is nothing to
 * fix by configuration.
 */
export function redirectTo(path: string): NextResponse {
  return new NextResponse(null, { status: 307, headers: { location: path } });
}

/** Somewhere off this service, where an absolute URL is the only option and is the correct one. */
export function redirectAway(url: URL): NextResponse {
  return NextResponse.redirect(url, 307);
}
