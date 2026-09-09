import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE, sealSession } from "@/auth/session";
import { config, proxy } from "@/proxy";

const SECRET = "a-test-session-secret-long-enough-to-be-plausible";

function ask(url: string, cookies: Record<string, string> = {}): NextRequest {
  const request = new NextRequest(new URL(url, "https://metrics.example"));
  for (const [name, value] of Object.entries(cookies)) {
    request.cookies.set(name, value);
  }
  return request;
}

/**
 * What the navigation bar relies on: a request that named a span leaves with that span remembered.
 *
 * Authentication is disabled for these, because they are about the `weeks` cookie and nothing else. With the
 * guard in play every one of them would be answered with a redirect to Microsoft and would assert nothing about
 * the behaviour it names.
 */
describe("proxy weeks cookie", () => {
  beforeEach(() => {
    vi.stubEnv("AUTH_DISABLED", "true");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function written(url: string, cookie?: string): Promise<string | null> {
    const response = await proxy(ask(url, cookie === undefined ? {} : { weeks: cookie }));
    return response.headers.get("set-cookie");
  }

  it("remembers the span a link named, so the next nav link keeps it", async () => {
    expect(await written("/repositories?weeks=26")).toContain("weeks=26");
    expect(await written("/repositories?weeks=26")).toContain("path=/");
  });

  it("remembers it for a detail page as well as a list", async () => {
    expect(await written("/contributors/someone?weeks=12")).toContain("weeks=12");
  });

  it("writes nothing where the request named no span", async () => {
    expect(await written("/repositories")).toBeNull();
    expect(await written("/teams?filter=platform")).toBeNull();
  });

  it("writes nothing where the cookie already holds the span", async () => {
    expect(await written("/repositories?weeks=26", "26")).toBeNull();
  });

  it("replaces a cookie holding a different span", async () => {
    expect(await written("/repositories?weeks=26", "4")).toContain("weeks=26");
  });

  it("writes nothing for a value that could not be a span", async () => {
    expect(await written("/repositories?weeks=soon")).toBeNull();
    expect(await written("/repositories?weeks=-4")).toBeNull();
  });

  it("lets the page it was asked for through untouched", async () => {
    expect((await proxy(ask("/repositories?weeks=26"))).status).toBe(200);
  });

  it("runs for pages and not for the build’s own assets", () => {
    const [matcher] = config.matcher;
    const pattern = new RegExp(`^${matcher}$`);
    expect(pattern.test("/repositories")).toBe(true);
    expect(pattern.test("/contributors/someone")).toBe(true);
    expect(pattern.test("/_next/static/chunks/main.js")).toBe(false);
  });
});

describe("proxy sign-in guard", () => {
  beforeEach(() => {
    vi.stubEnv("AUTH_DISABLED", "");
    vi.stubEnv("SESSION_SECRET", SECRET);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("should send a reader with no session to sign in", async () => {
    const response = await proxy(ask("/repositories"));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain("/auth/login");
  });

  it("should carry the path and query through the sign-in, so a shared link survives it", async () => {
    const response = await proxy(ask("/repositories?weeks=26"));

    const location = new URL(response.headers.get("location") ?? "");
    expect(location.searchParams.get("redirect")).toBe("/repositories?weeks=26");
  });

  it("should let a reader with a valid session through", async () => {
    const cookie = await sealSession({ subject: "abc", name: "A Reader", groups: [] }, SECRET);

    const response = await proxy(ask("/repositories", { [SESSION_COOKIE]: cookie }));

    expect(response.status).toBe(200);
  });

  it("should still remember the span for a reader with a session", async () => {
    const cookie = await sealSession({ subject: "abc", name: "A Reader", groups: [] }, SECRET);

    const response = await proxy(ask("/repositories?weeks=26", { [SESSION_COOKIE]: cookie }));

    expect(response.headers.get("set-cookie")).toContain("weeks=26");
  });

  it("should refuse a session sealed under a different secret", async () => {
    const cookie = await sealSession({ subject: "abc", name: "A Reader", groups: [] }, "a-different-secret-entirely");

    const response = await proxy(ask("/repositories", { [SESSION_COOKIE]: cookie }));

    expect(response.status).toBe(307);
  });

  it.each(["/health", "/health/liveness", "/health/readiness"])("should let the probe path %s through unauthenticated", async (path) => {
    // A redirect to Microsoft is not `UP`, and the chart's probes plus the pipeline's HealthChecker both read
    // this path. Protecting it fails the deployment rather than the request.
    expect((await proxy(ask(path))).status).toBe(200);
  });

  it("should let the sign-in routes through, or nobody could ever obtain a session", async () => {
    expect((await proxy(ask("/auth/login"))).status).toBe(200);
    expect((await proxy(ask("/auth/callback?code=x&state=y"))).status).toBe(200);
  });

  it("should send a reader to sign in when the session secret is missing entirely", async () => {
    // Fail closed: a deployment that lost SESSION_SECRET must not serve the estate to anybody who asks.
    vi.stubEnv("SESSION_SECRET", "");

    expect((await proxy(ask("/repositories"))).status).toBe(307);
  });
});
