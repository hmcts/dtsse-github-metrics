import {
  type Command,
  dumpCommand,
  listPodsCommand,
  readReplicasCommand,
  readSecretCommand,
  restoreCommand,
  rolloutStatusCommand,
  scaleCommand
} from "./commands.ts";
import type { ScrubResult } from "./database.ts";
import { dumpSource, type Environment, type PreviewServerSecret, type PreviewTarget, previewTarget, previewUrl } from "./target.ts";

/**
 * Replaces a PR preview's database with a scrubbed copy of AAT's, then applies the PR's own migrations on top.
 *
 * The pod has already migrated an empty database by the time this runs, because its container migrates on boot. So
 * the order is: stop the app, dump AAT, replace the PR database, scrub, gate on the migration history, migrate,
 * start the app. The app is never running while the database holds anything but the empty boot schema or the
 * finished, scrubbed copy, and a failure anywhere after the schema is dropped leaves it empty and the app stopped.
 */

export interface PreviewSession {
  reset(): Promise<void>;
  scrub(): Promise<ScrubResult>;
  migrations(): Promise<string[]>;
  close(): Promise<void>;
}

export interface Io {
  /** A file this process opens and hands to the child as its stdin. */
  readonly stdinFrom?: string;
  /** A file the child's stdout is written to, created readable by this user only. */
  readonly stdoutTo?: string;
}

export interface Dependencies {
  /** Runs one command to completion and returns its stdout, or rejects on a non-zero exit. */
  run(command: Command, io?: Io): Promise<string>;
  connect(target: PreviewTarget): Promise<PreviewSession>;
  migrate(connectionString: string): Promise<string[]>;
  localMigrations(): Promise<string[]>;
  makeDumpDirectory(): Promise<string>;
  /** The file's size and its first five bytes, which a custom-format archive always begins `PGDMP`. */
  inspectDump(file: string): Promise<{ bytes: number; header: string }>;
  removeDumpDirectory(directory: string): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
  log(line: string): void;
}

export interface Options {
  readonly env: Environment;
  readonly image: string;
  /** A kubeconfig context to pin every call to. The pipeline passes its own kubeconfig file instead. */
  readonly context?: string;
  readonly podsGoneTimeoutMs?: number;
  readonly rolloutTimeoutSeconds?: number;
}

export interface Report {
  readonly database: string;
  readonly restoredMigrations: readonly string[];
  readonly applied: readonly string[];
  readonly scrub: ScrubResult;
  readonly seconds: number;
}

const POD_POLL_MS = 5_000;

export function parseSecret(json: string): PreviewServerSecret {
  const data = (JSON.parse(json) as { data?: Record<string, string> }).data ?? {};
  const decode = (key: string) => (data[key] === undefined ? undefined : Buffer.from(data[key], "base64").toString("utf8"));
  return { HOST: decode("HOST"), PORT: decode("PORT"), USER: decode("USER"), PASSWORD: decode("PASSWORD") };
}

/** Migrations AAT has applied that this branch does not carry, which means the branch is behind master. */
export function missingLocally(restored: readonly string[], local: readonly string[]): string[] {
  const carried = new Set(local);
  return restored.filter((name) => !carried.has(name));
}

export function behindMasterMessage(missing: readonly string[]): string {
  const count = missing.length === 1 ? "a migration" : `${missing.length} migrations`;
  return `AAT's database has applied ${count} this branch does not have (${missing.join(", ")}). Merge master into this branch and push again.`;
}

function replicasToRestore(output: string): number {
  const replicas = Number.parseInt(output.trim(), 10);
  return Number.isInteger(replicas) && replicas > 0 ? replicas : 1;
}

async function waitForPodsGone(deps: Dependencies, command: Command, timeoutMs: number): Promise<void> {
  const deadline = deps.now() + timeoutMs;
  for (;;) {
    const pods = (await deps.run(command)).trim();
    if (pods === "") {
      return;
    }
    if (deps.now() >= deadline) {
      throw new Error(`the preview's pods were still present after ${Math.round(timeoutMs / 1000)}s: ${pods.replaceAll("\n", ", ")}`);
    }
    await deps.sleep(POD_POLL_MS);
  }
}

async function step<T>(deps: Dependencies, label: string, body: () => Promise<T>): Promise<T> {
  const started = deps.now();
  deps.log(`${label}...`);
  const result = await body();
  deps.log(`${label}: done in ${((deps.now() - started) / 1000).toFixed(1)}s`);
  return result;
}

async function emptyAfterFailure(deps: Dependencies, target: PreviewTarget): Promise<void> {
  try {
    const session = await deps.connect(target);
    try {
      await session.reset();
    } finally {
      await session.close();
    }
    deps.log(`${target.database} was emptied after the failure, and the app left stopped`);
  } catch (error) {
    deps.log(`could not empty ${target.database} after the failure: ${String(error)}`);
  }
}

export async function loadAat(options: Options, deps: Dependencies): Promise<Report> {
  const started = deps.now();

  const source = dumpSource(options.env);
  const secret = parseSecret(await deps.run(readSecretCommand(options.context)));
  const target = previewTarget(secret, options.env.CHANGE_ID, source);
  deps.log(`copying ${source.host}/${source.database} into ${target.host}/${target.database}`);

  const replicas = replicasToRestore(await deps.run(readReplicasCommand(options.context, target)));

  await step(deps, "stopping the preview app", async () => {
    await deps.run(scaleCommand(options.context, target, 0));
    await waitForPodsGone(deps, listPodsCommand(options.context, target), options.podsGoneTimeoutMs ?? 300_000);
  });

  const directory = await deps.makeDumpDirectory();
  const dumpFile = `${directory}/aat.dump`;
  let result: Omit<Report, "seconds">;
  try {
    await step(deps, "dumping AAT", () => deps.run(dumpCommand(options.image, source), { stdoutTo: dumpFile }));
    const dump = await deps.inspectDump(dumpFile);
    if (dump.header !== "PGDMP") {
      throw new Error(`the dump is not a custom-format archive (${dump.bytes} bytes), so nothing was dropped`);
    }
    deps.log(`dump: ${(dump.bytes / 1024 / 1024).toFixed(1)} MiB`);

    let dropped = false;
    try {
      const session = await deps.connect(target);
      try {
        dropped = true;
        await step(deps, `dropping and recreating ${target.database}'s schema`, () => session.reset());
        await step(deps, "restoring the dump", () => deps.run(restoreCommand(options.image, target), { stdinFrom: dumpFile }));
        const scrub = await step(deps, "scrubbing secret-scanning locations", () => session.scrub());
        deps.log(`secret-scanning alerts: ${scrub.secretScanningRows}, locations blanked: ${scrub.scrubbed}`);

        const restoredMigrations = await session.migrations();
        const missing = missingLocally(restoredMigrations, await deps.localMigrations());
        if (missing.length > 0) {
          throw new Error(behindMasterMessage(missing));
        }
        deps.log(`AAT has applied ${restoredMigrations.length} migrations: ${restoredMigrations.join(", ")}`);

        const applied = await step(deps, "applying this branch's migrations", () => deps.migrate(previewUrl(target)));
        deps.log(applied.length === 0 ? "no migrations to apply: this branch is at AAT's level" : `applied ${applied.length}: ${applied.join(", ")}`);

        result = { database: target.database, restoredMigrations, applied, scrub };
      } finally {
        await session.close();
      }
    } catch (error) {
      if (dropped) {
        await emptyAfterFailure(deps, target);
      }
      throw error;
    }
  } finally {
    await deps.removeDumpDirectory(directory);
  }

  await step(deps, "starting the preview app", async () => {
    await deps.run(scaleCommand(options.context, target, replicas));
    await deps.run(rolloutStatusCommand(options.context, target, options.rolloutTimeoutSeconds ?? 600));
  });

  const seconds = (deps.now() - started) / 1000;
  deps.log(`copied AAT into ${target.database} in ${seconds.toFixed(1)}s`);
  return { ...result, seconds };
}
