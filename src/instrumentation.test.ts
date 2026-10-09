import { afterEach, describe, expect, it, vi } from "vitest";
import { register } from "./instrumentation.ts";

const registerNode = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("./instrumentation-node.ts", () => ({ registerNode }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("register", () => {
  it("should start the pod in the Node.js runtime", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");

    await register();

    expect(registerNode).toHaveBeenCalledOnce();
  });

  it("should do nothing in the Edge runtime", async () => {
    vi.stubEnv("NEXT_RUNTIME", "edge");

    await register();

    expect(registerNode).not.toHaveBeenCalled();
  });
});
