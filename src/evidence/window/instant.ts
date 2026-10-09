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
    return fromParts(bare, 0);
  }

  const naive = NAIVE_DATETIME.exec(text);
  if (naive) {
    // No offset given, so UTC — matching `parse_instant`'s `replace(tzinfo=UTC)` rather than
    // JavaScript's local-time reading of the same string.
    return fromParts(naive, 0);
  }

  const zoned = ZONED_DATETIME.exec(text);
  if (zoned) {
    return fromParts(zoned, offsetMinutes(group(zoned, 8)));
  }

  throw new RangeError(`expected a date or datetime such as 2026-08-01, 2026-08-01T14:30 or 2026-08-01T14:30:00Z: ${value}`);
}

/** The most recent UTC midnight at or before an instant. */
export function midnight(reference: Date): Date {
  return new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth(), reference.getUTCDate()));
}

/**
 * Formats an instant as second-precision UTC with no fractional part: `2026-08-01T00:00:00Z`.
 *
 * WHERE IT GOES: the `since` and `until` variables of `commitHistoryQuery`, and nowhere else — see
 * `collectDirectCommits`. Those bound the commit walk, and GitHub treats both bounds as INCLUSIVE, which is
 * why membership is decided again against the half-open window after the nodes come back rather than being
 * left to the query.
 *
 * WHAT IT IS NOT PART OF, because both have been assumed and neither is true: there is no `merged:a..b`
 * search qualifier anywhere in this codebase — the merged-pull-request walk is cursor-paginated and ordered
 * by `updatedAt`, with no date range in the query at all — and no cache key contains a timestamp.
 * `querySignature` and `commitQuerySignature` hash the query DOCUMENTS, so changing this format cannot
 * invalidate coverage rows.
 *
 * So the format is a compatibility choice rather than a correctness one: it reproduces what the Python
 * implementation's `isoformat().replace("+00:00", "Z")` sent, where `toISOString()` would append `.000`.
 * Keeping the request text identical is what let the port's results be compared against upstream's. It is
 * pinned by `window.test.ts`; if that parity stops mattering, this function can go rather than being widened.
 */
export function githubTimestamp(instant: Date): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  const date = `${instant.getUTCFullYear()}-${pad(instant.getUTCMonth() + 1)}-${pad(instant.getUTCDate())}`;
  const time = `${pad(instant.getUTCHours())}:${pad(instant.getUTCMinutes())}:${pad(instant.getUTCSeconds())}`;
  return `${date}T${time}Z`;
}

/**
 * One capture group's text, or empty for an optional group (seconds, fraction) that took no part in the match.
 * Empty reads as zero through `Number` and as no digits through `padEnd`, which is what an omitted part means.
 */
function group(match: RegExpExecArray, index: number): string {
  return match[index] ?? "";
}

/**
 * The instant one of the three patterns matched. They share their first seven groups (date, time, fraction), and a
 * bare date's time groups are absent, so they read as empty and so as midnight.
 */
function fromParts(match: RegExpExecArray, offset: number): Date {
  const year = group(match, 1);
  const month = group(match, 2);
  const day = group(match, 3);
  const hour = group(match, 4);
  const minute = group(match, 5);
  const second = group(match, 6);
  const fraction = group(match, 7);
  // Microsecond precision in the source, milliseconds in a `Date`: pad to six digits, then keep the
  // leading three. Truncation, not rounding — a fractional second is a position in time, and rounding
  // one up could move an instant past a half-open window's exclusive edge.
  const micros = fraction.padEnd(6, "0");
  const millis = Number(micros.slice(0, 3));
  const local = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), millis));
  // `Date.UTC` rolls an hour of 24, a minute of 99 or a day of 32 over into the next unit rather than refusing
  // it, so an impossible value such as 2026-13-05 would parse as 2027-01-05. Reject it, and before the offset is
  // applied, because afterwards the rolled-over parts no longer line up with the text: PyYAML raises for that
  // value before pydantic sees it, and a configuration naming an instant that does not exist is a mistake to
  // report, not one to normalise. The time is checked first because a rolled-over hour also moves the date.
  if (local.getUTCHours() !== Number(hour) || local.getUTCMinutes() !== Number(minute) || local.getUTCSeconds() !== Number(second)) {
    const time = second === "" ? `${hour}:${minute}` : `${hour}:${minute}:${second}`;
    throw new RangeError(`no such time: ${time}`);
  }
  if (!sameCalendarDate(local, year, month, day)) {
    throw new RangeError(`no such date: ${year}-${month}-${day}`);
  }
  return new Date(local.getTime() - offset * 60_000);
}

function sameCalendarDate(instant: Date, year: string, month: string, day: string): boolean {
  return instant.getUTCFullYear() === Number(year) && instant.getUTCMonth() === Number(month) - 1 && instant.getUTCDate() === Number(day);
}

function offsetMinutes(designator: string): number {
  if (designator.toUpperCase() === "Z") {
    return 0;
  }
  const sign = designator.startsWith("-") ? -1 : 1;
  const digits = designator.slice(1).replace(":", "");
  const hours = Number(digits.slice(0, 2));
  const minutes = Number(digits.slice(2, 4));
  // Python's `fromisoformat` refuses an offset of a day or more, and a minute part of 60 or more is a typo.
  if (hours > 23 || minutes > 59) {
    throw new RangeError(`no such offset: ${designator}`);
  }
  return sign * (hours * 60 + minutes);
}
