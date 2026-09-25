import pg from "pg";
import { assertPreviewTarget, type PreviewTarget, previewUrl } from "./target.ts";

/**
 * The statements the copy runs against the PR's database. Each takes a client, and the only client the copy ever
 * makes is `connectPreview`'s, which refuses anything but a `PreviewTarget` and then asks the server which database
 * it actually landed in.
 */

const LOCK_TIMEOUT = "30s";

export async function connectPreview(target: PreviewTarget): Promise<pg.Client> {
  assertPreviewTarget(target);
  const client = new pg.Client({ connectionString: previewUrl(target) });
  await client.connect();
  try {
    const { rows } = await client.query<{ database: string }>("SELECT current_database() AS database");
    if (rows[0]?.database !== target.database) {
      throw new Error(`connected to ${rows[0]?.database ?? "no database"}, expected ${target.database}`);
    }
    return client;
  } catch (error) {
    await client.end().catch(() => undefined);
    throw error;
  }
}

/** Everything the empty-database boot created, gone, and a schema ready for the restore to fill. */
export async function resetSchema(client: pg.ClientBase): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
    await client.query("DROP SCHEMA IF EXISTS public CASCADE");
    await client.query("CREATE SCHEMA public");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export interface ScrubResult {
  readonly scrubbed: number;
  readonly secretScanningRows: number;
}

/**
 * Secret-scanning locations blanked, and proven blank in the same transaction.
 *
 * GitHub shows these to repository admins only, and a preview is served with authentication disabled. What stays is
 * what the pages grade on: the type, the state, the resolution and the dates.
 */
export async function scrubSecretScanning(client: pg.ClientBase): Promise<ScrubResult> {
  await client.query("BEGIN");
  try {
    const updated = await client.query(
      `UPDATE security_alerts SET path = NULL, line = NULL, html_url = NULL
        WHERE family = 'secret-scanning' AND (path IS NOT NULL OR line IS NOT NULL OR html_url IS NOT NULL)`
    );
    const { rows } = await client.query<{ total: string; located: string }>(
      `SELECT count(*) AS total, count(*) FILTER (WHERE path IS NOT NULL OR line IS NOT NULL OR html_url IS NOT NULL) AS located
         FROM security_alerts WHERE family = 'secret-scanning'`
    );
    const located = Number(rows[0]?.located ?? Number.NaN);
    if (located !== 0) {
      throw new Error(`${rows[0]?.located ?? "an unknown number of"} secret-scanning alerts still carry a location after the scrub`);
    }
    await client.query("COMMIT");
    return { scrubbed: updated.rowCount ?? 0, secretScanningRows: Number(rows[0]?.total ?? 0) };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
