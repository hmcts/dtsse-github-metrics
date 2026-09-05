/**
 * The absent-versus-null contract, at the one boundary that can enforce it.
 *
 * `src/lib/types.ts` states the rule the whole UI reads by: "an absent count means nobody measured it, and a
 * zero means somebody measured nothing." Upstream got that for free — every FastAPI route was registered
 * `response_model_exclude_none=True`, so a `None` never reached the wire.
 *
 * There is no HTTP hop here, so nothing strips anything automatically. `undefined` flows through a function call
 * naturally, which is most of the way there, but Prisma and a `jsonb` round trip both hand back `null`, and a
 * `null` reaching a component that expects `undefined` renders as `0` or throws on a `.toFixed()`. So every
 * report object crosses this on its way out.
 *
 * ARRAYS KEEP THEIR LENGTH. A null element is a bug in whatever built the array, not a field to drop — dropping
 * it would renumber a table's rows — so it throws rather than being quietly removed.
 */
export function stripAbsent<T>(value: T): T {
  return strip(value, "") as T;
}

function strip(value: unknown, path: string): unknown {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (value instanceof Date) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => {
      if (entry === null || entry === undefined) {
        throw new TypeError(`a report array holds an absent element at ${path}[${index}], which is a fault in whatever built it`);
      }
      return strip(entry, `${path}[${index}]`);
    });
  }
  if (typeof value === "object") {
    const stripped: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry === null || entry === undefined) {
        continue;
      }
      stripped[key] = strip(entry, path === "" ? key : `${path}.${key}`);
    }
    return stripped;
  }
  return value;
}

/** Whether a structure carries a `null` anywhere, for the gate that asserts the contract holds. */
export function findNulls(value: unknown, path = ""): string[] {
  if (value === null) {
    return [path === "" ? "<root>" : path];
  }
  if (value === undefined || value instanceof Date || typeof value !== "object") {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => findNulls(entry, `${path}[${index}]`));
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) => findNulls(entry, path === "" ? key : `${path}.${key}`));
}
