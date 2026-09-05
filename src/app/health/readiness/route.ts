import { checkDatabase } from "@/evidence/store/health";

/**
 * Readiness: can this process serve a page right now.
 *
 * Checks Postgres, because every page reads from it and a pod that cannot is not ready for traffic —
 * but it does NOT check whether a collection has ever run. An empty database is a ready service with
 * nothing to show yet, which is exactly the state a preview deployment is in before its CronJob
 * first fires; failing readiness there would fail the deployment over a fact that is not a fault.
 */
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const database = await checkDatabase();
  const status = database.status === "UP" ? "UP" : "DOWN";
  return Response.json({ status, checks: { database } }, { status: status === "UP" ? 200 : 503 });
}
