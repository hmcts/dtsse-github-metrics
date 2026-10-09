import { describe, expect, it } from "vitest";
import { messageOf } from "./error-message.ts";

class RateLimited extends Error {}

describe("messageOf", () => {
  it("should read an Error's message", () => {
    expect(messageOf(new Error("connection refused"))).toBe("connection refused");
  });

  it("should read the message of an Error subclass", () => {
    expect(messageOf(new RateLimited("try again later"))).toBe("try again later");
  });

  it("should pass a thrown string through unchanged", () => {
    expect(messageOf("timed out")).toBe("timed out");
  });

  it("should stringify anything else a library throws", () => {
    expect(messageOf(undefined)).toBe("undefined");
    expect(messageOf(42)).toBe("42");
    expect(messageOf({ status: 500 })).toBe("[object Object]");
  });
});
