/**
 * The not-found signal, on its own so it can be imported without a database.
 *
 * `api.ts` is `server-only` and opens a Postgres pool on import, but this is the one thing in it a page-level test
 * needs to construct: the error the pages branch on to render Next's own not-found rather than a stack trace.
 * Splitting it out is what lets those tests stub `@/lib/api` and still throw the real type at it.
 *
 * Upstream carried an HTTP status here, because a refusal arrived as a 404 from a loopback service. There is no
 * response any more, so the TYPE is the signal.
 */
export class RepositoryUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepositoryUnknownError";
  }
}

/** Whether a failure means "the name in the URL is not one the configuration holds". */
export function isNotFound(error: unknown): boolean {
  return error instanceof RepositoryUnknownError;
}
