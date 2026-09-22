import { parseArgs } from "node:util";
import { parseInstant } from "../evidence/window/instant.ts";

export const COMMANDS = [
  "doctor",
  "collect",
  "collect-org",
  "collect-cve",
  "collect-alerts",
  "map-sonar",
  "prune",
  "evidence",
  "migrate",
  "reduce-descriptions"
] as const;

export type Command = (typeof COMMANDS)[number];

/**
 * The commands whose subject is the cohort, and which therefore refuse an empty `teams:`.
 *
 * `collect-org` is deliberately NOT one of them, for the reason `map-sonar` and `prune` are not: the
 * organisation graph is not about any repository a team owns — it is what establishes who owns them — so
 * obliging a team file to be layered in would make the answer depend on the question. `map-sonar` walks the
 * projects a SonarCloud organisation lists, which is a question about SonarCloud rather than about the cohort.
 *
 * `collect-alerts` IS one, and for `collect`'s reason twice over: the cohort is the universe it writes a row for
 * every member of, and it reads the counts `collect` stored to tell a family that is off from one nobody could
 * read. Without a collected cohort it has nothing to write rows against and nothing to grade them with.
 */
export const COHORT_COMMANDS: ReadonlySet<Command> = new Set(["collect", "collect-alerts", "evidence"]);

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/**
 * EVERY FIELD IS READ BY A COMMAND, and that is the rule this shape is held to.
 *
 * A flag that parses and is then ignored is worse than one that does not exist: `--help` promises it, a
 * caller sets it, and the run does exactly what it would have done anyway — which reads as the flag having
 * been considered and rejected rather than never consulted. Nothing is declared here until something reads
 * it, so `usage()` below and the behaviour cannot drift apart.
 */
export interface Arguments {
  command: Command;
  config: string[];
  startsAt?: Date;
  endsAt?: Date;
  days?: number;
  repository?: string;
  toleratePartial: boolean;
  /** Emit a paste-ready `teams:` block instead of writing the graph (collect-org). */
  proposeTeams: boolean;
  /** Override the configured ceiling on repositories one run may pay the per-repository rungs for. */
  unresolvedLimit?: number;
  /** Read every cohort repository rather than a sample of them (doctor). */
  all: boolean;
  /**
   * Apply the change rather than only counting it (reduce-descriptions).
   *
   * OPT IN, so the default of the one command that rewrites stored payloads is to write nothing. An operator who
   * mistypes the connection details finds out from a count rather than from a table.
   */
  write: boolean;
  /** Rows per batch, for a command that walks the whole fact table (reduce-descriptions). */
  batchSize?: number;
}

const OPTIONS = {
  config: { type: "string", multiple: true },
  from: { type: "string" },
  to: { type: "string" },
  days: { type: "string" },
  repository: { type: "string" },
  "tolerate-partial": { type: "boolean" },
  "propose-teams": { type: "boolean" },
  "unresolved-limit": { type: "string" },
  all: { type: "boolean" },
  write: { type: "boolean" },
  "batch-size": { type: "string" }
} as const;

function integer(value: string | undefined, name: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new UsageError(`--${name} must be a whole number, and is ${JSON.stringify(value)}`);
  }
  return parsed;
}

function instant(value: string | undefined, name: string): Date | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    return parseInstant(value);
  } catch (error) {
    throw new UsageError(`--${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function parseArguments(argv: readonly string[]): Arguments {
  const [command, ...rest] = argv;

  if (command === undefined || command === "--help" || command === "-h") {
    throw new UsageError(usage());
  }
  if (!COMMANDS.includes(command as Command)) {
    throw new UsageError(`unknown command ${JSON.stringify(command)}\n\n${usage()}`);
  }

  let values: Record<string, unknown>;
  try {
    ({ values } = parseArgs({ args: [...rest], options: OPTIONS, allowPositionals: false, strict: true }));
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }

  const config = (values.config as string[] | undefined) ?? [];
  if (config.length === 0 && command !== "migrate") {
    throw new UsageError("--config is required, and may be repeated to layer a policy file with a team file");
  }

  const days = integer(values.days as string | undefined, "days");

  const unresolvedLimit = integer(values["unresolved-limit"] as string | undefined, "unresolved-limit");
  if (unresolvedLimit !== undefined && unresolvedLimit < 0) {
    throw new UsageError("--unresolved-limit may not be negative; zero skips the per-repository rungs entirely");
  }

  const batchSize = integer(values["batch-size"] as string | undefined, "batch-size");
  if (batchSize !== undefined && batchSize < 1) {
    throw new UsageError("--batch-size must be at least one row");
  }

  const startsAt = instant(values.from as string | undefined, "from");
  const endsAt = instant(values.to as string | undefined, "to");
  if (startsAt !== undefined && endsAt !== undefined && days !== undefined) {
    throw new UsageError("give at most two of --from, --to, and --days");
  }

  return {
    command: command as Command,
    config,
    ...(startsAt === undefined ? {} : { startsAt }),
    ...(endsAt === undefined ? {} : { endsAt }),
    ...(days === undefined ? {} : { days }),
    ...(values.repository === undefined ? {} : { repository: values.repository as string }),
    toleratePartial: values["tolerate-partial"] === true,
    proposeTeams: values["propose-teams"] === true,
    all: values.all === true,
    write: values.write === true,
    ...(unresolvedLimit === undefined ? {} : { unresolvedLimit }),
    ...(batchSize === undefined ? {} : { batchSize })
  };
}

export function usage(): string {
  return `usage: metrics <command> --config <file> [options]

commands:
  doctor      validate configuration and GitHub access
  collect     collect repository inventory and behaviour evidence
  collect-org collect the organisation's teams, people and repository ownership
  collect-cve collect the CVE reports the Jenkins security stage publishes, from both
              the jenkins and sds-jenkins Cosmos databases
  collect-alerts
              collect the individual security alerts of all three families, from each
              one's organisation-wide endpoint
  map-sonar   resolve each SonarCloud project to the repository it analyses
  prune       delete cached intervals that have not been used recently
  evidence    explain cached behaviour evidence without GitHub access
  migrate     apply any pending database migrations (takes no --config)
  reduce-descriptions
              replace the stored descriptions of pull requests cached before they
              were reduced with the two answers reports read; counts unless --write

options:
  --config <file>       path to the YAML configuration; repeat to layer files, later files winning
  --from <instant>      start of the window, inclusive: a UTC date or datetime
  --to <instant>        end of the window, exclusive
  --days <n>            span this many days, ending at the most recent UTC midnight
  --repository <name>   limit results to one configured repository
  --tolerate-partial    exit 0 when some repositories or projects refused, for a scheduled run
                        (collect, map-sonar, collect-alerts)
  --propose-teams       print a reviewable teams: block instead of writing the graph (collect-org)
  --unresolved-limit <n>  cap the repositories one run reads CODEOWNERS for (collect-org)
  --all                 read every cohort repository rather than a sample of them (doctor)
  --write               apply the change; without it nothing is written (reduce-descriptions)
  --batch-size <n>      rows per batch, so a failure part-way commits what it did (reduce-descriptions)

exit status:
  0  every configured repository was observed
  1  nothing usable came back
  2  the command line was wrong
  3  some evidence was collected, but not all of it
`;
}
