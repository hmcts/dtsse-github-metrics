import { beforeEach, describe, expect, it, vi } from "vitest";
import { AlertSeverity } from "../domain/security-alerts.ts";
import { HUMAN_MAINTENANCE_SEARCH_DAYS, humanWindowAnswer, maintenanceEvidence, maintenanceWindows } from "../domain/standards.ts";
import { createGitHubClient } from "../github/client.ts";
import { personalAccessToken } from "../github/credentials.ts";
import { bindsAdministrators, collectMergeGate, enforcingRules, mergeGateFromClassicProtection, mergeGateWithoutRuleDetails } from "./merge-gate.ts";
import { deploysToProduction, entryRepository, ProductionListError, parseProductionRepositories, parseRepositoryUrl } from "./production.ts";
import { codeScanningSeverity, collectSecurityAlerts, countBySeverity, dependabotSeverity, noSeverity, openAlerts } from "./security-alerts.ts";

// Ported from tests/test_inventory.py and tests/test_production.py.

interface Reply {
  status?: number;
  body?: unknown;
}

function replying(replies: Reply[]): typeof globalThis.fetch {
  const queue = [...replies];
  return vi.fn(() => {
    const next = queue.shift() ?? { status: 200, body: [] };
    return Promise.resolve(
      new Response(typeof next.body === "string" ? next.body : JSON.stringify(next.body ?? {}), {
        status: next.status ?? 200,
        headers: { "content-type": "application/json" }
      })
    );
  }) as unknown as typeof globalThis.fetch;
}

function client(fetch: typeof globalThis.fetch) {
  return createGitHubClient({ credentials: personalAccessToken("ghp_test"), fetch, pause: () => Promise.resolve(), clock: () => 1000 });
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "debug").mockImplementation(() => undefined);
});

describe("collectMergeGate", () => {
  it("should read an enforcing ruleset as the gate", async () => {
    const fetch = replying([
      { body: [{ type: "pull_request", parameters: { required_approving_review_count: 2, dismiss_stale_reviews_on_push: true }, ruleset_id: 7 }] },
      { body: { enforcement: "active", bypass_actors: [] } }
    ]);

    const report = await collectMergeGate(client(fetch), "hmcts", "cath-service", "main");

    expect(report.gate).toMatchObject({ branch: "main", protected: true, rulesObserved: true });
    expect(report.gate?.pullRequests[0]).toEqual({
      requiredApprovingReviewCount: 2,
      dismissStaleReviewsOnPush: true,
      requireCodeOwnerReview: false,
      requireLastPushApproval: false
    });
  });

  it("should fall back to classic protection when no ruleset governs the branch", async () => {
    // A repository can carry both, and only the classic side reports on admins.
    const fetch = replying([
      { body: [] },
      {
        body: {
          required_pull_request_reviews: { required_approving_review_count: 1 },
          enforce_admins: { enabled: true },
          allow_force_pushes: { enabled: false }
        }
      }
    ]);

    const report = await collectMergeGate(client(fetch), "hmcts", "cath-service", "main");

    expect(report.gate).toMatchObject({ protected: true, rulesObserved: true, appliesToAdministrators: true, blocksForcePushes: true });
  });

  it("should fall back to classic protection when every ruleset only evaluates", async () => {
    // A branch whose every ruleset only evaluates is a branch no ruleset gates.
    const fetch = replying([
      { body: [{ type: "pull_request", parameters: {}, ruleset_id: 7 }] },
      { body: { enforcement: "evaluate", bypass_actors: [] } },
      { body: { required_pull_request_reviews: { required_approving_review_count: 1 } } }
    ]);

    const report = await collectMergeGate(client(fetch), "hmcts", "cath-service", "main");

    expect(report.gate?.pullRequests[0]?.requiredApprovingReviewCount).toBe(1);
  });

  it("should still ask classic protection when rulesets are unavailable on the plan", async () => {
    // "Upgrade to GitHub Pro …" says rules cannot be configured at all, not that the branch is unprotected —
    // asserting the latter would publish that off a message about rulesets.
    const fetch = replying([
      { status: 403, body: { message: "Upgrade to GitHub Pro or make this repository public to enable this feature" } },
      { body: { required_pull_request_reviews: { required_approving_review_count: 1 } } }
    ]);

    const report = await collectMergeGate(client(fetch), "hmcts", "cath-service", "main");

    expect(report.gate?.protected).toBe(true);
  });

  it("should read a 404 from classic protection as an unprotected branch that was observed", async () => {
    const fetch = replying([{ body: [] }, { status: 404, body: { message: "Branch not protected" } }]);

    const report = await collectMergeGate(client(fetch), "hmcts", "cath-service", "main");

    expect(report.gate).toMatchObject({ protected: false, rulesObserved: true });
  });

  it("should record rules as unobserved when GitHub refuses the protection detail", async () => {
    // The assessment reads this as cannot-assess rather than as a branch requiring no review.
    const fetch = replying([
      { body: [] },
      { status: 403, body: { message: "Resource not accessible by personal access token" } },
      { body: { protected: true } }
    ]);

    const report = await collectMergeGate(client(fetch), "hmcts", "cath-service", "main");

    expect(report.gate).toMatchObject({ protected: true, rulesObserved: false });
  });

  it("should report the reason rather than a gate when collection fails outright", async () => {
    const fetch = replying([
      { status: 500, body: {} },
      { status: 500, body: {} },
      { status: 500, body: {} }
    ]);

    const report = await collectMergeGate(client(fetch), "hmcts", "cath-service", "main");

    expect(report.gate).toBeUndefined();
    expect(report.detail).toBeTruthy();
  });

  it("should name a rule type it does not model rather than dropping it", async () => {
    // A rule GitHub adds later would otherwise make a gate look weaker than it is enforced.
    const fetch = replying([
      {
        body: [
          { type: "pull_request", parameters: { required_approving_review_count: 1 }, ruleset_id: 7 },
          { type: "some_future_rule", parameters: {}, ruleset_id: 7 }
        ]
      },
      { body: { enforcement: "active", bypass_actors: [] } }
    ]);

    const report = await collectMergeGate(client(fetch), "hmcts", "cath-service", "main");

    expect(report.gate?.unmodelledRules).toEqual(["some_future_rule"]);
  });

  it("should read the status-check contexts a ruleset requires", async () => {
    const fetch = replying([
      {
        body: [
          {
            type: "required_status_checks",
            parameters: { required_status_checks: [{ context: "build" }, { context: "lint" }], strict_required_status_checks_policy: true },
            ruleset_id: 7
          }
        ]
      },
      { body: { enforcement: "active", bypass_actors: [] } }
    ]);

    const report = await collectMergeGate(client(fetch), "hmcts", "cath-service", "main");

    expect(report.gate?.statusChecks[0]).toEqual({ contexts: ["build", "lint"], strictRequiredStatusChecksPolicy: true });
  });

  it("should encode a branch name that needs it", async () => {
    const fetch = replying([{ body: [] }, { status: 404, body: {} }]);

    const report = await collectMergeGate(client(fetch), "hmcts", "cath-service", "release/1.0");

    expect(report.gate?.branch).toBe("release/1.0");
  });
});

describe("bindsAdministrators", () => {
  it("should report nothing when one ruleset could not be read", () => {
    // An exemption nobody was allowed to read is not an exemption that is absent.
    expect(bindsAdministrators([{ enforcement: "active", bypass_actors: [] }, undefined])).toBeUndefined();
  });

  it("should report nothing when there are no rulesets at all", () => {
    expect(bindsAdministrators([])).toBeUndefined();
  });

  it.each([
    [[{ enforcement: "active", bypass_actors: [] }], true],
    [[{ enforcement: "active", bypass_actors: [{ actor_id: 1, actor_type: "RepositoryRole", bypass_mode: "always" }] }], false],
    [[{ enforcement: "active", bypass_actors: [{ actor_id: 1, actor_type: "RepositoryRole", bypass_mode: "pull_request" }] }], false]
  ])("should judge %o as binding=%s", (rulesets, expected) => {
    expect(bindsAdministrators(rulesets)).toBe(expected);
  });
});

describe("enforcingRules", () => {
  it("should keep a rule whose ruleset could not be read", () => {
    // Refusing to disclose a ruleset is not evidence that it stopped enforcing.
    const rules = [{ type: "pull_request", parameters: {}, ruleset_id: 7 }];

    expect(enforcingRules(rules, new Map([[7, undefined]]))).toHaveLength(1);
  });

  it("should keep a rule that names no ruleset at all", () => {
    expect(enforcingRules([{ type: "pull_request", parameters: {} }], new Map())).toHaveLength(1);
  });

  it("should drop a rule whose ruleset only evaluates", () => {
    const rules = [{ type: "pull_request", parameters: {}, ruleset_id: 7 }];

    expect(enforcingRules(rules, new Map([[7, { enforcement: "evaluate", bypass_actors: [] }]]))).toEqual([]);
  });
});

describe("mergeGateWithoutRuleDetails", () => {
  it("should keep an unprotected branch apart from one whose rules were withheld", () => {
    // Two different situations produce empty rule arrays and only rulesObserved separates them.
    expect(mergeGateWithoutRuleDetails("main", { protected: false, rulesObserved: true })).toMatchObject({ protected: false, rulesObserved: true });
    expect(mergeGateWithoutRuleDetails("main", { protected: true, rulesObserved: false })).toMatchObject({ protected: true, rulesObserved: false });
  });
});

describe("mergeGateFromClassicProtection", () => {
  it("should invert what GitHub reports as allowed into what the gate blocks", () => {
    const gate = mergeGateFromClassicProtection("main", { allow_deletions: { enabled: false }, allow_force_pushes: { enabled: true } });

    expect(gate.restrictsDeletions).toBe(true);
    expect(gate.blocksForcePushes).toBe(false);
  });

  it("should leave administrators unknown when GitHub did not report enforce_admins", () => {
    expect(mergeGateFromClassicProtection("main", {}).appliesToAdministrators).toBeUndefined();
  });

  it("should deduplicate the required check contexts", () => {
    const gate = mergeGateFromClassicProtection("main", { required_status_checks: { strict: false, checks: [{ context: "build" }, { context: "build" }] } });

    expect(gate.statusChecks[0]?.contexts).toEqual(["build"]);
  });
});

describe("countBySeverity", () => {
  it("should count the gradings GitHub asserted", () => {
    expect(countBySeverity(["critical", "high", "high", undefined])).toEqual({ critical: 1, high: 2 });
  });

  it("should drop an unrecognised grading rather than mapping it onto the nearest known one", () => {
    // GitHub adding a severity should leave the counts it does understand correct.
    expect(countBySeverity(["critical", "apocalyptic"])).toEqual({ critical: 1 });
  });

  it("should report severities worst first, whatever order they arrived in", () => {
    expect(Object.keys(countBySeverity(["low", "critical", "medium"]))).toEqual([AlertSeverity.Critical, AlertSeverity.Medium, AlertSeverity.Low]);
  });

  it("should fold case, since GitHub is not consistent about it", () => {
    expect(countBySeverity(["CRITICAL"])).toEqual({ critical: 1 });
  });
});

describe("openAlerts", () => {
  it("should count open alerts by severity", async () => {
    const fetch = replying([{ body: [{ security_advisory: { severity: "high" } }, { security_advisory: { severity: "critical" } }] }]);

    const result = await openAlerts(client(fetch), "hmcts", "cath-service", "dependabot/alerts", dependabotSeverity);

    expect(result.count).toEqual({ open: 2, bySeverity: { critical: 1, high: 1 } });
    expect(result.reason).toBeUndefined();
  });

  it("should read a 404 as a family nobody turned on, and record no failure", async () => {
    // The repository was already read with this token, so a 404 here is not a permission problem.
    const fetch = replying([{ status: 404, body: { message: "Not Found" } }]);

    const result = await openAlerts(client(fetch), "hmcts", "cath-service", "dependabot/alerts", dependabotSeverity);

    expect(result.count.open).toBeUndefined();
    expect(result.count.detail).toMatch(/is not enabled for this repository/);
    expect(result.reason).toBeUndefined();
  });

  it("should read a 403 GitHub explained as a disabled feature the same way", async () => {
    // Across 1850 repositories all 945 of these were feature or plan messages, and not one a refusal.
    const fetch = replying([{ status: 403, body: { message: "Dependabot alerts are disabled for this repository." } }]);

    const result = await openAlerts(client(fetch), "hmcts", "cath-service", "dependabot/alerts", dependabotSeverity);

    expect(result.reason).toBeUndefined();
    expect(result.count.open).toBeUndefined();
  });

  it("should record an unrecognised 403 as a failure", async () => {
    const fetch = replying([{ status: 403, body: { message: "Resource not accessible by personal access token" } }]);

    const result = await openAlerts(client(fetch), "hmcts", "cath-service", "dependabot/alerts", dependabotSeverity);

    expect(result.reason).toBe("permission_denied");
  });

  it("should leave the count absent rather than zero whenever the family could not be read", async () => {
    // A family nobody can read and a family nobody turned on are equally not zero open alerts.
    const fetch = replying([{ status: 403, body: { message: "Resource not accessible by personal access token" } }]);

    const result = await openAlerts(client(fetch), "hmcts", "cath-service", "code-scanning/alerts", codeScanningSeverity);

    expect(result.count.open).toBeUndefined();
  });
});

describe("severity readers", () => {
  it("should read a Dependabot severity from its advisory", () => {
    expect(dependabotSeverity({ security_advisory: { severity: "high" } })).toBe("high");
    expect(dependabotSeverity({ security_advisory: null })).toBeUndefined();
  });

  it("should read a code-scanning security grading, which a non-security rule lacks", () => {
    expect(codeScanningSeverity({ rule: { security_severity_level: "medium" } })).toBe("medium");
    expect(codeScanningSeverity({ rule: {} })).toBeUndefined();
  });

  it("should grade no secret-scanning alert, since GitHub grades none", () => {
    // Treating every leaked secret as critical would rank a test fixture alongside a live production key.
    expect(noSeverity()).toBeUndefined();
  });
});

describe("collectSecurityAlerts", () => {
  it("should read all three families independently, so one refusal does not suppress the others", async () => {
    const fetch = replying([
      { body: [{ security_advisory: { severity: "high" } }] },
      { status: 403, body: { message: "Resource not accessible by personal access token" } },
      { body: [] }
    ]);

    const { evidence, failures } = await collectSecurityAlerts(client(fetch), "hmcts", "cath-service");

    expect(evidence.dependabot.open).toBe(1);
    expect(evidence.codeScanning.open).toBeUndefined();
    expect(evidence.secretScanning.open).toBe(0);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.family).toBe("code-scanning/alerts");
  });

  it("should record no failure for a family that is merely not enabled", async () => {
    const fetch = replying([
      { status: 404, body: {} },
      { status: 404, body: {} },
      { status: 404, body: {} }
    ]);

    const { failures } = await collectSecurityAlerts(client(fetch), "hmcts", "cath-service");

    expect(failures).toEqual([]);
  });
});

describe("parseRepositoryUrl", () => {
  it("should casefold, because the live document mixes HMCTS and hmcts", () => {
    // A case-sensitive comparison would silently drop that repository's badge.
    expect(parseRepositoryUrl("https://github.com/HMCTS/adoption-shared-infrastructure.git")).toBe("hmcts/adoption-shared-infrastructure");
  });

  it("should strip a .git suffix", () => {
    expect(parseRepositoryUrl("https://github.com/hmcts/cath-service.git")).toBe("hmcts/cath-service");
  });

  it("should refuse an scp-style remote, which has no parseable host", () => {
    // Treating the whole text as a path would read the organisation as `git@github.com:hmcts` — a pair that
    // matches nothing and logs nothing.
    expect(parseRepositoryUrl("git@github.com:hmcts/bar-api.git")).toBeUndefined();
  });

  it.each(["https://github.com/hmcts", "https://github.com/hmcts/a/b", "https://github.com/hmcts/.git", "not a url"])("should refuse %s", (url) => {
    expect(parseRepositoryUrl(url)).toBeUndefined();
  });
});

describe("entryRepository", () => {
  it("should read the repo key of one entry", () => {
    expect(entryRepository({ repo: "https://github.com/hmcts/cath-service" })).toBe("hmcts/cath-service");
  });

  it.each([[null], ["a string"], [{}], [{ repo: 7 }]])("should refuse %o", (entry) => {
    expect(entryRepository(entry)).toBeUndefined();
  });
});

describe("parseProductionRepositories", () => {
  it("should read the prod sequence and ignore every other environment", () => {
    const document = `
prod:
  - repo: https://github.com/hmcts/cath-service
demo:
  - repo: https://github.com/hmcts/not-production
`;

    expect([...parseProductionRepositories(document)]).toEqual(["hmcts/cath-service"]);
  });

  it("should let one unreadable entry cost that entry alone", () => {
    const document = `
prod:
  - repo: https://github.com/hmcts/cath-service
  - repo: git@github.com:hmcts/unreadable.git
`;

    expect([...parseProductionRepositories(document)]).toEqual(["hmcts/cath-service"]);
  });

  it("should refuse a sequence whose every entry is unreadable, which is the file changing shape", () => {
    // The day the other team renames `repo:`, each of 250 entries fails on its own and the parse would
    // otherwise succeed with nothing in it — serving a confident false to the whole estate.
    const document = "prod:\n  - repository: https://github.com/hmcts/cath-service\n";

    expect(() => parseProductionRepositories(document)).toThrow(ProductionListError);
  });

  it("should accept an explicitly empty sequence as a document stating nothing is approved", () => {
    expect(parseProductionRepositories("prod: []\n").size).toBe(0);
  });

  it.each([["not a mapping"], ["- a list\n"], ["demo:\n  - repo: https://github.com/hmcts/x\n"]])("should refuse %s", (document) => {
    expect(() => parseProductionRepositories(document)).toThrow(ProductionListError);
  });
});

describe("deploysToProduction", () => {
  it("should report nothing when the list could not be read", () => {
    // An unread list has said nothing; an empty list has said nothing deploys. Reporting the first as false
    // would state a fact nobody observed.
    expect(deploysToProduction(undefined, "hmcts", "cath-service")).toBeUndefined();
  });

  it("should report false against a list that was read and does not name the repository", () => {
    expect(deploysToProduction(new Set(["hmcts/other"]), "hmcts", "cath-service")).toBe(false);
  });

  it("should match case-insensitively", () => {
    expect(deploysToProduction(new Set(["hmcts/cath-service"]), "HMCTS", "Cath-Service")).toBe(true);
  });
});

describe("maintenanceEvidence", () => {
  it("should accept a branch with no commits", () => {
    expect(maintenanceEvidence({ branch: "main" }).lastCommitAt).toBeUndefined();
  });

  it("should refuse a branch with no commits that claims to have searched", () => {
    expect(() => maintenanceEvidence({ branch: "main", searchedBackTo: new Date() })).toThrow(/nothing to have searched/);
  });

  it("should require a search bound when no human commit was found", () => {
    // The two absences are different answers: none within the window, and unknown beyond what was examined.
    expect(() => maintenanceEvidence({ branch: "main", lastCommitAt: new Date() })).toThrow(/how far back the search examined/);
  });

  it("should refuse a search bound beside a found human commit", () => {
    expect(() => maintenanceEvidence({ branch: "main", lastCommitAt: new Date(), lastHumanCommitAt: new Date(), searchedBackTo: new Date() })).toThrow(
      /carries no search bound/
    );
  });
});

describe("humanWindowAnswer", () => {
  const cutoff = new Date("2026-02-08T00:00:00Z");

  it("should answer true when the human commit is inside the window", () => {
    const evidence = maintenanceEvidence({ branch: "main", lastCommitAt: new Date("2026-08-01Z"), lastHumanCommitAt: new Date("2026-07-01Z") });

    expect(humanWindowAnswer(evidence, cutoff)).toBe(true);
  });

  it("should answer false only where the search reached past the cutoff", () => {
    const reached = maintenanceEvidence({ branch: "main", lastCommitAt: new Date("2026-08-01Z"), searchedBackTo: new Date("2026-01-01Z") });

    expect(humanWindowAnswer(reached, cutoff)).toBe(false);
  });

  it("should answer nothing where the bounded search stopped short of the cutoff", () => {
    // "Nobody committed in six months" and "we did not look back six months" are different statements.
    const stoppedShort = maintenanceEvidence({ branch: "main", lastCommitAt: new Date("2026-08-01Z"), searchedBackTo: new Date("2026-06-01Z") });

    expect(humanWindowAnswer(stoppedShort, cutoff)).toBeUndefined();
  });

  it("should answer false for a branch with no commits at all", () => {
    expect(humanWindowAnswer(maintenanceEvidence({ branch: "main" }), cutoff)).toBe(false);
  });
});

describe("maintenanceWindows", () => {
  it("should answer all three windows against the instant the evidence was observed", () => {
    const fetchedAt = new Date("2026-08-08T00:00:00Z");
    const evidence = maintenanceEvidence({ branch: "main", lastCommitAt: new Date("2026-08-01Z"), lastHumanCommitAt: new Date("2026-07-01Z") });

    const windows = maintenanceWindows(evidence, fetchedAt);

    expect(windows.map((window) => window.months)).toEqual([6, 12, 24]);
    expect(windows.every((window) => window.committedWithin)).toBe(true);
    expect(windows.every((window) => window.humanCommittedWithin === true)).toBe(true);
  });

  it("should search back as far as the widest window it reports", () => {
    // A narrower bound would silently turn every exhausted-history answer for that window into unknown.
    expect(HUMAN_MAINTENANCE_SEARCH_DAYS).toBe(730);
  });
});
