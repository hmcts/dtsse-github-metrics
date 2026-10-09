import { describe, expect, it } from "vitest";
import * as liveness from "./liveness/route.ts";
import * as readiness from "./readiness/route.ts";
import * as health from "./route.ts";

describe("the health routes", () => {
  it.each([
    ["/health", health],
    ["/health/liveness", liveness],
    ["/health/readiness", readiness]
  ])("%s should answer UP with no services, and never be cached", async (_path, route) => {
    const response = await route.GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "UP", services: {} });
    expect(route.dynamic).toBe("force-dynamic");
  });
});
