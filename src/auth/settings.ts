/**
 * What the dashboard needs to know to authenticate a reader against Microsoft Entra ID.
 *
 * Read from the environment rather than `config/`: every other secret this service holds arrives the same way,
 * as a file under /mnt/secrets that `getPropertiesVolumeSecrets` turns into a variable, and a second mechanism
 * for the same job would be a place for the two to disagree.
 */

/**
 * SIGNING IN IS THE WHOLE CONTROL. There is deliberately no group or role check anywhere in this module.
 *
 * The registration is single tenant, so Entra refuses everybody outside HMCTS before a request reaches us, and
 * that is the intended audience: the dashboard is for the organisation rather than for engineers, and many of
 * the people who should read it hold no engineering group. Narrowing by group would have locked them out.
 *
 * The consequence, decided rather than overlooked: the tenant holds several thousand guest accounts, including
 * some from other government departments, and they can read the dashboard too.
 */
export interface AuthSettings {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  /** Absolute, and must match a redirect URI on the app registration exactly — Entra compares the whole string. */
  redirectUri: string;
  sessionSecret: string;
}

/** Only the named keys are read, so this is deliberately narrower than the augmented `NodeJS.ProcessEnv`. */
export type Environment = Readonly<Record<string, string | undefined>>;

export class AuthConfigurationError extends Error {}

/**
 * Whether readers must sign in.
 *
 * FAIL CLOSED. Authentication is required unless something explicitly says otherwise, so a deployment that
 * loses its Entra variables refuses to start rather than quietly serving the estate's security posture to
 * anybody who finds the hostname. `AUTH_DISABLED` exists for `yarn dev` and for a preview environment whose
 * database is empty, and it has to be set on purpose.
 */
export function authRequired(env: Environment = process.env): boolean {
  return env.AUTH_DISABLED !== "true";
}

function required(env: Environment, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new AuthConfigurationError(`${name} is not set, and authentication is required. Set it, or set AUTH_DISABLED=true to run without a sign-in.`);
  }
  return value;
}

export function authSettings(env: Environment = process.env): AuthSettings {
  return {
    tenantId: required(env, "ENTRA_TENANT_ID"),
    clientId: required(env, "ENTRA_CLIENT_ID"),
    clientSecret: required(env, "ENTRA_CLIENT_SECRET"),
    redirectUri: required(env, "ENTRA_REDIRECT_URI"),
    sessionSecret: required(env, "SESSION_SECRET")
  };
}

/** The Entra issuer for a tenant, which is what OIDC discovery is performed against. */
export function issuerUrl(tenantId: string): URL {
  return new URL(`https://login.microsoftonline.com/${tenantId}/v2.0`);
}
