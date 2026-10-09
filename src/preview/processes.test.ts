import type { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dependencies, run } from "./processes.ts";
import type { PreviewTarget } from "./target.ts";

interface FakeChild extends EventEmitter {
  stdout: EventEmitter | null;
}

const spawned = vi.hoisted(() => ({
  calls: [] as { program: string; args: readonly string[]; options: { env: NodeJS.ProcessEnv; stdio: unknown[] } }[],
  script: (_child: FakeChild) => {}
}));
const client = vi.hoisted(() => ({ end: vi.fn(async () => undefined) }));
const connectPreview = vi.hoisted(() => vi.fn(async () => client));
const resetSchema = vi.hoisted(() => vi.fn(async () => undefined));
const scrubSecretScanning = vi.hoisted(() => vi.fn(async () => ({ alerts: 1 })));
const applied = vi.hoisted(() => vi.fn(async () => new Set(["b_second", "a_first"])));
const migrate = vi.hoisted(() => vi.fn(async () => ["a_first"]));
const migrationNames = vi.hoisted(() => vi.fn(async () => ["a_first", "b_second"]));
const migrationsDirectory = vi.hoisted(() => vi.fn(() => "/migrations"));

vi.mock("node:child_process", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    spawn: (program: string, args: readonly string[], options: { env: NodeJS.ProcessEnv; stdio: unknown[] }) => {
      spawned.calls.push({ program, args, options });
      const child = Object.assign(new EventEmitter(), { stdout: options.stdio[1] === "pipe" ? new EventEmitter() : null });
      setImmediate(() => spawned.script(child));
      return child;
    }
  };
});
vi.mock("./database.ts", () => ({ connectPreview, resetSchema, scrubSecretScanning }));
vi.mock("../evidence/store/migrate.ts", () => ({ applied, migrate, migrationNames, migrationsDirectory }));

let directory: string;

beforeEach(async () => {
  spawned.calls = [];
  directory = await mkdtemp(path.join(tmpdir(), "processes-test-"));
  vi.stubEnv("PATH", "/usr/bin");
  vi.stubEnv("HOME", "/home/test");
  // Every other allow-listed name is cleared so the expected environment does not depend on the machine running
  // the suite: macOS always sets TMPDIR, and a developer may have the Kubernetes, Docker or Azure ones set.
  for (const name of ["USER", "TMPDIR", "KUBECONFIG", "DOCKER_CONFIG", "DOCKER_HOST", "AZURE_CONFIG_DIR"]) {
    vi.stubEnv(name, undefined);
  }
  vi.stubEnv("PGPASSWORD", "must-not-leak");
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("run", () => {
  it("should resolve with the child's stdout and pass it only the allow-listed environment", async () => {
    spawned.script = (child) => {
      child.stdout?.emit("data", Buffer.from("hello "));
      child.stdout?.emit("data", Buffer.from("world"));
      child.emit("close", 0, null);
    };

    expect(await run({ program: "kubectl", args: ["get", "secret"] })).toBe("hello world");
    const [call] = spawned.calls;
    expect(call?.program).toBe("kubectl");
    expect(call?.options.env).toEqual({ PATH: "/usr/bin", HOME: "/home/test" });
    expect(call?.options.stdio).toEqual(["ignore", "pipe", "inherit"]);
  });

  it("should hand the password to the child that carries it", async () => {
    spawned.script = (child) => child.emit("close", 0, null);

    await run({ program: "docker", args: ["run"], password: "aat-password" });

    expect(spawned.calls[0]?.options.env).toEqual({ PATH: "/usr/bin", HOME: "/home/test", PGPASSWORD: "aat-password" });
  });

  it("should give the child the files it reads and writes, and close them afterwards", async () => {
    const input = path.join(directory, "in.dump");
    const output = path.join(directory, "out.dump");
    await writeFile(input, "PGDMP");
    spawned.script = (child) => child.emit("close", 0, null);

    expect(await run({ program: "docker", args: ["run"] }, { stdinFrom: input, stdoutTo: output })).toBe("");

    const stdio = spawned.calls[0]?.options.stdio ?? [];
    expect(typeof stdio[0]).toBe("number");
    expect(typeof stdio[1]).toBe("number");
    expect((await stat(output)).mode & 0o777).toBe(0o600);
  });

  it("should reject with the exit code of a failed child", async () => {
    spawned.script = (child) => child.emit("close", 2, null);

    await expect(run({ program: "pg_dump", args: ["--format", "custom", "--verbose"] })).rejects.toThrow("pg_dump --format custom exited with 2");
  });

  it("should reject with the signal that killed the child", async () => {
    spawned.script = (child) => child.emit("close", null, "SIGTERM");

    await expect(run({ program: "pg_restore", args: ["--clean"] })).rejects.toThrow("pg_restore --clean exited with SIGTERM");
  });

  it("should reject when the child cannot be started", async () => {
    spawned.script = (child) => child.emit("error", new Error("spawn docker ENOENT"));

    await expect(run({ program: "docker", args: [] })).rejects.toThrow("spawn docker ENOENT");
  });
});

describe("dependencies", () => {
  it("should run commands through run", () => {
    expect(dependencies.run).toBe(run);
  });

  it("should open a session on the preview database", async () => {
    const target = { host: "preview" } as unknown as PreviewTarget;

    const session = await dependencies.connect(target);
    await session.reset();
    const scrubbed = await session.scrub();
    const migrations = await session.migrations();
    await session.close();

    expect(connectPreview).toHaveBeenCalledWith(target);
    expect(resetSchema).toHaveBeenCalledWith(client);
    expect(scrubbed).toEqual({ alerts: 1 });
    expect(migrations).toEqual(["a_first", "b_second"]);
    expect(client.end).toHaveBeenCalled();
  });

  it("should migrate and list migrations from the migrations directory", async () => {
    expect(await dependencies.migrate("postgres://preview")).toEqual(["a_first"]);
    expect(migrate).toHaveBeenCalledWith("/migrations", undefined, "postgres://preview");
    expect(await dependencies.localMigrations()).toEqual(["a_first", "b_second"]);
    expect(migrationNames).toHaveBeenCalledWith("/migrations");
  });

  it("should make, inspect and remove a dump directory", async () => {
    const dumps = await dependencies.makeDumpDirectory();
    expect(path.basename(dumps)).toMatch(/^preview-aat-copy-/);
    const file = path.join(dumps, "aat.dump");
    await writeFile(file, "PGDMP and the rest");

    expect(await dependencies.inspectDump(file)).toEqual({ bytes: 18, header: "PGDMP" });

    await dependencies.removeDumpDirectory(dumps);
    await expect(readFile(file)).rejects.toThrow();
  });

  it("should read only as much header as a short file has", async () => {
    const file = path.join(directory, "short.dump");
    await writeFile(file, "PG");

    expect(await dependencies.inspectDump(file)).toEqual({ bytes: 2, header: "PG" });
  });

  it("should sleep, tell the time and log with the command's prefix", async () => {
    vi.useFakeTimers({ now: 1234 });
    try {
      const slept = dependencies.sleep(500);
      await vi.advanceTimersByTimeAsync(500);
      await slept;
      expect(dependencies.now()).toBe(1734);
    } finally {
      vi.useRealTimers();
    }

    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    dependencies.log("dumped");
    expect(info).toHaveBeenCalledWith("[preview:load-aat] dumped");
  });
});
