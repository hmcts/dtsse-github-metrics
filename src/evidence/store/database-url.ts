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
 * A hostname, a port and a database name, and nothing else at all.
 *
 * Narrower than what Postgres accepts in a name, on purpose: this is a description for a log line rather than an
 * identifier anything connects with, so a value that does not read as one of the three is better withheld than
 * printed. An IPv6 literal is one such value, and reads as unrecognised.
 */
const TARGET = /^[a-z0-9._-]{1,253}:[0-9]{1,5}\/[a-z0-9_$.-]{1,63}$/i;

/** What is said instead, so a line nobody can act on is still a line rather than a blank. */
const UNRECOGNISED = "an unrecognised database target";

/**
 * Where a process is about to connect, as `host:port/database` and NEVER WITH THE CREDENTIAL.
 *
 * Written at start-up so which database a process holds is a fact in the log rather than an inference from
 * which variables happened to be set. `yarn dev` resolved the AAT vault and warmed the whole production
 * estate with nothing in its output saying so; one line would have made that visible in seconds.
 *
 * The user and password are left out deliberately. This goes to stdout, which in a pod ships to App Insights
 * and locally scrolls into whatever a developer pastes into a ticket.
 *
 * CHECKED AGAINST `TARGET` ON THE WAY OUT, whichever branch produced it, so the three fields are the only thing
 * that can ever leave here. `new URL` already drops the userinfo, and this is what makes that narrowing a
 * property of the function rather than a property of one call inside it: a `DATABASE_URL` holding something
 * unexpected cannot put arbitrary text — a password among it — into a log line, and a taint analyser reading
 * this file can see as much.
 */
export function describeDatabase(env: Environment = process.env): string {
  const parts = mountedParts(env);
  const described = parts === undefined ? describeUrl(env.DATABASE_URL ?? LOCAL_DATABASE_URL) : `${parts.host}:${parts.port}/${parts.database}`;
  return TARGET.test(described) ? described : UNRECOGNISED;
}

/**
 * The same three fields out of a whole URL, which is the shape an explicit `DATABASE_URL` arrives in.
 *
 * PARSED RATHER THAN PATTERN-MATCHED: a regex over a string holding a password would name whatever followed the
 * first `@` as the host. An unparseable one produces nothing, which `TARGET` above then declines.
 */
function describeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const port = parsed.port === "" ? "5432" : parsed.port;
    return `${parsed.hostname}:${port}/${parsed.pathname.replace(/^\//, "")}`;
  } catch {
    return "";
  }
}
