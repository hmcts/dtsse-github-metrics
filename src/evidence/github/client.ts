import { AvailabilityReason, GitHubError } from "../domain/availability.ts";
import { type BodyFailure, classify, failureMessage, graphqlBodyFailure, graphqlRateLimited } from "./classify.ts";
import type { GitHubCredentials } from "./credentials.ts";
import { endpointTemplate, graphqlOperationName } from "./endpoint-template.ts";

/**
 * The authenticated GitHub client. Ported from `metrics.github.GitHubClient`.
 *
 * `fetch` with an explicit retry loop rather than a library: the retry policy here is not a generic one.
 * It distinguishes a spent quota from a refusal, reads a failure GitHub stated inside an HTTP 200, and
 * counts a retried call once while counting each of its responses — none of which a general-purpose
 * wrapper does.
 *
 * The clock and the pause are injected so the tests do not sleep for real.
 */

const DEFAULT_API_URL = "https://api.github.com";
const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAXIMUM_ATTEMPTS = 3;

/** The latest GitHub budget reported for one API resource. */
export interface RateLimitBudget {
  limit: number;
  remaining: number;
  used: number;
  /** Epoch seconds, as GitHub reports it. */
  resetsAt: number;
}

/**
 * One counted kind of call: status, outcome word, method, endpoint.
 *
 * The status alone does not say what happened to a call. A 403 is a refusal or a feature nobody turned
 * on, and a 502 is neither — so the word beside the status is what a reader counts by. The status is the
 * one the failure IS rather than the one it travelled in, so a GraphQL refusal is counted at 403 with the
 * refusals rather than at the 200 GitHub wrapped it in.
 *
 * ONE OUTCOME PER ATTEMPT, and the word says what that attempt did. Four of them describe an attempt that
 * was not the last:
 *
 * - `retried` — the response was not usable and another attempt followed. A 500, or a 401 answered by
 *   minting a fresh token.
 * - `rate-limited` — the response was a spent quota, which this client waited out and asked again. Kept
 *   apart from `refused` because the whole retry policy rests on not confusing the two: a 403 is GitHub's
 *   answer to both, and counting a spent quota as a refusal records "nobody may look" as a fact about a
 *   repository.
 * - `unreachable` — no response arrived at all, so there is no status; counted at 0.
 * - `exhausted` — this attempt was the last and the operation gave up on it. The one word that says a run
 *   DID NOT GET ITS ANSWER, which is why it exists: a rate limit or a dead socket that outlasted
 *   `maximumAttempts` used to be counted as no outcome whatsoever, so the run that failed could not be
 *   explained from its own summary.
 */
export interface CallOutcome {
  status: number;
  outcome: "ok" | "errors" | "disabled" | "refused" | "failed" | "retried" | "rate-limited" | "unreachable" | "exhausted";
  method: string;
  endpoint: string;
}

/**
 * Why part of a GraphQL answer is missing, for a caller that consumed the rest of it.
 *
 * `message` and `reason` are exactly what `graphql` would have THROWN, so a partial caller reporting a
 * refusal reports the same refusal in the same words. `summary` is GitHub's own `TYPE: message` text and
 * `byAlias` says which node each error names — the two things a caller needs to record a null node as a
 * refusal rather than as an absence.
 */
export interface GraphqlFailure {
  message: string;
  reason: AvailabilityReason;
  /** The status the failure IS, which for a refusal wrapped in an HTTP 200 is 403. */
  status: number;
  summary: string;
  /** Each alias GitHub named an error at, as `TYPE: message`. Empty where no error named a node. */
  byAlias: Map<string, string>;
}

/**
 * One GraphQL answer, which may carry data, a failure, or BOTH.
 *
 * GitHub answers an aliased document naming one unreadable repository with HTTP 200, the populated aliases it
 * could resolve, a `null` for the one it could not, and an `errors` array saying why — so "succeeded" and
 * "failed" do not describe it and a caller that must choose one throws away 49 answers to report the 50th.
 *
 * Three combinations, and each means something different. `data` with no `failure` is a whole answer. `data`
 * with a `failure` is a partial one, and the caller owes the reader a reason for every node it did not get.
 * `failure` with no `data` is what `graphql` throws for and is NOT partial: GitHub answered about nothing, so
 * there is nothing to consume.
 *
 * A UNION RATHER THAN TWO OPTIONAL FIELDS, so that the fourth combination cannot be written and a caller
 * narrowing on `data === undefined` is handed a `failure` it does not have to defend against. "There is no data,
 * and no reason either" is not an answer this can return: where GitHub named no errors, the shape of the
 * response is itself the reason and is reported as one.
 */
export type GraphqlPartial<T> = { data: T; failure?: GraphqlFailure } | { data?: undefined; failure: GraphqlFailure };

/** How long one resource's quota made a run stand still, and how many times. */
export interface RateLimitWait {
  resource: string;
  seconds: number;
  count: number;
}

/** The status counted for an attempt no response arrived for. There is no HTTP status to report. */
const NO_RESPONSE = 0;

export interface GitHubClientOptions {
  credentials: GitHubCredentials;
  fetch?: typeof globalThis.fetch;
  /** Milliseconds. */
  pause?: (ms: number) => Promise<void>;
  /** Epoch seconds, matching GitHub's own reset header. */
  clock?: () => number;
  maximumAttempts?: number;
  /**
   * How much quota to leave unspent. Zero by default, and opt-in for a reason: holding quota back is
   * only meaningful when something ELSE shares the token, and nothing here does. The previous absolute
   * default of 100 parked GraphQL for the rest of its hour with 75 of 5000 still in hand.
   */
  rateLimitReserve?: number;
  apiUrl?: string;
}

export function createGitHubClient(options: GitHubClientOptions) {
  const { credentials } = options;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const pause = options.pause ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const clock = options.clock ?? (() => Date.now() / 1000);
  const maximumAttempts = options.maximumAttempts ?? DEFAULT_MAXIMUM_ATTEMPTS;
  const rateLimitReserve = options.rateLimitReserve ?? 0;
  const apiUrl = options.apiUrl ?? DEFAULT_API_URL;
  const graphqlUrl = `${apiUrl}/graphql`;

  const rateLimits = new Map<string, RateLimitBudget>();
  const outcomes = new Map<string, { outcome: CallOutcome; count: number }>();
  const waits = new Map<string, { seconds: number; count: number }>();
  let requestsIssued = 0;

  /**
   * The Authorization header for ONE request, asking credentials for the token now.
   *
   * Asked for per request rather than once, because in App mode the token is minted on demand and
   * replaced before it expires: a header built at construction would be an hour stale by the end of a
   * collection that takes longer than that.
   *
   * NO PATH IN THIS CLIENT LOGS A HEADER MAPPING, which is why there is no redaction step here to
   * remember to apply — the token has nowhere to leak to. Anything added that logs headers wholesale has
   * to redact them, and `redact.ts` is how.
   */
  async function authorization(): Promise<Record<string, string>> {
    return {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      Authorization: `Bearer ${await credentials.token()}`
    };
  }

  /** Records a complete resource budget reported in response headers. */
  function recordRateLimit(response: Response): void {
    const resource = response.headers.get("x-ratelimit-resource");
    if (resource === null) {
      return;
    }
    const limit = headerNumber(response, "x-ratelimit-limit");
    const remaining = headerNumber(response, "x-ratelimit-remaining");
    const used = headerNumber(response, "x-ratelimit-used");
    const resetsAt = headerNumber(response, "x-ratelimit-reset");
    // All four or none: a partial budget would be worse than no budget, because the waiter would act on
    // a `remaining` whose reset instant it cannot see.
    if (limit === undefined || remaining === undefined || used === undefined || resetsAt === undefined) {
      return;
    }
    rateLimits.set(resource, { limit, remaining, used, resetsAt });
  }

  /**
   * Waits out a window this client has nothing left in, before spending a call proving it.
   *
   * A BUDGET WITH CALLS LEFT IN IT IS NOT EXHAUSTED. What this must never do is decide the window is
   * spent when it is not — GraphQL charges POINTS rather than calls, so `remaining` falls in steps of
   * whatever the last query cost, and a threshold above zero throws away everything between it and zero.
   *
   * The wait is announced at warning rather than debug because it is the one place a collection stops for
   * minutes at a time without issuing a request: a silent pause here is indistinguishable from a hang.
   *
   * It is also COUNTED, and separately from the call outcomes: no call is made here, so recording one would
   * report a request that never happened. It is counted at all because the summary's job is to say where a
   * run's hours went, and an hour spent standing still is the one answer the outcome lines cannot give.
   */
  async function waitForRateLimit(resource: string): Promise<void> {
    const budget = rateLimits.get(resource);
    if (budget === undefined || budget.remaining > rateLimitReserve || budget.resetsAt <= clock()) {
      return;
    }
    const delay = Math.max(budget.resetsAt - clock(), 0);
    const waited = waits.get(resource);
    waits.set(resource, { seconds: (waited?.seconds ?? 0) + delay, count: (waited?.count ?? 0) + 1 });
    console.warn(
      `GitHub ${resource} quota spent (${budget.remaining} of ${budget.limit} left, reserve ${rateLimitReserve}), waiting ${delay.toFixed(0)}s for the window to reset`
    );
    await pause(delay * 1000);
    rateLimits.delete(resource);
  }

  /**
   * GitHub's required delay for a rate-limited response, or `undefined` if it is not one.
   *
   * A 403 is GitHub's answer both to a spent quota and to a refusal, and the two must never be confused:
   * retrying a refusal spends a minute learning nothing, and reporting a spent quota as a refusal records
   * "nobody may look" as a fact about the repository. Only the three signals GitHub documents are read as
   * a rate limit, and a 403 carrying none of them falls through to the classifier without pausing.
   *
   * Both header reads are guarded. `retry-after` is allowed to be an HTTP-date by the HTTP spec (GitHub
   * sends seconds, but a proxy in the path need not), and `x-ratelimit-reset` can be absent on the very
   * response whose `x-ratelimit-remaining` is `0`. Either would otherwise raise out of the retry path as
   * an unclassified crash instead of a graded refusal.
   */
  function rateLimitDelay(response: Response, body: string): number | undefined {
    if (response.status !== 403 && response.status !== 429) {
      return undefined;
    }
    const after = headerNumber(response, "retry-after");
    if (after !== undefined) {
      return Math.max(after, 0);
    }
    const resetsAt = headerNumber(response, "x-ratelimit-reset");
    if (response.headers.get("x-ratelimit-remaining") === "0" && resetsAt !== undefined) {
      return Math.max(resetsAt - clock(), 0);
    }
    if (response.status === 429 || body.toLowerCase().includes("rate limit")) {
      return 60;
    }
    return undefined;
  }

  /** The delay required before retrying a response, or `undefined` when it should not be retried. */
  function responseRetryDelay(response: Response, body: string, attempt: number): number | undefined {
    const delay = rateLimitDelay(response, body);
    if (delay !== undefined) {
      if (attempt === maximumAttempts) {
        throw new GitHubError(`GitHub rate limit exceeded after ${maximumAttempts} attempts`, AvailabilityReason.RateLimited, response.status);
      }
      return delay;
    }
    if (response.status >= 500 && attempt < maximumAttempts) {
      return 2 ** (attempt - 1);
    }
    return undefined;
  }

  /**
   * The delay for an HTTP or GraphQL rate-limit failure.
   *
   * Falling through to the flat 60s is the same answer this gives a rate limit that names no deadline.
   */
  function graphqlRetryDelay(response: Response, body: string, attempt: number): number | undefined {
    const delay = responseRetryDelay(response, body, attempt);
    if (delay !== undefined || !graphqlRateLimited(body)) {
      return delay;
    }
    if (attempt === maximumAttempts) {
      throw new GitHubError(`GitHub rate limit exceeded after ${maximumAttempts} attempts`, AvailabilityReason.RateLimited, response.status);
    }
    const after = headerNumber(response, "retry-after");
    if (after !== undefined) {
      return Math.max(after, 0);
    }
    const resetsAt = headerNumber(response, "x-ratelimit-reset");
    if (response.headers.get("x-ratelimit-remaining") === "0" && resetsAt !== undefined) {
      return Math.max(resetsAt - clock(), 0);
    }
    return 60;
  }

  /**
   * Counts one attempt, without logging it.
   *
   * SEPARATE FROM `logOutcome` so that the retry paths can be counted while the summary keeps its "exactly
   * one line per response" rule: an attempt this client is about to retry already logs the line saying so,
   * and counting it there rather than logging again is what keeps the two from doubling up.
   */
  function countOutcome(status: number, outcome: CallOutcome["outcome"], method: string, endpoint: string): void {
    const key = `${status} ${outcome} ${method} ${endpoint}`;
    const existing = outcomes.get(key);
    if (existing === undefined) {
      outcomes.set(key, { outcome: { status, outcome, method, endpoint }, count: 1 });
    } else {
      existing.count += 1;
    }
  }

  /**
   * Whether a response about to be retried was a SPENT QUOTA rather than a server error.
   *
   * Re-derived from the response rather than plumbed out of the delay deciders, because the deciders answer
   * "how long" and this asks "why", and both `rateLimitDelay` and `graphqlRateLimited` are pure reads of a
   * response already in hand. It decides one word in the summary and nothing about the retry itself.
   */
  function isRateLimited(response: Response, body: string, isGraphql: boolean): boolean {
    return rateLimitDelay(response, body) !== undefined || (isGraphql && graphqlRateLimited(body));
  }

  /**
   * Logs EXACTLY ONE LINE for one GitHub response, at a level chosen by what came back, and counts it.
   *
   * A disabled feature logs at debug beside a 200 rather than at warning, so AT THE DEFAULT LEVEL A 403 IN
   * THE LOG IS ALWAYS A GENUINE PERMISSION PROBLEM.
   *
   * The body is deliberately NOT logged. Secret-scanning alert records carry the literal detected
   * credential in a `secret` field, so dumping every response at debug would copy live keys out of
   * GitHub's access controls into a plain file on disk. A failure logs GitHub's own `message` and nothing
   * else of the body.
   */
  function logOutcome(response: Response, method: string, endpoint: string, body: string, bodyFailure?: BodyFailure): void {
    const failure = bodyFailure;
    const status = failure?.status ?? response.status;

    let outcome: CallOutcome["outcome"];
    if (failure !== undefined) {
      outcome = "errors";
    } else if (response.ok) {
      outcome = "ok";
    } else if (response.status === 403 && classify(response.status, body)[1] === AvailabilityReason.FeatureDisabled) {
      outcome = "disabled";
    } else if (response.status === 401 || response.status === 403 || response.status === 404) {
      // `refused` is reserved for these three. Every other error status is `failed`, because the client
      // cannot tell a 404 on a feature that is off from one on a repository that is genuinely unreadable.
      outcome = "refused";
    } else if (!response.ok) {
      outcome = "failed";
    } else {
      outcome = "ok";
    }

    countOutcome(status, outcome, method, endpoint);

    // `(equivalent)` so nobody reads the status as one HTTP returned.
    const equivalent = failure !== undefined && failure.status !== response.status ? " (equivalent)" : "";
    const detail = failure?.summary ?? (response.ok ? `${body.length} bytes` : failureMessage(body));
    const line = `GitHub ${outcome} ${status}${equivalent} ${method} ${endpoint}: ${detail}`;
    if (outcome === "ok" || outcome === "disabled") {
      // STDERR, not stdout, and that matters rather than being a preference: a command whose product is a
      // document — `evidence --format json`, `collect-org --propose-teams` — has stdout redirected into a
      // file, and `console.debug` writes to stdout, so one call per repository was landing in the middle of
      // it. Upstream stated the rule and the port lost it: "writes the report to stdout and progress to
      // stderr, so stdout can be redirected into a file". `console.warn` below was always stderr.
      process.stderr.write(`${line}\n`);
    } else {
      console.warn(line);
    }
  }

  /**
   * Issues one request with retries, returning its body.
   *
   * `requestsIssued` counts an OPERATION once regardless of how many attempts it took; the outcome
   * counters count each ATTEMPT. Two different numbers, both surfaced, because "how much did this run
   * cost GitHub" and "what did GitHub answer" are different questions — and the second one has to include
   * the attempts that were retried, waited out or given up on, or a run's summary describes a cheaper and
   * more successful run than the one that happened.
   *
   * `tolerateBodyFailure` changes ONE line of this: whether a failure GitHub stated inside an HTTP 200 is
   * thrown or handed back beside the body. Nothing else moves — the retry loop, the rate-limit waits, the
   * outcome counting and every non-200 still behave identically — which is what makes `graphqlPartial` an
   * addition rather than a change. In particular a `RATE_LIMITED` inside a 200 never reaches that line: the
   * retry deciders above have already either paused and asked again or given up, so a spent budget keeps its
   * wait-and-retry path and is never offered to a caller as partial data.
   */
  async function request(
    method: string,
    url: string,
    init: RequestInit,
    resource: string,
    operation?: string,
    tolerateBodyFailure = false
  ): Promise<GitHubResponse> {
    requestsIssued += 1;
    let refreshed = false;
    const endpoint = endpointTemplate(url, operation);

    for (let attempt = 1; ; attempt += 1) {
      await waitForRateLimit(resource);

      const headers = { ...(init.headers as Record<string, string> | undefined), ...(await authorization()) };
      let response: Response;
      try {
        response = await fetchImpl(url, { ...init, method, headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      } catch (error) {
        // No response, so no status: counted at 0 rather than at a status nothing returned.
        if (attempt < maximumAttempts) {
          countOutcome(NO_RESPONSE, "unreachable", method, endpoint);
          console.warn(`GitHub request failed, retrying (attempt ${attempt} of ${maximumAttempts}): ${error instanceof Error ? error.message : String(error)}`);
          await pause(2 ** (attempt - 1) * 1000);
          continue;
        }
        countOutcome(NO_RESPONSE, "exhausted", method, endpoint);
        throw new GitHubError(`GitHub could not be reached after ${maximumAttempts} attempts`, AvailabilityReason.CollectionFailed, undefined, {
          cause: error
        });
      }

      recordRateLimit(response);
      const body = await response.text();

      // A refused token is worth one fresh mint and one retry — and only one, because `refresh` reports
      // whether a genuinely new credential was obtained. A PAT answers false and the 401 is classified
      // where it was raised rather than retried against the same string.
      if (response.status === 401 && !refreshed && (await credentials.refresh())) {
        refreshed = true;
        countOutcome(response.status, "retried", method, endpoint);
        continue;
      }

      const isGraphql = url === graphqlUrl;
      let delay: number | undefined;
      try {
        delay = isGraphql ? graphqlRetryDelay(response, body, attempt) : responseRetryDelay(response, body, attempt);
      } catch (error) {
        // The deciders raise when a rate limit outlasted `maximumAttempts`, and that attempt is the one the
        // operation gave up on. Counted before rethrowing, because it was previously the run's largest
        // silence: hours of waiting ending in nothing, and not a line in the summary to say so.
        countOutcome(response.status, "exhausted", method, endpoint);
        throw error;
      }
      if (delay !== undefined) {
        countOutcome(response.status, isRateLimited(response, body, isGraphql) ? "rate-limited" : "retried", method, endpoint);
        console.warn(`GitHub ${response.status} ${method} ${endpoint}, retrying in ${delay.toFixed(0)}s (attempt ${attempt} of ${maximumAttempts})`);
        await pause(delay * 1000);
        continue;
      }

      const bodyFailure = isGraphql && response.ok ? graphqlBodyFailure(response.status, body) : undefined;
      logOutcome(response, method, endpoint, body, bodyFailure);

      if (!response.ok) {
        const [message, reason] = classify(response.status, body);
        throw new GitHubError(message, reason, response.status);
      }
      if (bodyFailure !== undefined && !tolerateBodyFailure) {
        throw new GitHubError(
          "GitHub refused part of a GraphQL query",
          bodyFailure.status === 403 ? AvailabilityReason.PermissionDenied : AvailabilityReason.CollectionFailed,
          bodyFailure.status
        );
      }
      // The link header travels with the body, so pagination can follow it without re-reading a consumed
      // response.
      return { body, link: response.headers.get("link") ?? undefined, ...(bodyFailure === undefined ? {} : { bodyFailure }) };
    }
  }

  return {
    /** One REST GET, parsed as JSON. */
    async get<T>(pathOrUrl: string, parameters: Record<string, string | number> = {}, resource = "core"): Promise<T> {
      const url = new URL(pathOrUrl.startsWith("http") ? pathOrUrl : `${apiUrl}${pathOrUrl}`);
      for (const [name, value] of Object.entries(parameters)) {
        url.searchParams.set(name, String(value));
      }
      const { body } = await request("GET", url.toString(), {}, resource);
      return parseJson<T>(body, "GitHub returned an unreadable body");
    },

    /**
     * One GraphQL query.
     *
     * `resource` is a parameter because the commit search is issued under a name of its own precisely so
     * the shared waiter leaves it alone: GitHub reports it as `search`, and a caller pacing that scarce
     * quota by hand reads the real budget rather than assuming a limit.
     *
     * The document's OPERATION NAME is what it is counted under, so the summary tells an assurance batch
     * from a merge walk. Read from the document rather than passed by each caller: there are fifteen named
     * documents here, and a name a caller supplies is a name that can disagree with the query it travels
     * with.
     */
    async graphql<T>(query: string, variables: Record<string, unknown> = {}, resource = "graphql"): Promise<T> {
      const { body } = await request(
        "POST",
        graphqlUrl,
        { body: JSON.stringify({ query, variables }), headers: { "content-type": "application/json" } },
        resource,
        graphqlOperationName(query)
      );
      const payload = parseJson<{ data?: T }>(body, "GitHub returned an unreadable GraphQL body");
      if (payload.data === undefined || payload.data === null) {
        throw new GitHubError("GitHub returned a GraphQL response with no data", AvailabilityReason.CollectionFailed);
      }
      return payload.data;
    },

    /**
     * One GraphQL query whose caller will handle a PARTIAL answer.
     *
     * A SEPARATE METHOD RATHER THAN AN OPTION ON `graphql`, and that is the whole design. `graphql` above is
     * untouched — same signature, same body, same throw for any non-empty `errors` array — so no existing
     * caller's semantics can have moved: partial data is reachable only by naming a method that did not exist
     * before. An options flag would have left a default value to get wrong, and a partial answer silently
     * reaching a caller that assumed a whole one is a worse fault than the cost this exists to save.
     *
     * WHAT THIS BUYS. GitHub answers an aliased 50-repository document containing one archived-and-transferred
     * repository with HTTP 200, 49 populated aliases, one `null` and one error. `graphql` throws that away and
     * its callers re-read the batch one repository at a time, so 38 intended documents became roughly 1,900
     * calls — most 50-wide batches contain at least one node GitHub will not answer for.
     *
     * WHAT IT DOES NOT CHANGE. A transport failure still throws from `request`, before anything here runs, so
     * there is no partial consumption of a response that never arrived. A `RATE_LIMITED` inside a 200 is still
     * waited out and retried by the loop in `request` and never surfaces here. And a 200 carrying errors and
     * NO `data` is still a failure — GitHub answered about nothing, and `{ failure }` with no `data` is how
     * that is said to a caller that cannot be thrown at.
     */
    async graphqlPartial<T>(query: string, variables: Record<string, unknown> = {}, resource = "graphql"): Promise<GraphqlPartial<T>> {
      const { body, bodyFailure } = await request(
        "POST",
        graphqlUrl,
        { body: JSON.stringify({ query, variables }), headers: { "content-type": "application/json" } },
        resource,
        graphqlOperationName(query),
        true
      );
      const payload = parseJson<{ data?: T }>(body, "GitHub returned an unreadable GraphQL body");
      const failure = bodyFailure === undefined ? undefined : graphqlFailure(bodyFailure);
      if (payload.data === undefined || payload.data === null) {
        // The same judgement `graphql` throws, handed back instead. Where GitHub named errors they are the
        // reason; where it named none there is nothing to report but the shape of the answer.
        return {
          failure: failure ?? {
            message: "GitHub returned a GraphQL response with no data",
            reason: AvailabilityReason.CollectionFailed,
            status: 200,
            summary: "no data and no errors",
            byAlias: new Map()
          }
        };
      }
      return { data: payload.data, ...(failure === undefined ? {} : { failure }) };
    },

    /**
     * Every page of a REST collection.
     *
     * Follows the `Link` header, and ONLY within `api.github.com`: a `next` pointing anywhere else is not
     * GitHub's pagination and is not followed with GitHub's credential attached.
     */
    async *paginate<T>(pathOrUrl: string, parameters: Record<string, string | number> = {}, resource = "core"): AsyncGenerator<T[]> {
      const first = new URL(pathOrUrl.startsWith("http") ? pathOrUrl : `${apiUrl}${pathOrUrl}`);
      for (const [name, value] of Object.entries(parameters)) {
        first.searchParams.set(name, String(value));
      }
      let next: string | undefined = first.toString();
      const host = new URL(apiUrl).host;
      while (next !== undefined) {
        const { body, link } = await request("GET", next, {}, resource);
        yield parseJson<T[]>(body, "GitHub returned an unreadable body");
        const followed = link === undefined ? undefined : nextLink(link);
        // Only within GitHub's own host: a `next` pointing anywhere else is not GitHub's pagination and is
        // not followed with GitHub's credential attached.
        next = followed !== undefined && new URL(followed).host === host ? followed : undefined;
      }
    },

    /** The budget GitHub last reported for one of ITS OWN resource names. */
    budget(resource: string): RateLimitBudget | undefined {
      return rateLimits.get(resource);
    },

    /** How many operations this run issued, counting a retried call once. */
    requestsIssued(): number {
      return requestsIssued;
    },

    /** Every counted call outcome, one entry per attempt kind, for the run summary. */
    callOutcomes(): { outcome: CallOutcome; count: number }[] {
      return [...outcomes.values()];
    },

    /** How long this run stood still waiting for a quota, per resource. */
    rateLimitWaits(): RateLimitWait[] {
      return [...waits.entries()].map(([resource, waited]) => ({ resource, seconds: waited.seconds, count: waited.count }));
    }
  };
}

/** One response's body beside the `Link` header pagination follows. */
interface GitHubResponse {
  body: string;
  link: string | undefined;
  /** The failure GitHub stated inside an HTTP 200, present only where the caller said it would handle one. */
  bodyFailure?: BodyFailure;
}

/**
 * The failure a partial caller is handed, from the one `graphql` would have thrown.
 *
 * THE SAME MESSAGE AND THE SAME REASON, deliberately: a refusal a caller reports out of a partial read has to
 * read as the same refusal a caller reports out of a thrown one, or the run summary and the log describe two
 * different faults. Only `byAlias` is new, and it is what lets a caller say which node the refusal was about.
 */
function graphqlFailure(bodyFailure: BodyFailure): GraphqlFailure {
  return {
    message: "GitHub refused part of a GraphQL query",
    reason: bodyFailure.status === 403 ? AvailabilityReason.PermissionDenied : AvailabilityReason.CollectionFailed,
    status: bodyFailure.status,
    summary: bodyFailure.summary,
    byAlias: bodyFailure.byAlias
  };
}

function parseJson<T>(body: string, message: string): T {
  try {
    return JSON.parse(body) as T;
  } catch (error) {
    throw new GitHubError(message, AvailabilityReason.CollectionFailed, undefined, { cause: error });
  }
}

/** The `next` URL of a GitHub `Link` header, or `undefined` when there is no next page. */
export function nextLink(header: string): string | undefined {
  for (const part of header.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part.trim());
    if (match) {
      return match[1];
    }
  }
  return undefined;
}

function headerNumber(response: Response, name: string): number | undefined {
  const value = response.headers.get(name);
  if (value === null) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export type GitHubClient = ReturnType<typeof createGitHubClient>;
