import { describe, expect, it } from "vitest";
import { redirectAway, redirectTo } from "./redirect.ts";

describe("redirectTo", () => {
  it.each(["/repositories", "/teams", "/auth/login", "/repositories?weeks=26"])("should emit %s as a RELATIVE location", (path) => {
    // The whole point. A route handler emits Location verbatim, and its request URL carries the server's own
    // listen address — the pod name in Kubernetes — so any absolute URL built from it is a dead end for the
    // browser. Relative is resolved against the address the reader actually asked for.
    const location = redirectTo(path).headers.get("location");

    expect(location).toBe(path);
    expect(location).not.toMatch(/^https?:\/\//);
  });

  it("should redirect temporarily, so nothing caches the bounce", () => {
    expect(redirectTo("/repositories").status).toBe(307);
  });

  it("should carry no body", async () => {
    expect(await redirectTo("/repositories").text()).toBe("");
  });
});

describe("redirectAway", () => {
  it("should keep an absolute location, which is the only correct form for somewhere off this service", () => {
    const url = new URL("https://login.microsoftonline.com/a-tenant/oauth2/v2.0/authorize?client_id=x");

    expect(redirectAway(url).headers.get("location")).toBe(url.toString());
  });
});
