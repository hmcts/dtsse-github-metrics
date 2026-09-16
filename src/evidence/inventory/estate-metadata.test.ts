import { beforeEach, describe, expect, it, vi } from "vitest";
import { AvailabilityReason, GitHubError } from "../domain/availability.ts";
import type { GitHubClient } from "../github/client.ts";
import { hygieneFromMetadata } from "./assurance.ts";
import { readEstateMetadata } from "./estate-metadata.ts";

/**
 * The `security_and_analysis` block as live GitHub answers it on `GET /orgs/hmcts/repos`, verbatim from the
 * check made before this was built: eight keys, of which three are read.
 *
 * Eight rather than three deliberately. The point of the parity cases below is that the block reaches
 * `hygieneFromMetadata` AS GITHUB SENT IT — a projection that kept only the three read fields would pass a
 * three-key fixture and drop the rest of a real one.
 */
const SECURITY_AND_ANALYSIS = {
  secret_scanning: { status: "enabled" },
  secret_scanning_push_protection: { status: "enabled" },
  dependabot_security_updates: { status: "disabled" },
  secret_scanning_non_provider_patterns: { status: "disabled" },
  secret_scanning_ai_detection: { status: "disabled" },
  secret_scanning_validity_checks: { status: "disabled" },
  secret_scanning_delegated_alert_dismissal: { status: "disabled" },
  secret_scanning_delegated_bypass: { status: "enabled" }
};

/** One record as the organisation listing carries it. */
function listed(name: string, overrides: Record<string, unknown> = {}) {
  return { name, default_branch: "main", security_and_analysis: SECURITY_AND_ANALYSIS, ...overrides };
}

/** A client whose pagination yields the given pages, recording the path and parameters it was asked for. */
function paginating(...pages: unknown[][]) {
  const asked: { path: string; parameters: Record<string, string | number> }[] = [];
  const client = {
    paginate: (path: string, parameters: Record<string, string | number> = {}) => {
      asked.push({ path, parameters });
      return (async function* yielding() {
        for (const page of pages) {
          yield page;
        }
      })();
    }
  } as unknown as GitHubClient;
  return { client, asked };
}

/** A client whose pagination refuses on its first page, which is where the credential is refused. */
function refusing(error: unknown) {
  return {
    paginate: () => ({ [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(error) }) })
  } as unknown as GitHubClient;
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("readEstateMetadata", () => {
  it("should read the whole estate in one paginated listing rather than one call per repository", async () => {
    const { client, asked } = paginating([listed("cath-service"), listed("pcs-api")], [listed("nfdiv-case-api")]);

    const estate = await readEstateMetadata(client, "hmcts");

    expect([...(estate?.keys() ?? [])]).toEqual(["cath-service", "pcs-api", "nfdiv-case-api"]);
    // One request, paged by the client. `type=all` because the cohort holds archived, private and internal
    // repositories, and a listing narrower than the cohort puts the difference back on per-repository reads.
    expect(asked).toEqual([{ path: "/orgs/hmcts/repos", parameters: { per_page: 100, type: "all" } }]);
  });

  it("should carry the security block through unchanged, so the three hygiene signals do not move", async () => {
    // THE PARITY CASE. `hygieneFromMetadata` is the only reader of that block, and the criterion it feeds grades
    // roughly 890 repositories on `secretScanning` alone — a block this listing dropped or reshaped would change
    // every one of those grades without failing anything. Asserted against the per-repository body the collector
    // used to read, field by field, rather than against a hand-written expectation of it.
    const perRepositoryBody = { default_branch: "main", security_and_analysis: SECURITY_AND_ANALYSIS };
    const { client } = paginating([listed("cath-service")]);

    const estate = await readEstateMetadata(client, "hmcts");

    expect(hygieneFromMetadata(estate?.get("cath-service"))).toEqual(hygieneFromMetadata(perRepositoryBody));
    expect(hygieneFromMetadata(estate?.get("cath-service"))).toEqual({
      secretScanning: true,
      pushProtection: true,
      dependabotSecurityUpdates: false
    });
  });

  it("should leave every hygiene signal absent when a listed record carries no security block", async () => {
    // Absence is NOT evidence that scanning is off, which is the rule `hygieneFromMetadata` already states. A
    // `secretScanning: false` here would grade 890 repositories as failing a criterion nobody measured.
    const { client } = paginating([listed("cath-service", { security_and_analysis: undefined })]);

    const estate = await readEstateMetadata(client, "hmcts");

    expect(hygieneFromMetadata(estate?.get("cath-service"))).toEqual({});
  });

  it("should name the default branch it listed, which is what the collector reads it for", async () => {
    const { client } = paginating([listed("cath-service", { default_branch: "master" })]);

    const estate = await readEstateMetadata(client, "hmcts");

    expect(estate?.get("cath-service")?.default_branch).toBe("master");
  });

  it("should skip a record naming no repository rather than failing the whole estate", async () => {
    // One unreadable record must not turn every repository's answer into unknown — `openAlerts`' rule.
    const { client } = paginating([listed("cath-service"), { default_branch: "main" }, null]);

    const estate = await readEstateMetadata(client, "hmcts");

    expect([...(estate?.keys() ?? [])]).toEqual(["cath-service"]);
  });

  it("should report nothing when the listing itself was refused", async () => {
    // `undefined` rather than an empty map, so the caller falls back to the per-repository read it made before.
    // An empty map would report every repository as having no security block, which reads as clean.
    const estate = await readEstateMetadata(refusing(new GitHubError("no", AvailabilityReason.PermissionDenied, 403)), "hmcts");

    expect(estate).toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("read on its own"));
  });

  it("should name the failure when something other than GitHub raised it", async () => {
    const estate = await readEstateMetadata(refusing("a string nobody threw as an Error"), "hmcts");

    expect(estate).toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("a string nobody threw as an Error"));
  });
});
