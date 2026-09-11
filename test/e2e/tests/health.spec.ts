import { expect, test } from "@playwright/test";

/**
 * `@smoke` IS THIS FILE AND NOTHING ELSE.
 *
 * The smoke suite gates a deploy, so what belongs in it is "did this deployment come up and can it reach its
 * database" — questions with a fast, unambiguous answer. Rendering a page is not one of those: the dashboard
 * currently takes about twenty seconds against the real estate, and page assertions in here failed the master
 * build on a 30-second timeout while the deployment itself was perfectly healthy.
 *
 * Those assertions were not wrong and are not gone — they moved to `@regression`, which runs against AAT after a
 * deploy rather than deciding whether one may proceed. That keeps the slow render visible somewhere it can be
 * argued with, rather than blocking every release until it is fixed.
 */
test.describe("health @smoke @regression", () => {
  test("should report overall health UP at the path the pipeline polls @smoke @regression", async ({ request }) => {
    const response = await request.get("/health");

    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ status: "UP", services: { database: "UP" } });
  });

  test("should report liveness UP @smoke @regression", async ({ request }) => {
    const response = await request.get("/health/liveness");

    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ status: "UP", services: {} });
  });

  test("should report readiness UP with the database reachable @smoke @regression", async ({ request }) => {
    const response = await request.get("/health/readiness");

    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ status: "UP", services: { database: "UP" } });
  });
});
