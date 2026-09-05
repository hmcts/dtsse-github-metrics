import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigurationError, parseConfiguration } from "./load.ts";
import { configuredRepositories, enablementInstants, ownedRepositories, repositoryOwners, sonarOrganizationName } from "./repositories.ts";
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
      stale_collection_days: 8
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

  it("should reject a repository owned by more than one team", () => {
    const document = `${POPULATION}  - identifier: shared\n    display_name: Shared\n    repositories:\n      - nfdiv-case-api\n`;

    expect(() => parseConfiguration(document)).toThrow(/repositories may belong to only one team: nfdiv-case-api/);
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

  it("should reject an enablement date for a repository the configuration does not own", () => {
    const document = `${VALID}\nenablement:\n  civil-servce: 2026-06-01\n`;

    expect(() => parseConfiguration(document)).toThrow(/enablement dates must name a configured repository: civil-servce/);
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

  it("should reject a sonar project for a repository the configuration does not own", () => {
    const document = `${VALID}\nsonar_projects:\n  civil-servce: key\n`;

    expect(() => parseConfiguration(document)).toThrow(/sonar projects must name a configured repository: civil-servce/);
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

describe("ownedRepositories", () => {
  it("should order by team and then repository, so editing the file cannot reorder a report", () => {
    // The file lists `opal` before `divorce`, and opal's second repository before its first.
    expect(ownedRepositories(parseConfiguration(POPULATION))).toEqual([
      ["divorce", "nfdiv-case-api"],
      ["opal", "opal-common-lib"],
      ["opal", "opal-logging-service"]
    ]);
  });

  it("should list every configured repository in the reporting order", () => {
    expect(configuredRepositories(parseConfiguration(POPULATION))).toEqual(["nfdiv-case-api", "opal-common-lib", "opal-logging-service"]);
  });
});

describe("repositoryOwners", () => {
  it("should name the team that owns each repository", () => {
    expect([...repositoryOwners(parseConfiguration(POPULATION))]).toEqual([
      ["nfdiv-case-api", "divorce"],
      ["opal-common-lib", "opal"],
      ["opal-logging-service", "opal"]
    ]);
  });
});

describe("enablementInstants", () => {
  it("should report every repository in the reporting order, dated or not", () => {
    // A repository missing an anchor is reported with that reason and no series, never silently
    // dropped and never defaulted to an instant nobody chose.
    const document = `${POPULATION}enablement:\n  opal-common-lib: 2026-06-01\n`;

    const instants = enablementInstants(parseConfiguration(document));

    expect([...instants.keys()]).toEqual(["nfdiv-case-api", "opal-common-lib", "opal-logging-service"]);
    expect(instants.get("nfdiv-case-api")).toBeUndefined();
    expect(instants.get("opal-common-lib")?.toISOString()).toBe("2026-06-01T00:00:00.000Z");
    expect(instants.get("opal-logging-service")).toBeUndefined();
  });
});
