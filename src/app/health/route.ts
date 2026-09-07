import { checkDatabase } from "@/evidence/store/health";

/**
 * `/health`: the overall answer, and the one the PIPELINE asks for.
 *
 * Three health paths, because two different things ask and they ask different questions. The `nodejs` chart
 * probes `/health/liveness` and `/health/readiness` — Kubernetes wants those separate, or a blinking database
 * would restart a healthy pod. `helmInstall` then polls `${SERVICE_FQDN}/health` up to 40 times after the deploy
 * and treats anything above 300 as unhealthy, so without this route a preview whose pods were all ready still
 * failed its deploy on a 404 from Next's not-found page.
 *
 * Reports the same checks readiness does. A pod that cannot reach Postgres has not come up, which is exactly
 * what the caller polling this wants to be told.
 */
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const database = await checkDatabase();
  const status = database.status === "UP" ? "UP" : "DOWN";
  return Response.json({ status, checks: { database } }, { status: status === "UP" ? 200 : 503 });
}
