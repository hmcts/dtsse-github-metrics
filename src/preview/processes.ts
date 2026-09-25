import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { mkdtemp, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { byCodePoint } from "../evidence/org/graph.ts";
import { applied, migrate, migrationNames, migrationsDirectory } from "../evidence/store/migrate.ts";
import type { Command } from "./commands.ts";
import { connectPreview, resetSchema, scrubSecretScanning } from "./database.ts";
import type { Dependencies, Io } from "./load-aat.ts";

/**
 * The real processes, files and connections behind `load-aat.ts`'s `Dependencies`.
 *
 * Children get an allow-listed environment rather than this process's, so the AAT password reaches the one child
 * whose command carries it — `pg_dump` — and nothing else.
 */

const INHERITED = ["PATH", "HOME", "USER", "TMPDIR", "KUBECONFIG", "DOCKER_CONFIG", "DOCKER_HOST", "AZURE_CONFIG_DIR"];

function childEnvironment(command: Command): NodeJS.ProcessEnv {
  const env: Record<string, string> = {};
  for (const name of INHERITED) {
    const value = process.env[name];
    if (value !== undefined) {
      env[name] = value;
    }
  }
  if (command.password !== undefined) {
    env.PGPASSWORD = command.password;
  }
  return env as NodeJS.ProcessEnv;
}

export async function run(command: Command, io: Io = {}): Promise<string> {
  const stdin = io.stdinFrom === undefined ? undefined : await open(io.stdinFrom, "r");
  const stdout = io.stdoutTo === undefined ? undefined : await open(io.stdoutTo, "wx", 0o600);
  try {
    return await new Promise<string>((resolve, reject) => {
      const options: SpawnOptions = { env: childEnvironment(command), stdio: [stdin?.fd ?? "ignore", stdout?.fd ?? "pipe", "inherit"] };
      const child: ChildProcess = spawn(command.program, command.args, options);
      const chunks: Buffer[] = [];
      child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
      child.on("error", reject);
      child.on("close", (code, signal) => {
        if (code === 0) {
          resolve(Buffer.concat(chunks).toString("utf8"));
        } else {
          reject(new Error(`${command.program} ${command.args.slice(0, 2).join(" ")} exited with ${signal ?? code}`));
        }
      });
    });
  } finally {
    await stdin?.close();
    await stdout?.close();
  }
}

export const dependencies: Dependencies = {
  run,
  connect: async (target) => {
    const client = await connectPreview(target);
    return {
      reset: () => resetSchema(client),
      scrub: () => scrubSecretScanning(client),
      migrations: async () => [...(await applied(client))].sort(byCodePoint),
      close: () => client.end()
    };
  },
  migrate: (connectionString) => migrate(migrationsDirectory(), undefined, connectionString),
  localMigrations: () => migrationNames(migrationsDirectory()),
  makeDumpDirectory: () => mkdtemp(path.join(tmpdir(), "preview-aat-copy-")),
  inspectDump: async (file) => {
    const handle = await open(file, "r");
    try {
      const header = Buffer.alloc(5);
      const { bytesRead } = await handle.read(header, 0, 5, 0);
      return { bytes: (await stat(file)).size, header: header.subarray(0, bytesRead).toString("latin1") };
    } finally {
      await handle.close();
    }
  },
  removeDumpDirectory: (directory) => rm(directory, { recursive: true, force: true }),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  log: (line) => console.info(`[preview:load-aat] ${line}`)
};
