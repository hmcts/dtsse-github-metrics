import { describe, expect, it } from "vitest";
import { findNulls, stripAbsent } from "./absent.ts";

/**
 * The contract `src/lib/types.ts` states and the whole UI reads by: an absent count means nobody measured it, a
 * zero means somebody measured nothing.
 *
 * Upstream got this from FastAPI's `response_model_exclude_none`. There is no serialiser here, so these cases are
 * what hold the line.
 */
describe("stripAbsent", () => {
  it("should drop a null field, which Prisma and a jsonb round trip both produce", () => {
    // A null reaching a component that reads the field as optional renders as 0 or throws on a .toFixed().
    expect(stripAbsent({ open: null, detail: "not enabled" })).toEqual({ detail: "not enabled" });
  });

  it("should drop an undefined field", () => {
    expect(stripAbsent({ open: undefined, detail: "x" })).toEqual({ detail: "x" });
  });

  it("should keep a zero, which is a measurement and not an absence", () => {
    expect(stripAbsent({ open: 0 })).toEqual({ open: 0 });
  });

  it("should keep false, for the same reason", () => {
    // `production: false` says the list was read and does not name this repository, which is not the same as the
    // list being unreadable.
    expect(stripAbsent({ production: false })).toEqual({ production: false });
  });

  it("should keep an empty string and an empty array, which are values", () => {
    expect(stripAbsent({ detail: "", conditions: [] })).toEqual({ detail: "", conditions: [] });
  });

  it("should strip nested objects", () => {
    expect(stripAbsent({ security: { dependabot: { open: 2, detail: null }, codeScanning: { open: null } } })).toEqual({
      security: { dependabot: { open: 2 }, codeScanning: {} }
    });
  });

  it("should strip inside an array's elements while keeping its length", () => {
    // Dropping an element would renumber a table's rows.
    expect(
      stripAbsent([
        { a: 1, b: null },
        { a: 2, b: 3 }
      ])
    ).toEqual([{ a: 1 }, { a: 2, b: 3 }]);
  });

  it("should refuse a null array element, naming where it is", () => {
    // A null element is a bug in whatever built the array, not a field to drop.
    expect(() => stripAbsent({ rows: [{ a: 1 }, null] })).toThrow(/rows\[1\]/);
  });

  it("should pass a Date through rather than walking it into an empty object", () => {
    const instant = new Date("2026-08-08T00:00:00Z");

    expect(stripAbsent({ collectedAt: instant }).collectedAt).toBe(instant);
  });
});

describe("findNulls", () => {
  it("should find nothing in a stripped structure", () => {
    expect(findNulls(stripAbsent({ open: null, nested: { detail: null } }))).toEqual([]);
  });

  it("should name every path that still carries a null", () => {
    expect(findNulls({ a: null, b: { c: null }, d: [{ e: null }] })).toEqual(["a", "b.c", "d[0].e"]);
  });

  it("should name the root when the value itself is null", () => {
    expect(findNulls(null)).toEqual(["<root>"]);
  });
});
