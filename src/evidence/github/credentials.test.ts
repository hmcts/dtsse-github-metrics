import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACCESS_TOKEN_VARIABLE,
  APP_IDENTIFIER_VARIABLE,
  appInstallation,
  CredentialsError,
  INSTALLATION_IDENTIFIER_VARIABLE,
  identifier,
  keyConfigured,
  mintedExpiry,
  mintedToken,
  PRIVATE_KEY_PATH_VARIABLE,
  PRIVATE_KEY_VARIABLE,
  personalAccessToken,
  privateKeyMaterial,
  resolveCredentials,
  transient
} from "./credentials.ts";
import { MINIMUM_SECRET_LENGTH, REDACTION, redacted, refusal } from "./redact.ts";

// Ported from tests/test_credentials.py.

const PRIVATE_KEY = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" }
}).privateKey;

// GitHub's "Generate a private key" button hands out PKCS#1. The PKCS#8 fixture above is what a converted key
// looks like; both must sign, because the real downloaded key is the first kind.
const PKCS1_PRIVATE_KEY = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" }
}).privateKey;

const NOW = new Date("2026-08-08T12:00:00Z");

function responding(...responses: { status: number; body: unknown }[]): typeof globalThis.fetch {
  const queue = [...responses];
  return vi.fn(() => {
    const next = queue.shift() ?? { status: 500, body: {} };
    return Promise.resolve(
      new Response(typeof next.body === "string" ? next.body : JSON.stringify(next.body), {
        status: next.status,
        headers: { "content-type": "application/json" }
      })
    );
  }) as unknown as typeof globalThis.fetch;
}

function installation(overrides: Partial<Parameters<typeof appInstallation>[0]> = {}) {
  return appInstallation({
    appIdentifier: 12345,
    installationIdentifier: 67890,
    privateKey: PRIVATE_KEY,
    clock: () => NOW,
    pause: () => Promise.resolve(),
    fetch: responding({ status: 201, body: { token: "ghs_minted", expires_at: "2026-08-08T13:00:00Z" } }),
    ...overrides
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("personalAccessToken", () => {
  it("should return the configured token when asked", async () => {
    expect(await personalAccessToken("ghp_configured").token()).toBe("ghp_configured");
  });

  it("should report that nothing was refreshed, because a PAT is the only token there will be", async () => {
    // False is the answer that matters: a caller holding a 401 learns that retrying would send the same
    // refused credential again.
    expect(await personalAccessToken("ghp_configured").refresh()).toBe(false);
  });
});

describe("appInstallation", () => {
  it("should mint a token on first use and hold it for the next call", async () => {
    const fetchImpl = responding({ status: 201, body: { token: "ghs_minted", expires_at: "2026-08-08T13:00:00Z" } });
    const credentials = installation({ fetch: fetchImpl });

    expect(await credentials.token()).toBe("ghs_minted");
    expect(await credentials.token()).toBe("ghs_minted");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("should replace a token inside the renewal margin before it stops working", async () => {
    // A collection of 1850 repositories outlives GitHub's hour, so the token is replaced early rather
    // than sent expired.
    let current = new Date("2026-08-08T12:00:00Z");
    const fetchImpl = responding(
      { status: 201, body: { token: "ghs_first", expires_at: "2026-08-08T12:04:00Z" } },
      { status: 201, body: { token: "ghs_second", expires_at: "2026-08-08T13:04:00Z" } }
    );
    const credentials = installation({ fetch: fetchImpl, clock: () => current });

    expect(await credentials.token()).toBe("ghs_first");
    current = new Date("2026-08-08T12:00:30Z");
    expect(await credentials.token()).toBe("ghs_second");
  });

  it("should keep a still-valid token when an early renewal fails", async () => {
    // The margin is the retry budget. Failing here would discard a working token, and with it a
    // collection that may be hours in, because GitHub had a bad second five minutes early.
    let current = new Date("2026-08-08T12:00:00Z");
    const fetchImpl = responding({ status: 201, body: { token: "ghs_first", expires_at: "2026-08-08T12:04:00Z" } }, { status: 401, body: { message: "no" } });
    const credentials = installation({ fetch: fetchImpl, clock: () => current });

    expect(await credentials.token()).toBe("ghs_first");
    current = new Date("2026-08-08T12:00:30Z");
    expect(await credentials.token()).toBe("ghs_first");
  });

  it("should fail the run when renewal fails and the held token has genuinely expired", async () => {
    let current = new Date("2026-08-08T12:00:00Z");
    const fetchImpl = responding({ status: 201, body: { token: "ghs_first", expires_at: "2026-08-08T12:01:00Z" } }, { status: 401, body: { message: "no" } });
    const credentials = installation({ fetch: fetchImpl, clock: () => current });

    await credentials.token();
    current = new Date("2026-08-08T12:02:00Z");
    await expect(credentials.token()).rejects.toThrow(CredentialsError);
  });

  it("should mint unconditionally on refresh, because the held token was refused rather than old", async () => {
    const fetchImpl = responding(
      { status: 201, body: { token: "ghs_first", expires_at: "2026-08-08T13:00:00Z" } },
      { status: 201, body: { token: "ghs_second", expires_at: "2026-08-08T13:00:00Z" } }
    );
    const credentials = installation({ fetch: fetchImpl });

    await credentials.token();
    expect(await credentials.refresh()).toBe(true);
    expect(await credentials.token()).toBe("ghs_second");
  });

  it("should run one exchange at a time when callers ask concurrently", async () => {
    const fetchImpl = responding({ status: 201, body: { token: "ghs_minted", expires_at: "2026-08-08T13:00:00Z" } });
    const credentials = installation({ fetch: fetchImpl });

    const [first, second] = await Promise.all([credentials.token(), credentials.token()]);

    expect([first, second]).toEqual(["ghs_minted", "ghs_minted"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("should retry a transient refusal and succeed", async () => {
    const fetchImpl = responding({ status: 503, body: { message: "unavailable" } }, { status: 201, body: { token: "ghs_minted", expires_at: null } });

    expect(await installation({ fetch: fetchImpl }).token()).toBe("ghs_minted");
  });

  it("should not retry a 401, because the second identical request gets the identical answer", async () => {
    const fetchImpl = responding({ status: 401, body: { message: "A JSON web token could not be decoded" } });

    await expect(installation({ fetch: fetchImpl }).token()).rejects.toThrow(/A JSON web token could not be decoded/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("should give up after the bounded number of attempts", async () => {
    const fetchImpl = responding({ status: 500, body: {} }, { status: 500, body: {} }, { status: 500, body: {} });

    await expect(installation({ fetch: fetchImpl }).token()).rejects.toThrow(CredentialsError);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("should sign with a PKCS#1 key, which is what GitHub actually downloads", async () => {
    // Regression: importPKCS8 reads only `BEGIN PRIVATE KEY`, so the real App key — `BEGIN RSA PRIVATE KEY` —
    // was rejected as unusable until this went through node:crypto instead.
    expect(PKCS1_PRIVATE_KEY).toContain("BEGIN RSA PRIVATE KEY");

    const fetchImpl = responding({ status: 201, body: { token: "ghs_minted", expires_at: "2026-08-08T13:00:00Z" } });

    expect(await installation({ privateKey: PKCS1_PRIVATE_KEY, fetch: fetchImpl }).token()).toBe("ghs_minted");
  });

  it("should sign with a PKCS#8 key too, which is what a converted one looks like", async () => {
    expect(PRIVATE_KEY).toContain("BEGIN PRIVATE KEY");

    const fetchImpl = responding({ status: 201, body: { token: "ghs_minted", expires_at: "2026-08-08T13:00:00Z" } });

    expect(await installation({ privateKey: PRIVATE_KEY, fetch: fetchImpl }).token()).toBe("ghs_minted");
  });

  it("should report an unusable private key in one line rather than a crypto traceback", async () => {
    const credentials = installation({ privateKey: "-----BEGIN PRIVATE KEY-----\nnot a key\n-----END PRIVATE KEY-----" });

    await expect(credentials.token()).rejects.toThrow(/private key could not be used to sign a request/);
  });

  it("should refuse a successful exchange that carried no token", async () => {
    const fetchImpl = responding({ status: 201, body: { expires_at: "2026-08-08T13:00:00Z" } });

    await expect(installation({ fetch: fetchImpl }).token()).rejects.toThrow(/no installation token in a successful exchange/);
  });

  it("should refuse an exchange body that cannot be read", async () => {
    const fetchImpl = responding({ status: 201, body: "not json" });

    await expect(installation({ fetch: fetchImpl }).token()).rejects.toThrow(/unreadable body/);
  });

  it("should name the app and installation without ever naming the credential", async () => {
    const described = installation().describe();

    expect(described).toBe("GitHub App 12345 installation 67890");
    expect(described).not.toContain(PRIVATE_KEY.slice(40, 80));
  });

  it("should keep the private key out of a signing failure's message", async () => {
    // An escaped error carries the key in its frames, so the message is redacted on the way out.
    const key = `-----BEGIN PRIVATE KEY-----\n${"A".repeat(64)}\nbroken\n-----END PRIVATE KEY-----`;

    const error = await installation({ privateKey: key })
      .token()
      .catch((thrown: unknown) => thrown);

    expect(String(error)).not.toContain("A".repeat(64));
  });
});

describe("redacted", () => {
  it("should blank a whole secret out of a message", () => {
    expect(redacted(`the token ${"s".repeat(20)} was refused`, "s".repeat(20))).toBe(`the token ${REDACTION} was refused`);
  });

  it("should blank each line of a PEM, because quoting one line still publishes part of the key", () => {
    const key = `${"A".repeat(64)}\n${"B".repeat(64)}`;

    const result = redacted(`parser saw ${"B".repeat(64)} here`, key);

    expect(result).not.toContain("B".repeat(64));
  });

  it("should leave a short fragment alone, so a refusal is not reduced to a row of markers", () => {
    // A PEM's `-----END-----` line is not a secret.
    const short = "x".repeat(MINIMUM_SECRET_LENGTH - 1);

    expect(redacted(`saw ${short}`, short)).toBe(`saw ${short}`);
  });

  it("should ignore an absent secret", () => {
    expect(redacted("nothing to hide", undefined, "")).toBe("nothing to hide");
  });
});

describe("refusal", () => {
  it("should prefer GitHub's own message to the whole body", () => {
    expect(refusal(JSON.stringify({ message: "Integration not found" }))).toBe("Integration not found");
  });

  it("should fall back to the body when it is not JSON", () => {
    expect(refusal("<html>gateway timeout</html>")).toBe("<html>gateway timeout</html>");
  });

  it("should redact before truncating, so a long body cannot leave a secret's prefix behind", () => {
    // Cutting first would leave the first 200 characters of a JWT in the message, which no later pass
    // can match against the whole one.
    const secret = "j".repeat(300);

    const result = refusal(JSON.stringify({ message: `refused ${secret}` }), secret);

    expect(result).toBe(`refused ${REDACTION}`);
  });

  it("should collapse whitespace and cap the length", () => {
    expect(refusal("a\n\n   b").length).toBeLessThanOrEqual(200);
    expect(refusal("a\n\n   b")).toBe("a b");
    expect(refusal("z".repeat(400))).toHaveLength(200);
  });
});

describe("transient", () => {
  it.each([
    [500, true],
    [502, true],
    [429, true],
    [401, false],
    [403, false],
    [404, false]
  ])("should report %i as retryable=%s", (status, expected) => {
    expect(transient(status)).toBe(expected);
  });
});

describe("mintedExpiry", () => {
  it("should read a stated expiry as an instant", () => {
    expect(mintedExpiry({ expires_at: "2026-08-08T13:00:00Z" })?.toISOString()).toBe("2026-08-08T13:00:00.000Z");
  });

  it.each([[{}], [{ expires_at: 17 }], [{ expires_at: "not a date" }]])("should treat %o as an unknown expiry rather than a failure", (payload) => {
    // The token GitHub just issued works now; an unreadable expiry falls back to the 401 retry.
    expect(mintedExpiry(payload)).toBeUndefined();
  });
});

describe("mintedToken", () => {
  it("should refuse a body carrying no token", () => {
    expect(() => mintedToken({ expires_at: "2026-08-08T13:00:00Z" })).toThrow(CredentialsError);
  });

  it("should refuse an empty token", () => {
    expect(() => mintedToken({ token: "" })).toThrow(CredentialsError);
  });
});

describe("keyConfigured", () => {
  it.each([
    [{ [PRIVATE_KEY_PATH_VARIABLE]: "/tmp/app.pem" }, true],
    [{ [PRIVATE_KEY_VARIABLE]: "-----BEGIN-----" }, true],
    [{}, false]
  ])("should report whether a key source is named in %o without reading it", (environment, expected) => {
    expect(keyConfigured(environment)).toBe(expected);
  });
});

describe("privateKeyMaterial", () => {
  it("should prefer a path on disk to the key in a variable", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "ghm-"));
    const file = path.join(directory, "app.pem");
    writeFileSync(file, "from the file");

    const key = await privateKeyMaterial({ [PRIVATE_KEY_PATH_VARIABLE]: file, [PRIVATE_KEY_VARIABLE]: "from the variable" });

    // The path wins because a PEM in an environment variable is visible to every child process.
    expect(key).toBe("from the file");
  });

  it("should convert escaped newlines in an inline key, since a PEM with literal backslash-n will not parse", async () => {
    const key = await privateKeyMaterial({ [PRIVATE_KEY_VARIABLE]: "-----BEGIN-----\\nbody\\n-----END-----" });

    expect(key).toBe("-----BEGIN-----\nbody\n-----END-----");
  });

  it("should name the path when the key cannot be read", async () => {
    await expect(privateKeyMaterial({ [PRIVATE_KEY_PATH_VARIABLE]: "/nonexistent/app.pem" })).rejects.toThrow(/could not be read from \/nonexistent\/app.pem/);
  });

  it("should report an empty key rather than leaving it to the signer", async () => {
    // A signer says "could not parse the provided key", which is no help to someone whose real problem is
    // a file that was never written to.
    const directory = mkdtempSync(path.join(tmpdir(), "ghm-"));
    const file = path.join(directory, "empty.pem");
    writeFileSync(file, "   \n");

    await expect(privateKeyMaterial({ [PRIVATE_KEY_PATH_VARIABLE]: file })).rejects.toThrow(/is empty/);
  });
});

describe("identifier", () => {
  it("should read a numeric identifier", () => {
    expect(identifier("12345", APP_IDENTIFIER_VARIABLE)).toBe(12345);
  });

  it("should name the variable that is wrong", () => {
    expect(() => identifier("twelve", APP_IDENTIFIER_VARIABLE)).toThrow(/GH_APP_ID must be a number, and is "twelve"/);
  });
});

describe("resolveCredentials", () => {
  it("should prefer an App installation when the whole set is configured", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "ghm-"));
    const file = path.join(directory, "app.pem");
    writeFileSync(file, PRIVATE_KEY);

    const credentials = await resolveCredentials({
      [APP_IDENTIFIER_VARIABLE]: "12345",
      [INSTALLATION_IDENTIFIER_VARIABLE]: "67890",
      [PRIVATE_KEY_PATH_VARIABLE]: file,
      [ACCESS_TOKEN_VARIABLE]: "ghp_also_set"
    });

    expect(credentials.describe()).toBe("GitHub App 12345 installation 67890");
  });

  it("should fall back to the token on a half-set nobody meant to use", async () => {
    // A leftover App id without an installation or a key is an abandoned experiment, not a configuration
    // to fail the run over.
    const credentials = await resolveCredentials({ [APP_IDENTIFIER_VARIABLE]: "12345", [ACCESS_TOKEN_VARIABLE]: "ghp_configured" });

    expect(credentials.describe()).toBe("a personal access token");
  });

  it("should fail the run when a named key is unreadable, rather than quietly downgrading", async () => {
    // The whole point of selecting on whether the key was NAMED: an empty PEM at a path a fully configured
    // App named would otherwise silently authenticate with the token's much smaller permissions.
    await expect(
      resolveCredentials({
        [APP_IDENTIFIER_VARIABLE]: "12345",
        [INSTALLATION_IDENTIFIER_VARIABLE]: "67890",
        [PRIVATE_KEY_PATH_VARIABLE]: "/nonexistent/app.pem",
        [ACCESS_TOKEN_VARIABLE]: "ghp_also_set"
      })
    ).rejects.toThrow(CredentialsError);
  });

  it("should name both options when nothing is configured", async () => {
    await expect(resolveCredentials({})).rejects.toThrow(/GH_APP_ID.*GH_TOKEN/s);
  });
});
