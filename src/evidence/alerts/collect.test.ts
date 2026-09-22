import { beforeEach, describe, expect, it, vi } from "vitest";
import { AlertFamily, AlertScanState } from "../domain/alert-detail.ts";
import type { SecurityAlertEvidence } from "../domain/security-alerts.ts";
import { FEATURE_NOT_ENABLED } from "../domain/security-alerts.ts";
import { createGitHubClient } from "../github/client.ts";
import { personalAccessToken } from "../github/credentials.ts";
import { type AlertWalk, collectOrganisationAlerts, familyCoverage, resolveAlertScan, resolveAlertScans } from "./collect.ts";

/**
 * Walking each family's organisation-wide endpoint, and reading a repository's absence from the response.
 *
 * The absence is what these cases are mostly about. The walk itself is a loop over pages; what can be wrong is what
 * a repository the response did not mention is reported as, and there are three right answers and one very wrong one.
 */

interface Reply {
  status?: number;
  body?: unknown;
  link?: string;
}

function replying(replies: Reply[], asked: string[] = []): typeof globalThis.fetch {
  const queue = [...replies];
  return vi.fn((url: string) => {
    asked.push(String(url));
    const next = queue.shift() ?? { status: 200, body: [] };
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (next.link !== undefined) {
      headers.link = next.link;
    }
    return Promise.resolve(new Response(JSON.stringify(next.body ?? []), { status: next.status ?? 200, headers }));
  }) as unknown as typeof globalThis.fetch;
}

function client(fetch: typeof globalThis.fetch) {
  return createGitHubClient({ credentials: personalAccessToken("ghp_test"), fetch, pause: () => Promise.resolve(), clock: () => 1000 });
}

function secretAlert(repository: string, number: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number,
    state: "open",
    secret_type: "azure_storage_account_key",
    secret: "ghp_neverStoredAnywhere0123456789abcd",
    created_at: "2026-01-01T00:00:00Z",
    html_url: `https://github.com/hmcts/${repository}/security/secret-scanning/${number}`,
    first_location_detected: { path: "values.yaml", start_line: 3 },
    repository: { name: repository, full_name: `hmcts/${repository}` },
    ...overrides
  };
}

/** A count block whose named family was read, which is what turns an absence from the walk into a clean answer. */
function counted(family: keyof SecurityAlertEvidence, count: number): SecurityAlertEvidence {
  const empty = { dependabot: {}, codeScanning: {}, secretScanning: {} };
  return { ...empty, [family]: { open: count, bySeverity: {} } };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

describe("collectOrganisationAlerts", () => {
  it("should key every alert by its repository when the walk succeeds", async () => {
    const fetch = replying([{ body: [secretAlert("alpha", 1), secretAlert("beta", 2), secretAlert("alpha", 3)] }]);

    const walk = await collectOrganisationAlerts(client(fetch), "hmcts", AlertFamily.SecretScanning);

    expect(walk.byRepository?.get("alpha")).toHaveLength(2);
    expect(walk.byRepository?.get("beta")).toHaveLength(1);
  });

  it("should fold every page of a paginated walk into one answer", async () => {
    const fetch = replying([
      { body: [secretAlert("alpha", 1)], link: '<https://api.github.com/orgs/hmcts/secret-scanning/alerts?page=2>; rel="next"' },
      { body: [secretAlert("alpha", 2)] }
    ]);

    const walk = await collectOrganisationAlerts(client(fetch), "hmcts", AlertFamily.SecretScanning);

    expect(walk.byRepository?.get("alpha")).toHaveLength(2);
  });

  it("should key the map on the casefolded name, so a differently-spelled cohort still matches", async () => {
    // GitHub names are case-insensitive, and a miss here would report a repository that has alerts as clean.
    const fetch = replying([{ body: [secretAlert("CVP-Audio-Ingress", 1)] }]);

    const walk = await collectOrganisationAlerts(client(fetch), "hmcts", AlertFamily.SecretScanning);

    expect(walk.byRepository?.has("cvp-audio-ingress")).toBe(true);
  });

  it("should never carry a secret value out of the walk", async () => {
    const fetch = replying([{ body: [secretAlert("alpha", 1)] }]);

    const walk = await collectOrganisationAlerts(client(fetch), "hmcts", AlertFamily.SecretScanning);

    expect(JSON.stringify([...(walk.byRepository ?? [])])).not.toContain("ghp_neverStoredAnywhere0123456789abcd");
  });

  it("should report an empty map when the estate genuinely has no alerts of a family", async () => {
    const walk = await collectOrganisationAlerts(client(replying([{ body: [] }])), "hmcts", AlertFamily.CodeScanning);

    // EMPTY AND NOT UNDEFINED. Something looked, and the answer is none.
    expect(walk.byRepository?.size).toBe(0);
    expect(walk.detail).toBeUndefined();
  });

  it("should report no map at all when the walk itself was refused", async () => {
    const walk = await collectOrganisationAlerts(
      client(replying([{ status: 403, body: { message: "Resource not accessible" } }])),
      "hmcts",
      AlertFamily.Dependabot
    );

    // The distinction the whole feature rests on: `undefined`, so every repository reads unmeasured rather than clean.
    expect(walk.byRepository).toBeUndefined();
    expect(walk.detail).toContain("could not be read for the organisation");
  });

  it("should count a record it cannot attribute rather than failing the estate for it", async () => {
    const fetch = replying([{ body: [secretAlert("alpha", 1), { number: 9, repository: null }, "not a record"] }]);

    const walk = await collectOrganisationAlerts(client(fetch), "hmcts", AlertFamily.SecretScanning);

    expect(walk.unattributable).toBe(2);
    expect(walk.byRepository?.get("alpha")).toHaveLength(1);
  });

  it("should ask for open Dependabot alerts only, because every state is 503 pages against 296", async () => {
    const asked: string[] = [];

    await collectOrganisationAlerts(client(replying([{ body: [] }], asked)), "hmcts", AlertFamily.Dependabot);

    expect(asked.join()).toContain("state=open");
  });

  it.each([
    [AlertFamily.SecretScanning, "secret-scanning"],
    [AlertFamily.CodeScanning, "code-scanning"]
  ])("should ask for every state of %s, because the resolution exists nowhere else", async (family, path) => {
    const asked: string[] = [];

    await collectOrganisationAlerts(client(replying([{ body: [] }], asked)), "hmcts", family);

    // Unfiltered, so a resolved alert arrives with the `resolution` GitHub reports nowhere else.
    expect(asked.join()).toContain(`/orgs/hmcts/${path}/alerts`);
    expect(asked.join()).not.toContain("state=");
  });
});

describe("resolveAlertScan", () => {
  function walkOf(entries: Record<string, number>): AlertWalk {
    const byRepository = new Map(
      Object.entries(entries).map(([repository, count]) => [
        repository,
        Array.from({ length: count }, (_unused, index) => ({ repository, family: AlertFamily.SecretScanning, number: index + 1 }))
      ])
    );
    return { family: AlertFamily.SecretScanning, byRepository, unattributable: 0 };
  }

  it("should report read with the alerts when the walk named the repository", () => {
    const scan = resolveAlertScan("alpha", walkOf({ alpha: 2 }), new Map());

    expect(scan.state).toBe(AlertScanState.Read);
    expect(scan.alerts).toHaveLength(2);
    expect(scan.detail).toBeUndefined();
  });

  it("should report read whatever the count block says, because something found those alerts", () => {
    // Named in the response beats every other signal: alerts exist, so something scanned. `organisationAnswer`
    // decides the counts the same way.
    const counts = new Map([["alpha", { dependabot: {}, codeScanning: {}, secretScanning: { detail: `secret-scanning ${FEATURE_NOT_ENABLED}` } }]]);

    expect(resolveAlertScan("alpha", walkOf({ alpha: 1 }), counts).state).toBe(AlertScanState.Read);
  });

  it("should report read and clean when the walk named nothing and the counts say the family was read", () => {
    const counts = new Map([["alpha", counted("secretScanning", 0)]]);

    const scan = resolveAlertScan("alpha", walkOf({ beta: 1 }), counts);

    // THE MEASURED ZERO. A scan row with no alerts, which is the answer this table exists to be able to give.
    expect(scan.state).toBe(AlertScanState.Read);
    expect(scan.alerts).toHaveLength(0);
    expect(scan.detail).toBeUndefined();
  });

  it("should report not enabled when the counts say the feature is off here", () => {
    const counts = new Map([["alpha", { dependabot: {}, codeScanning: {}, secretScanning: { detail: `secret-scanning/alerts ${FEATURE_NOT_ENABLED}` } }]]);

    const scan = resolveAlertScan("alpha", walkOf({ beta: 1 }), counts);

    expect(scan.state).toBe(AlertScanState.NotEnabled);
    expect(scan.detail).toContain(FEATURE_NOT_ENABLED);
  });

  it("should report unmeasured when nothing says whether the family is even on", () => {
    const scan = resolveAlertScan("alpha", walkOf({ beta: 1 }), new Map());

    expect(scan.state).toBe(AlertScanState.Unmeasured);
    expect(scan.alerts).toHaveLength(0);
    expect(scan.detail).toContain("has not been collected");
  });

  it("should report unmeasured for every repository when the walk itself was refused", () => {
    // The case VIBE-590 makes the most likely one. A refused walk must not turn an estate with no stored counts
    // into an estate that was read and found clean.
    const refused: AlertWalk = { family: AlertFamily.SecretScanning, unattributable: 0, detail: "secret-scanning could not be read for the organisation" };
    const counts = new Map([["alpha", counted("secretScanning", 4)]]);

    const scan = resolveAlertScan("alpha", refused, counts);

    expect(scan.state).toBe(AlertScanState.Unmeasured);
    expect(scan.detail).toBe("secret-scanning could not be read for the organisation");
  });

  it("should match a cohort name against the walk whatever the case either spelled it in", () => {
    const walk: AlertWalk = {
      family: AlertFamily.SecretScanning,
      byRepository: new Map([["cvp-audio-ingress", [{ repository: "CVP-Audio-Ingress", family: AlertFamily.SecretScanning, number: 1 }]]]),
      unattributable: 0
    };

    const scan = resolveAlertScan("CVP-Audio-Ingress", walk, new Map());

    expect(scan.state).toBe(AlertScanState.Read);
    // Stored as the cohort spelled it, so the row joins to `repository_state` and `org_repository`.
    expect(scan.repository).toBe("CVP-Audio-Ingress");
  });

  it("should read the counts casefolded too, so a stored spelling cannot hide a clean answer", () => {
    const counts = new Map([["alpha", counted("secretScanning", 0)]]);

    expect(resolveAlertScan("Alpha", walkOf({}), counts).state).toBe(AlertScanState.Read);
  });
});

describe("resolveAlertScans", () => {
  const emptyWalk = (family: AlertFamily): AlertWalk => ({ family, byRepository: new Map(), unattributable: 0 });

  it("should write one scan per cohort repository per family walked", () => {
    const scans = resolveAlertScans(["alpha", "beta"], [emptyWalk(AlertFamily.SecretScanning), emptyWalk(AlertFamily.Dependabot)], new Map());

    expect(scans).toHaveLength(4);
    expect(scans.filter((scan) => scan.repository === "alpha").map((scan) => scan.family)).toEqual([AlertFamily.SecretScanning, AlertFamily.Dependabot]);
  });

  it("should write a row for a repository with no alerts, because no row would mean nobody looked", () => {
    const scans = resolveAlertScans(["alpha"], [emptyWalk(AlertFamily.SecretScanning)], new Map([["alpha", counted("secretScanning", 0)]]));

    expect(scans).toEqual([{ repository: "alpha", family: AlertFamily.SecretScanning, state: AlertScanState.Read, alerts: [] }]);
  });

  it("should drop an alert against a repository the cohort does not include", () => {
    // The cohort is the universe. An alert on an archived or excluded repository has no row to hang off.
    const walk: AlertWalk = {
      family: AlertFamily.SecretScanning,
      byRepository: new Map([["gamma", [{ repository: "gamma", family: AlertFamily.SecretScanning, number: 1 }]]]),
      unattributable: 0
    };

    const scans = resolveAlertScans(["alpha"], [walk], new Map());

    expect(scans.map((scan) => scan.repository)).toEqual(["alpha"]);
  });

  it("should write nothing for a family that was not walked at all", () => {
    expect(resolveAlertScans(["alpha"], [], new Map())).toEqual([]);
  });
});

describe("familyCoverage", () => {
  const scans = [
    {
      repository: "alpha",
      family: AlertFamily.SecretScanning,
      state: AlertScanState.Read,
      alerts: [{ repository: "alpha", family: AlertFamily.SecretScanning, number: 1 }]
    },
    { repository: "beta", family: AlertFamily.SecretScanning, state: AlertScanState.Read, alerts: [] },
    { repository: "gamma", family: AlertFamily.SecretScanning, state: AlertScanState.NotEnabled, alerts: [] },
    { repository: "delta", family: AlertFamily.SecretScanning, state: AlertScanState.Unmeasured, alerts: [] },
    { repository: "alpha", family: AlertFamily.Dependabot, state: AlertScanState.Read, alerts: [] }
  ];

  it("should count the three states and the alerts separately for one family", () => {
    expect(familyCoverage(AlertFamily.SecretScanning, scans)).toEqual({
      family: AlertFamily.SecretScanning,
      withAlerts: 1,
      clean: 1,
      notEnabled: 1,
      unmeasured: 1,
      alerts: 1
    });
  });

  it("should never fold a refusal into the clean count", () => {
    // The whole reason the run reports four numbers rather than two: a reader shown "3 clean" for an estate where
    // one of them was unreadable has been told something false.
    const coverage = familyCoverage(AlertFamily.SecretScanning, scans);

    expect(coverage.clean).toBe(1);
    expect(coverage.clean + coverage.withAlerts + coverage.notEnabled + coverage.unmeasured).toBe(4);
  });

  it("should count only the family asked for", () => {
    expect(familyCoverage(AlertFamily.Dependabot, scans).clean).toBe(1);
  });

  it("should report zeroes for a family with no scans, rather than throwing", () => {
    expect(familyCoverage(AlertFamily.CodeScanning, scans)).toEqual({
      family: AlertFamily.CodeScanning,
      withAlerts: 0,
      clean: 0,
      notEnabled: 0,
      unmeasured: 0,
      alerts: 0
    });
  });
});
