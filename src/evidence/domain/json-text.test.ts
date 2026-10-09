import { describe, expect, it } from "vitest";
import { jsonText } from "./json-text.ts";

describe("jsonText", () => {
  it("returns a string unquoted", () => {
    expect(jsonText("FORBIDDEN")).toBe("FORBIDDEN");
  });

  it("states a number and a boolean as String would", () => {
    expect(jsonText(80)).toBe("80");
    expect(jsonText(false)).toBe("false");
  });

  it("states an object by its contents rather than as [object Object]", () => {
    expect(jsonText({ code: "x" })).toBe('{"code":"x"}');
  });
});
