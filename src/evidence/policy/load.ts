import { readFile } from "node:fs/promises";
import yaml from "js-yaml";
import type { ZodError } from "zod";
import { type Configuration, configurationSchema } from "./schema.ts";

/**
 * `json: true` for one reason: a key given twice must resolve the way PyYAML resolved it, with the last
 * occurrence winning.
 *
 * That is not a detail. `--config` is repeatable and the files are read as ONE document precisely so a
 * team file can restate a key the shared policy file set, and js-yaml's default is to throw
 * `duplicated mapping key` — which would refuse the layering the split exists to allow.
 *
 * It costs nothing in safety: js-yaml's default schema already rejects the arbitrary-object
 * constructors PyYAML needed `safe_load` to avoid, so an unknown tag is still refused with this set.
 */
const YAML_OPTIONS = { json: true } as const;

/** Reports invalid metrics configuration. */
export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

/**
 * Reports each rejected key as `location: problem`, naming the files the document was read from.
 *
 * Zod's own rendering, like pydantic's, buries the two things a reader needs: WHICH key, and where it
 * was looked for. The file list is part of the message because `--config` is repeatable and the files
 * are read as one document: a missing `teams:` almost always means the team file was not given, not
 * that the policy file naming it is wrong, and the message cannot say so without naming what was read.
 */
export function describeValidationError(paths: readonly string[], error: ZodError): string {
  const problems = error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join(", ");
  return `${problems} (read from ${paths.join(", ")})`;
}

/**
 * Loads a versioned metrics configuration from YAML held in one file or split across several.
 *
 * Several files are concatenated and parsed as ONE document, so how the text was stored is settled
 * before anything reads it: the schema, and every rule and default below it, is unconcerned with
 * whether the configuration arrived as one file or twenty. The split exists so the policy every report
 * shares — assessment thresholds, practices, lookbacks — is written once and paired with whichever
 * team file a run is about, rather than restated per team set and left to drift.
 *
 * Nothing here treats a file as a configuration in its own right, so a file holding only `teams:` is
 * not a partial configuration to be checked; it is part of the text of the one configuration being
 * read. A key given twice is resolved by YAML as it always was, the last occurrence winning.
 *
 * Upstream's `database:` key is deliberately absent: Postgres replaces the two SQLite files, and the
 * connection string arrives as `DATABASE_URL` rather than as policy.
 */
export async function loadConfiguration(...paths: string[]): Promise<Configuration> {
  if (paths.length === 0) {
    throw new ConfigurationError("at least one --config file is required");
  }

  let document: string;
  try {
    const contents = await Promise.all(paths.map((path) => readFile(path, "utf8")));
    // Joined on a newline rather than concatenated directly: a file whose last line has no newline
    // would otherwise run into the next file's first line and change what both mean.
    document = contents.join("\n");
  } catch (error) {
    throw new ConfigurationError(error instanceof Error ? error.message : String(error));
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(document, YAML_OPTIONS);
  } catch (error) {
    // js-yaml raises for an unparseable document and for an impossible timestamp such as `2026-13-05`
    // before the schema sees the value. Both are invalid configuration to be reported as such, not
    // crashes to escape the loader.
    throw new ConfigurationError(error instanceof Error ? error.message : String(error));
  }

  const result = configurationSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigurationError(describeValidationError(paths, result.error));
  }
  return result.data;
}

/** Parses an already-read document, for tests and for callers holding the text rather than a path. */
export function parseConfiguration(document: string, source = "<inline>"): Configuration {
  let parsed: unknown;
  try {
    parsed = yaml.load(document, YAML_OPTIONS);
  } catch (error) {
    throw new ConfigurationError(error instanceof Error ? error.message : String(error));
  }
  const result = configurationSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigurationError(describeValidationError([source], result.error));
  }
  return result.data;
}
