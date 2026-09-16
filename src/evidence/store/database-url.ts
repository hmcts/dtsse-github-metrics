/**
 * Assembles `DATABASE_URL` the way every CFT Node service does: from the `POSTGRES_*` parts the Helm
 * chart mounts out of the Key Vault, falling back to a local Docker Compose default.
 *
 * Deployed, the five parts are all present and `sslmode=require` is mandatory — the flexible server
 * refuses an unencrypted connection. Locally, none of them are set and the compose default applies.
 * An explicit `DATABASE_URL` always wins over the fallback, which is how a test run points at a
 * scratch database.
 */

/**
 * The environment these functions read, as a plain string map.
 *
 * Deliberately not `NodeJS.ProcessEnv`, for the reason `github/credentials.ts` states: Next.js augments that
 * type to make `NODE_ENV` required, so a caller or a test passing a literal of just the variables under test
 * would not type-check against it.
 */
export type Environment = Record<string, string | undefined>;

/** What a developer's compose stack serves, and so what a process connects to when no vault has been read. */
export const LOCAL_DATABASE_URL = "postgresql://hmcts@localhost:5432/github_metrics";

interface MountedParts {
  host: string;
  port: string;
  user: string;
  password: string;
  database: string;
}

/**
 * The five mounted parts, or nothing where any one of them is missing.
 *
 * READ BY BOTH FUNCTIONS BELOW, so what a process connects to and what it reports connecting to cannot
 * drift apart. A start-up line naming a host the pool is not using would be worse than no line at all — it
 * is the same class of fault as the silent Key Vault the line exists to expose.
 */
function mountedParts(env: Environment): MountedParts | undefined {
  const { POSTGRES_HOST, POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_PORT, POSTGRES_DATABASE } = env;
  if (POSTGRES_HOST && POSTGRES_USER && POSTGRES_PASSWORD && POSTGRES_PORT && POSTGRES_DATABASE) {
    return { host: POSTGRES_HOST, port: POSTGRES_PORT, user: POSTGRES_USER, password: POSTGRES_PASSWORD, database: POSTGRES_DATABASE };
  }
  return undefined;
}

export function resolveDatabaseUrl(env: Environment = process.env): string {
  const parts = mountedParts(env);
  if (parts !== undefined) {
    return `postgresql://${parts.user}:${parts.password}@${parts.host}:${parts.port}/${parts.database}?sslmode=require`;
  }
  return env.DATABASE_URL ?? LOCAL_DATABASE_URL;
}

/** Sets `DATABASE_URL` in the environment, for Prisma's own CLI and generated client to read. */
export function applyDatabaseUrl(env: Environment = process.env): string {
  const url = resolveDatabaseUrl(env);
  env.DATABASE_URL = url;
  return url;
}

/**
 * Where a process is about to connect, as `host:port/database` and NEVER WITH THE CREDENTIAL.
 *
 * Written at start-up so which database a process holds is a fact in the log rather than an inference from
 * which variables happened to be set. `yarn dev` resolved the AAT vault and warmed the whole production
 * estate with nothing in its output saying so; one line would have made that visible in seconds.
 *
 * The user and password are left out deliberately. This goes to stdout, which in a pod ships to App Insights
 * and locally scrolls into whatever a developer pastes into a ticket.
 */
export function describeDatabase(env: Environment = process.env): string {
  const parts = mountedParts(env);
  if (parts !== undefined) {
    return `${parts.host}:${parts.port}/${parts.database}`;
  }
  return describeUrl(env.DATABASE_URL ?? LOCAL_DATABASE_URL);
}

/**
 * The same three fields out of a whole URL, which is the shape an explicit `DATABASE_URL` arrives in.
 *
 * PARSED RATHER THAN PATTERN-MATCHED, and unparseable is reported as such: a description is only worth
 * printing if it is right, and a regex over a string holding a password would name whatever followed the
 * first `@` as the host.
 */
function describeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const port = parsed.port === "" ? "5432" : parsed.port;
    return `${parsed.hostname}:${port}/${parsed.pathname.replace(/^\//, "")}`;
  } catch {
    return "an unparseable DATABASE_URL";
  }
}
