import { EXIT_FAILED } from "./exit-status.ts";
import { main } from "./index.ts";

/**
 * The collector's executable entry point: `node dist/cli/run.js <command>`.
 *
 * Separate from `index.ts` so that module can be imported by a test, and by anything else that wants to run a
 * command in-process, without a top-level side effect. This file is the only place the process exits.
 */
main().then(
  (status) => process.exit(status),
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exit(EXIT_FAILED);
  }
);
