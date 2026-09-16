import type { Environment } from "../evidence/store/database-url.ts";
import { describeDatabase } from "./database-target.ts";

/**
 * Reading the deployed secrets, which is the one thing a process does before it can reach a database.
 *
 * Both entry points start here — `instrumentation.ts` for the web pod and `cli/run.ts` for the collector — so
 * the decision about WHICH estate a process attaches to is made in one place rather than in two that could
 * disagree. What each of them supplies is the platform call itself: the web pod reaches the package through
 * `createRequire`, and that is its own decision to keep.
 */

/** The variable that asks for the deployed secrets outside production, and has to be set on purpose. */
export const KEY_VAULT_OPT_IN = "USE_KEY_VAULT";

/** The chart the properties-volume loader reads its secret list out of, for both entry points. */
export const CHART_PATH = "./charts/dtsse-github-metrics/values.yaml";

/** The platform call, injected so this module can be tested without a vault and without the package. */
export type ReadSecrets = (chartPath: string) => Promise<unknown>;

/**
 * Whether this process may read the Key Vault at all.
 *
 * FAIL LOCAL, which is `auth/settings.ts`'s fail-closed pointing the other way: authentication asks what
 * protects a reader, and this asks what a developer's machine is allowed to attach to, so the safe default is
 * the compose stack rather than the deployed one.
 *
 * It used to be unconditional, and `getPropertiesVolumeSecrets` finds `keyVaults:` AT ANY DEPTH of the chart —
 * so a plain `yarn dev` with an `az login` session resolved the `dtsse-aat` vault, merged the web pod's secret
 * list WITH the collector's, and attached to the production database holding 1,890 repositories. Nothing in the
 * command or its output said so. It also handed a dev server the GitHub App credentials the web pod
 * deliberately does not hold in production, so the reach was wider than the database.
 *
 * The failure mode this chooses instead is "no data locally", which a developer notices immediately and can fix
 * by running the collector against their own compose stack — or by opting in, on purpose, for one command.
 *
 * NODE_ENV IS THE DEPLOYED SIGNAL, and the runtime image sets it: `ENV NODE_ENV=production` in the final
 * Dockerfile stage covers the web pod and both CronJobs, none of which set it in the chart's `environment`. An
 * unset `NODE_ENV` is therefore treated as local — the direction that refuses production rather than reaching
 * for it — so anything running the built image outside a container has to opt in like a developer does.
 */
export function keyVaultAllowed(env: Environment = process.env): boolean {
  return env.NODE_ENV === "production" || env[KEY_VAULT_OPT_IN] === "true";
}

/**
 * Loads the deployed secrets where they are allowed, and says which database the process ended up with.
 *
 * AWAITED BEFORE ANY MODULE THAT READS `POSTGRES_*`, which is what both callers' dynamic imports are for:
 * `store/prisma.ts` resolves its connection string at module load, so the decision here has to be finished
 * before that module is reachable. Skipping the vault does not change that ordering — it only changes what the
 * environment holds by the time prisma.ts reads it.
 *
 * THE DATABASE LINE IS UNCONDITIONAL and comes last, after the secrets have or have not been read, so it
 * reports what the pool will actually use rather than what was set before the mount. It carries the host, port
 * and database name and no credential.
 */
export async function loadSecrets(read: ReadSecrets, env: Environment = process.env): Promise<void> {
  if (keyVaultAllowed(env)) {
    try {
      await read(CHART_PATH);
    } catch (error) {
      console.warn(`could not load Key Vault secrets: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    console.info(`not reading the Key Vault: NODE_ENV is ${env.NODE_ENV ?? "unset"} and ${KEY_VAULT_OPT_IN}=true is not set, so the local defaults apply`);
  }

  console.info(`database: ${describeDatabase(env)}`);
}
