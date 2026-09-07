import { LIVENESS_CHECKS, probeResponse } from "@/health/probe";

export const dynamic = "force-dynamic";

export function GET(): Promise<Response> {
  return probeResponse(LIVENESS_CHECKS);
}
