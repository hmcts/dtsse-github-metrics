import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authorizationUrl = vi.hoisted(() => vi.fn());
const beginSignIn = vi.hoisted(() => vi.fn());
const sealSignIn = vi.hoisted(() => vi.fn());

vi.mock("@/auth/entra", () => ({ authorizationUrl, beginSignIn, sealSignIn }));

const { GET, dynamic } = await import("./route.ts");

const AUTHORIZE = "https://login.microsoftonline.com/a-tenant/oauth2/v2.0/authorize?state=a-state";

function login(query = ""): NextRequest {
  return new NextRequest(new URL(`http://a-pod:3000/auth/login${query}`));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("AUTH_DISABLED", "");
  vi.stubEnv("ENTRA_TENANT_ID", "a-tenant");
  vi.stubEnv("ENTRA_CLIENT_ID", "a-client");
  vi.stubEnv("ENTRA_CLIENT_SECRET", "a-secret");
  vi.stubEnv("ENTRA_REDIRECT_URI", "https://metrics.example/auth/callback");
  vi.stubEnv("SESSION_SECRET", "a-session-secret-long-enough-to-be-plausible");
  beginSignIn.mockImplementation((returnTo: string) => ({ state: "a-state", nonce: "a-nonce", codeVerifier: "a-verifier", returnTo }));
  authorizationUrl.mockResolvedValue(new URL(AUTHORIZE));
  sealSignIn.mockResolvedValue("a-sealed-sign-in");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the login route", () => {
  it("should send the reader to Entra, holding the sign-in in a cookie for the callback", async () => {
    const response = await GET(login("?redirect=/teams"));

    expect(response.headers.get("location")).toBe(AUTHORIZE);
    expect(beginSignIn).toHaveBeenCalledWith("/teams");
    expect(response.headers.getSetCookie().join(" | ")).toContain("gm_sign_in=a-sealed-sign-in");
  });

  it("should refuse a return path off this origin before the sign-in begins", async () => {
    await GET(login("?redirect=//elsewhere.example"));

    expect(beginSignIn).toHaveBeenCalledWith("/repositories");
  });

  it("should send the reader straight on where there is nothing to sign in to", async () => {
    vi.stubEnv("AUTH_DISABLED", "true");

    const response = await GET(login("?redirect=/teams"));

    expect(response.headers.get("location")).toBe("/teams");
    expect(beginSignIn).not.toHaveBeenCalled();
  });

  it("should be dynamic, so one reader's sign-in is never served to another", () => {
    expect(dynamic).toBe("force-dynamic");
  });
});
