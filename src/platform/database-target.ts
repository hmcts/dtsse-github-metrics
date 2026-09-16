import { type Environment, LOCAL_DATABASE_URL, mountedDatabaseParts } from "../evidence/store/database-url.ts";

/**
 * Which database a process holds, in the one form it is ever said out loud.
 *
 * Beside the secrets decision rather than beside `resolveDatabaseUrl`, because this is a decision about a log
 * line: what may be printed, and what is withheld. The five parts still come from `store/database-url.ts`, so
 * the description and the connection cannot disagree about which database is meant.
 */

/**
 * A hostname, a port and a database name, and nothing else at all.
 *
 * Narrower than what Postgres accepts in a name, on purpose: this is a description for a log line rather than an
 * identifier anything connects with, so a value that does not read as one of the three is better withheld than
 * printed. An IPv6 literal is one such value, and reads as unrecognised.
 */
const TARGET = /^[a-z0-9._-]{1,253}:\d{1,5}\/[a-z0-9_$.-]{1,63}$/i;

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
  const parts = mountedDatabaseParts(env);
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
