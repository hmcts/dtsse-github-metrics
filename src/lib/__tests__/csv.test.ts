/**
 * The three quoting rules, which are the only way a hand-rolled CSV writer goes wrong.
 *
 * Every case below is a real value from this estate rather than a synthetic one. A repository `detail` reads "No
 * merge activity in this window." and one day will read something with a comma in it; a team's contributors are
 * joined into one cell and a person's profile name may carry a quote; and the writer is fed values from `jsonb`
 * that nothing guarantees the shape of. The failure each rule prevents is silent: a column shifted one to the
 * right, or the rest of the file swallowed into one enormous field, in a spreadsheet somebody then reports from.
 */

import { describe, expect, it } from "vitest";
import { CSV_BYTE_ORDER_MARK, csvDocument, csvField, csvFilename } from "@/lib/csv";

describe("csvField", () => {
  it("should leave a field with nothing special in it unquoted", () => {
    // Quoting everything would be valid too. This file is read by people as well as by spreadsheets, and 1,880
    // rows in which every cell is quoted is harder to read than one where the quotes mark what needed them.
    expect(csvField("pcs-api")).toBe("pcs-api");
    expect(csvField("")).toBe("");
  });

  it("should quote a field holding a comma, so the columns after it do not shift", () => {
    expect(csvField("No merge activity, at this span.")).toBe('"No merge activity, at this span."');
  });

  it("should quote a field holding a quote and double the quote inside it", () => {
    // Both halves or neither: quoting without doubling ends the field early and turns the rest of the line into
    // one value, which is worse than not quoting at all.
    expect(csvField('the "primary" team')).toBe('"the ""primary"" team"');
  });

  it("should quote a field holding a newline, which would otherwise end the row", () => {
    expect(csvField("first\nsecond")).toBe('"first\nsecond"');
    expect(csvField("first\r\nsecond")).toBe('"first\r\nsecond"');
  });

  it("should quote a field that is nothing but a quote", () => {
    expect(csvField('"')).toBe('""""');
  });
});

describe("csvDocument", () => {
  it("should join fields with commas and rows with CRLF", () => {
    expect(
      csvDocument([
        ["Team", "Repository"],
        ["dtsse", "pcs-api"]
      ])
    ).toBe("Team,Repository\r\ndtsse,pcs-api");
  });

  it("should quote per field rather than per row", () => {
    expect(csvDocument([["plain", "has, comma", "plain"]])).toBe('plain,"has, comma",plain');
  });

  it("should end no document with a trailing row separator", () => {
    // A trailing CRLF reads back as one more row of empty fields in several readers, which puts a blank row under
    // every export and a blank row in every count taken off it.
    expect(csvDocument([["one"], ["two"]]).endsWith("two")).toBe(true);
  });

  it("should survive a field carrying every special character at once", () => {
    const document = csvDocument([['a,b"c\nd']]);

    expect(document).toBe('"a,b""c\nd"');
    // Round trip: the quoting is only correct if the field can be read back out. Unwrap the outer quotes and undo
    // the doubling, which is what any conforming reader does.
    expect(document.slice(1, -1).replaceAll('""', '"')).toBe('a,b"c\nd');
  });
});

describe("CSV_BYTE_ORDER_MARK", () => {
  it("should be the single byte-order-mark character and nothing else", () => {
    // Excel on Windows reads a CSV in the machine's ANSI code page without it, which mojibakes every accented
    // profile name — which is the material this export exists to carry.
    expect(CSV_BYTE_ORDER_MARK).toBe("﻿");
    expect(CSV_BYTE_ORDER_MARK).toHaveLength(1);
  });

  it("should not be part of the document a test asserts CSV on", () => {
    expect(csvDocument([["Team"]])).not.toContain(CSV_BYTE_ORDER_MARK);
  });
});

describe("csvFilename", () => {
  it("should carry the reported span and the day it was taken, so two exports differ", () => {
    // Either alone leaves two files with one name: two spans of the same day, or two days of the same span.
    expect(csvFilename("repositories", "2026-06-08 to 2026-08-31", "2026-09-15")).toBe("repositories-2026-06-08to2026-08-31-taken-2026-09-15.csv");
  });

  it("should distinguish two spans taken on one day", () => {
    const taken = "2026-09-15";

    expect(csvFilename("repositories", "2026-08-03 to 2026-08-31", taken)).not.toBe(csvFilename("repositories", "2026-06-08 to 2026-08-31", taken));
  });

  it("should leave no space in the name", () => {
    expect(csvFilename("repositories", "2026-06-08 to 2026-08-31", "2026-09-15")).not.toContain(" ");
  });
});
