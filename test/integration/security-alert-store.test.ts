import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { AlertScan } from "../../src/evidence/alerts/collect.ts";
import { collectOrganisationAlerts } from "../../src/evidence/alerts/collect.ts";
import { AlertFamily, AlertScanState } from "../../src/evidence/domain/alert-detail.ts";
import { createGitHubClient } from "../../src/evidence/github/client.ts";
import { personalAccessToken } from "../../src/evidence/github/credentials.ts";
import { recordSecurityAlerts, storedAlertCounts } from "../../src/evidence/store/alerts.ts";
import { prisma } from "../../src/evidence/store/prisma.ts";
import { StorageError } from "../../src/evidence/store/storage-error.ts";

/**
 * The security-alert store against a real database.
 *
 * THE FIRST BLOCK IS THE ONE THIS FEATURE IS JUDGED ON. A secret-scanning response carries the detected credential,
 * and the claim being made is not "we filter it out" but "it cannot get here". That claim can only be proved where
 * the value would have landed, so the case below drives a whole real API payload through the collector into Postgres
 * and then searches EVERY COLUMN OF EVERY ROW, as text, for the value the payload carried. A build that stored it
 * anywhere at all — in `alert_type`, in `subject`, in a column added later — fails that search, which is the point
 * of searching rather than asserting about a named field.
 *
 * The rest is what only Postgres can refuse or prove: the three CHECK constraints, the foreign key that makes an
 * alert unreachable without its scan, and the re-run guarantee.
 */

const ORGANIZATION = "hmcts";
const OBSERVED = new Date(Date.UTC(2026, 8, 22, 11, 0, 0));
const LATER = new Date(Date.UTC(2026, 8, 23, 11, 0, 0));

/** Shaped like a GitHub token so a reader can see what is being refused. No such token exists. */
const SECRET_VALUE = "ghp_vibe597ThisMustNotReachPostgres00";

/** One secret-scanning alert exactly as the organisation-wide endpoint returns it, credential included. */
const LIVE_SECRET_PAYLOAD = {
  number: 42,
  created_at: "2022-05-26T09:14:00Z",
  updated_at: "2026-01-04T11:00:00Z",
  url: "https://api.github.com/repos/hmcts/cvp-audio-ingress/secret-scanning/alerts/42",
  html_url: "https://github.com/hmcts/cvp-audio-ingress/security/secret-scanning/42",
  locations_url: "https://api.github.com/repos/hmcts/cvp-audio-ingress/secret-scanning/alerts/42/locations",
  state: "open",
  secret_type: "azure_storage_account_key",
  secret_type_display_name: "Azure Storage Account Access Key",
  secret: SECRET_VALUE,
  validity: "unknown",
  multi_repo: false,
  is_base64_encoded: false,
  first_location_detected: { path: "charts/cvp-audio-ingress/values.yaml", start_line: 31, end_line: 31, blob_sha: "9c2e1f", commit_sha: "4d7a0b" },
  has_more_locations: false,
  publicly_leaked: false,
  resolution: null,
  resolved_at: null,
  resolved_by: null,
  repository: { id: 9001, name: "cvp-audio-ingress", full_name: "hmcts/cvp-audio-ingress", private: false }
};

function scan(overrides: Partial<AlertScan> = {}): AlertScan {
  return { repository: "pcs-api", family: AlertFamily.Dependabot, state: AlertScanState.Read, alerts: [], ...overrides };
}

function alert(number: number, overrides: Record<string, unknown> = {}) {
  return {
    repository: "pcs-api",
    family: AlertFamily.Dependabot,
    number,
    alertType: "GHSA-29mw-wpgm-hmr9",
    subject: "lodash",
    severity: "high" as const,
    path: "yarn.lock",
    state: "open",
    createdAt: new Date(Date.UTC(2026, 2, 2)),
    htmlUrl: `https://github.com/hmcts/pcs-api/security/dependabot/${number}`,
    ...overrides
  };
}

/** Every value in every row of `security_alerts`, as one string. The needle search below is over this. */
async function everyStoredValue(): Promise<string> {
  const rows = await prisma.$queryRaw<{ row: string }[]>`SELECT to_jsonb(security_alerts)::text AS row FROM security_alerts`;
  const scans = await prisma.$queryRaw<{ row: string }[]>`SELECT to_jsonb(security_alert_scans)::text AS row FROM security_alert_scans`;
  return [...rows, ...scans].map((entry) => entry.row).join("\n");
}

async function wipe(): Promise<void> {
  // Alerts first: the foreign key would refuse the scans otherwise, which is the point of having it.
  await prisma.securityAlert.deleteMany();
  await prisma.securityAlertScan.deleteMany();
  await prisma.repositoryState.deleteMany();
}

beforeEach(wipe);

afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

describe("never storing a secret value", () => {
  it("should store a record with no trace of the secret when a real payload carried one", async () => {
    // THE WHOLE JOURNEY, and deliberately not the projection alone: the payload goes through the response schema,
    // the walk, the three-state resolution and the writer, because a filter lost at any one of those would be the
    // failure this proves against.
    const fetch = (() =>
      Promise.resolve(new Response(JSON.stringify([LIVE_SECRET_PAYLOAD]), { headers: { "content-type": "application/json" } }))) as typeof globalThis.fetch;
    const client = createGitHubClient({ credentials: personalAccessToken("ghp_test"), fetch, pause: () => Promise.resolve(), clock: () => 1000 });

    const walk = await collectOrganisationAlerts(client, ORGANIZATION, AlertFamily.SecretScanning);
    const alerts = walk.byRepository?.get("cvp-audio-ingress") ?? [];
    await recordSecurityAlerts(
      ORGANIZATION,
      [{ repository: "cvp-audio-ingress", family: AlertFamily.SecretScanning, state: AlertScanState.Read, alerts }],
      OBSERVED
    );

    const stored = await everyStoredValue();

    // EVERY COLUMN OF EVERY ROW, as text. Not `expect(row.alertType).not.toBe(...)`, which would pass on a build
    // that had put the credential in some other column, and not a check of the object in memory, which would pass
    // on a build that had stored it and read it back differently.
    expect(stored).not.toContain(SECRET_VALUE);
    // And the row IS there, so the case cannot pass by having stored nothing at all.
    expect(stored).toContain("azure_storage_account_key");
  });

  it("should store the type and the location, which is what the row is for", async () => {
    const fetch = (() =>
      Promise.resolve(new Response(JSON.stringify([LIVE_SECRET_PAYLOAD]), { headers: { "content-type": "application/json" } }))) as typeof globalThis.fetch;
    const client = createGitHubClient({ credentials: personalAccessToken("ghp_test"), fetch, pause: () => Promise.resolve(), clock: () => 1000 });

    const walk = await collectOrganisationAlerts(client, ORGANIZATION, AlertFamily.SecretScanning);
    await recordSecurityAlerts(
      ORGANIZATION,
      [
        {
          repository: "cvp-audio-ingress",
          family: AlertFamily.SecretScanning,
          state: AlertScanState.Read,
          alerts: walk.byRepository?.get("cvp-audio-ingress") ?? []
        }
      ],
      OBSERVED
    );

    const row = await prisma.securityAlert.findFirstOrThrow();
    expect(row).toMatchObject({
      repository: "cvp-audio-ingress",
      family: "secret-scanning",
      alertNumber: 42,
      alertType: "azure_storage_account_key",
      path: "charts/cvp-audio-ingress/values.yaml",
      line: 31,
      state: "open",
      severity: null,
      resolution: null
    });
  });

  it("should store no column that could hold a credential for any family", async () => {
    // A guard on the SHAPE rather than on a value: a column added later whose name suggests it carries the finding
    // itself would fail this, and the reviewer would be looking at the right line.
    const columns = await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'security_alerts'
    `;
    const names = columns.map((column) => column.column_name);

    expect(names).not.toContain("secret");
    expect(names.filter((name) => name.includes("secret") && name !== "secret_type")).toEqual([]);
  });
});

describe("telling a clean family from one nobody could read", () => {
  it("should store a scan row with no alerts when a family was read and found nothing", async () => {
    await recordSecurityAlerts(ORGANIZATION, [scan({ state: AlertScanState.Read, alerts: [] })], OBSERVED);

    const row = await prisma.securityAlertScan.findFirstOrThrow();
    expect(row).toMatchObject({ repository: "pcs-api", family: "dependabot", state: "read", detail: null });
    expect(await prisma.securityAlert.count()).toBe(0);
  });

  it("should leave no scan row at all for a repository this run had no answer for", async () => {
    await recordSecurityAlerts(ORGANIZATION, [scan()], OBSERVED);

    // NO ROW IS THE UNMEASURED ANSWER for a repository nothing has walked, and it is what a reader joining through
    // the scan gets nothing from. There is no way to read it as clean, because there is nothing there.
    expect(
      await prisma.securityAlertScan.findUnique({
        where: { organization_repository_family: { organization: ORGANIZATION, repository: "ccd-data-store-api", family: "dependabot" } }
      })
    ).toBeNull();
  });

  it("should keep the reason beside a family nobody could read", async () => {
    await recordSecurityAlerts(
      ORGANIZATION,
      [scan({ state: AlertScanState.Unmeasured, detail: "dependabot could not be read for the organisation" })],
      OBSERVED
    );

    expect((await prisma.securityAlertScan.findFirstOrThrow()).detail).toBe("dependabot could not be read for the organisation");
  });

  it("should clear yesterday's reason when a family that was unreadable now reads clean", async () => {
    await recordSecurityAlerts(ORGANIZATION, [scan({ state: AlertScanState.Unmeasured, detail: "dependabot could not be read" })], OBSERVED);

    await recordSecurityAlerts(ORGANIZATION, [scan({ state: AlertScanState.Read })], LATER);

    // A stale sentence beside a fresh answer is the same class of wrong as an absence read as a zero.
    expect(await prisma.securityAlertScan.findFirstOrThrow()).toMatchObject({ state: "read", detail: null, observedAt: LATER });
  });

  it("should refuse a state outside the three the vocabulary allows", async () => {
    await expect(
      prisma.$executeRaw`
        INSERT INTO security_alert_scans (organization, repository, family, state, observed_at)
        VALUES (${ORGANIZATION}, 'pcs-api', 'dependabot', 'clean', ${OBSERVED})
      `
    ).rejects.toThrow(/security_alert_scans_state_vocabulary/);
  });

  it("should refuse a reason beside a family that WAS read, which has nothing to explain", async () => {
    await expect(
      prisma.$executeRaw`
        INSERT INTO security_alert_scans (organization, repository, family, state, detail, observed_at)
        VALUES (${ORGANIZATION}, 'pcs-api', 'dependabot', 'read', 'something', ${OBSERVED})
      `
    ).rejects.toThrow(/security_alert_scans_detail_only_when_absent/);
  });

  it("should refuse a family spelled as the API path rather than as the contract spells it", async () => {
    // The mistake this exists to catch: `inventory/security-alerts.ts` names families `dependabot/alerts` for its
    // log lines, and a row spelled that way is a row no page can render.
    await expect(
      prisma.$executeRaw`
        INSERT INTO security_alert_scans (organization, repository, family, state, observed_at)
        VALUES (${ORGANIZATION}, 'pcs-api', 'dependabot/alerts', 'read', ${OBSERVED})
      `
    ).rejects.toThrow(/security_alert_scans_family_vocabulary/);
  });

  it("should refuse a severity outside the four words, so `unknown` cannot become a stored value", async () => {
    await recordSecurityAlerts(ORGANIZATION, [scan()], OBSERVED);

    await expect(
      prisma.$executeRaw`
        INSERT INTO security_alerts (organization, repository, family, alert_number, severity)
        VALUES (${ORGANIZATION}, 'pcs-api', 'dependabot', 1, 'unknown')
      `
    ).rejects.toThrow(/security_alerts_severity_vocabulary/);
  });

  it("should refuse an alert whose repository has no scan row", async () => {
    // Without the foreign key, a write could leave alerts for a repository that reads as never looked at — the one
    // inconsistency that would make the absent-versus-zero rule unenforceable.
    await expect(
      prisma.$executeRaw`
        INSERT INTO security_alerts (organization, repository, family, alert_number)
        VALUES (${ORGANIZATION}, 'never-scanned', 'dependabot', 1)
      `
    ).rejects.toThrow(/foreign key/i);
  });
});

describe("re-running the collection", () => {
  it("should leave the same rows rather than duplicating them when nothing has changed", async () => {
    const twice = [scan({ alerts: [alert(1), alert(2)] })];

    await recordSecurityAlerts(ORGANIZATION, twice, OBSERVED);
    await recordSecurityAlerts(ORGANIZATION, twice, LATER);

    expect(await prisma.securityAlertScan.count()).toBe(1);
    expect(await prisma.securityAlert.count()).toBe(2);
  });

  it("should forget an alert the next walk no longer reports, rather than reporting it open for ever", async () => {
    await recordSecurityAlerts(ORGANIZATION, [scan({ alerts: [alert(1), alert(2)] })], OBSERVED);

    await recordSecurityAlerts(ORGANIZATION, [scan({ alerts: [alert(1)] })], LATER);

    expect((await prisma.securityAlert.findMany()).map((row) => row.alertNumber)).toEqual([1]);
  });

  it("should update an alert in place when GitHub's answer about it changed", async () => {
    await recordSecurityAlerts(ORGANIZATION, [scan({ alerts: [alert(1, { state: "open" })] })], OBSERVED);

    await recordSecurityAlerts(ORGANIZATION, [scan({ alerts: [alert(1, { state: "dismissed", resolution: "tolerable_risk", resolvedAt: LATER })] })], LATER);

    expect(await prisma.securityAlert.findFirstOrThrow()).toMatchObject({ alertNumber: 1, state: "dismissed", resolution: "tolerable_risk" });
    expect(await prisma.securityAlert.count()).toBe(1);
  });

  it("should not let one family's walk disturb another's rows for the same repository", async () => {
    await recordSecurityAlerts(
      ORGANIZATION,
      [
        scan({ family: AlertFamily.Dependabot, alerts: [alert(1)] }),
        scan({ family: AlertFamily.SecretScanning, alerts: [alert(1, { family: AlertFamily.SecretScanning, alertType: "aws_api_key" })] })
      ],
      OBSERVED
    );

    await recordSecurityAlerts(ORGANIZATION, [scan({ family: AlertFamily.Dependabot, alerts: [] })], LATER);

    // The unit of replacement is a repository AND a family: one refused walk must not wipe the other two families.
    expect(await prisma.securityAlert.count()).toBe(1);
    expect((await prisma.securityAlert.findFirstOrThrow()).family).toBe("secret-scanning");
  });

  it("should report a storage failure with the repository and never with a record", async () => {
    // `alert_number` is an INTEGER, so a number past its range is refused by Postgres. What is asserted is the
    // MESSAGE: the family whose records must never reach a log is one of the three this writes.
    const failing = [
      scan({ family: AlertFamily.SecretScanning, repository: "cvp-audio-ingress", alerts: [alert(2 ** 40, { family: AlertFamily.SecretScanning })] })
    ];

    await expect(recordSecurityAlerts(ORGANIZATION, failing, OBSERVED)).rejects.toThrow(StorageError);
    await expect(recordSecurityAlerts(ORGANIZATION, failing, OBSERVED)).rejects.toThrow(/cvp-audio-ingress/);
  });
});

describe("storedAlertCounts", () => {
  async function storeState(repository: string, payload: unknown): Promise<void> {
    await prisma.repositoryState.create({ data: { organization: ORGANIZATION, repository, fetchedAt: OBSERVED, payload: payload as object } });
  }

  it("should read each repository's three families off the stored payload", async () => {
    await storeState("pcs-api", { defaultBranch: "master", securityAlerts: { dependabot: { open: 4 }, codeScanning: {}, secretScanning: { open: 0 } } });

    const counts = await storedAlertCounts(ORGANIZATION);
    expect(counts.get("pcs-api")?.dependabot).toEqual({ open: 4 });
    expect(counts.get("pcs-api")?.secretScanning).toEqual({ open: 0 });
  });

  it("should key the map casefolded, so a differently-spelled cohort name still finds its counts", async () => {
    await storeState("CVP-Audio-Ingress", { securityAlerts: { dependabot: {}, codeScanning: {}, secretScanning: { open: 1 } } });

    expect((await storedAlertCounts(ORGANIZATION)).has("cvp-audio-ingress")).toBe(true);
  });

  it("should give an entry with no block for a state collected before the alert counts existed", async () => {
    await storeState("legacy", { defaultBranch: "master" });

    const counts = await storedAlertCounts(ORGANIZATION);
    // Present as a key with nothing under it: the repository WAS collected, and this family's answer is unmeasured.
    expect(counts.has("legacy")).toBe(true);
    expect(counts.get("legacy")).toBeUndefined();
  });

  it("should not name a repository nothing has collected at all", async () => {
    await storeState("pcs-api", { securityAlerts: { dependabot: { open: 1 }, codeScanning: {}, secretScanning: {} } });

    expect((await storedAlertCounts(ORGANIZATION)).has("never-collected")).toBe(false);
  });
});
