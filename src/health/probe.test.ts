import { type HealthCheck, hc } from "@hmcts-cft/cloud-native-platform";
import { describe, expect, it } from "vitest";
import { LIVENESS_CHECKS, probe, probeResponse } from "./probe.ts";

const up: HealthCheck = async () => hc.up();
const down: HealthCheck = async () => hc.down();

describe("probe", () => {
  it("should report UP with no services when nothing is checked", async () => {
    expect(await probe(LIVENESS_CHECKS)).toEqual({ status: "UP", services: {} });
  });

  it("should name each service beside its own status", async () => {
    expect(await probe({ database: up, upstream: up })).toEqual({ status: "UP", services: { database: "UP", upstream: "UP" } });
  });

  it("should report DOWN overall when any one service is down", async () => {
    expect(await probe({ database: down, upstream: up })).toEqual({ status: "DOWN", services: { database: "DOWN", upstream: "UP" } });
  });

  it("should treat a check that throws as DOWN rather than failing the probe", async () => {
    const exploding: HealthCheck = async () => {
      throw new Error("connection reset");
    };

    expect(await probe({ database: exploding })).toEqual({ status: "DOWN", services: { database: "DOWN" } });
  });

  it("should treat a rejected promise as DOWN", async () => {
    expect(await probe({ database: () => Promise.reject(new Error("timed out")) })).toEqual({ status: "DOWN", services: { database: "DOWN" } });
  });
});

describe("probeResponse", () => {
  it("should answer 200 when everything is up", async () => {
    const response = await probeResponse({ database: up });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "UP", services: { database: "UP" } });
  });

  it("should answer 503 when anything is down", async () => {
    const response = await probeResponse({ database: down });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "DOWN", services: { database: "DOWN" } });
  });
});
