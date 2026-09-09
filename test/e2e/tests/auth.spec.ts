import { expect, test } from "@playwright/test";

/**
 * That the dashboard cannot be read without signing in.
 *
 * Tagged `@auth` and in no other suite, because it can only pass where authentication is actually on: preview
 * and the pipeline's temporary AAT `-staging` release both set `AUTH_DISABLED=true`, since neither hostname can
 * be a redirect URI on the app registration. Run it against the persistent AAT release, which is what readers
 * reach:
 *
 *     TEST_URL=https://github-metrics.aat.platform.hmcts.net yarn test:e2e --grep @auth
 *
 * These assert the redirect rather than completing a sign-in. Driving a real Microsoft login would need a test
 * account and its second factor, and would be testing Entra rather than this service — what is ours to get
 * right is that an unauthenticated reader never receives the figures.
 */
test.describe("authentication @auth", () => {
  for (const path of ["/repositories", "/teams", "/contributors", "/"]) {
    test(`should not serve ${path} to a reader with no session @auth`, async ({ page, context }) => {
      await context.clearCookies();

      await page.goto(path);

      // Landed at Microsoft, carrying this service's client id.
      expect(page.url()).toContain("login.microsoftonline.com");
    });
  }

  test("should ask for only the scopes it uses @auth", async ({ page, context }) => {
    await context.clearCookies();

    await page.goto("/repositories");

    // No Graph scopes: the dashboard reads nothing from Graph, and asking would put the registration through an
    // admin-consent conversation it does not need.
    const scope = new URL(page.url()).searchParams.get("scope") ?? "";
    expect(scope.split(/[+ ]/).sort()).toEqual(["email", "openid", "profile"]);
  });

  test("should use PKCE @auth", async ({ page, context }) => {
    await context.clearCookies();

    await page.goto("/repositories");

    const authorize = new URL(page.url());
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("code_challenge")).toBeTruthy();
  });

  test("should keep serving health without a session, or the deployment fails rather than the request @auth", async ({ request }) => {
    const response = await request.get("/health");

    expect(response.status()).toBe(200);
    expect((await response.json()).status).toBe("UP");
  });

  test("should refuse to send a reader off the origin after signing in @auth", async ({ request }) => {
    // The open-redirect case: the link starts on a real HMCTS hostname and a real Microsoft sign-in follows, so
    // a return path is only ever a path on this service.
    const response = await request.get("/auth/login?redirect=https://elsewhere.example/steal", { maxRedirects: 0 });

    const location = response.headers().location ?? "";
    expect(location).not.toContain("elsewhere.example");
    expect(location).toContain("login.microsoftonline.com");
  });
});
