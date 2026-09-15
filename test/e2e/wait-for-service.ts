import { request } from "@playwright/test";

/**
 * Waits for the deployment under test to be routable before any spec runs.
 *
 * THE TESTS WERE RACING THE INGRESS. `helm upgrade --wait` returns when the pod is Ready, which is not the same as
 * Traefik having a healthy backend for the hostname: the pipeline updates DNS and starts the suite about twelve
 * seconds later, and for a few seconds after that the edge still answers 502, 503 or `no available server`. Four
 * master builds failed that way — 33 and 34 in `@regression` on whichever page happened to load inside the window,
 * 35 in `@smoke` on all three health checks — every one of them against a pod whose own log was clean.
 *
 * A retry on the individual test cannot fix it. Playwright's `retries` re-runs a spec within seconds, so all three
 * attempts land inside the same outage; that is exactly what builds 33 to 35 show, three failures a few seconds
 * apart. The wait has to happen once, before the suite, which is what `globalSetup` is for.
 *
 * POLLS LIVENESS, not readiness and not a page. `/health/liveness` runs no check at all — see `src/health/probe.ts`
 * — so a 200 from it means precisely "a request reached this process and it answered", which is the one thing being
 * waited for. Readiness would work too but conflates the question, and a page would make the gate wait for the
 * report warm as well and time out on a cold estate.
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
