import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const signOutUrl = vi.hoisted(() => vi.fn());

vi.mock("@/auth/entra", () => ({ signOutUrl }));

const { GET, dynamic } = await import("./route.ts");

const END_SESSION = "https://login.microsoftonline.com/a-tenant/oauth2/v2.0/logout";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("AUTH_DISABLED", "");
  vi.stubEnv("ENTRA_TENANT_ID", "a-tenant");
  vi.stubEnv("ENTRA_CLIENT_ID", "a-client");
  vi.stubEnv("ENTRA_CLIENT_SECRET", "a-secret");
  vi.stubEnv("ENTRA_REDIRECT_URI", "https://metrics.example/auth/callback");
  vi.stubEnv("SESSION_SECRET", "a-session-secret-long-enough-to-be-plausible");
  signOutUrl.mockResolvedValue(new URL(END_SESSION));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the logout route", () => {
  it("should clear the session and send the reader to Entra to be forgotten there too", async () => {
    const response = await GET();

    expect(response.headers.get("location")).toBe(END_SESSION);
    expect(response.headers.getSetCookie().join(" | ")).toMatch(/gm_session=.*max-age=0/i);
  });

  it("should clear the session and stay on this service where Entra advertises no end session endpoint", async () => {
    signOutUrl.mockResolvedValue(undefined);

    const response = await GET();

    expect(response.headers.get("location")).toBe("/repositories");
    expect(response.headers.getSetCookie().join(" | ")).toMatch(/gm_session=.*max-age=0/i);
  });

  it("should send the reader to the repositories where there is no sign-in to leave", async () => {
    vi.stubEnv("AUTH_DISABLED", "true");

    const response = await GET();

    expect(response.headers.get("location")).toBe("/repositories");
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(signOutUrl).not.toHaveBeenCalled();
  });

  it("should be dynamic", () => {
    expect(dynamic).toBe("force-dynamic");
  });
});
