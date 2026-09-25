import { loadAat } from "./load-aat.ts";
import { dependencies } from "./processes.ts";
import { SOURCE_VARIABLES } from "./target.ts";

/**
 * `yarn preview:load-aat`, which `Jenkinsfile_CNP` runs in `before('smoketest:preview')` on pull requests only.
 *
 * Reads `CHANGE_ID`, the `AAT_POSTGRES_*` source and `PG_CLIENT_IMAGE` from the environment, and the target from
 * the cluster's `postgres` secret through `kubectl`, using `KUBECONFIG` or `--context $KUBE_CONTEXT`.
 */
async function main(): Promise<number> {
  const image = process.env.PG_CLIENT_IMAGE;
  if (!image) {
    console.error("[preview:load-aat] PG_CLIENT_IMAGE is not set");
    return 1;
  }
  const env = { ...process.env };
  for (const name of Object.values(SOURCE_VARIABLES)) {
    delete process.env[name];
  }
  try {
    await loadAat({ env, image, ...(process.env.KUBE_CONTEXT ? { context: process.env.KUBE_CONTEXT } : {}) }, dependencies);
    return 0;
  } catch (error) {
    console.error(`[preview:load-aat] FAILED: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

main().then((status) => process.exit(status));
