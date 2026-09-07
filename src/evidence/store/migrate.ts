import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { resolveDatabaseUrl } from "./database-url.ts";

/**
 * Applying the migrations in `prisma/migrations` from inside the deployed image.
 *
 * The Prisma CLI cannot do this here. It is a devDependency, so `yarn workspaces focus --production` leaves it
 * out of the runtime stage, and it reads its connection string from `prisma.config.ts` — a TypeScript file that
 * is only present in the build stage. Adding both back to the runtime image to run two files of SQL costs more
 * than reading them with the `pg` client that is already there.
 *
 * What this must not do is invent its own bookkeeping. It writes `_prisma_migrations` rows in Prisma's own
 * shape, with Prisma's own checksum (sha256 of the file, hex), so a database migrated here is one
 * `prisma migrate status` still understands and `prisma migrate dev` will not offer to reset.
 */

/** Prisma's own ledger table, created exactly as its migration engine creates it. */
const LEDGER = `
  CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
    "id"                    VARCHAR(36)  PRIMARY KEY NOT NULL,
    "checksum"              VARCHAR(64)  NOT NULL,
    "finished_at"           TIMESTAMPTZ,
    "migration_name"        VARCHAR(255) NOT NULL,
    "logs"                  TEXT,
    "rolled_back_at"        TIMESTAMPTZ,
    "started_at"            TIMESTAMPTZ  NOT NULL DEFAULT now(),
    "applied_steps_count"   INTEGER      NOT NULL DEFAULT 0
  )
`;

/**
 * The lock every migrating process contends for.
 *
 * A session-level advisory lock rather than a transaction-level one, because the migrations are applied in
 * separate transactions and the lock has to span all of them. Two pods starting together therefore migrate one
 * after the other, and the second finds the ledger already written and applies nothing.
 */
const LOCK_KEY = 0x67686d65_74726963n;

/** One migration on disk: the directory Prisma names it by, and the SQL inside it. */
interface Migration {
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}

/** Where the migrations live, relative to the working directory both the image and a local run use. */
export function migrationsDirectory(cwd: string = process.cwd()): string {
  return path.join(cwd, "prisma", "migrations");
}

/** Every migration on disk, in the order Prisma applies them — its directory names sort chronologically. */
async function readMigrations(directory: string): Promise<Migration[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  // Compared by code unit, deliberately, and NOT with `localeCompare`. Prisma names a migration directory
  // `<utc timestamp>_<label>`, so a plain code-unit ordering is chronological. Locale collation is not: it can
  // treat punctuation as insignificant and varies with the runtime's locale, which would make the order
  // migrations are applied in depend on where the container happens to run. Written out rather than left as a
  // bare `.sort()` so the choice reads as one.
  const names = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

  const migrations: Migration[] = [];
  for (const name of names) {
    const sql = await readFile(path.join(directory, name, "migration.sql"), "utf8");
    migrations.push({ name, sql, checksum: createHash("sha256").update(sql).digest("hex") });
  }
  return migrations;
}

/** The migrations the ledger already records as finished. */
async function applied(client: pg.ClientBase): Promise<Set<string>> {
  const { rows } = await client.query<{ migration_name: string }>(
    `SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`
  );
  return new Set(rows.map((row) => row.migration_name));
}

/**
 * Brings the database up to the schema in `prisma/migrations`, and reports which migrations that took.
 *
 * Idempotent: the common case is that everything is already applied and this is one query. Each migration runs
 * in its own transaction alongside its ledger row, so a failure half way leaves the ones before it applied and
 * recorded, which is what lets the next start resume rather than begin again.
 */
export async function migrate(directory: string = migrationsDirectory()): Promise<string[]> {
  const migrations = await readMigrations(directory);
  const client = new pg.Client({ connectionString: resolveDatabaseUrl() });
  await client.connect();

  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY.toString()]);
    await client.query(LEDGER);
    const done = await applied(client);
    const pending = migrations.filter((migration) => !done.has(migration.name));

    for (const migration of pending) {
      await client.query("BEGIN");
      try {
        await client.query(migration.sql);
        await client.query(
          `INSERT INTO "_prisma_migrations" (id, checksum, migration_name, started_at, finished_at, applied_steps_count)
           VALUES ($1, $2, $3, now(), now(), 1)`,
          [crypto.randomUUID(), migration.checksum, migration.name]
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw new Error(`migration ${migration.name} failed: ${error instanceof Error ? error.message : String(error)}`, {
          cause: error
        });
      }
    }

    return pending.map((migration) => migration.name);
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY.toString()]).catch(() => undefined);
    await client.end();
  }
}
