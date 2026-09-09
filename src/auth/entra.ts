import * as client from "openid-client";
import { SIGN_IN_MAX_AGE } from "./cookies.ts";
import { open, seal } from "./sealed.ts";
import type { Session } from "./session.ts";
import { type AuthSettings, issuerUrl } from "./settings.ts";

/**
 * The Entra half of the sign-in: discovery, the authorization URL, and the code exchange.
 *
 * `openid-client` rather than a hand-rolled flow with `jose`, which this service already depends on and could
 * technically manage. Token validation is where OIDC implementations go subtly wrong — signature, issuer,
 * audience, nonce, `azp`, clock skew, and which of them are optional — and none of that is this repository's
 * problem to be original about. It is also what `cms-template` uses, at this version, so a reader moving
 * between the two DTSSE services meets one library rather than two.
 */

/** What the sign-in has to remember between the redirect out and the callback back. */
export interface SignInState {
  state: string;
  nonce: string;
  codeVerifier: string;
  /** Where the reader was going before they were interrupted. */
  returnTo: string;
}

/**
 * Discovery is memoised per process.
 *
 * The metadata is stable and the request is a round trip to Microsoft that would otherwise happen twice per
 * sign-in. Keyed by nothing because a process serves exactly one tenant and client; if that ever stops being
 * true this must become a map rather than gain a second cached slot.
 */
let discovered: Promise<client.Configuration> | undefined;

export function forgetDiscovery(): void {
  discovered = undefined;
}

export function configuration(settings: AuthSettings): Promise<client.Configuration> {
  /**
   * Cached on success only.
   *
   * A bare `??=` would memoise a REJECTED promise for the life of the process, so one transient failure on the
   * first sign-in after a deploy — DNS, an egress blip, an Entra 5xx — would poison every later sign-in with the
   * same stale error. Nothing would recover it either: `/health` never touches Entra, so the pod is never
   * restarted for it.
   */
  discovered ??= client.discovery(issuerUrl(settings.tenantId), settings.clientId, settings.clientSecret).catch((error: unknown) => {
    discovered = undefined;
    throw error;
  });
  return discovered;
}

export async function sealSignIn(signIn: SignInState, secret: string): Promise<string> {
  return await seal({ ...signIn }, secret, SIGN_IN_MAX_AGE);
}

/**
 * The sign-in a callback's cookie describes, or `undefined` if there is nothing usable to compare against.
 *
 * A callback without this cannot be completed, and must not be: the state and nonce it would otherwise be
 * checked against are exactly what stop a forged callback from establishing a session.
 */
export async function readSignIn(cookie: string | undefined, secret: string): Promise<SignInState | undefined> {
  const payload = await open(cookie, secret);
  if (payload === undefined) {
    return undefined;
  }
  const { state, nonce, codeVerifier, returnTo } = payload;
  if (typeof state !== "string" || typeof nonce !== "string" || typeof codeVerifier !== "string") {
    return undefined;
  }
  return { state, nonce, codeVerifier, returnTo: typeof returnTo === "string" ? returnTo : "/" };
}

export function beginSignIn(returnTo: string): SignInState {
  return {
    state: client.randomState(),
    nonce: client.randomNonce(),
    codeVerifier: client.randomPKCECodeVerifier(),
    returnTo
  };
}

export async function authorizationUrl(settings: AuthSettings, signIn: SignInState): Promise<URL> {
  return client.buildAuthorizationUrl(await configuration(settings), {
    redirect_uri: settings.redirectUri,
    // `openid` for an id token, `profile` for a display name, `email` for an address. No Graph scopes: the
    // dashboard reads nothing from Graph, and asking for permissions it never uses would put the registration
    // through an admin-consent conversation it does not need.
    scope: "openid profile email",
    state: signIn.state,
    nonce: signIn.nonce,
    code_challenge: await client.calculatePKCECodeChallenge(signIn.codeVerifier),
    code_challenge_method: "S256"
  });
}

export class SignInFailed extends Error {}

/**
 * The session a completed callback establishes.
 *
 * The claims are read for identity only — a name to show and a subject to log. Nothing here decides whether the
 * reader may read the dashboard, because having signed in is what decides that.
 */
export async function completeSignIn(settings: AuthSettings, currentUrl: URL, signIn: SignInState): Promise<Session> {
  let tokens: Awaited<ReturnType<typeof client.authorizationCodeGrant>>;
  try {
    tokens = await client.authorizationCodeGrant(await configuration(settings), currentUrl, {
      expectedState: signIn.state,
      expectedNonce: signIn.nonce,
      pkceCodeVerifier: signIn.codeVerifier
    });
  } catch (error) {
    throw new SignInFailed(error instanceof Error ? error.message : String(error));
  }

  const claims = tokens.claims();
  if (claims?.sub === undefined) {
    throw new SignInFailed("Entra returned no id token subject, so there is no identity to hold a session for");
  }

  return {
    subject: claims.sub,
    name: typeof claims.name === "string" ? claims.name : claims.sub,
    ...(typeof claims.email === "string" ? { email: claims.email } : {})
  };
}

/**
 * Where to send a reader who has signed out, so Entra forgets them too.
 *
 * No `post_logout_redirect_uri`. Entra only honours one that is registered on the application, and the
 * registration holds the callback and nothing else — so passing the dashboard's address would be ignored, and
 * registering a second URI to save one click is not worth another platform PR. The reader lands on Microsoft's
 * signed-out page, which at least says plainly what happened.
 */
export async function signOutUrl(settings: AuthSettings): Promise<URL | undefined> {
  const endpoint = (await configuration(settings)).serverMetadata().end_session_endpoint;
  return endpoint === undefined ? undefined : new URL(endpoint);
}
