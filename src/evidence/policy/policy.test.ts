import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigurationError, parseConfiguration } from "./load.ts";
import { configuredOwners, enablementInstants, sonarOrganizationName } from "./repositories.ts";
import { PRODUCTION_LIST_URL } from "./schema.ts";

// Ported from tests/test_config.py. Upstream wrote each case to a temp file; these parse the same text
// in memory, since the file reading is `loadConfiguration`'s job and is tested once there.

const VALID = `
version: 1
organization: hmcts
lookback:
  operational_days: 60
  maximum_days: 180
  stale_open_days: 21
excluded_repositories:
  - retired-service
teams:
  - identifier: civil
    display_name: Civil
    github_team_slugs:
      - civil-developers
    repositories:
      - civil-service
`;

// Teams and repositories deliberately out of order, to prove the reporting order is imposed.
const POPULATION = `
version: 1
organization: hmcts
teams:
  - identifier: opal
    display_name: Opal
    repositories:
      - opal-logging-service
      - opal-common-lib
  - identifier: divorce
    display_name: Divorce
    repositories:
      - nfdiv-case-api
`;

describe("parseConfiguration", () => {
  it("should load every supported field when the document is valid", () => {
    const configuration = parseConfiguration(VALID);

    expect(configuration.version).toBe(1);
    expect(configuration.organization).toBe("hmcts");
    expect(configuration.lookback.operational_days).toBe(60);
    expect(configuration.lookback.maximum_days).toBe(180);
    expect(configuration.lookback.stale_open_days).toBe(21);
    expect(configuration.excluded_repositories).toEqual(["retired-service"]);
    expect(configuration.teams[0]?.identifier).toBe("civil");
    expect(configuration.teams[0]?.github_team_slugs).toEqual(["civil-developers"]);
  });

  it("should apply the documented default lookbacks when none are given", () => {
    const configuration = parseConfiguration("version: 1\norganization: hmcts\n");

    expect(configuration.lookback).toEqual({
      operational_days: 90,
      maximum_days: 365,
      mutable_hours: 6,
      stale_open_days: 14,
      stale_collection_days: 2
    });
  });

  it("should apply the documented default assessment policy when none is given", () => {
    const { assessment } = parseConfiguration("version: 1\norganization: hmcts\n");

    expect(assessment.enabled).toBe(true);
    expect(assessment.minimum_merges).toBe(10);
    expect(assessment["independent-review-coverage"]).toEqual({ green_percentage: 90, amber_percentage: 70 });
    expect(assessment["approval-coverage"]).toEqual({ green_percentage: 90, amber_percentage: 70 });
    expect(assessment["checks-passing-at-merge"]).toEqual({ green_percentage: 90, amber_percentage: 70 });
    expect(assessment["pull-request-size"]).toEqual({ maximum: 400 });
    expect(assessment["merge-cycle-time"]).toEqual({ maximum: 24 });
    expect(assessment["time-to-first-review"]).toEqual({ maximum: 8 });
    expect(assessment["unreviewed-substantial-merges"]).toEqual({ maximum_count: 0, maximum_percentage: 1 });
    expect(assessment["review-depth-minimum-percentage"]).toBe(50);
  });

  it("should apply the documented default traceability policy when none is given", () => {
    const { traceability } = parseConfiguration("version: 1\norganization: hmcts\n");

    expect(traceability.minimum_description).toBe(30);
    expect(traceability.reference_patterns).toEqual(["#\\d+", "[A-Z][A-Z0-9]+-\\d+"]);
  });

  it("should apply the documented default practice rule when none is given", () => {
    const { practices } = parseConfiguration("version: 1\norganization: hmcts\n");

    expect(practices["unreviewed-merge"]).toEqual({ enabled: true, severity: "high", minimum_occurrences: 1, excluded_logins: [] });
  });

  it("should exclude renovate and dependabot from the cohort by default", () => {
    expect(parseConfiguration("version: 1\norganization: hmcts\n").cohort.excluded_authors).toEqual(["renovate", "dependabot"]);
  });

  it("should reject a reference pattern that cannot compile", () => {
    const document = `${VALID}\ntraceability:\n  reference_patterns:\n    - "[unclosed"\n`;

    expect(() => parseConfiguration(document)).toThrow(/invalid reference pattern/);
  });

  it("should allow a team to configure no github team slugs", () => {
    const configuration = parseConfiguration(VALID.replace("    github_team_slugs:\n      - civil-developers\n", ""));

    expect(configuration.teams[0]?.github_team_slugs).toEqual([]);
  });

  it.each([
    ["version: 1", "version: 2", /version/],
    ["  operational_days: 60", "  operational_days: 0", /operational_days/],
    ["  stale_open_days: 21", "  stale_collection_days: 0", /lookback\.stale_collection_days/],
    // A misspelled key must be refused, not silently ignored with the default reported as a choice.
    ["  stale_open_days: 21", "  stale_collection_day: 8", /stale_collection_day/],
    ["organization: hmcts", "organisation: hmcts", /organisation|organization/]
  ])("should reject %s replaced by %s as unsupported, invalid or misspelled", (from, to, message) => {
    expect(() => parseConfiguration(VALID.replace(from, to))).toThrow(message);
  });

  it("should reject a green percentage below its amber percentage", () => {
    const document = `${VALID}\nassessment:\n  independent-review-coverage:\n    green_percentage: 50\n    amber_percentage: 70\n`;

    expect(() => parseConfiguration(document)).toThrow(/green percentage may not be below the amber percentage/);
  });

  it("should reject the scalar maximum_unreviewed_substantial_merges the two allowances replaced", () => {
    // Rejected rather than ignored: a stale key silently doing nothing would read as a policy choice.
    const document = `${VALID}\nassessment:\n  maximum_unreviewed_substantial_merges: 0\n`;

    expect(() => parseConfiguration(document)).toThrow(ConfigurationError);
  });

  it("should name the rejected key and the file read when validation fails", () => {
    expect(() => parseConfiguration(VALID.replace("  maximum_days: 180", "  maximum_days: 0"), "policy.yaml")).toThrow(
      /lookback\.maximum_days:.*\(read from policy\.yaml\)/s
    );
  });

  it("should report a missing required key rather than defaulting it", () => {
    expect(() => parseConfiguration("organization: hmcts\n")).toThrow(/version/);
  });

  it("should accept a policy file with no teams, for the commands whose subject is not the cohort", () => {
    // `map-sonar` and `prune` are about an organisation and a cache, not about any repository a team
    // owns, so neither should oblige a team file to be layered in.
    expect(parseConfiguration("version: 1\norganization: hmcts\n").teams).toEqual([]);
  });

  it("should keep checking sonar project keys even when no teams are configured", () => {
    const document = 'version: 1\norganization: hmcts\nsonar_projects:\n  some-repo: "  "\n';

    expect(() => parseConfiguration(document)).toThrow(/sonar project keys may not be empty/);
  });

  it("should defer the cohort cross-checks when no teams are configured", () => {
    // Every name would be "unconfigured" with one side of the comparison absent, failing the load over
    // a key neither command reads.
    const document = "version: 1\norganization: hmcts\nenablement:\n  some-repo: 2026-06-01\n";

    expect(parseConfiguration(document).enablement["some-repo"]?.toISOString()).toBe("2026-06-01T00:00:00.000Z");
  });

  it("should accept a repository owned by more than one team", () => {
    const document = `${POPULATION}  - identifier: shared\n    display_name: Shared\n    repositories:\n      - nfdiv-case-api\n`;

    expect(parseConfiguration(document).teams.map((team) => team.identifier)).toContain("shared");
  });

  it("should reject a repository listed twice under one team", () => {
    const document = `${POPULATION}  - identifier: shared\n    display_name: Shared\n    repositories:\n      - other-api\n      - other-api\n`;

    expect(() => parseConfiguration(document)).toThrow(/shared lists a repository twice: other-api/);
  });

  it("should reject duplicate team identifiers", () => {
    const document = `${POPULATION}  - identifier: opal\n    display_name: Opal Again\n    repositories:\n      - opal-other\n`;

    expect(() => parseConfiguration(document)).toThrow(/team identifiers must be unique/);
  });

  it("should reject an excluded repository that a team owns", () => {
    const document = `${VALID}\n`.replace("  - retired-service", "  - civil-service");

    expect(() => parseConfiguration(document)).toThrow(/excluded repositories may not have an owner: civil-service/);
  });

  it("should carry no enablement dates by default", () => {
    expect(parseConfiguration(VALID).enablement).toEqual({});
  });

  it.each([
    ["2026-06-01", "2026-06-01T00:00:00.000Z"],
    ["2026-06-01T09:00:00Z", "2026-06-01T09:00:00.000Z"],
    ["2026-06-01T09:00:00+01:00", "2026-06-01T08:00:00.000Z"]
  ])("should parse the enablement date %s exactly as a window edge is parsed", (written, expected) => {
    const document = `${VALID}\nenablement:\n  civil-service: ${written}\n`;

    expect(parseConfiguration(document).enablement["civil-service"]?.toISOString()).toBe(expected);
  });

  it("should accept an enablement date for a repository the file does not override the owner of", () => {
    // This case USED TO BE REJECTED, while `teams:` listed the estate and so could be checked against. It
    // lists ownership overrides now, so the old rule rejected the ordinary case: a date for a repository whose
    // owner nobody has overridden. A typo is caught where the cohort lives — by the report naming a key that
    // matched no repository — rather than by a schema that would need a database to know.
    const document = `${VALID}\nenablement:\n  civil-servce: 2026-06-01\n`;

    expect(parseConfiguration(document).enablement["civil-servce"]?.toISOString()).toBe("2026-06-01T00:00:00.000Z");
  });

  it("should reject an unparseable enablement date", () => {
    const document = `${VALID}\nenablement:\n  civil-service: "last tuesday"\n`;

    expect(() => parseConfiguration(document)).toThrow(/expected a date or datetime/);
  });

  it("should reject an enablement value that is neither text nor a date", () => {
    // A bare number would otherwise be read as a Unix timestamp: a third instant rule, by accident.
    const document = `${VALID}\nenablement:\n  civil-service: 1780000000\n`;

    expect(() => parseConfiguration(document)).toThrow(ConfigurationError);
  });

  it("should default the production list to the published HMCTS document", () => {
    expect(parseConfiguration(VALID).production_list_url).toBe(PRODUCTION_LIST_URL);
  });

  it("should prefer an explicit production list url", () => {
    const document = `${VALID}\nproduction_list_url: https://example.test/approvals.yml\n`;

    expect(parseConfiguration(document).production_list_url).toBe("https://example.test/approvals.yml");
  });

  it("should disable the production list when it is null", () => {
    // No repository then carries a production badge, which is what an organisation with no such list
    // wants — as distinct from a fetch that failed.
    expect(parseConfiguration(`${VALID}\nproduction_list_url: null\n`).production_list_url).toBeNull();
  });

  it("should load a sonar project override", () => {
    const document = `${VALID}\nsonar_projects:\n  civil-service: civil_service_key\n`;

    expect(parseConfiguration(document).sonar_projects).toEqual({ "civil-service": "civil_service_key" });
  });

  it("should accept a sonar project for a repository the file does not override the owner of", () => {
    // Removed for the same reason as the enablement check above: `teams:` no longer lists the estate, so
    // requiring every override key to appear in it rejected the ordinary case.
    const document = `${VALID}\nsonar_projects:\n  civil-servce: key\n`;

    expect(parseConfiguration(document).sonar_projects).toEqual({ "civil-servce": "key" });
  });

  it.each(['""', '"   "'])("should reject the empty sonar project key %s", (written) => {
    const document = `${VALID}\nsonar_projects:\n  civil-service: ${written}\n`;

    expect(() => parseConfiguration(document)).toThrow(/sonar project keys may not be empty/);
  });

  it("should resolve a key given twice as YAML does, the last occurrence winning", () => {
    const document = `${VALID}\nlookback:\n  operational_days: 30\n`;

    expect(parseConfiguration(document).lookback.operational_days).toBe(30);
  });

  it("should reject a document that is not a mapping", () => {
    expect(() => parseConfiguration("- not a mapping\n")).toThrow(ConfigurationError);
  });

  it.each([
    "!!python/object/apply:builtins.str [unsafe]",
    '!!js/function "function(){return 1}"'
  ])("should reject the constructor tag %s, which could instantiate an arbitrary object", (document) => {
    // `json: true` is set on the loader so a duplicate key resolves as PyYAML resolved it. This
    // asserts that option did not also widen the schema: an unknown tag is still refused.
    expect(() => parseConfiguration(document)).toThrow(ConfigurationError);
  });
});

describe("the shipped metrics.example.yaml", () => {
  it("should load and carry every documented key", () => {
    // It is the file an operator copies to start a real configuration, so a key the schema no longer
    // accepts — or one it silently ignores — is a defect in the example rather than a stale comment.
    const example = readFileSync(path.join(process.cwd(), "metrics.example.yaml"), "utf8");

    const configuration = parseConfiguration(example, "metrics.example.yaml");

    expect(configuration.version).toBe(1);
    expect(configuration.organization).toBe("hmcts");
    expect(configuration.teams).not.toHaveLength(0);
    expect(configuration.production_list_url).toBe(PRODUCTION_LIST_URL);
    // Upstream's `database:` key is gone; Postgres replaces the two SQLite files.
    expect(example).not.toMatch(/^database:/m);
  });
});

describe("sonarOrganizationName", () => {
  it("should read sonar under the github organisation by default", () => {
    expect(sonarOrganizationName(parseConfiguration(VALID))).toBe("hmcts");
  });

  it("should prefer an explicit sonar organisation", () => {
    expect(sonarOrganizationName(parseConfiguration(`${VALID}\nsonar_organization: hmcts-sonar\n`))).toBe("hmcts-sonar");
  });
});

// `ownedRepositories` and `configuredRepositories` were removed with the cohort's move to the graph. What the
// file still answers is "whose is this", and the tests for the estate itself live in org/cohort.test.ts.

describe("org_graph", () => {
  it("should be off unless a configuration turns it on, so no existing file changes meaning", () => {
    expect(parseConfiguration(VALID).org_graph.enabled).toBe(false);
  });

  it("should carry the measured defaults for every threshold", () => {
    const graph = parseConfiguration(VALID).org_graph;

    expect(graph).toMatchObject({
      prefix_support: 3,
      prefix_dominance: 0.8,
      maximum_team_share: 0.25,
      maximum_team_members: 100,
      excluded_teams: ["all-org-members"],
      unresolved_repository_limit: 500
    });
  });

  it("should read a lowered member ceiling", () => {
    const document = `${VALID}\norg_graph:\n  enabled: true\n  maximum_team_members: 50\n`;

    expect(parseConfiguration(document).org_graph.maximum_team_members).toBe(50);
  });

  it("should refuse a member ceiling of zero, which would disown every team", () => {
    const document = `${VALID}\norg_graph:\n  enabled: true\n  maximum_team_members: 0\n`;

    expect(() => parseConfiguration(document)).toThrow();
  });

  it("should refuse a misspelled threshold rather than silently reporting the default as a choice", () => {
    const document = `${VALID}\norg_graph:\n  enabled: true\n  maximum_team_member: 50\n`;

    expect(() => parseConfiguration(document)).toThrow();
  });
});

describe("configuredOwners", () => {
  it("should name the teams a human has overridden the owner to", () => {
    expect([...configuredOwners(parseConfiguration(POPULATION))]).toEqual([
      ["nfdiv-case-api", ["divorce"]],
      ["opal-common-lib", ["opal"]],
      ["opal-logging-service", ["opal"]]
    ]);
  });

  it("should name every team overriding a shared repository, in the reporting order", () => {
    const document = `${POPULATION}  - identifier: shared\n    display_name: Shared\n    repositories:\n      - nfdiv-case-api\n`;

    expect(configuredOwners(parseConfiguration(document)).get("nfdiv-case-api")).toEqual(["divorce", "shared"]);
  });

  it("should be empty where the file overrides nothing, which is now the normal case", () => {
    // The estate no longer comes from the file, so a file naming no team is a file that disagrees with no
    // inference — not a misconfiguration a cohort command should refuse.
    expect(configuredOwners(parseConfiguration("version: 1\norganization: hmcts\n")).size).toBe(0);
  });
});

describe("enablementInstants", () => {
  it("should report every repository it is given, dated or not", () => {
    // A repository missing an anchor is reported with that reason and no series, never silently
    // dropped and never defaulted to an instant nobody chose. The estate is passed in now rather than read
    // from the file, so this stays a pure lookup.
    const document = `${POPULATION}enablement:\n  opal-common-lib: 2026-06-01\n`;
    const cohort = ["nfdiv-case-api", "opal-common-lib", "opal-logging-service"];

    const instants = enablementInstants(parseConfiguration(document), cohort);

    expect([...instants.keys()]).toEqual(cohort);
    expect(instants.get("nfdiv-case-api")).toBeUndefined();
    expect(instants.get("opal-common-lib")?.toISOString()).toBe("2026-06-01T00:00:00.000Z");
    expect(instants.get("opal-logging-service")).toBeUndefined();
  });
});

describe("cohort", () => {
  it("should select every visibility and exclude archived by default, over a 90-day window", () => {
    expect(parseConfiguration(VALID).cohort).toMatchObject({
      visibilities: ["public", "internal", "private"],
      include_archived: false,
      active_within_days: 90
    });
  });

  it("should let the window be turned off outright", () => {
    const document = `${VALID}\ncohort:\n  active_within_days: null\n`;

    expect(parseConfiguration(document).cohort.active_within_days).toBeNull();
  });

  it("should narrow to the visibilities a deployment can actually read", () => {
    const document = `${VALID}\ncohort:\n  visibilities:\n    - public\n`;

    expect(parseConfiguration(document).cohort.visibilities).toEqual(["public"]);
  });

  it("should refuse an empty visibility list, which would select nothing at all", () => {
    const document = `${VALID}\ncohort:\n  visibilities: []\n`;

    expect(() => parseConfiguration(document)).toThrow();
  });

  it("should refuse a visibility GitHub does not have", () => {
    const document = `${VALID}\ncohort:\n  visibilities:\n    - secret\n`;

    expect(() => parseConfiguration(document)).toThrow();
  });
});
