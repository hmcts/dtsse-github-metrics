/**
 * The two ends of the AAT-to-preview copy, and the only functions that can produce either.
 *
 * THE SOURCE AND THE TARGET ARE DIFFERENT TYPES, branded so that neither can be passed where the other is
 * expected. `dumpCommand` accepts only a `DumpSource`; every function that drops, restores, scrubs or migrates
 * accepts only a `PreviewTarget`, and `previewTarget` is the one place a `PreviewTarget` is made. A swapped
 * variable is therefore a compile error before it is a guard failure, and a guard failure before it is a dropped
 * production schema.
 */

/** The flexible server `cnp-flux-config/apps/dtsse/preview/aso/dtsse-postgres.yaml` defines. Nothing else is a target. */
export const PREVIEW_SERVER_HOST = "dtsse-preview.postgres.database.azure.com";

const PREVIEW_DATABASE = /^dtsse-github-metrics-pr-[1-9]\d*$/;

export interface Connection {
  readonly host: string;
  readonly port: string;
  readonly user: string;
  readonly password: string;
  readonly database: string;
}

declare const sourceBrand: unique symbol;
declare const targetBrand: unique symbol;

export type DumpSource = Connection & { readonly [sourceBrand]: true };
export type PreviewTarget = Connection & { readonly [targetBrand]: true };

/** The keys of the in-cluster `postgres` secret, decoded. It carries no database: each release names its own. */
export interface PreviewServerSecret {
  readonly HOST?: string;
  readonly PORT?: string;
  readonly USER?: string;
  readonly PASSWORD?: string;
}

export type Environment = Record<string, string | undefined>;

/** The variables the pipeline sets from the `dtsse-aat` vault, and only for the duration of the copy. */
export const SOURCE_VARIABLES = {
  host: "AAT_POSTGRES_HOST",
  port: "AAT_POSTGRES_PORT",
  user: "AAT_POSTGRES_USER",
  password: "AAT_POSTGRES_PASSWORD",
  database: "AAT_POSTGRES_DATABASE"
} as const;

export class GuardError extends Error {
  override readonly name = "GuardError";
}

function normalisedHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "");
}

function required(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === "") {
    throw new GuardError(`${name} is not set`);
  }
  return value;
}

/** The pull-request number, refused unless it is one: it becomes part of the name of the database that is dropped. */
export function changeNumber(changeId: string | undefined): string {
  const value = required(changeId, "CHANGE_ID");
  if (!/^[1-9]\d*$/.test(value)) {
    throw new GuardError(`CHANGE_ID must be a pull-request number, not ${JSON.stringify(value)}`);
  }
  return value;
}

export function previewDatabaseName(changeId: string | undefined): string {
  return `dtsse-github-metrics-pr-${changeNumber(changeId)}`;
}

export function dumpSource(env: Environment): DumpSource {
  const source = {
    host: required(env[SOURCE_VARIABLES.host], SOURCE_VARIABLES.host),
    port: required(env[SOURCE_VARIABLES.port], SOURCE_VARIABLES.port),
    user: required(env[SOURCE_VARIABLES.user], SOURCE_VARIABLES.user),
    password: required(env[SOURCE_VARIABLES.password], SOURCE_VARIABLES.password),
    database: required(env[SOURCE_VARIABLES.database], SOURCE_VARIABLES.database)
  };
  if (normalisedHost(source.host) === PREVIEW_SERVER_HOST) {
    throw new GuardError(`${SOURCE_VARIABLES.host} names the preview server, so the dump and the restore would be the same server`);
  }
  return source as DumpSource;
}

/**
 * The PR's own database on the preview server, or a refusal.
 *
 * Every condition is checked here and again by `assertPreviewTarget` at the point of use, so a target that did
 * not come through this function — a cast, a spread with one field changed — is still refused.
 */
export function previewTarget(secret: PreviewServerSecret, changeId: string | undefined, source: DumpSource): PreviewTarget {
  const target = {
    host: required(secret.HOST, "the postgres secret's HOST"),
    port: required(secret.PORT, "the postgres secret's PORT"),
    user: required(secret.USER, "the postgres secret's USER"),
    password: required(secret.PASSWORD, "the postgres secret's PASSWORD"),
    database: previewDatabaseName(changeId)
  };
  if (normalisedHost(target.host) !== PREVIEW_SERVER_HOST) {
    throw new GuardError(`the postgres secret's HOST is ${target.host}, not the preview server ${PREVIEW_SERVER_HOST}`);
  }
  if (normalisedHost(target.host) === normalisedHost(source.host)) {
    throw new GuardError(`the source and the target are both ${target.host}`);
  }
  assertPreviewTarget(target);
  return target as PreviewTarget;
}

export function assertPreviewTarget(target: Connection): void {
  if (normalisedHost(target.host) !== PREVIEW_SERVER_HOST) {
    throw new GuardError(`refusing to modify ${target.host}: only ${PREVIEW_SERVER_HOST} may be modified`);
  }
  if (!PREVIEW_DATABASE.test(target.database)) {
    throw new GuardError(`refusing to modify database ${JSON.stringify(target.database)}: only a pull request's own database may be modified`);
  }
}

/** Keyword form for libpq, which `pg_dump` and `pg_restore` read. The password travels in `PGPASSWORD`, never here. */
export function libpqConninfo(connection: Connection): string {
  const quote = (value: string) => `'${value.replaceAll("\\", String.raw`\\`).replaceAll("'", String.raw`\'`)}'`;
  return [
    `host=${quote(connection.host)}`,
    `port=${quote(connection.port)}`,
    `user=${quote(connection.user)}`,
    `dbname=${quote(connection.database)}`,
    "sslmode=require",
    "connect_timeout=30"
  ].join(" ");
}

/** A URL for the `pg` driver. Encoded, because a vault password is free to contain `@`, `/` or `:`. */
export function previewUrl(target: PreviewTarget): string {
  assertPreviewTarget(target);
  const user = encodeURIComponent(target.user);
  const password = encodeURIComponent(target.password);
  return `postgresql://${user}:${password}@${target.host}:${target.port}/${encodeURIComponent(target.database)}?sslmode=require`;
}
