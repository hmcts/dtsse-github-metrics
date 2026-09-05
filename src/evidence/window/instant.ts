/**
 * Parsing and truncating instants, ported from `metrics.window`.
 *
 * Hand-rolled rather than handed to `new Date(value)`, because the two disagree on the case that
 * matters most here. Python's `datetime.fromisoformat("2026-08-01T14:30")` yields a NAIVE datetime
 * that `parse_instant` then stamps as UTC; JavaScript's `new Date("2026-08-01T14:30")` reads the same
 * text as LOCAL time. On a machine in Europe/London that is an hour out for half the year, which
 * would silently shift every window edge and enablement anchor the configuration declares. So the
 * rule upstream states — a bare date is UTC midnight, a naive datetime is UTC, an offset is honoured —
 * is implemented explicitly.
 */

const BARE_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAIVE_DATETIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?$/;
const ZONED_DATETIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?(Z|[+-]\d{2}:?\d{2})$/i;

/** Parses an ISO 8601 date or datetime as a UTC instant. */
export function parseInstant(value: string): Date {
  const text = value.trim();

  const bare = BARE_DATE.exec(text);
  if (bare) {
    return fromParts(bare[1], bare[2], bare[3], "0", "0", "0", "0", 0);
  }

  const naive = NAIVE_DATETIME.exec(text);
  if (naive) {
    // No offset given, so UTC — matching `parse_instant`'s `replace(tzinfo=UTC)` rather than
    // JavaScript's local-time reading of the same string.
    return fromParts(naive[1], naive[2], naive[3], naive[4], naive[5], naive[6], naive[7], 0);
  }

  const zoned = ZONED_DATETIME.exec(text);
  if (zoned) {
    return fromParts(zoned[1], zoned[2], zoned[3], zoned[4], zoned[5], zoned[6], zoned[7], offsetMinutes(zoned[8]));
  }

  throw new RangeError(`expected a date or datetime such as 2026-08-01, 2026-08-01T14:30 or 2026-08-01T14:30:00Z: ${value}`);
}

/** The most recent UTC midnight at or before an instant. */
export function midnight(reference: Date): Date {
  return new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth(), reference.getUTCDate()));
}

/**
 * Formats an instant as GitHub expects it in a search qualifier: second precision, no fraction.
 *
 * `toISOString()` cannot be used. Python's `isoformat().replace("+00:00", "Z")` emits
 * `2026-08-01T00:00:00Z`, while `toISOString()` emits `2026-08-01T00:00:00.000Z` — and this text goes
 * into a `merged:a..b` range and into the hash that keys cached coverage, so the milliseconds would
 * change both what GitHub is asked and which cache rows answer it.
 */
export function githubTimestamp(instant: Date): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  const date = `${instant.getUTCFullYear()}-${pad(instant.getUTCMonth() + 1)}-${pad(instant.getUTCDate())}`;
  const time = `${pad(instant.getUTCHours())}:${pad(instant.getUTCMinutes())}:${pad(instant.getUTCSeconds())}`;
  return `${date}T${time}Z`;
}

function fromParts(
  year: string | undefined,
  month: string | undefined,
  day: string | undefined,
  hour: string | undefined,
  minute: string | undefined,
  second: string | undefined,
  fraction: string | undefined,
  offset: number
): Date {
  // Microsecond precision in the source, milliseconds in a `Date`: pad to six digits, then keep the
  // leading three. Truncation, not rounding — a fractional second is a position in time, and rounding
  // one up could move an instant past a half-open window's exclusive edge.
  const micros = (fraction ?? "").padEnd(6, "0");
  const millis = Number(micros.slice(0, 3));
  const utc = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour ?? 0), Number(minute ?? 0), Number(second ?? 0), millis);
  const instant = new Date(utc - offset * 60_000);
  if (Number.isNaN(instant.getTime())) {
    throw new RangeError(`expected a date or datetime such as 2026-08-01, 2026-08-01T14:30 or 2026-08-01T14:30:00Z: ${year}-${month}-${day}`);
  }
  // `Date.UTC` rolls a month-13 or day-32 over into the next month rather than refusing it, so an
  // impossible date such as 2026-13-05 would parse as 2027-01-05. Reject it: PyYAML raises for that
  // value before pydantic sees it, and a configuration naming a date that does not exist is a
  // mistake to report, not one to normalise.
  if (instant.getTime() === utc - offset * 60_000 && offset === 0 && !sameCalendarDate(instant, year, month, day)) {
    throw new RangeError(`no such date: ${year}-${month}-${day}`);
  }
  return instant;
}

function sameCalendarDate(instant: Date, year: string | undefined, month: string | undefined, day: string | undefined): boolean {
  return instant.getUTCFullYear() === Number(year) && instant.getUTCMonth() === Number(month) - 1 && instant.getUTCDate() === Number(day);
}

function offsetMinutes(designator: string | undefined): number {
  if (!designator || designator.toUpperCase() === "Z") {
    return 0;
  }
  const sign = designator.startsWith("-") ? -1 : 1;
  const digits = designator.slice(1).replace(":", "");
  return sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4)));
}
