import { describe, expect, it } from "vitest";
import type { Command } from "./commands.ts";
import { behindMasterMessage, type Dependencies, type Io, loadAat, missingLocally, parseSecret } from "./load-aat.ts";
import { PREVIEW_SERVER_HOST } from "./target.ts";

const AAT_HOST = "dts-github-metrics-aat.postgres.database.azure.com";
const ENV = {
  CHANGE_ID: "75",
  AAT_POSTGRES_HOST: AAT_HOST,
  AAT_POSTGRES_PORT: "5432",
  AAT_POSTGRES_USER: "pgadmin",
  AAT_POSTGRES_PASSWORD: "aat-password",
  AAT_POSTGRES_DATABASE: "github_metrics"
};
const MIGRATIONS = ["20260905062029_init", "20260922120000_security_alerts"];

function secretJson(host = PREVIEW_SERVER_HOST): string {
  const encode = (value: string) => Buffer.from(value).toString("base64");
  return JSON.stringify({ data: { HOST: encode(host), PORT: encode("5432"), USER: encode("hmcts"), PASSWORD: encode("preview-password") } });
}

interface Fake {
  readonly deps: Dependencies;
  readonly events: string[];
}

interface FakeOptions {
  secretHost?: string;
  replicas?: string;
  podPolls?: number;
  restored?: string[];
  local?: string[];
  applied?: string[];
  failOn?: string;
  dumpHeader?: string;
}

function fake(options: FakeOptions = {}): Fake {
  const events: string[] = [];
  let clock = 0;
  let pods = options.podPolls ?? 1;
  const fail = (event: string) => {
    events.push(event);
    if (options.failOn === event) {
      throw new Error(`${event} failed`);
    }
  };

  const describeCommand = (command: Command, io: Io): string => {
    const args = command.args.filter((arg) => !arg.startsWith("--context") && arg !== "--namespace" && arg !== "dtsse");
    if (command.program === "docker") {
      const program = args.find((arg) => arg === "pg_dump" || arg === "pg_restore");
      const dbname = args.find((arg) => arg.startsWith("--dbname="));
      return `${program} ${dbname?.includes(AAT_HOST) ? "aat" : "preview"}${io.stdoutTo ? ` > ${io.stdoutTo}` : ""}${io.stdinFrom ? ` < ${io.stdinFrom}` : ""}`;
    }
    return `kubectl ${args.join(" ")}`;
  };

  const deps: Dependencies = {
    run: async (command, io = {}) => {
      const event = describeCommand(command, io);
      fail(event);
      if (event.includes("get secret")) {
        return secretJson(options.secretHost);
      }
      if (event.includes("get deployment")) {
        return options.replicas ?? "1";
      }
      if (event.includes("get pods")) {
        pods -= 1;
        return pods >= 0 ? "pod/dtsse-github-metrics-pr-75-nodejs-abc\n" : "";
      }
      return "";
    },
    connect: async (target) => {
      fail(`connect ${target.database}`);
      return {
        reset: async () => fail("reset"),
        scrub: async () => {
          fail("scrub");
          return { scrubbed: 101, secretScanningRows: 103 };
        },
        migrations: async () => {
          fail("read restored migrations");
          return options.restored ?? MIGRATIONS;
        },
        close: async () => fail("close")
      };
    },
    migrate: async (connectionString) => {
      fail(`migrate ${new URL(connectionString).pathname}`);
      return options.applied ?? [];
    },
    localMigrations: async () => options.local ?? MIGRATIONS,
    makeDumpDirectory: async () => {
      fail("mkdtemp");
      return "/tmp/preview-aat-copy-x";
    },
    inspectDump: async () => ({ bytes: 6_698_391, header: options.dumpHeader ?? "PGDMP" }),
    removeDumpDirectory: async (directory) => fail(`rm ${directory}`),
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    log: () => undefined
  };
  return { deps, events };
}

const OPTIONS = { env: ENV, image: "postgres:16-alpine" };

describe("loadAat", () => {
  it("should stop the app, dump, replace, scrub, gate, migrate and restart, in that order", async () => {
    const { deps, events } = fake({ applied: ["20260930000000_new_column"], local: [...MIGRATIONS, "20260930000000_new_column"] });

    const report = await loadAat(OPTIONS, deps);

    expect(events).toEqual([
      "kubectl get secret postgres --output json",
      "kubectl get deployment dtsse-github-metrics-pr-75-nodejs --output jsonpath={.spec.replicas}",
      "kubectl scale deployment/dtsse-github-metrics-pr-75-nodejs --replicas=0",
      "kubectl get pods --selector app.kubernetes.io/name=dtsse-github-metrics-pr-75-nodejs --output name",
      "kubectl get pods --selector app.kubernetes.io/name=dtsse-github-metrics-pr-75-nodejs --output name",
      "mkdtemp",
      "pg_dump aat > /tmp/preview-aat-copy-x/aat.dump",
      "connect dtsse-github-metrics-pr-75",
      "reset",
      "pg_restore preview < /tmp/preview-aat-copy-x/aat.dump",
      "scrub",
      "read restored migrations",
      "migrate /dtsse-github-metrics-pr-75",
      "close",
      "rm /tmp/preview-aat-copy-x",
      "kubectl scale deployment/dtsse-github-metrics-pr-75-nodejs --replicas=1",
      "kubectl rollout status deployment/dtsse-github-metrics-pr-75-nodejs --timeout=600s"
    ]);
    expect(report).toMatchObject({ database: "dtsse-github-metrics-pr-75", applied: ["20260930000000_new_column"], restoredMigrations: MIGRATIONS });
  });

  it("should hand the AAT connection to pg_dump and to nothing else", async () => {
    const commands: Command[] = [];
    const { deps } = fake();
    const run = deps.run;

    await loadAat(OPTIONS, {
      ...deps,
      run: (command, io) => {
        commands.push(command);
        return run(command, io);
      }
    });

    const reachingAat = commands.filter((command) => command.args.join(" ").includes(AAT_HOST) || command.password === "aat-password");
    expect(reachingAat).toHaveLength(1);
    expect(reachingAat[0]?.args).toContain("pg_dump");
  });

  it("should refuse before touching anything when the secret names a server other than the preview one", async () => {
    const { deps, events } = fake({ secretHost: AAT_HOST });

    await expect(loadAat(OPTIONS, deps)).rejects.toThrow(/not the preview server/);
    expect(events).toEqual(["kubectl get secret postgres --output json"]);
  });

  it("should refuse before touching anything when it is not a pull-request build", async () => {
    const { deps, events } = fake();

    await expect(loadAat({ ...OPTIONS, env: { ...ENV, CHANGE_ID: undefined } }, deps)).rejects.toThrow("CHANGE_ID is not set");
    expect(events).toEqual(["kubectl get secret postgres --output json"]);
  });

  it("should refuse before reading the cluster when the source is the preview server", async () => {
    const { deps, events } = fake();

    await expect(loadAat({ ...OPTIONS, env: { ...ENV, AAT_POSTGRES_HOST: PREVIEW_SERVER_HOST } }, deps)).rejects.toThrow(/names the preview server/);
    expect(events).toEqual([]);
  });

  it("should fail with an instruction to merge master when AAT has a migration the branch lacks, leaving the database empty and the app stopped", async () => {
    const { deps, events } = fake({ restored: [...MIGRATIONS, "20261001000000_from_master"] });

    await expect(loadAat(OPTIONS, deps)).rejects.toThrow("(20261001000000_from_master). Merge master into this branch and push again.");
    expect(events.slice(events.indexOf("read restored migrations"))).toEqual([
      "read restored migrations",
      "close",
      "connect dtsse-github-metrics-pr-75",
      "reset",
      "close",
      "rm /tmp/preview-aat-copy-x"
    ]);
    expect(events.filter((event) => event.startsWith("migrate"))).toEqual([]);
  });

  it.each([
    "pg_restore preview < /tmp/preview-aat-copy-x/aat.dump",
    "scrub",
    "migrate /dtsse-github-metrics-pr-75"
  ])("should empty the database, delete the dump and never restart the app when %s fails", async (failOn) => {
    const { deps, events } = fake({ failOn });

    await expect(loadAat(OPTIONS, deps)).rejects.toThrow(`${failOn} failed`);
    const after = events.slice(events.indexOf(failOn) + 1);
    expect(after).toContain("reset");
    expect(after.at(-1)).toBe("rm /tmp/preview-aat-copy-x");
    expect(events.filter((event) => event.includes("--replicas=1"))).toEqual([]);
  });

  it("should leave the PR database untouched and delete the dump when the dump fails", async () => {
    const { deps, events } = fake({ failOn: "pg_dump aat > /tmp/preview-aat-copy-x/aat.dump" });

    await expect(loadAat(OPTIONS, deps)).rejects.toThrow("pg_dump aat");
    expect(events.slice(events.indexOf("pg_dump aat > /tmp/preview-aat-copy-x/aat.dump"))).toEqual([
      "pg_dump aat > /tmp/preview-aat-copy-x/aat.dump",
      "rm /tmp/preview-aat-copy-x"
    ]);
  });

  it("should leave the PR database untouched when the dump exited cleanly but is not an archive", async () => {
    const { deps, events } = fake({ dumpHeader: "" });

    await expect(loadAat(OPTIONS, deps)).rejects.toThrow("the dump is not a custom-format archive (6698391 bytes), so nothing was dropped");
    expect(events.filter((event) => event.startsWith("connect") || event === "reset")).toEqual([]);
    expect(events.at(-1)).toBe("rm /tmp/preview-aat-copy-x");
  });

  it("should not touch the PR database when it cannot connect to it", async () => {
    const { deps, events } = fake({ failOn: "connect dtsse-github-metrics-pr-75" });

    await expect(loadAat(OPTIONS, deps)).rejects.toThrow("connect dtsse-github-metrics-pr-75 failed");
    expect(events.slice(events.indexOf("connect dtsse-github-metrics-pr-75"))).toEqual(["connect dtsse-github-metrics-pr-75", "rm /tmp/preview-aat-copy-x"]);
  });

  it("should still fail with the original error when emptying the database after a failure also fails", async () => {
    const { deps } = fake({ failOn: "scrub" });
    let connections = 0;

    await expect(
      loadAat(OPTIONS, {
        ...deps,
        connect: async (target) => {
          connections += 1;
          if (connections > 1) {
            throw new Error("server gone");
          }
          return deps.connect(target);
        }
      })
    ).rejects.toThrow("scrub failed");
  });

  it("should fail when the pods do not go away in time", async () => {
    const { deps, events } = fake({ podPolls: 1_000 });

    await expect(loadAat({ ...OPTIONS, podsGoneTimeoutMs: 20_000 }, deps)).rejects.toThrow(/still present after 20s/);
    expect(events).not.toContain("mkdtemp");
  });

  it("should restore the replica count the deployment had, and at least one", async () => {
    const two = fake({ replicas: "2" });
    const zero = fake({ replicas: "0" });

    await loadAat(OPTIONS, two.deps);
    await loadAat(OPTIONS, zero.deps);

    expect(two.events).toContain("kubectl scale deployment/dtsse-github-metrics-pr-75-nodejs --replicas=2");
    expect(zero.events).toContain("kubectl scale deployment/dtsse-github-metrics-pr-75-nodejs --replicas=1");
  });
});

describe("missingLocally", () => {
  it("should name the migrations AAT has that the branch does not", () => {
    expect(missingLocally(["a", "b", "c"], ["a", "c", "d"])).toEqual(["b"]);
  });

  it("should find nothing missing when the branch carries everything AAT has and more", () => {
    expect(missingLocally(["a"], ["a", "b"])).toEqual([]);
  });
});

describe("behindMasterMessage", () => {
  it("should count several migrations", () => {
    expect(behindMasterMessage(["a", "b"])).toContain("2 migrations this branch does not have (a, b)");
  });
});

describe("parseSecret", () => {
  it("should decode the secret's keys and leave absent ones undefined", () => {
    expect(parseSecret(JSON.stringify({ data: { HOST: Buffer.from("h").toString("base64") } }))).toEqual({
      HOST: "h",
      PORT: undefined,
      USER: undefined,
      PASSWORD: undefined
    });
    expect(parseSecret("{}")).toEqual({ HOST: undefined, PORT: undefined, USER: undefined, PASSWORD: undefined });
  });
});
