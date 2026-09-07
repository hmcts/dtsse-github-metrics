import { probeResponse, READINESS_CHECKS } from "@/health/probe";

export const dynamic = "force-dynamic";

export function GET(): Promise<Response> {
  return probeResponse(READINESS_CHECKS);
}
