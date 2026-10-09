/**
 * A field read off a parsed JSON payload, as text.
 *
 * A string is itself; anything else is its JSON. For the numbers and booleans these fields usually carry when they
 * are not strings that is exactly what `String` gave, and for an object it is the object rather than
 * `[object Object]`, which would put a message nobody can read where the payload had one.
 */
export function jsonText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}
