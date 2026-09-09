import { describe, expect, it } from "vitest";
import { exempt, safeReturnTo } from "./guard.ts";

describe("exempt", () => {
  it.each([
    "/health",
    "/health/liveness",
    "/health/readiness",
    "/liveness",
    "/readiness"
  ])("should serve %s without a session, because a probe cannot sign in", (path) => {
    expect(exempt(path)).toBe(true);
  });

  it("should serve the sign-in routes without a session, or nobody could ever get one", () => {
    expect(exempt("/auth/login")).toBe(true);
    expect(exempt("/auth/callback")).toBe(true);
    expect(exempt("/auth/logout")).toBe(true);
  });

  it("should serve the compiled bundles and stylesheet without a session", () => {
    expect(exempt("/_next/static/chunks/main.js")).toBe(true);
    expect(exempt("/favicon.ico")).toBe(true);
  });

  it.each([
    "/",
    "/repositories",
    "/teams",
    "/contributors",
    "/repositories/cms-template"
  ])("should require a session for %s, which is where the estate's figures are", (path) => {
    expect(exempt(path)).toBe(false);
  });

  it.each([
    "/healthcheck-report",
    "/health-summary",
    "/authors",
    "/_nextdoor",
    "/authentication"
  ])("should not exempt %s, which merely begins the same way as an exempt path", (path) => {
    // The boundary that stops a future page being published because its name shares a prefix with a probe.
    expect(exempt(path)).toBe(false);
  });
});

describe("safeReturnTo", () => {
  it.each([
    "/repositories",
    "/teams",
    "/repositories/cms-template",
    "/repositories?weeks=26",
    "/contributors#top"
  ])("should keep the same-origin path %s", (path) => {
    expect(safeReturnTo(path)).toBe(path);
  });

  it("should keep a path containing a hyphen, which a careless character class would reject", () => {
    expect(safeReturnTo("/repositories/dtsse-github-metrics")).toBe("/repositories/dtsse-github-metrics");
  });

  it.each([
    ["an absolute url", "https://elsewhere.example/steal"],
    ["a protocol-relative url", "//elsewhere.example/steal"],
    ["a scheme without a host", "javascript:alert(1)"],
    ["a bare path with no leading slash", "repositories"],
    ["nothing at all", ""],
    ["null", null],
    ["undefined", undefined]
  ])("should refuse %s and fall back to the dashboard", (_label, value) => {
    expect(safeReturnTo(value)).toBe("/repositories");
  });

  it("should refuse a backslash, which some browsers normalise into a protocol-relative url", () => {
    expect(safeReturnTo("/\\elsewhere.example")).toBe("/repositories");
  });

  it.each([
    ["a newline, which would split the Location header", 0x0a],
    ["a carriage return", 0x0d],
    ["a NUL", 0x00],
    ["a DEL", 0x7f]
  ])("should refuse %s", (_label, code) => {
    expect(safeReturnTo(`/repositories${String.fromCharCode(code)}x`)).toBe("/repositories");
  });
});
