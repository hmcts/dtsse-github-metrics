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

export interface MountedParts {
  host: string;
  port: string;
  user: string;
  password: string;
  database: string;
}

/**
 * The five mounted parts, or nothing where any one of them is missing.
 *
 * EXPORTED FOR `platform/database-target.ts`, which describes the connection for the start-up log. What a
 * process connects to and what it reports connecting to therefore read the same five variables through one
 * function, and a line naming a host the pool is not using is not a state this can reach. The description
 * itself lives over there because it is a decision about a log line rather than about connecting.
 */
export function mountedDatabaseParts(env: Environment): MountedParts | undefined {
  const { POSTGRES_HOST, POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_PORT, POSTGRES_DATABASE } = env;
  return POSTGRES_HOST && POSTGRES_USER && POSTGRES_PASSWORD && POSTGRES_PORT && POSTGRES_DATABASE
    ? { host: POSTGRES_HOST, port: POSTGRES_PORT, user: POSTGRES_USER, password: POSTGRES_PASSWORD, database: POSTGRES_DATABASE }
    : undefined;
}

export function resolveDatabaseUrl(env: Environment = process.env): string {
  const parts = mountedDatabaseParts(env);
  return parts === undefined
    ? (env.DATABASE_URL ?? LOCAL_DATABASE_URL)
    : `postgresql://${parts.user}:${parts.password}@${parts.host}:${parts.port}/${parts.database}?sslmode=require`;
}

/** Sets `DATABASE_URL` in the environment, for Prisma's own CLI and generated client to read. */
export function applyDatabaseUrl(env: Environment = process.env): string {
  const url = resolveDatabaseUrl(env);
  env.DATABASE_URL = url;
  return url;
}
