import { expect, test } from "@playwright/test";

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
