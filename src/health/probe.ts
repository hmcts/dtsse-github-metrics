import type { HealthCheck, HealthStatus } from "@hmcts-cft/cloud-native-platform";

export interface ProbeResult {
  status: HealthStatus;
  services: Record<string, HealthStatus>;
}

export const LIVENESS_CHECKS: Record<string, HealthCheck> = {};

/**
 * NO DATABASE QUERY, from 2026-09-15. A probe answers whether this process is serving HTTP, and nothing else.
 *
 * It used to run `SELECT 1` through the shared `pg.Pool`, whose default maximum is ten connections. On a cold pod
 * the warmer reads the whole estate's facts for five spans — ~80 MB of jsonb — while requests are already being
 * served, so the pool saturates and the probe's query WAITS FOR A CONNECTION rather than for Postgres. Past the
 * probe's 3-second timeout, three times at fifteen-second intervals, Kubernetes takes the pod out of the Service
 * and Traefik answers `no available server` for about forty-five seconds. Measured on a staging install: a healthy
 * pod, no restart — `LIVENESS_CHECKS` is empty so liveness never noticed — and the regression suite failing on
 * whichever page happened to load inside that window.
 *
 * So the probe was reporting how busy the connection pool was, dressed up as whether the database was reachable.
 * The two are not the same question and only one of them belongs in a probe.
 *
 * A database check is still worth having as a DIAGNOSTIC; it just must not gate routing. It would need its own
 * connection rather than the application's pool, and its own endpoint that no probe polls.
 */
export const READINESS_CHECKS: Record<string, HealthCheck> = {};

export async function probe(checks: Record<string, HealthCheck>): Promise<ProbeResult> {
  const services: Record<string, HealthStatus> = {};
  let allUp = true;

  await Promise.all(
    Object.entries(checks).map(async ([name, check]) => {
      try {
        services[name] = await check();
      } catch {
        services[name] = "DOWN";
      }
      if (services[name] === "DOWN") {
        allUp = false;
      }
    })
  );

  return { status: allUp ? "UP" : "DOWN", services };
}

export async function probeResponse(checks: Record<string, HealthCheck>): Promise<Response> {
  const result = await probe(checks);
  return Response.json(result, { status: result.status === "UP" ? 200 : 503 });
}
