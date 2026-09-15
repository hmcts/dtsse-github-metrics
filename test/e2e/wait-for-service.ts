import { request } from "@playwright/test";

/**
 * Waits for the deployment under test to be routable before any spec runs.
 *
 * `helm upgrade --wait` returns when the pod is Ready, which is not the same as Traefik having a healthy backend
 * for the hostname; the pipeline updates DNS and starts the suite seconds later, and until the edge has an
 * endpoint it answers 502 or 503. Waiting once here rather than through Playwright's `retries` is deliberate:
 * retries re-run a spec within seconds, so every attempt lands inside the same outage.
 *
 * POLLS LIVENESS, not readiness and not a page. `/health/liveness` runs no check at all — see `src/health/probe.ts`
 * — so a 200 from it means precisely "a request reached this process and it answered", which is the one thing being
 * waited for. A page would make the gate wait for the report warm as well and time out on a cold estate.
 *
 * WHAT THIS GATE CANNOT DO is notice a pod that dies later, because it runs once and then the suite owns the
 * deployment. A 502 partway through a run is therefore NOT this gate failing to wait long enough, and reaching for
 * a longer deadline will not help: look for a restarting container first. `kubectl get pod` showing a non-zero
 * restart count, or `lastState.terminated`, names the cause in one line — see the `dev*` resource keys in
 * `charts/dtsse-github-metrics/values.yaml` for the instance of this that cost several builds.
 *
 * BOUNDED AND LOUD. A deployment that never becomes routable is a real failure and must not be waited on for the
 * length of the job, so the gate gives up after `DEADLINE_MS` and throws with the last thing it saw. It does not
 * swallow the outage — it reports it as itself rather than as an unrelated assertion three layers down.
 */
const READY_PATH = "/health/liveness";
const DEADLINE_MS = 180_000;
const INTERVAL_MS = 3_000;
/** How often to say something, so a stuck gate is visible in the build log rather than silent for three minutes. */
const REPORT_EVERY_MS = 15_000;

export default async function waitForService(): Promise<void> {
  const baseURL = process.env.TEST_URL ?? "http://localhost:3000";
  // `ignoreHTTPSErrors` for the reason the specs set it: the staging hostname is served by the cluster's own edge.
  const client = await request.newContext({ baseURL, ignoreHTTPSErrors: true });
  const startedAt = Date.now();
  let lastSeen = "no attempt completed";
  let lastReported = 0;

  try {
    while (Date.now() - startedAt < DEADLINE_MS) {
      try {
        const response = await client.get(READY_PATH, { timeout: INTERVAL_MS });
        if (response.status() === 200) {
          console.info(`${baseURL} answered ${READY_PATH} after ${Date.now() - startedAt}ms`);
          return;
        }
        lastSeen = `HTTP ${response.status()}`;
      } catch (error) {
        // A refused connection, a DNS miss and a timeout are all "not routable yet" and are all worth retrying.
        lastSeen = error instanceof Error ? (error.message.split("\n")[0] ?? "request failed") : String(error);
      }

      const waited = Date.now() - startedAt;
      if (waited - lastReported >= REPORT_EVERY_MS) {
        console.info(`waiting for ${baseURL}${READY_PATH}: ${lastSeen} after ${Math.round(waited / 1000)}s`);
        lastReported = waited;
      }
      await new Promise((settle) => setTimeout(settle, INTERVAL_MS));
    }
  } finally {
    await client.dispose();
  }

  throw new Error(
    `${baseURL}${READY_PATH} did not answer 200 within ${DEADLINE_MS / 1000}s; last saw ${lastSeen}. ` +
      "The deployment is not routable — check the pod is Running and that the ingress has an endpoint for this host."
  );
}
