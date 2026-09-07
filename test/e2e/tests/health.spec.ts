import { expect, test } from "@playwright/test";

/**
 * The three health paths, and who asks for each.
 *
 * If these are wrong the deployment never goes green, so they are the first thing a preview asserts.
 */
test.describe("health @smoke @regression", () => {
  test("should report overall health UP at the path the pipeline polls @smoke @regression", async ({ request }) => {
    // `/health`, which `helmInstall` polls after the deploy — separately from the chart's two probe paths below.
    // A 404 here failed a preview whose pods were all ready, so it is asserted rather than assumed.
    const response = await request.get("/health");

    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({ status: "UP", checks: { database: { status: "UP" } } });
  });

  test("should report liveness UP @smoke @regression", async ({ request }) => {
    const response = await request.get("/health/liveness");

    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({ status: "UP" });
  });

  test("should report readiness UP with the database reachable @smoke @regression", async ({ request }) => {
    // Readiness checks Postgres but NOT whether a collection has run: an empty database is a ready service with
    // nothing to show yet, which is exactly what a preview deploys into.
    const response = await request.get("/health/readiness");

    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({ status: "UP", checks: { database: { status: "UP" } } });
  });
});
