import { describe, expect, it } from "vitest";
import { AuthConfigurationError, authRequired, authSettings, issuerUrl, sessionSecret } from "./settings.ts";

const COMPLETE = {
  ENTRA_TENANT_ID: "531ff96d-0ae9-462a-8d2d-bec7c0b42082",
  ENTRA_CLIENT_ID: "a-client-id",
  ENTRA_CLIENT_SECRET: "a-client-secret",
  ENTRA_REDIRECT_URI: "https://github-metrics.aat.platform.hmcts.net/auth/callback",
  SESSION_SECRET: "a-session-secret"
};

describe("authRequired", () => {
  it("should require a sign-in when nothing says otherwise", () => {
    // Fail closed. A deployment that lost its variables must refuse readers, not serve the estate to anybody.
    expect(authRequired({})).toBe(true);
  });

  it("should only skip the sign-in when asked exactly", () => {
    expect(authRequired({ AUTH_DISABLED: "true" })).toBe(false);
  });

  it.each(["", "false", "TRUE", "1", "yes"])("should still require a sign-in for AUTH_DISABLED=%s", (value) => {
    // Anything but the exact string is a typo, and a typo must not open the dashboard.
    expect(authRequired({ AUTH_DISABLED: value })).toBe(true);
  });
});

describe("authSettings", () => {
  it("should read a complete configuration", () => {
    const settings = authSettings(COMPLETE);

    expect(settings.tenantId).toBe(COMPLETE.ENTRA_TENANT_ID);
    expect(settings.clientId).toBe("a-client-id");
    expect(settings.redirectUri).toBe(COMPLETE.ENTRA_REDIRECT_URI);
  });

  it.each(Object.keys(COMPLETE))("should refuse a configuration missing %s, naming it", (missing) => {
    const partial = { ...COMPLETE, [missing]: "" };

    expect(() => authSettings(partial)).toThrow(AuthConfigurationError);
    expect(() => authSettings(partial)).toThrow(new RegExp(missing));
  });

  it("should name the escape hatch in the error, so the fix is discoverable", () => {
    expect(() => authSettings({})).toThrow(/AUTH_DISABLED=true/);
  });

  it("should treat a whitespace-only value as missing", () => {
    expect(() => authSettings({ ...COMPLETE, ENTRA_CLIENT_ID: "   " })).toThrow(AuthConfigurationError);
  });
});

describe("issuerUrl", () => {
  it("should point at the tenant's v2 endpoint, which is what discovery is performed against", () => {
    expect(issuerUrl("a-tenant").toString()).toBe("https://login.microsoftonline.com/a-tenant/v2.0");
  });
});

describe("sessionSecret", () => {
  it("should trim the value, because a vault secret stored from a file carries a trailing newline", () => {
    expect(sessionSecret({ SESSION_SECRET: "  a-secret\n" })).toBe("a-secret");
  });

  it.each([
    ["unset", {}],
    ["empty", { SESSION_SECRET: "" }],
    ["only whitespace", { SESSION_SECRET: "  \n" }]
  ])("should report %s as no secret rather than throwing, so the guard can refuse without taking /health down", (_label, env) => {
    expect(sessionSecret(env)).toBeUndefined();
  });

  it("should give authSettings the same trimmed value the guard uses", () => {
    // The bug this exists for: the guard trimmed and the callback did not, so a cookie sealed under one key was
    // verified under another and a successful sign-in bounced straight back to Entra, forever, silently.
    const env = { ...COMPLETE, SESSION_SECRET: " a-secret\n" };

    expect(authSettings(env).sessionSecret).toBe(sessionSecret(env));
  });
});
