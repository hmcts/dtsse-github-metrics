import { AvailabilityReason } from "../domain/availability.ts";

/**
 * Reading what GitHub actually meant by a failure. Ported from `metrics.github`'s classification half.
 *
 * Kept apart from the client that issues the calls because this is pure judgement over a status and a
 * body, and it is where the port most needs to be provably identical to the original.
 */

/**
 * How one HTTP status is classified for EVERY endpoint this client reads.
 *
 * 422 is deliberately absent. `/repos/{org}/{repo}/commits/{sha}` answers it for a SHA the repository
 * does not hold, which refutes a candidate Sonar mapping — but that meaning belongs to that one
 * endpoint, and classifying it here would give it to all of them. Two readers turn
 * `NotFoundOrInaccessible` into an affirmative observation: the classic merge gate reads it as "the
 * branch is unprotected" and the alert families as "the family is not enabled". A 422 from either — a
 * malformed query, a spammed endpoint — would then be published as a fact nobody observed. It stays a
 * collection failure here and is read as a refutation only by the call that knows what it means.
 */
const HTTP_FAILURES = new Map<number, readonly [string, AvailabilityReason]>([
  [401, ["GitHub authentication failed", AvailabilityReason.AuthenticationFailed]],
  [403, ["GitHub permission denied", AvailabilityReason.PermissionDenied]],
  [404, ["GitHub repository not found or inaccessible", AvailabilityReason.NotFoundOrInaccessible]]
]);

/**
 * What GitHub says when a 403 means "this feature is off" rather than "you may not look".
 *
 * A 403 is GitHub's answer to both, and only this text tells them apart. Grading all of them as refusals
 * was the earlier ruling, and the evidence overturned it: across 1850 repositories every 403 was a
 * feature or plan message — 830 `Code Security must be enabled for this repository to use code
 * scanning`, 113 `Dependabot alerts are disabled for this repository`, 2 `Upgrade to GitHub Pro or make
 * this repository public to enable this feature` — and not one was a genuine refusal. A run that grades
 * 945 disabled features as refusals exits non-zero and buries the real permission problem among them.
 *
 * EVERY PHRASE BUT ONE IS ANCHORED ON `for this repository`, so an organisation-level refusal can never
 * match: GitHub does not say a token was refused "for this repository". The plan message is anchored on
 * GitHub's own product name instead. AN UNRECOGNISED 403 STAYS A REFUSAL — the failure direction is
 * deliberate. A disabled message nobody listed here is reported as a refusal, which a human reads in the
 * log and adds; a refusal is never hidden by a phrase we guessed at.
 */
export const FEATURE_DISABLED_PHRASES: readonly string[] = [
  "is disabled for this repository",
  "are disabled for this repository",
  "must be enabled for this repository",
  "is not enabled for this repository",
  "upgrade to github pro"
];

/**
 * A failure an API stated in the body of a response HTTP called a success.
 *
 * `status` is the status the failure IS, which for GraphQL is not the status it arrived under: a query a
 * token may not run comes back as HTTP 200 with a `FORBIDDEN` error, and reporting that as 200 hides the
 * estate's single most-searched-for problem from anyone grepping a log for `403`. The log says
 * `403 (equivalent)` so that nobody reads it as a status HTTP returned.
 */
export interface BodyFailure {
  summary: string;
  status: number;
}

/** Whether GitHub's own message says a feature is off rather than that access was refused. */
export function reportsFeatureDisabled(message: string): boolean {
  const folded = message.toLowerCase();
  return FEATURE_DISABLED_PHRASES.some((phrase) => folded.includes(phrase));
}

/**
 * GitHub's own `message` for a failed response, for the log and nothing else.
 *
 * THE ONE PIECE OF A BODY THIS CLIENT WILL COPY OUT. Everything else is withheld deliberately — a
 * secret-scanning alert record carries the detected credential itself — but a 403 is undiagnosable
 * without it: "API rate limit exceeded for user 123", "You have exceeded a secondary rate limit",
 * "Resource not accessible by personal access token" and an IP-allow-list refusal are four different
 * problems with four different fixes, and all four look identical in a log recording only the status.
 */
export function failureMessage(body: string): string {
  try {
    const payload: unknown = JSON.parse(body);
    if (typeof payload === "object" && payload !== null) {
      const message = (payload as { message?: unknown }).message;
      return message === undefined ? "no message" : String(message);
    }
  } catch {
    // Not JSON, so there is no message to prefer.
  }
  return "no message";
}

/**
 * The shareable message and the reason for a response GitHub did not answer.
 *
 * A 403 explained as a disabled feature is `FeatureDisabled`, which readers treat as an observation
 * rather than a failure — the same way they already read a 404 from an alert endpoint. Everything else
 * defers to the table, so an unrecognised 403 stays `PermissionDenied`.
 */
export function classify(status: number, body: string): readonly [string, AvailabilityReason] {
  if (status === 403 && reportsFeatureDisabled(failureMessage(body))) {
    return ["GitHub reports the feature is not enabled", AvailabilityReason.FeatureDisabled];
  }
  return HTTP_FAILURES.get(status) ?? [`GitHub returned HTTP ${status}`, AvailabilityReason.CollectionFailed];
}

/** Whether a successful HTTP response carries a GraphQL rate-limit error. */
export function graphqlRateLimited(body: string): boolean {
  const errors = graphqlErrors(body);
  if (errors === undefined) {
    return false;
  }
  return errors.some((error) => {
    const message = String((error as { message?: unknown })?.message ?? "").toLowerCase();
    const type = String((error as { type?: unknown })?.type ?? "").toLowerCase();
    return message.includes("rate limit") || type.includes("rate_limit");
  });
}

/**
 * Summarises GraphQL errors as `TYPE: message` for the log, each kind reported once.
 *
 * GitHub distinguishes a repository that was renamed or deleted from one a token may not read only in
 * this text, so a collection that lost repositories is undiagnosable without it.
 *
 * COUNTED RATHER THAN LISTED, because GitHub returns one error per node it would not answer for: a
 * single search returned `FORBIDDEN: Resource not accessible by personal access token` 76 times, and one
 * run wrote that same sentence out 6,880 times. Repeating it says nothing the first copy did not, and it
 * buries the error that appears once — which is the one worth reading. First-appearance order is kept
 * for that reason: a rare kind is never pushed below a common one by its count.
 */
export function graphqlErrorSummary(errors: readonly unknown[]): string {
  const counted = new Map<string, number>();
  for (const error of errors) {
    const text =
      typeof error === "object" && error !== null
        ? `${String((error as { type?: unknown }).type ?? "UNKNOWN")}: ${String((error as { message?: unknown }).message ?? "")}`
        : String(error);
    counted.set(text, (counted.get(text) ?? 0) + 1);
  }
  return [...counted.entries()].map(([text, count]) => (count > 1 ? `${text} (x${count})` : text)).join("; ");
}

/** Classifies terminal GraphQL errors without exposing response content. */
export function graphqlErrorReason(errors: readonly unknown[]): AvailabilityReason {
  const refused = errors.some((error) => {
    if (typeof error !== "object" || error === null) {
      return false;
    }
    const type = String((error as { type?: unknown }).type ?? "").toUpperCase();
    const message = String((error as { message?: unknown }).message ?? "").toLowerCase();
    return type === "FORBIDDEN" || message.includes("not accessible");
  });
  return refused ? AvailabilityReason.PermissionDenied : AvailabilityReason.CollectionFailed;
}

/**
 * Summarises the errors one GraphQL response carries, or `undefined` when it carries none.
 *
 * GITHUB ANSWERS A GRAPHQL FAILURE WITH HTTP 200 AND AN `errors` ARRAY, so a status read on its own
 * grades a query nobody was allowed to run as a call that worked. One run counted 2158 GraphQL calls as
 * `200 ok` when 181 of them had failed FORBIDDEN, which is a tenth of the GraphQL evidence missing from
 * a summary that reported no GraphQL problem at all. The body is read here, before the call is counted,
 * so the summary says what the run got.
 *
 * The equivalent status comes from `graphqlErrorReason` rather than from a second reading of the same
 * errors: the permission failure a caller is handed and the 403 the log is grepped for are then one
 * judgement, and a body that stops being read as a refusal cannot go on being reported as one. Every
 * other reason keeps the response's own status, because `CollectionFailed` names no status a reader
 * would search for.
 */
export function graphqlBodyFailure(status: number, body: string): BodyFailure | undefined {
  const errors = graphqlErrors(body);
  if (errors === undefined || errors.length === 0) {
    return undefined;
  }
  const refused = graphqlErrorReason(errors) === AvailabilityReason.PermissionDenied;
  return { summary: graphqlErrorSummary(errors), status: refused ? 403 : status };
}

/** The `errors` array of a GraphQL body, or `undefined` when there is not one to read. */
export function graphqlErrors(body: string): readonly unknown[] | undefined {
  try {
    const payload: unknown = JSON.parse(body);
    if (typeof payload !== "object" || payload === null) {
      return undefined;
    }
    const errors = (payload as { errors?: unknown }).errors;
    return Array.isArray(errors) ? errors : undefined;
  } catch {
    return undefined;
  }
}
