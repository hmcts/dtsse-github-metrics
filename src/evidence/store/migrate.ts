import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { resolveDatabaseUrl } from "./database-url.ts";

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

const LOCK_KEY = 0x67686d65_74726963n;

interface Migration {
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}

const CONNECT_TIMEOUT_MS = 120_000;
const CONNECT_RETRY_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectWhenReady(connectionString: string, pause: (ms: number) => Promise<void>): Promise<pg.Client> {
  const deadline = Date.now() + CONNECT_TIMEOUT_MS;

  for (;;) {
    const client = new pg.Client({ connectionString });
    try {
      await client.connect();
      return client;
    } catch (error) {
      await client.end().catch(() => undefined);
      const code = (error as { code?: string }).code;
      const starting = code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EAI_AGAIN";
      if (!starting || Date.now() >= deadline) {
        throw error;
      }
      console.info(`waiting for the database: ${error instanceof Error ? error.message : String(error)}`);
      await pause(CONNECT_RETRY_MS);
    }
  }
}

export function migrationsDirectory(cwd: string = process.cwd()): string {
  return path.join(cwd, "prisma", "migrations");
}

async function readMigrations(directory: string): Promise<Migration[]> {
  const entries = await readdir(directory, { withFileTypes: true });
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

async function applied(client: pg.ClientBase): Promise<Set<string>> {
  const { rows } = await client.query<{ migration_name: string }>(
    `SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`
  );
  return new Set(rows.map((row) => row.migration_name));
}

export async function migrate(directory: string = migrationsDirectory(), pause: (ms: number) => Promise<void> = sleep): Promise<string[]> {
  const migrations = await readMigrations(directory);
  const client = await connectWhenReady(resolveDatabaseUrl(), pause);

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
