/**
 * Liveness: is this process still able to answer at all.
 *
 * Deliberately touches nothing but the process itself — no database, no cache. A liveness probe that
 * checked Postgres would restart a healthy pod every time the database blinked, which is the
 * readiness probe's job to report and not a reason to kill anything.
 *
 * The `nodejs` Helm chart probes `/health/liveness` and `/health/readiness`, which is why these paths
 * exist rather than the `/healthz` the Python service served.
 */
export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json({ status: "UP" });
}
