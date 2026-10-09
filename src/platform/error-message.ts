/** One failure's message, for a log line that names what went wrong rather than that something did. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
