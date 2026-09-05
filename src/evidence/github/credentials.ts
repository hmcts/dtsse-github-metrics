import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { importPKCS8, SignJWT } from "jose";
import { redacted, refusal } from "./redact.ts";

/**
 * Resolving the credential every GitHub call in a run is made with. Ported from `metrics.credentials`.
 *
 * Two things can authenticate a run, and they are not equivalent. A GitHub App installation is granted
 * its permissions by the organisation rather than intersected with a user's, which is what makes branch
 * protection, the three alert families and the GraphQL pull-request searches readable at all: a
 * user-intersected fine-grained token is refused on every one of them. A personal access token stays
 * supported because it is what a developer already has in their shell, and a run that reads less is
 * better than a run nobody can start.
 *
 * This port currently deploys with a PAT — the `dtsse-aat` vault holds `github-token` and no App
 * secrets — so in practice merge-gate and alert evidence will report as unavailable rather than as
 * numbers. The App path is ported anyway and selected the moment the three variables are set, so
 * switching is a Key Vault change and no code change.
 *
 * App auth is selected only when the whole set — an App id, an installation id and a private key — is
 * configured, so a half-set left over from an experiment falls back to the token rather than failing the
 * run with a partial configuration nobody meant to use. Selected on whether the key was NAMED, though,
 * not on whether it read back: a key that was pointed at and turns out to be missing or empty is a
 * broken App configuration, and fails the run rather than quietly authenticating as something with fewer
 * permissions than the one that was asked for.
 */

export const API_URL = "https://api.github.com";
export const REQUEST_TIMEOUT_MS = 30_000;

export const APP_IDENTIFIER_VARIABLE = "GH_APP_ID";
export const INSTALLATION_IDENTIFIER_VARIABLE = "GH_APP_INSTALLATION_ID";
export const PRIVATE_KEY_PATH_VARIABLE = "GH_APP_PRIVATE_KEY_PATH";
export const PRIVATE_KEY_VARIABLE = "GH_APP_PRIVATE_KEY";
export const ACCESS_TOKEN_VARIABLE = "GH_TOKEN";

// GitHub refuses a JWT whose lifetime exceeds ten minutes, and refuses one whose `iat` is in its own
// future — which a clock a few seconds fast will produce. Both numbers are GitHub's own guidance.
const JWT_LIFETIME_MS = 600_000;
const JWT_BACKDATE_MS = 60_000;

/**
 * How long before its stated expiry a held installation token is replaced.
 *
 * GitHub issues installation tokens with an hour's life, and a collection of 1850 repositories runs past
 * that, so the token WILL expire mid-run. Replacing it early is what stops a request being sent with a
 * token that expires while it is in flight — the failure the 401 retry catches and should never have to.
 */
export const RENEWAL_MARGIN_MS = 300_000;

/**
 * How many times the token exchange is attempted before the run is failed. The same bound an evidence
 * call gets, for the same reason: a run started overnight should not die because GitHub had a bad
 * second, and it should not hang for an hour either.
 */
export const MAXIMUM_EXCHANGE_ATTEMPTS = 3;

/**
 * Reports that a run cannot authenticate at all.
 *
 * Deliberately not a `GitHubError`. That exception carries an availability reason, which grades ONE
 * repository's evidence and lets a collection continue past it; a credentials failure grades the whole
 * run, and there is nothing for the next repository to try.
 */
export class CredentialsError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CredentialsError";
  }
}

/** Supplies the bearer token one GitHub request is made with, and replaces it when it is refused. */
export interface GitHubCredentials {
  /** The token to send on the next request, minting or renewing one if that is needed. */
  token(): Promise<string>;
  /**
   * Replaces the current token, reporting whether a genuinely new one was obtained.
   *
   * False is the answer that matters: it tells a caller holding a 401 that retrying would send the same
   * refused credential again, so the failure is classified where it was raised.
   */
  refresh(): Promise<boolean>;
  /** How the run authenticated, for the one line every run logs. Never the credential itself. */
  describe(): string;
}

/** Holds one long-lived token exactly as the environment gave it. */
export function personalAccessToken(value: string): GitHubCredentials {
  return {
    token: () => Promise.resolve(value),
    // Nothing to refresh: a PAT is the only token there will be.
    refresh: () => Promise.resolve(false),
    describe: () => "a personal access token"
  };
}

/**
 * Mints and holds an installation access token for one GitHub App installation.
 *
 * The token exchange is the one GitHub call in this project that does not go through the client, because
 * it is what mints the credential that client sends. It is also deliberately absent from the call
 * counters: those measure evidence collection, and an authentication call is not evidence.
 *
 * One token is minted and held rather than one per request, and it is replaced early — see
 * `RENEWAL_MARGIN_MS` — so a collection lasting longer than GitHub's hour never sends an expired one.
 * Where upstream took a `threading.Lock` defensively, this holds the in-flight mint as a promise: two
 * concurrent callers await the same exchange rather than starting two, which is the same check-then-act
 * hazard resolved the way an event loop resolves it.
 *
 * NOTHING ON THESE PATHS LOGS THE KEY, THE JWT OR THE TOKEN. Every message a failure carries goes
 * through `redacted`, and the one debug line a success writes says when the token expires rather than
 * what it is.
 */
export function appInstallation(options: AppInstallationOptions): GitHubCredentials {
  const { appIdentifier, installationIdentifier, privateKey } = options;
  const now = options.clock ?? (() => new Date());
  const pause = options.pause ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const fetchImpl = options.fetch ?? globalThis.fetch;

  let held: string | undefined;
  let expiresAt: Date | undefined;
  let inFlight: Promise<string> | undefined;

  /** Whether the held token is PAST the expiry GitHub stated, rather than merely near it. */
  function expired(): boolean {
    return expiresAt !== undefined && now().getTime() >= expiresAt.getTime();
  }

  /**
   * Whether the held token is inside the margin at which it is replaced early.
   *
   * An expiry nobody could read is not treated as expiring. The token GitHub just issued works now, and
   * re-minting on every request because its expiry was unparseable would turn a cosmetic problem into an
   * authentication call per evidence call.
   */
  function expiring(): boolean {
    return expiresAt !== undefined && now().getTime() + RENEWAL_MARGIN_MS >= expiresAt.getTime();
  }

  /** Signs the short-lived JWT that proves this process holds the App's private key. */
  async function assertion(): Promise<string> {
    const issuedAt = Math.floor((now().getTime() - JWT_BACKDATE_MS) / 1000);
    try {
      const key = await importPKCS8(privateKey, "RS256");
      return await new SignJWT({})
        .setProtectedHeader({ alg: "RS256" })
        .setIssuedAt(issuedAt)
        .setExpirationTime(issuedAt + (JWT_BACKDATE_MS + JWT_LIFETIME_MS) / 1000)
        .setIssuer(String(appIdentifier))
        .sign(key);
    } catch (error) {
      // The likeliest wrong keys are ordinary mistakes — the wrong `.pem` in the directory, a public key,
      // a passphrase-protected one — and each surfaces from the crypto layer differently. Catching
      // broadly is what puts every one of them in the single line saying the key cannot be used, and it
      // is also what keeps the redaction: an escaped error carries the key in its frames.
      const detail = redacted(error instanceof Error ? error.message : String(error), privateKey);
      throw new CredentialsError(`the GitHub App private key could not be used to sign a request: ${detail}`);
    }
  }

  /** Exchanges the App's JWT for an installation access token, and holds it with its expiry. */
  async function mint(): Promise<string> {
    // Signed once for the whole attempt sequence: it outlives every retry by minutes, and re-signing
    // would put another RSA operation between GitHub and the run for no gain. Held in a local as well,
    // so every message built below can be checked for it on the way out.
    const signed = await assertion();
    const url = `${API_URL}/app/installations/${installationIdentifier}/access_tokens`;
    const headers = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${signed}`,
      "X-GitHub-Api-Version": "2022-11-28"
    };

    for (let attempt = 1; ; attempt += 1) {
      let response: Response;
      try {
        response = await fetchImpl(url, { method: "POST", headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      } catch (error) {
        const detail = redacted(error instanceof Error ? error.message : String(error), signed, privateKey);
        if (attempt === MAXIMUM_EXCHANGE_ATTEMPTS) {
          throw new CredentialsError(`the GitHub App installation token could not be obtained after ${MAXIMUM_EXCHANGE_ATTEMPTS} attempts: ${detail}`);
        }
        await wait(attempt, detail);
        continue;
      }

      const body = await response.text();
      if (response.ok) {
        return hold(body);
      }

      const detail = `HTTP ${response.status}: ${refusal(body, signed, privateKey)}`;
      if (transient(response.status) && attempt < MAXIMUM_EXCHANGE_ATTEMPTS) {
        await wait(attempt, detail);
        continue;
      }
      throw new CredentialsError(`GitHub refused to issue an installation token for app ${appIdentifier} (${detail})`);
    }
  }

  /**
   * Backs off between exchange attempts, saying which attempt failed and what GitHub said.
   *
   * At warning, because a run that eventually authenticated still spent time not collecting, and an
   * exchange that needs two attempts every night is a problem worth seeing before it needs four. The
   * detail is GitHub's own account and nothing else — `mint` redacts it before calling this.
   */
  async function wait(attempt: number, detail: string): Promise<void> {
    const backoff = 2 ** (attempt - 1) * 1000;
    console.warn(
      `the GitHub App installation token exchange failed (attempt ${attempt} of ${MAXIMUM_EXCHANGE_ATTEMPTS}), retrying in ${backoff / 1000}s: ${detail}`
    );
    await pause(backoff);
  }

  /** Reads one successful exchange and keeps the token it issued, with the expiry it stated. */
  function hold(body: string): string {
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch (error) {
      throw new CredentialsError(`GitHub's installation token exchange returned an unreadable body: ${error instanceof Error ? error.message : String(error)}`);
    }
    held = mintedToken(payload);
    expiresAt = mintedExpiry(payload);
    return held;
  }

  /**
   * Replaces a token nearing expiry, keeping the one in hand if the exchange fails while it lives.
   *
   * THE MARGIN IS THE RETRY BUDGET, and this is what spends it. `RENEWAL_MARGIN_MS` exists so a token is
   * replaced BEFORE it stops working, which means the credential still holds a usable one at the moment
   * the exchange is attempted. Failing the run there would discard a working token — and with it a
   * collection that may be hours in, its inventory unwritten and its alert observations never appended —
   * because GitHub had a bad second five minutes early. Every later request attempts the exchange again,
   * so the margin buys minutes of retries; only once the held token has genuinely expired is there
   * nothing left to fall back on.
   *
   * A 401 does not come through here. `refresh` mints unconditionally, because there the held token was
   * refused rather than merely old, and falling back to it would send the same refused string.
   */
  async function renew(current: string): Promise<string> {
    try {
      return await mint();
    } catch (error) {
      if (expired()) {
        throw error;
      }
      console.warn(
        `the GitHub App installation token could not be renewed early, continuing with the held token until it expires at ${expiresAt?.toISOString()}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return current;
    }
  }

  /** Runs one exchange at a time, so concurrent callers await the same mint rather than starting two. */
  async function once(work: () => Promise<string>): Promise<string> {
    if (inFlight === undefined) {
      inFlight = work().finally(() => {
        inFlight = undefined;
      });
    }
    return inFlight;
  }

  return {
    async token(): Promise<string> {
      const current = held;
      if (current === undefined) {
        return once(mint);
      }
      if (expiring()) {
        return once(() => renew(current));
      }
      return current;
    },
    async refresh(): Promise<boolean> {
      await once(mint);
      return true;
    },
    describe(): string {
      // Identifiers rather than secrets, so a report full of refusals is one line away from its
      // explanation.
      return `GitHub App ${appIdentifier} installation ${installationIdentifier}`;
    }
  };
}

/**
 * Whether a refused exchange is worth attempting again.
 *
 * A 401 or a 404 is a statement about the key, the App or the installation, and the second identical
 * request gets the identical answer — retrying it only delays the message a human needs. A 5xx or a 429
 * is GitHub having a bad minute, which is the one failure here a retry actually fixes.
 */
export function transient(status: number): boolean {
  return status >= 500 || status === 429;
}

/** Reads the token out of an exchange GitHub called a success, refusing a body without one. */
export function mintedToken(payload: unknown): string {
  const token = typeof payload === "object" && payload !== null ? (payload as { token?: unknown }).token : undefined;
  if (typeof token !== "string" || token === "") {
    throw new CredentialsError("GitHub returned no installation token in a successful exchange");
  }
  return token;
}

/**
 * Reads `expires_at` as a UTC instant, treating anything unreadable as unknown.
 *
 * An unknown expiry is not a failure. The token GitHub just issued works now, and a caller that cannot
 * see when it stops working simply falls back to the 401 retry — which is the path a revoked token takes
 * anyway.
 */
export function mintedExpiry(payload: unknown): Date | undefined {
  const raw = typeof payload === "object" && payload !== null ? (payload as { expires_at?: unknown }).expires_at : undefined;
  if (typeof raw !== "string") {
    return undefined;
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    console.warn(`GitHub reported an unreadable installation token expiry: ${raw}`);
    return undefined;
  }
  return parsed;
}

/**
 * Whether a key SOURCE is named, without reading what it holds.
 *
 * Selecting App auth on the source rather than on the key's contents is what keeps two different failures
 * apart. A key nobody named is a half-set, and the run falls back to the token as documented; a key that
 * WAS named and turns out to be unreadable or empty is a broken configuration, and `privateKey` fails the
 * run saying which one it is.
 *
 * Deciding after the read collapsed both into the fallback and got each of them wrong: a stale
 * `GH_APP_PRIVATE_KEY_PATH` left over from an experiment ended a perfectly good token-authenticated run,
 * and an empty PEM at a path a fully configured App named silently downgraded that run to the token's much
 * smaller permissions — reporting branch protection and all three alert families as unavailable, with
 * nothing in the log pointing at the App configuration that was ignored.
 */
export function keyConfigured(environment: Environment): boolean {
  return Boolean(environment[PRIVATE_KEY_PATH_VARIABLE] || environment[PRIVATE_KEY_VARIABLE]);
}

/**
 * The GitHub App's private key, preferring a path on disk to the key in a variable.
 *
 * Called only when `keyConfigured` has already said one of the two is set, so every way out of here is a
 * usable key or a `CredentialsError` naming the source that failed — never a quiet undefined that sends
 * the run off to authenticate as something else.
 *
 * The path wins because it is the safer of the two: a PEM in an environment variable is visible to every
 * child process and to anything that dumps the environment. A key set inline is accepted anyway — CI
 * secret stores commonly cannot hold newlines — and its escaped `\n` sequences are converted back, since a
 * PEM with literal backslash-n in it will not parse.
 *
 * A leading `~` is expanded, because the variable does not always arrive from a shell that did it.
 * `export GH_APP_PRIVATE_KEY_PATH=~/app.pem` is expanded by bash before this ever sees it, but the same
 * line in a CI `env:` block, a compose file or a Kubernetes manifest is passed through literally — and
 * those are the runs App auth exists for.
 */
export async function privateKeyMaterial(environment: Environment): Promise<string> {
  const configured = environment[PRIVATE_KEY_PATH_VARIABLE];
  let key: string;
  let source: string;

  if (configured) {
    const expanded = configured.startsWith("~") ? path.join(os.homedir(), configured.slice(1)) : configured;
    try {
      key = await readFile(expanded, "utf8");
    } catch (error) {
      // A file that is not UTF-8 — a DER key, or a `.pem` that is really a keystore — fails the decode
      // rather than the open, and is an ordinary mistake belonging in the one line naming the path.
      throw new CredentialsError(`the GitHub App private key could not be read from ${configured}: ${error instanceof Error ? error.message : String(error)}`);
    }
    source = `read from ${configured}`;
  } else {
    key = (environment[PRIVATE_KEY_VARIABLE] ?? "").replace(/\\n/g, "\n");
    source = `in ${PRIVATE_KEY_VARIABLE}`;
  }

  // Checked here rather than left to the signing failure, because what a signer says about an empty
  // string is "could not parse the provided key" — true, and no help at all to someone whose real
  // problem is a file that was never written to.
  if (key.trim() === "") {
    throw new CredentialsError(`the GitHub App private key ${source} is empty`);
  }
  return key;
}

/** Reads one numeric GitHub identifier out of the environment, naming the variable that is wrong. */
export function identifier(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new CredentialsError(`${name} must be a number, and is ${JSON.stringify(value)}`);
  }
  return parsed;
}

/** Builds the credential this run authenticates with, preferring an App installation to a token. */
export async function resolveCredentials(environment: Environment = process.env, options: ResolveOptions = {}): Promise<GitHubCredentials> {
  const app = environment[APP_IDENTIFIER_VARIABLE];
  const installation = environment[INSTALLATION_IDENTIFIER_VARIABLE];

  if (app && installation && keyConfigured(environment)) {
    return appInstallation({
      appIdentifier: identifier(app, APP_IDENTIFIER_VARIABLE),
      installationIdentifier: identifier(installation, INSTALLATION_IDENTIFIER_VARIABLE),
      privateKey: await privateKeyMaterial(environment),
      ...options
    });
  }

  const token = environment[ACCESS_TOKEN_VARIABLE];
  if (token) {
    return personalAccessToken(token);
  }

  throw new CredentialsError(
    `no GitHub credential is configured: set ${APP_IDENTIFIER_VARIABLE}, ${INSTALLATION_IDENTIFIER_VARIABLE} and ` +
      `${PRIVATE_KEY_PATH_VARIABLE} (or ${PRIVATE_KEY_VARIABLE}) to authenticate as a GitHub App installation, ` +
      `or ${ACCESS_TOKEN_VARIABLE} to authenticate with a personal access token`
  );
}

/**
 * The environment these functions read, as a plain string map.
 *
 * Deliberately not `NodeJS.ProcessEnv`: Next.js augments that type to make `NODE_ENV` required, so a test
 * or a caller passing a small literal of just the variables under test would not type-check against it.
 * Nothing here reads anything but the five GitHub variables by name.
 */
export type Environment = Record<string, string | undefined>;

export interface AppInstallationOptions {
  appIdentifier: number;
  installationIdentifier: number;
  privateKey: string;
  clock?: () => Date;
  pause?: (ms: number) => Promise<void>;
  fetch?: typeof globalThis.fetch;
}

export type ResolveOptions = Omit<AppInstallationOptions, "appIdentifier" | "installationIdentifier" | "privateKey">;
