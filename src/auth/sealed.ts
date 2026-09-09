import { EncryptJWT, jwtDecrypt } from "jose";

/**
 * Putting a small object in a cookie so that the browser holding it can neither read nor alter it.
 *
 * ENCRYPTED, not merely signed. Both the things carried this way — a reader's identity and a sign-in's state —
 * would be legible to anything that can see a request otherwise: a proxy log, a browser extension, a
 * screenshot of devtools. Neither is worth much alone, but there is no reason to publish somebody's name and
 * group memberships to hold a session. `dir` with A256GCM both hides and authenticates in one pass, so a
 * tampered cookie fails to decrypt rather than needing a separate signature check.
 */

/**
 * A 32-byte key for A256GCM, derived from the configured secret rather than used raw.
 *
 * The secret is a vault string of whatever length somebody generated, and `dir` requires exactly 256 bits.
 * SHA-256 because it is a fixed-length digest of the WHOLE input: truncating would silently discard entropy,
 * and padding would make a short secret look adequate. A 31-character secret should be a weak key, not a
 * runtime exception at the point of use.
 *
 * WEB CRYPTO, not `node:crypto`. `readSession` is called from `src/proxy.ts`, and Next.js runs middleware in the
 * Edge runtime, where `createHash` does not exist — the build does not say so, and it would have failed on the
 * first request in AAT instead. `crypto.subtle` is present in both runtimes and is why this is async.
 */
async function key(secret: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return new Uint8Array(digest);
}

export async function seal(claims: Record<string, unknown>, secret: string, maxAgeSeconds: number, now = new Date()): Promise<string> {
  const issued = Math.floor(now.getTime() / 1000);
  return await new EncryptJWT(claims)
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setIssuedAt(issued)
    .setExpirationTime(issued + maxAgeSeconds)
    .encrypt(await key(secret));
}

/**
 * What a cookie carries, or `undefined` if it carries nothing usable.
 *
 * Every failure collapses to one answer, because a caller's only reachable decision is whether it has a usable
 * value. Expired, tampered with, encrypted under a rotated secret and absent are indistinguishable to that
 * decision, and separating them in the return type would invite a caller to treat one as partial success.
 */
export async function open(token: string | undefined, secret: string): Promise<Record<string, unknown> | undefined> {
  if (!token) {
    return undefined;
  }
  try {
    const { payload } = await jwtDecrypt(token, await key(secret));
    return payload as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
