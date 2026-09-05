/**
 * Assembles `DATABASE_URL` the way every CFT Node service does: from the `POSTGRES_*` parts the Helm
 * chart mounts out of the Key Vault, falling back to a local Docker Compose default.
 *
 * Deployed, the five parts are all present and `sslmode=require` is mandatory — the flexible server
 * refuses an unencrypted connection. Locally, none of them are set and the compose default applies.
 * An explicit `DATABASE_URL` always wins over the fallback, which is how a test run points at a
 * scratch database.
 */
export function resolveDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const { POSTGRES_HOST, POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_PORT, POSTGRES_DATABASE } = env;
  if (POSTGRES_HOST && POSTGRES_USER && POSTGRES_PASSWORD && POSTGRES_PORT && POSTGRES_DATABASE) {
    return `postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DATABASE}?sslmode=require`;
  }
  return env.DATABASE_URL ?? "postgresql://hmcts@localhost:5432/github_metrics";
}

/** Sets `DATABASE_URL` in the environment, for Prisma's own CLI and generated client to read. */
export function applyDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = resolveDatabaseUrl(env);
  env.DATABASE_URL = url;
  return url;
}
