import pg from "pg";

const DEFAULT_URL = "postgresql://hmcts@localhost:5432/github_metrics";

export default async function setup() {
  const url = process.env.DATABASE_URL ?? DEFAULT_URL;
  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
    await client.query("SELECT 1");
  } catch (err) {
    throw new Error(
      `Integration tests require Postgres at ${url}.\n` +
        `Bring it up and apply migrations:\n` +
        `  yarn deps:up && yarn db:migrate:dev\n\n` +
        `Underlying error: ${(err as Error).message}`
    );
  } finally {
    await client.end();
  }
}
