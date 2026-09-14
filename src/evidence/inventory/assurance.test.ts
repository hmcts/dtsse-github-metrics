import { describe, expect, it, vi } from "vitest";
import { createGitHubClient } from "../github/client.ts";
import { personalAccessToken } from "../github/credentials.ts";
import {
  assuranceEvidence,
  assuranceQuery,
  collectAssuranceSignals,
  DefaultAssuranceBatchSize,
  hygieneFromMetadata,
  readDependabotAlerts,
  severeAlertAge,
  UpdateConfigurationPaths
} from "./assurance.ts";

/**
 * Collecting the assurance signals, driven through a stubbed `fetch` so nothing reaches GitHub.
 *
 * The cases that matter are the tri-state ones. Every signal here has three answers — on, off, and nobody could
 * read it — and folding the third into the second is how a missing permission becomes a finding about a team.
 */

interface Reply {
  status?: number;
  body?: unknown;
}

function replying(...replies: Reply[]): { fetch: typeof globalThis.fetch; sent: { url: string; variables: Record<string, unknown> }[] } {
  const queue = [...replies];
  const sent: { url: string; variables: Record<string, unknown> }[] = [];
  const fetch = vi.fn((url: string | URL, init?: RequestInit) => {
    const parsed = init?.body === undefined ? { variables: {} } : (JSON.parse(String(init.body)) as { variables: Record<string, unknown> });
    sent.push({ url: String(url), variables: parsed.variables ?? {} });
    const next = queue.shift() ?? { status: 200, body: {} };
    return Promise.resolve(new Response(JSON.stringify(next.body ?? {}), { status: next.status ?? 200, headers: { "content-type": "application/json" } }));
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, sent };
}

function client(fetch: typeof globalThis.fetch) {
  return createGitHubClient({ credentials: personalAccessToken("ghp_test"), fetch, pause: () => Promise.resolve(), clock: () => 1000 });
}

/** GitHub's answer to a token that may not look: a refusal, not a rate limit, so it is not retried. */
const REFUSED: Reply = { status: 403, body: { message: "Forbidden" } };

const NOW = new Date("2026-09-14T12:00:00Z");

describe("hygieneFromMetadata", () => {
  it("should read the three signals GitHub carries on a repository's own metadata", () => {
    // These are FREE: they ride on the body `collect` already fetches for the default branch, which is the whole
    // reason the assurance columns cost no REST call per repository.
    const metadata = {
      default_branch: "main",
      security_and_analysis: {
        secret_scanning: { status: "enabled" },
        secret_scanning_push_protection: { status: "enabled" },
        dependabot_security_updates: { status: "disabled" }
      }
    };

    expect(hygieneFromMetadata(metadata)).toEqual({ secretScanning: true, pushProtection: true, dependabotSecurityUpdates: false });
  });

  it("should leave every signal absent where GitHub named no block at all", () => {
    // Measured: a personal access token gets `security_and_analysis` omitted entirely where an App installation
    // gets it in full. Reading that as three disabled features would report the whole estate as unscanned.
    expect(hygieneFromMetadata({ default_branch: "main" })).toEqual({});
  });

  it("should leave a signal absent where its own block is missing, keeping the ones present", () => {
    const metadata = { security_and_analysis: { secret_scanning: { status: "enabled" } } };

    expect(hygieneFromMetadata(metadata)).toEqual({ secretScanning: true });
  });

  it("should read anything but GitHub's own word for enabled as off", () => {
    // GitHub keeps adding statuses to this object, and a new one is not evidence that a feature is on.
    const metadata = { security_and_analysis: { secret_scanning: { status: "enabled_for_new_repos" } } };

    expect(hygieneFromMetadata(metadata)).toEqual({ secretScanning: false });
  });

  it("should leave every signal absent for a body it cannot read, rather than reporting them off", () => {
    expect(hygieneFromMetadata({ security_and_analysis: "unexpected" })).toEqual({});
    expect(hygieneFromMetadata(undefined)).toEqual({});
  });
});

describe("severeAlertAge", () => {
  function alert(severity: string, createdAt: string): unknown {
    return { created_at: createdAt, security_advisory: { severity } };
  }

  it("should report the OLDEST severe alert, which is the one a patching expectation is about", () => {
    const records = [alert("high", "2026-09-01T00:00:00Z"), alert("critical", "2026-06-01T00:00:00Z"), alert("high", "2026-09-10T00:00:00Z")];

    expect(severeAlertAge(records, NOW)).toBe(105);
  });

  it("should count only critical and high, a medium alert not being what the criterion asks about", () => {
    const records = [alert("medium", "2020-01-01T00:00:00Z"), alert("high", "2026-09-04T00:00:00Z")];

    expect(severeAlertAge(records, NOW)).toBe(10);
  });

  it("should have no age where nothing severe is open", () => {
    expect(severeAlertAge([alert("low", "2020-01-01T00:00:00Z")], NOW)).toBeUndefined();
    expect(severeAlertAge([], NOW)).toBeUndefined();
  });

  it("should drop an unreadable instant rather than counting it as zero days", () => {
    // Counted as zero, an unparseable `created_at` on the estate's oldest alert would report it as its newest —
    // the one direction of error that turns a finding into a clean bill.
    const records = [alert("critical", "not a date"), alert("high", "2026-09-04T00:00:00Z")];

    expect(severeAlertAge(records, NOW)).toBe(10);
  });

  it("should ignore a record whose shape it cannot read", () => {
    expect(severeAlertAge(["nonsense", alert("high", "2026-09-04T00:00:00Z")], NOW)).toBe(10);
  });

  it("should fold the severity's case, GitHub's own words having varied", () => {
    expect(severeAlertAge([alert("CRITICAL", "2026-09-04T00:00:00Z")], NOW)).toBe(10);
  });
});

describe("assuranceQuery", () => {
  it("should carry repository names as variables and never as document text", () => {
    // Verbatim from `ownershipFilesQuery` and for its reason: a name reaching a document as text is an injection
    // surface, small and not zero, and as a variable it cannot be read as syntax at all.
    const document = assuranceQuery(3);

    expect(document).toContain("$r0: String!");
    expect(document).toContain("repository(owner: $organization, name: $r2)");
    expect(document).not.toContain("hmcts/");
  });

  it("should echo the name back, so a mis-aliased answer can be caught", () => {
    expect(assuranceQuery(1)).toContain("name");
  });

  it("should ask for every update-configuration path", () => {
    const document = assuranceQuery(1);

    for (const path of UpdateConfigurationPaths) {
      expect(document).toContain(`HEAD:${path}`);
    }
  });

  it("should ask only whether the file exists, never for its contents", () => {
    // `__typename` rather than `text`: the question is presence, and fetching the bytes would pay for a blob
    // nothing reads — 1,880 repositories times three paths.
    expect(assuranceQuery(1)).not.toContain("text");
    expect(assuranceQuery(1)).toContain("__typename");
  });

  it("should build one document per batch size and reuse it, the text depending on nothing else", () => {
    expect(assuranceQuery(DefaultAssuranceBatchSize)).toBe(assuranceQuery(DefaultAssuranceBatchSize));
  });
});

describe("collectAssuranceSignals", () => {
  /** One repository's aliased answer, with whichever update-configuration paths are present. */
  function entry(name: string, options: { alerts?: boolean | null; configured?: number[] } = {}): Record<string, unknown> {
    const files: Record<string, unknown> = {};
    for (const at of UpdateConfigurationPaths.keys()) {
      files[`c${at}`] = (options.configured ?? []).includes(at) ? { __typename: "Blob" } : null;
    }
    // `??` would turn a deliberate `null` — GitHub naming no answer — into `true`, which is the very case one of
    // these tests is about.
    return { name, hasVulnerabilityAlertsEnabled: "alerts" in options ? options.alerts : true, ...files };
  }

  it("should read both GraphQL-only signals for every repository in one document", () => {
    const { fetch, sent } = replying({ body: { data: { a0: entry("alpha", { configured: [0] }), a1: entry("beta", { alerts: false }) } } });

    return collectAssuranceSignals(client(fetch), "hmcts", ["alpha", "beta"], 2).then((signals) => {
      expect(signals.get("alpha")).toEqual({ vulnerabilityAlerts: true, updateConfiguration: true });
      expect(signals.get("beta")).toEqual({ vulnerabilityAlerts: false, updateConfiguration: false });
      // ONE round trip for both, which is the difference between 38 documents and 1,880 requests.
      expect(sent).toHaveLength(1);
    });
  });

  it("should count any of the update-configuration paths as configured", () => {
    // Renovate is the platform's standard and Dependabot is GitHub's default. Reading only `dependabot.yml` would
    // report every Renovate-managed repository as having no update tooling, which here is most of them.
    const { fetch } = replying({ body: { data: { a0: entry("alpha", { configured: [UpdateConfigurationPaths.length - 1] }) } } });

    return collectAssuranceSignals(client(fetch), "hmcts", ["alpha"], 1).then((signals) => {
      expect(signals.get("alpha")?.updateConfiguration).toBe(true);
    });
  });

  it("should re-read a failing batch one repository at a time", () => {
    // GitHub answers a document naming one unreadable repository with errors beside partial data, which the client
    // raises. Without the retry, one archived-and-transferred name records "nobody could look" for the 49 beside
    // it. Verbatim from `readOwnershipBatch`, whose comment records the same measurement.
    const { fetch, sent } = replying(
      { body: { data: { a0: entry("alpha"), a1: null }, errors: [{ message: "Could not resolve to a Repository" }] } },
      { body: { data: { a0: entry("alpha") } } },
      REFUSED
    );

    return collectAssuranceSignals(client(fetch), "hmcts", ["alpha", "gone"], 2).then((signals) => {
      expect(signals.get("alpha")).toEqual({ vulnerabilityAlerts: true, updateConfiguration: false });
      // The unreadable one is ABSENT rather than recorded as having its tooling off.
      expect(signals.has("gone")).toBe(false);
      expect(sent).toHaveLength(3);
    });
  });

  it("should refuse an answer echoing a repository it did not ask for", () => {
    // The one check that guards the aliasing scheme: `a0` must be the repository `$r0` named, or the batch has been
    // read off by one and every signal in it belongs to the wrong repository.
    const { fetch } = replying({ body: { data: { a0: entry("somebody-else") } } });

    return collectAssuranceSignals(client(fetch), "hmcts", ["alpha"], 1).then((signals) => {
      expect(signals.has("alpha")).toBe(false);
    });
  });

  it("should leave the alerts flag absent where GitHub sent none, keeping the file answer", () => {
    const { fetch } = replying({ body: { data: { a0: entry("alpha", { alerts: null }) } } });

    return collectAssuranceSignals(client(fetch), "hmcts", ["alpha"], 1).then((signals) => {
      expect(signals.get("alpha")).toEqual({ updateConfiguration: false });
    });
  });

  it("should ask for nothing when given no repositories", () => {
    const { fetch, sent } = replying();

    return collectAssuranceSignals(client(fetch), "hmcts", [], 5).then(() => {
      expect(sent).toEqual([]);
    });
  });
});

describe("readDependabotAlerts", () => {
  it("should return the open alert records, which the patching age is read from", () => {
    const { fetch } = replying({ body: [{ created_at: "2026-09-01T00:00:00Z", security_advisory: { severity: "high" } }] });

    return readDependabotAlerts(client(fetch), "hmcts", "alpha").then((records) => {
      expect(records).toHaveLength(1);
    });
  });

  it("should report a refused or disabled family as UNREAD rather than as no alerts", () => {
    // The distinction that keeps `severeAlertsRead` honest: "Dependabot is not enabled here" is not "no critical
    // alert is open", and the column must not read as a pass for a repository with no scanner.
    const { fetch } = replying(REFUSED);

    return readDependabotAlerts(client(fetch), "hmcts", "alpha").then((records) => {
      expect(records).toBeUndefined();
    });
  });
});

describe("assuranceEvidence", () => {
  it("should join the three sources into one evidence block", () => {
    const metadata = { security_and_analysis: { secret_scanning: { status: "enabled" } } };
    const alerts = [{ created_at: "2026-09-04T00:00:00Z", security_advisory: { severity: "critical" } }];

    expect(assuranceEvidence(metadata, { vulnerabilityAlerts: true, updateConfiguration: false }, alerts, NOW)).toEqual({
      hygiene: { secretScanning: true, vulnerabilityAlerts: true, updateConfiguration: false },
      oldestSevereAlertDays: 10,
      severeAlertsRead: true
    });
  });

  it("should record that the alerts were unread where the family could not be listed", () => {
    const evidence = assuranceEvidence({}, undefined, undefined, NOW);

    expect(evidence.severeAlertsRead).toBe(false);
    expect(evidence.oldestSevereAlertDays).toBeUndefined();
  });

  it("should record the alerts as read with no age where nothing severe is open", () => {
    // The pair that separates "read, and clean" from "nobody could look" — both leave the age absent, and only
    // this flag tells them apart.
    const evidence = assuranceEvidence({}, undefined, [], NOW);

    expect(evidence.severeAlertsRead).toBe(true);
    expect(evidence.oldestSevereAlertDays).toBeUndefined();
  });
});
