import { type HealthCheck, type HealthStatus, hc } from "@hmcts-cft/cloud-native-platform";
import { checkDatabase } from "../evidence/store/health.ts";

export interface ProbeResult {
  status: HealthStatus;
  services: Record<string, HealthStatus>;
}

export const LIVENESS_CHECKS: Record<string, HealthCheck> = {};

export const READINESS_CHECKS: Record<string, HealthCheck> = {
  database: hc.raw(async () => (await checkDatabase()).status)
};

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
