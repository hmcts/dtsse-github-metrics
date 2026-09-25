import { assertPreviewTarget, type DumpSource, libpqConninfo, type PreviewTarget } from "./target.ts";

/**
 * The external processes the copy runs, as argument vectors rather than shell strings, so no value is ever
 * interpreted by a shell and no password is ever an argument.
 *
 * The Postgres clients run from the pipeline's own `postgres:16-alpine` image rather than whatever the agent has
 * installed, because `pg_dump` refuses a server newer than itself and the server is 16. `--network host` because
 * Docker's default bridge replaces a systemd-resolved stub with public resolvers, which cannot see the private DNS
 * zones both flexible servers resolve through.
 */

export interface Command {
  readonly program: string;
  readonly args: readonly string[];
  /** Set only on the child, never on this process, and passed to the container by name so it is not an argument. */
  readonly password?: string;
}

export const NAMESPACE = "dtsse";

export function deploymentName(target: PreviewTarget): string {
  assertPreviewTarget(target);
  return `${target.database}-nodejs`;
}

function postgresClient(image: string, program: "pg_dump" | "pg_restore", args: readonly string[], password: string): Command {
  return {
    program: "docker",
    args: ["run", "--rm", "--interactive", "--network", "host", "--env", "PGPASSWORD", image, program, ...args],
    password
  };
}

/** The ONLY command the AAT connection is ever handed to, and it reads. Its output is this process's stdout. */
export function dumpCommand(image: string, source: DumpSource): Command {
  return postgresClient(image, "pg_dump", ["--format=custom", "--no-owner", "--no-privileges", `--dbname=${libpqConninfo(source)}`], source.password);
}

/**
 * One transaction, stopping at the first error: a restore that fails leaves the empty schema rather than half an
 * estate. Reads the dump from stdin.
 */
export function restoreCommand(image: string, target: PreviewTarget): Command {
  assertPreviewTarget(target);
  return postgresClient(
    image,
    "pg_restore",
    ["--no-owner", "--no-privileges", "--exit-on-error", "--single-transaction", `--dbname=${libpqConninfo(target)}`],
    target.password
  );
}

function kubectl(context: string | undefined, args: readonly string[]): Command {
  return { program: "kubectl", args: [...(context ? ["--context", context] : []), "--namespace", NAMESPACE, ...args] };
}

export function readSecretCommand(context: string | undefined): Command {
  return kubectl(context, ["get", "secret", "postgres", "--output", "json"]);
}

export function readReplicasCommand(context: string | undefined, target: PreviewTarget): Command {
  return kubectl(context, ["get", "deployment", deploymentName(target), "--output", "jsonpath={.spec.replicas}"]);
}

export function scaleCommand(context: string | undefined, target: PreviewTarget, replicas: number): Command {
  return kubectl(context, ["scale", `deployment/${deploymentName(target)}`, `--replicas=${replicas}`]);
}

export function listPodsCommand(context: string | undefined, target: PreviewTarget): Command {
  return kubectl(context, ["get", "pods", "--selector", `app.kubernetes.io/name=${deploymentName(target)}`, "--output", "name"]);
}

export function rolloutStatusCommand(context: string | undefined, target: PreviewTarget, timeoutSeconds: number): Command {
  return kubectl(context, ["rollout", "status", `deployment/${deploymentName(target)}`, `--timeout=${timeoutSeconds}s`]);
}
