import { describe, expect, it } from "vitest";
import { AlertFamily } from "../domain/alert-detail.ts";
import { readCodeScanningAlert, readDependabotAlert, readSecretScanningAlert } from "./records.ts";

/**
 * Reading one alert out of one GitHub record, and — first and at length — proving the credential never survives it.
 *
 * The payloads here are shaped from real organisation-wide responses: the field names, nesting and which of them
 * GitHub leaves null were taken off the live HMCTS installation rather than invented, so a case passing here is a
 * case about the records this collector actually receives.
 */

/**
 * A value that looks like what GitHub would hand back in `secret`, and is unique enough to search a whole row for.
 *
 * Deliberately shaped like a real GitHub token, because that is the thing a reader of the test needs to see is
 * being refused. It is not a credential — no such token exists — and the point of the case is that a string in this
 * position cannot reach anything that persists.
 */
const SECRET_VALUE = "ghp_vibe597NeverStoreThisValue0123456789";

/** One secret-scanning alert as `GET /orgs/{org}/secret-scanning/alerts` returns it, credential included. */
function secretScanningPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 42,
    created_at: "2022-05-26T09:14:00Z",
    updated_at: "2026-01-04T11:00:00Z",
    url: "https://api.github.com/repos/hmcts/cvp-audio-ingress/secret-scanning/alerts/42",
    html_url: "https://github.com/hmcts/cvp-audio-ingress/security/secret-scanning/42",
    locations_url: "https://api.github.com/repos/hmcts/cvp-audio-ingress/secret-scanning/alerts/42/locations",
    state: "open",
    secret_type: "azure_storage_account_key",
    secret_type_display_name: "Azure Storage Account Access Key",
    // THE FIELD THIS WHOLE FILE IS ABOUT. GitHub populates it on every record it returns.
    secret: SECRET_VALUE,
    validity: "unknown",
    multi_repo: false,
    is_base64_encoded: false,
    first_location_detected: {
      path: "charts/cvp-audio-ingress/values.yaml",
      start_line: 31,
      end_line: 31,
      start_column: 24,
      end_column: 112,
      blob_sha: "9c2e1f",
      commit_sha: "4d7a0b"
    },
    has_more_locations: false,
    publicly_leaked: false,
    resolution: null,
    resolved_at: null,
    resolved_by: null,
    repository: { id: 9001, name: "cvp-audio-ingress", full_name: "hmcts/cvp-audio-ingress", private: false },
    ...overrides
  };
}

function dependabotPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 771,
    state: "open",
    dependency: { package: { ecosystem: "npm", name: "lodash" }, manifest_path: "yarn.lock", scope: "runtime" },
    security_advisory: { ghsa_id: "GHSA-29mw-wpgm-hmr9", cve_id: "CVE-2020-8203", severity: "HIGH", summary: "Prototype pollution" },
    security_vulnerability: { package: { ecosystem: "npm", name: "lodash" }, severity: "high" },
    url: "https://api.github.com/repos/hmcts/pcs-api/dependabot/alerts/771",
    html_url: "https://github.com/hmcts/pcs-api/security/dependabot/771",
    created_at: "2026-03-02T08:00:00Z",
    fixed_at: null,
    dismissed_at: null,
    auto_dismissed_at: null,
    dismissed_reason: null,
    repository: { id: 9002, name: "pcs-api", full_name: "hmcts/pcs-api" },
    ...overrides
  };
}

function codeScanningPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 8,
    created_at: "2026-02-11T14:22:00Z",
    html_url: "https://github.com/hmcts/pcs-frontend/security/code-scanning/8",
    state: "open",
    fixed_at: null,
    dismissed_at: null,
    dismissed_reason: null,
    rule: { id: "js/incomplete-sanitization", severity: "warning", security_severity_level: "medium", name: "Incomplete string escaping" },
    tool: { name: "CodeQL" },
    most_recent_instance: {
      ref: "refs/heads/master",
      state: "open",
      commit_sha: "aa11bb",
      location: { path: "src/main/routes/home.ts", start_line: 114, end_line: 114, start_column: 9, end_column: 40 }
    },
    repository: { id: 9003, name: "pcs-frontend", full_name: "hmcts/pcs-frontend" },
    ...overrides
  };
}

describe("readSecretScanningAlert", () => {
  it("should never carry the secret value onto the alert when GitHub returned one", () => {
    const alert = readSecretScanningAlert(secretScanningPayload());

    // FIELD BY FIELD RATHER THAN BY A PROPERTY NAME. Asserting `alert.secret` is undefined would pass on a build
    // that had put the credential in `alertType` or `subject`, so this searches every value the object carries.
    expect(JSON.stringify(alert)).not.toContain(SECRET_VALUE);
    expect(Object.values(alert as unknown as Record<string, unknown>)).not.toContain(SECRET_VALUE);
  });

  it("should not even declare a key for the secret value when GitHub returned one", () => {
    // The structural half of the guarantee: the key is not present with an `undefined` value, it is gone. A schema
    // that had declared it and a projection that had dropped it would differ here, and only one of the two is safe.
    expect(Object.keys(readSecretScanningAlert(secretScanningPayload()) as object)).not.toContain("secret");
  });

  it("should store the secret type and the location, which is what a reader needs to act", () => {
    expect(readSecretScanningAlert(secretScanningPayload())).toEqual({
      repository: "cvp-audio-ingress",
      family: AlertFamily.SecretScanning,
      number: 42,
      alertType: "azure_storage_account_key",
      path: "charts/cvp-audio-ingress/values.yaml",
      line: 31,
      state: "open",
      createdAt: new Date("2022-05-26T09:14:00Z"),
      htmlUrl: "https://github.com/hmcts/cvp-audio-ingress/security/secret-scanning/42"
    });
  });

  it("should carry GitHub's own resolution when the alert is resolved", () => {
    const alert = readSecretScanningAlert(secretScanningPayload({ state: "resolved", resolution: "revoked", resolved_at: "2026-04-01T10:00:00Z" }));

    expect(alert?.state).toBe("resolved");
    expect(alert?.resolution).toBe("revoked");
    expect(alert?.resolvedAt).toEqual(new Date("2026-04-01T10:00:00Z"));
  });

  it("should never grade a secret-scanning alert, because GitHub grades none", () => {
    expect(readSecretScanningAlert(secretScanningPayload())?.severity).toBeUndefined();
  });

  it("should keep the alert when GitHub named no location, because an unlocated leak is still a leak", () => {
    const alert = readSecretScanningAlert(secretScanningPayload({ first_location_detected: null }));

    expect(alert?.number).toBe(42);
    expect(alert?.path).toBeUndefined();
    expect(alert?.line).toBeUndefined();
  });

  it("should keep the alert when GitHub named no secret type", () => {
    expect(readSecretScanningAlert(secretScanningPayload({ secret_type: null }))?.alertType).toBeUndefined();
  });

  it("should skip a record that names no repository, because there is nothing to store it against", () => {
    expect(readSecretScanningAlert(secretScanningPayload({ repository: null }))).toBeUndefined();
  });

  it("should fall back to the qualified name when GitHub named only full_name", () => {
    const alert = readSecretScanningAlert(secretScanningPayload({ repository: { full_name: "hmcts/cvp-audio-ingress" } }));

    expect(alert?.repository).toBe("cvp-audio-ingress");
  });

  it("should skip a record with no alert number, which is half of its identity", () => {
    expect(readSecretScanningAlert(secretScanningPayload({ number: null }))).toBeUndefined();
  });

  it("should skip a record that is not an object at all", () => {
    expect(readSecretScanningAlert("not a record")).toBeUndefined();
  });

  it("should leave the created instant absent when GitHub stated one that does not parse", () => {
    // Absent rather than an Invalid Date, which would reach Postgres and be stored as a null anyway — but would
    // compare equal to nothing on the way there, including itself.
    expect(readSecretScanningAlert(secretScanningPayload({ created_at: "the day before yesterday" }))?.createdAt).toBeUndefined();
  });
});

describe("readDependabotAlert", () => {
  it("should store the advisory, the package and the manifest path", () => {
    expect(readDependabotAlert(dependabotPayload())).toEqual({
      repository: "pcs-api",
      family: AlertFamily.Dependabot,
      number: 771,
      alertType: "GHSA-29mw-wpgm-hmr9",
      subject: "lodash",
      severity: "high",
      path: "yarn.lock",
      state: "open",
      createdAt: new Date("2026-03-02T08:00:00Z"),
      htmlUrl: "https://github.com/hmcts/pcs-api/security/dependabot/771"
    });
  });

  it("should fold GitHub's severity to the vocabulary this tool grades in", () => {
    // The live responses spell it `HIGH`; `bySeverity` on the counts folds the same way, through the same function.
    expect(readDependabotAlert(dependabotPayload({ security_advisory: { ghsa_id: "GHSA-x", severity: "CRITICAL" } }))?.severity).toBe("critical");
  });

  it("should drop a grading this build does not know rather than guessing the nearest", () => {
    expect(readDependabotAlert(dependabotPayload({ security_advisory: { ghsa_id: "GHSA-x", severity: "catastrophic" } }))?.severity).toBeUndefined();
  });

  it("should give a Dependabot alert no line, because GitHub reports none", () => {
    expect(readDependabotAlert(dependabotPayload())?.line).toBeUndefined();
  });

  it("should read a dismissal as the resolution when GitHub dismissed the alert", () => {
    const alert = readDependabotAlert(dependabotPayload({ state: "dismissed", dismissed_reason: "tolerable_risk", dismissed_at: "2026-05-05T09:00:00Z" }));

    expect(alert?.resolution).toBe("tolerable_risk");
    expect(alert?.resolvedAt).toEqual(new Date("2026-05-05T09:00:00Z"));
  });

  it("should date a fixed alert from when it was fixed, with no resolution word to report", () => {
    const alert = readDependabotAlert(dependabotPayload({ state: "fixed", fixed_at: "2026-06-06T09:00:00Z" }));

    expect(alert?.resolvedAt).toEqual(new Date("2026-06-06T09:00:00Z"));
    expect(alert?.resolution).toBeUndefined();
  });

  it("should date an auto-dismissed alert from when GitHub dismissed it", () => {
    expect(readDependabotAlert(dependabotPayload({ state: "auto_dismissed", auto_dismissed_at: "2026-07-07T09:00:00Z" }))?.resolvedAt).toEqual(
      new Date("2026-07-07T09:00:00Z")
    );
  });

  it("should keep the alert when the advisory named no identifier, so the package still reports it", () => {
    const alert = readDependabotAlert(dependabotPayload({ security_advisory: null }));

    expect(alert?.alertType).toBeUndefined();
    expect(alert?.subject).toBe("lodash");
  });
});

describe("readCodeScanningAlert", () => {
  it("should store the rule, its security grading and the instance's location", () => {
    expect(readCodeScanningAlert(codeScanningPayload())).toEqual({
      repository: "pcs-frontend",
      family: AlertFamily.CodeScanning,
      number: 8,
      alertType: "js/incomplete-sanitization",
      severity: "medium",
      path: "src/main/routes/home.ts",
      line: 114,
      state: "open",
      createdAt: new Date("2026-02-11T14:22:00Z"),
      htmlUrl: "https://github.com/hmcts/pcs-frontend/security/code-scanning/8"
    });
  });

  it("should leave a non-security rule ungraded rather than reading its confidence as a severity", () => {
    // `rule.severity` is `warning` on this payload and is deliberately not read: it grades the rule's confidence,
    // and a non-security rule has no `security_severity_level` at all.
    expect(readCodeScanningAlert(codeScanningPayload({ rule: { id: "js/unused-local-variable", severity: "note" } }))?.severity).toBeUndefined();
  });

  it("should keep the alert when there is no instance to locate it by", () => {
    const alert = readCodeScanningAlert(codeScanningPayload({ most_recent_instance: null }));

    expect(alert?.number).toBe(8);
    expect(alert?.path).toBeUndefined();
  });

  it("should read a dismissal as the resolution when GitHub dismissed the alert", () => {
    const alert = readCodeScanningAlert(codeScanningPayload({ state: "dismissed", dismissed_reason: "false positive", dismissed_at: "2026-03-03T09:00:00Z" }));

    expect(alert?.resolution).toBe("false positive");
    expect(alert?.resolvedAt).toEqual(new Date("2026-03-03T09:00:00Z"));
  });

  it("should date a fixed alert from when it was fixed", () => {
    expect(readCodeScanningAlert(codeScanningPayload({ state: "fixed", fixed_at: "2026-04-04T09:00:00Z" }))?.resolvedAt).toEqual(
      new Date("2026-04-04T09:00:00Z")
    );
  });
});
