import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthSettings } from "./settings.ts";

const discovery = vi.hoisted(() => vi.fn());
const buildAuthorizationUrl = vi.hoisted(() => vi.fn());
const authorizationCodeGrant = vi.hoisted(() => vi.fn());
const calculatePKCECodeChallenge = vi.hoisted(() => vi.fn());

vi.mock("openid-client", () => ({
  discovery,
  buildAuthorizationUrl,
  authorizationCodeGrant,
  calculatePKCECodeChallenge,
  randomState: () => "a-state",
  randomNonce: () => "a-nonce",
  randomPKCECodeVerifier: () => "a-verifier"
}));

const { authorizationUrl, beginSignIn, completeSignIn, configuration, forgetDiscovery, readSignIn, sealSignIn, SignInFailed, signOutUrl } = await import(
  "./entra.ts"
);

const SETTINGS: AuthSettings = {
  tenantId: "a-tenant",
  clientId: "a-client",
  clientSecret: "a-secret",
  redirectUri: "https://metrics.example/auth/callback",
  sessionSecret: "a-session-secret-long-enough-to-be-plausible",
  allowedGroupIds: []
};

/** A discovered configuration carrying whatever server metadata a case needs. */
function discovered(metadata: Record<string, unknown> = {}) {
  return { serverMetadata: () => metadata };
}

beforeEach(() => {
  vi.clearAllMocks();
  forgetDiscovery();
  discovery.mockResolvedValue(discovered());
  calculatePKCECodeChallenge.mockResolvedValue("a-challenge");
  buildAuthorizationUrl.mockImplementation((_config: unknown, params: Record<string, string>) => {
    const url = new URL("https://login.microsoftonline.com/a-tenant/oauth2/v2.0/authorize");
    for (const [name, value] of Object.entries(params)) {
      url.searchParams.set(name, value);
    }
    return url;
  });
});

describe("configuration", () => {
  it("should discover against the tenant's v2 issuer", async () => {
    await configuration(SETTINGS);

    expect(discovery).toHaveBeenCalledWith(new URL("https://login.microsoftonline.com/a-tenant/v2.0"), "a-client", "a-secret");
  });

  it("should discover once and reuse it, rather than once per sign-in", async () => {
    await configuration(SETTINGS);
    await configuration(SETTINGS);

    expect(discovery).toHaveBeenCalledOnce();
  });
});

describe("beginSignIn", () => {
  it("should carry the state, nonce and verifier the callback will be checked against", () => {
    const signIn = beginSignIn("/teams");

    expect(signIn).toEqual({ state: "a-state", nonce: "a-nonce", codeVerifier: "a-verifier", returnTo: "/teams" });
  });
});

describe("sealSignIn and readSignIn", () => {
  it("should carry a sign-in back out unchanged", async () => {
    const signIn = beginSignIn("/repositories?weeks=26");

    expect(await readSignIn(await sealSignIn(signIn, SETTINGS.sessionSecret), SETTINGS.sessionSecret)).toEqual(signIn);
  });

  it("should not put the verifier where a browser can read it", async () => {
    expect(await sealSignIn(beginSignIn("/"), SETTINGS.sessionSecret)).not.toContain("a-verifier");
  });

  it("should refuse a cookie sealed under a different secret", async () => {
    const sealed = await sealSignIn(beginSignIn("/"), "another-secret-entirely");

    expect(await readSignIn(sealed, SETTINGS.sessionSecret)).toBeUndefined();
  });

  it.each([
    ["nothing", undefined],
    ["a value that is not a token", "not-a-jwe"]
  ])("should refuse %s, because a callback cannot be checked without it", async (_label, cookie) => {
    expect(await readSignIn(cookie, SETTINGS.sessionSecret)).toBeUndefined();
  });
});

describe("authorizationUrl", () => {
  it("should ask for only the scopes the dashboard uses", async () => {
    const url = await authorizationUrl(SETTINGS, beginSignIn("/"));

    expect(url.searchParams.get("scope")).toBe("openid profile email");
  });

  it("should carry the redirect uri, state and nonce", async () => {
    const url = await authorizationUrl(SETTINGS, beginSignIn("/"));

    expect(url.searchParams.get("redirect_uri")).toBe(SETTINGS.redirectUri);
    expect(url.searchParams.get("state")).toBe("a-state");
    expect(url.searchParams.get("nonce")).toBe("a-nonce");
  });

  it("should use PKCE with S256, never the verifier itself", async () => {
    const url = await authorizationUrl(SETTINGS, beginSignIn("/"));

    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe("a-challenge");
    expect(url.toString()).not.toContain("a-verifier");
  });
});

describe("completeSignIn", () => {
  const CURRENT = new URL("https://metrics.example/auth/callback?code=a-code&state=a-state");

  function granted(claims: Record<string, unknown> | undefined) {
    authorizationCodeGrant.mockResolvedValue({ claims: () => claims });
  }

  it("should check the state, nonce and verifier it was given", async () => {
    granted({ sub: "0000", name: "A Reader" });

    await completeSignIn(SETTINGS, CURRENT, beginSignIn("/"));

    expect(authorizationCodeGrant).toHaveBeenCalledWith(expect.anything(), CURRENT, {
      expectedState: "a-state",
      expectedNonce: "a-nonce",
      pkceCodeVerifier: "a-verifier"
    });
  });

  it("should build a session from the id token claims", async () => {
    granted({ sub: "0000", name: "A Reader", email: "a.reader@justice.gov.uk", groups: ["group-a"] });

    expect(await completeSignIn(SETTINGS, CURRENT, beginSignIn("/"))).toEqual({
      subject: "0000",
      name: "A Reader",
      email: "a.reader@justice.gov.uk",
      groups: ["group-a"]
    });
  });

  it("should fall back to the subject when Entra returns no display name", async () => {
    granted({ sub: "0000" });

    expect((await completeSignIn(SETTINGS, CURRENT, beginSignIn("/"))).name).toBe("0000");
  });

  it("should read an absent groups claim as no groups, which is what a registration without the claim sends", async () => {
    granted({ sub: "0000", name: "A Reader" });

    expect((await completeSignIn(SETTINGS, CURRENT, beginSignIn("/"))).groups).toEqual([]);
  });

  it("should keep only the string entries of a groups claim", async () => {
    granted({ sub: "0000", name: "A Reader", groups: ["group-a", 7, null, "group-b"] });

    expect((await completeSignIn(SETTINGS, CURRENT, beginSignIn("/"))).groups).toEqual(["group-a", "group-b"]);
  });

  it("should refuse a response with no id token subject, since there is no identity to hold a session for", async () => {
    granted(undefined);

    await expect(completeSignIn(SETTINGS, CURRENT, beginSignIn("/"))).rejects.toThrow(SignInFailed);
  });

  it("should turn a rejected grant into SignInFailed rather than leaking the library's error out", async () => {
    authorizationCodeGrant.mockRejectedValue(new Error("state mismatch"));

    await expect(completeSignIn(SETTINGS, CURRENT, beginSignIn("/"))).rejects.toThrow(SignInFailed);
  });
});

describe("signOutUrl", () => {
  it("should send the reader to Entra's end session endpoint, and back afterwards", async () => {
    discovery.mockResolvedValue(discovered({ end_session_endpoint: "https://login.microsoftonline.com/a-tenant/oauth2/v2.0/logout" }));

    const url = await signOutUrl(SETTINGS, "https://metrics.example/repositories");

    expect(url?.origin).toBe("https://login.microsoftonline.com");
    expect(url?.searchParams.get("post_logout_redirect_uri")).toBe("https://metrics.example/repositories");
  });

  it("should say so when the tenant advertises no end session endpoint, rather than inventing one", async () => {
    expect(await signOutUrl(SETTINGS, "https://metrics.example/repositories")).toBeUndefined();
  });
});
