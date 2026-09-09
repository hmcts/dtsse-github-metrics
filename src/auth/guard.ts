/**
 * Which requests may be served without a session, and where a reader may be sent afterwards.
 *
 * Both decisions are pure functions here rather than conditions inside the middleware, because both are the
 * kind of thing that is wrong quietly: an over-broad exemption serves the estate's security posture to anybody,
 * and an unchecked return path turns the sign-in into an open redirect. They are testable in isolation for
 * exactly that reason.
 */

/**
 * Paths served without a session.
 *
 * `/health` is load-bearing in two places that fail the deployment rather than the request if it is protected:
 * the `nodejs` chart's startup, readiness and liveness probes, and the CNP pipeline's `HealthChecker`, which
 * polls `${SERVICE_FQDN}/health` forty times before it will promote a build. A 302 to Microsoft is not `UP`.
 *
 * `/_next` carries the compiled bundles and the stylesheet. They hold no estate data — the figures arrive
 * server-rendered in the document, which IS protected — and nothing renders without them.
 */
const EXEMPT_PATHS = ["/health", "/liveness", "/readiness", "/favicon.ico"];

/**
 * Every prefix ends in `/`, which is the point of writing them this way.
 *
 * `"/health"` as a PREFIX would also exempt `/health-summary` or `/healthcheck-report`, so a page added under a
 * name that merely starts the same way would be published without anybody deciding to. There is no such route
 * today, which is exactly why the boundary belongs here rather than in a note for whoever adds one.
 */
const EXEMPT_PREFIXES = ["/health/", "/auth/", "/_next/"];

export function exempt(pathname: string): boolean {
  return EXEMPT_PATHS.includes(pathname) || EXEMPT_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/**
 * A backslash, or any C0 control character or DEL.
 *
 * A loop rather than a character class, because the class has to contain the control characters it matches and
 * the linter rightly objects to that — one in a pattern is usually a mistake. Suppressing the rule to keep a
 * one-liner would spend the warning that catches the genuine ones, and spelled out the rule is plainer anyway.
 */
function unsafeInAPath(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (character === "\\" || code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/**
 * The path a reader may be returned to after signing in, or `/repositories` if the one asked for is not safe.
 *
 * ONLY same-origin paths. `redirect=https://elsewhere.example` would otherwise make the sign-in a credible open
 * redirect: the link starts on a real HMCTS hostname, the reader completes a real Microsoft sign-in, and the
 * last hop lands somewhere else entirely. Rejected rather than sanitised, because a value that is not a plain
 * path is not a near-miss to be repaired — it is a request nobody legitimate makes.
 *
 * Three things a naive "must start with /" check admits, and all three are refused:
 *   - `//elsewhere.example`, which browsers read as protocol-relative and follow off the origin;
 *   - `/\elsewhere.example`, which some browsers have historically normalised into the same thing;
 *   - a control character, because a newline in a `Location` header is a response split.
 */
export function safeReturnTo(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) {
    return "/repositories";
  }
  if (unsafeInAPath(value)) {
    return "/repositories";
  }
  return value;
}
