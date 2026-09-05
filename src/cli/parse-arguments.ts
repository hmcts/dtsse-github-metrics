import { parseArgs } from "node:util";
import { behaviourMetricIdentifiers } from "../evidence/behaviour/metrics.ts";
import { parseInstant } from "../evidence/window/instant.ts";

/**
 * Parsing the collector's command line. Ported from `metrics.cli`'s argument parser.
 *
 * `node:util`'s `parseArgs` rather than a dependency: the surface is six subcommands and a dozen options, all of
 * them strings, numbers or booleans, and pinning another package to format a help message would be the larger
 * cost.
 */

export const COMMANDS = ["doctor", "collect", "prune", "map-sonar", "evidence", "trend"] as const;

export type Command = (typeof COMMANDS)[number];

/** The commands whose subject is the reported cohort, and which therefore need a team file layered in. */
export const COHORT_COMMANDS: ReadonlySet<Command> = new Set(["collect", "evidence", "trend"]);

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export interface Arguments {
  command: Command;
  /** Repeatable, and read as ONE document in the order given: a policy file, then a team file. */
  config: string[];
  logging: string;
  startsAt?: Date;
  endsAt?: Date;
  days?: number;
  maximumDays?: number;
  repository?: string;
  metric?: string;
  refresh: boolean;
  offline: boolean;
  identities: boolean;
  format: "json" | "report";
  periodDays: number;
  periods?: number;
}

const OPTIONS = {
  config: { type: "string", multiple: true },
  logging: { type: "string" },
  from: { type: "string" },
  to: { type: "string" },
  days: { type: "string" },
  "maximum-days": { type: "string" },
  repository: { type: "string" },
  metric: { type: "string" },
  refresh: { type: "boolean" },
  offline: { type: "boolean" },
  identities: { type: "boolean" },
  format: { type: "string" },
  "period-days": { type: "string" },
  periods: { type: "string" }
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
  if (config.length === 0) {
    throw new UsageError("--config is required, and may be repeated to layer a policy file with a team file");
  }

  const format = (values.format as string | undefined) ?? "json";
  if (format !== "json" && format !== "report") {
    throw new UsageError(`--format must be json or report, and is ${JSON.stringify(format)}`);
  }
  if (format === "report") {
    // render.py was deliberately not ported: it was presentation-only, and the dashboard computes its own
    // presentation figures. The flag is recognised so the failure names its replacement rather than reading as
    // an unknown option.
    throw new UsageError("--format report was not carried over from the Python collector; use --format json and filter it with jq");
  }

  const metric = values.metric as string | undefined;
  if (metric !== undefined && !behaviourMetricIdentifiers().includes(metric)) {
    throw new UsageError(`--metric must be one of ${behaviourMetricIdentifiers().join(", ")}, and is ${JSON.stringify(metric)}`);
  }

  const days = integer(values.days as string | undefined, "days");
  const periodDays = integer(values["period-days"] as string | undefined, "period-days") ?? 28;
  if (periodDays < 1) {
    // Checked here rather than at the first repository carrying an enablement date: a configuration where
    // nobody is enabled yet must still refuse `--period-days 0` rather than report an empty series as though
    // the request were fine.
    throw new UsageError("--period-days must be at least one day");
  }

  const startsAt = instant(values.from as string | undefined, "from");
  const endsAt = instant(values.to as string | undefined, "to");
  if (startsAt !== undefined && endsAt !== undefined && days !== undefined) {
    throw new UsageError("give at most two of --from, --to, and --days");
  }

  return {
    command: command as Command,
    config,
    logging: (values.logging as string | undefined) ?? "info",
    ...(startsAt === undefined ? {} : { startsAt }),
    ...(endsAt === undefined ? {} : { endsAt }),
    ...(days === undefined ? {} : { days }),
    ...(integer(values["maximum-days"] as string | undefined, "maximum-days") === undefined
      ? {}
      : { maximumDays: integer(values["maximum-days"] as string | undefined, "maximum-days") as number }),
    ...(values.repository === undefined ? {} : { repository: values.repository as string }),
    ...(metric === undefined ? {} : { metric }),
    refresh: values.refresh === true,
    offline: values.offline === true,
    identities: values.identities === true,
    format,
    periodDays,
    ...(integer(values.periods as string | undefined, "periods") === undefined
      ? {}
      : { periods: integer(values.periods as string | undefined, "periods") as number })
  };
}

export function usage(): string {
  return `usage: metrics <command> --config <file> [options]

commands:
  doctor      validate configuration and GitHub access
  collect     collect repository inventory and behaviour evidence
  prune       delete cached intervals that have not been used recently
  map-sonar   resolve each SonarCloud project to the repository it analyses
  evidence    explain cached behaviour evidence without GitHub access
  trend       report each repository's periods since it was enabled

options:
  --config <file>       path to the YAML configuration; repeat to layer files, later files winning
  --logging <level>     set the logging level (default: info)
  --from <instant>      start of the window, inclusive: a UTC date or datetime
  --to <instant>        end of the window, exclusive
  --days <n>            span this many days, ending at the most recent UTC midnight
  --maximum-days <n>    raise the configured maximum window span
  --repository <name>   limit results to one configured repository
  --metric <id>         show one raw metric
  --identities          include raw pull-request, author and reviewer references
  --refresh             contact GitHub to collect missing history (evidence)
  --offline             never contact GitHub, and refuse a period the cache does not cover (trend)
  --period-days <n>     span each trend period this many days (default: 28)
  --periods <n>         report at most this many whole periods since enablement
  --format json         emit the machine-readable contract (the only supported format)

exit status:
  0  every configured repository was observed
  1  nothing usable came back
  2  the command line was wrong
  3  some evidence was collected, but not all of it
`;
}
