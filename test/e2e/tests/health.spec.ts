import { expect, test } from "@playwright/test";

/**
 * The probes the `nodejs` chart uses to decide whether a pod may take traffic.
 *
 * If these are wrong the deployment never goes green, so they are the first thing a preview asserts.
 */
test.describe("health @smoke", () => {
  test("should report liveness UP @smoke", async ({ request }) => {
    const response = await request.get("/health/liveness");

    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({ status: "UP" });
  });

  test("should report readiness UP with the database reachable @smoke", async ({ request }) => {
    // Readiness checks Postgres but NOT whether a collection has run: an empty database is a ready service with
    // nothing to show yet, which is exactly what a preview deploys into.
    const response = await request.get("/health/readiness");

    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({ status: "UP", checks: { database: { status: "UP" } } });
  });
});
