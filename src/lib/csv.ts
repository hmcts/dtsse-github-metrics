/**
 * Writing CSV, which is a format with exactly three rules and no room to get them wrong.
 *
 * Hand-rolled rather than taken from a dependency, because the whole of it is the function below and this
 * project's dependencies are pinned exact for a reason. What it must not do is the failure mode that makes a
 * hand-rolled writer a bad idea: a repository whose `detail` reads "No merge activity in this window, at this
 * span." shifting every column after it one to the right, silently, in a file somebody then reports from.
 *
 * THE THREE RULES, from RFC 4180:
 *
 *   • A field holding a comma, a quote or a line break is wrapped in double quotes.
 *   • A quote inside a quoted field is written twice.
 *   • Rows end CRLF, which is what the RFC says and what every spreadsheet reads; a lone LF is accepted by all of
 *     them too, so this is correctness rather than compatibility.
 *
 * A field is quoted only where one of those characters appears. Quoting everything would also be valid and is
 * what a library would probably do, but this file is read by people as well as by spreadsheets — `git diff` of a
 * checked-in export, or a glance in a terminal — and an estate of 1,880 rows in which every cell is quoted is
 * harder to read than one where the quotes mark the fields that needed them.
 */

/** The characters whose presence forces a field to be quoted. */
const QUOTABLE = /[",\r\n]/;

/**
 * One field, quoted if it has to be.
 *
 * The test for it is the presence of any of the three, NOT a comma alone. A newline inside a field is the case
 * that produces a broken file rather than a shifted column — an unquoted line break ends the row, so the reader
 * gets one row too many and every field after it in the wrong place — and a stray quote is what turns the rest of
 * the file into one enormous field.
 */
export function csvField(value: string): string {
  return QUOTABLE.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** One row, its fields joined by the separator the format is named after. */
function csvRow(fields: readonly string[]): string {
  return fields.map(csvField).join(",");
}

/**
 * A whole document, header row included, ready to be handed to a download.
 *
 * The caller passes the header as the first row rather than as its own argument: a header is a row of strings and
 * is quoted by the same rules, and two arguments would let a caller emit a document with none.
 */
export function csvDocument(rows: readonly (readonly string[])[]): string {
  return rows.map(csvRow).join("\r\n");
}

/**
 * The bytes a UTF-8 CSV needs in front of it for Excel to read it as UTF-8.
 *
 * Excel on Windows still reads a CSV in the machine's ANSI code page unless the file opens with this, so an
 * export naming anybody whose profile name carries an accent arrives mojibaked — which is a real half of the
 * organisation's names and exactly the material this export was added to carry. Every other reader ignores it.
 *
 * It is NOT part of `csvDocument`, so what that function returns is the document and nothing else: the mark is a
 * fact about handing a file to a spreadsheet, and a test asserting on CSV should not have to strip it.
 */
export const CSV_BYTE_ORDER_MARK = "﻿";

/**
 * What one export is called: what it is of, the span it reports, and the day it was taken.
 *
 * BOTH THE SPAN AND THE DAY, because either alone leaves two exports indistinguishable. A reader comparing this
 * week's estate against last week's has two files of the same span, and a reader checking whether four weeks
 * reads differently from twelve has two of the same day — so the name carries the two things that vary.
 *
 * The span is the window's own dates rather than the week count, so the file says what it covers rather than what
 * was asked for; `span` in `lib/format.ts` renders them, and the spaces in "to" are collapsed here because a file
 * name with spaces in it is a small unkindness to whoever writes the script that reads it.
 */
export function csvFilename(subject: string, window: string, taken: string): string {
  return `${subject}-${window.replaceAll(" ", "")}-taken-${taken}.csv`;
}
