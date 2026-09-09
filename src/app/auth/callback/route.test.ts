import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const completeSignIn = vi.hoisted(() => vi.fn());
const readSignIn = vi.hoisted(() => vi.fn());

vi.mock("@/auth/entra", () => ({
  completeSignIn,
  readSignIn,
  SignInFailed: class SignInFailed extends Error {}
}));

const { GET } = await import("./route.ts");

const REDIRECT_URI = "https://github-metrics.aat.platform.hmcts.net/auth/callback";

/**
 * A request as the pod sees it: `nextUrl` carries the server's own listen address, which in Kubernetes is the pod
 * name, NOT the hostname the reader typed. Measured — a `Host` header does not change it.
 */
function callbackFrom(podName: string, query = "?code=a-code&state=a-state"): NextRequest {
  const request = new NextRequest(new URL(`http://${podName}:3000/auth/callback${query}`));
  request.cookies.set("gm_sign_in", "a-sealed-sign-in");
  return request;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.stubEnv("AUTH_DISABLED", "");
  vi.stubEnv("ENTRA_TENANT_ID", "a-tenant");
  vi.stubEnv("ENTRA_CLIENT_ID", "a-client");
  vi.stubEnv("ENTRA_CLIENT_SECRET", "a-secret");
  vi.stubEnv("ENTRA_REDIRECT_URI", REDIRECT_URI);
  vi.stubEnv("SESSION_SECRET", "a-session-secret-long-enough-to-be-plausible");
  readSignIn.mockResolvedValue({ state: "a-state", nonce: "a-nonce", codeVerifier: "a-verifier", returnTo: "/teams" });
  completeSignIn.mockResolvedValue({ subject: "0000", name: "A Reader" });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the callback's token exchange", () => {
  it("should exchange against the REGISTERED redirect uri, never the pod's own address", async () => {
    // openid-client derives the token request's redirect_uri from the URL it is handed. Handed the request URL it
    // would post redirect_uri=http://<pod-name>:3000/auth/callback, which matches neither the authorization
    // request nor the registration, and Entra answers AADSTS50011 for every single sign-in.
    await GET(callbackFrom("dtsse-github-metrics-nodejs-84b57c9548-m2xjb"));

    const handed = completeSignIn.mock.calls[0]?.[1] as URL;
    expect(handed.origin).toBe(new URL(REDIRECT_URI).origin);
    expect(handed.pathname).toBe("/auth/callback");
    expect(handed.toString()).not.toContain("dtsse-github-metrics-nodejs");
  });

  it("should carry the code and state through, since that is what is being exchanged", async () => {
    await GET(callbackFrom("a-pod", "?code=the-code&state=the-state"));

    const handed = completeSignIn.mock.calls[0]?.[1] as URL;
    expect(handed.searchParams.get("code")).toBe("the-code");
    expect(handed.searchParams.get("state")).toBe("the-state");
  });
});

describe("the callback's redirects", () => {
  it("should send a signed-in reader on with a RELATIVE location", async () => {
    const response = await GET(callbackFrom("a-pod"));

    const location = response.headers.get("location");
    expect(location).toBe("/teams");
    expect(location).not.toMatch(/^https?:\/\//);
  });

  it("should set the session and clear the spent sign-in", async () => {
    const response = await GET(callbackFrom("a-pod"));

    const cookies = response.headers.getSetCookie().join(" | ");
    expect(cookies).toContain("gm_session=");
    expect(cookies).toContain("gm_sign_in=");
    expect(cookies).toContain("max-age=0");
  });

  it("should send a callback with no sign-in in flight back to start again, relatively", async () => {
    readSignIn.mockResolvedValue(undefined);

    const response = await GET(callbackFrom("a-pod"));

    expect(response.headers.get("location")).toBe("/auth/login");
  });

  it("should offer a way back when the exchange fails, or that tab is simply stuck", async () => {
    // Two tabs share one gm_sign_in cookie, so the first tab's state check fails and reloading replays a spent
    // code. Without a link there is nothing the reader can do.
    completeSignIn.mockRejectedValue(new Error("state mismatch"));

    const response = await GET(callbackFrom("a-pod"));

    expect(response.status).toBe(403);
    expect(await response.text()).toContain("/auth/login");
  });
});
