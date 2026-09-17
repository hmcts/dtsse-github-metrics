import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sourceSignature } from "../../src/evidence/behaviour/queries.ts";
import { EvidenceSource } from "../../src/evidence/domain/coverage.ts";
import { parseConfiguration } from "../../src/evidence/policy/load.ts";
import { findNulls } from "../../src/evidence/report/absent.ts";
import {
  actorRows,
  directPushRows,
  forgetBuiltRows,
  mergeRows,
  overviewSummary,
  repositoryEvidence,
  repositoryRows,
  teamRows,
  windowOptions
} from "../../src/evidence/report/repositories.ts";
import { prisma } from "../../src/evidence/store/prisma.ts";
import type * as contract from "../../src/lib/types.ts";

/**
 * THE GATE `findNulls` WAS WRITTEN FOR, which nothing ever called.
 *
 * `absent.ts` documents `findNulls` as being "for the gate that asserts the contract holds"; until VIBE-568 its only
 * caller was `absent.test.ts`, over objects that file wrote by hand. So the rule the whole contract rests on — a
 * `null` never reaches a component, an absent key means unmeasured — was asserted against fixtures and never against
 * a report.
 *
 * WHAT THIS ASSERTS AND WHY IT IS NOT REDUNDANT WITH THE TYPES. `src/evidence/report/**` declares the contract's own
 * types now, so a field of the wrong TYPE is a compile error. Three things a declaration still cannot see:
 *
 *   • A `null` from Prisma or a `jsonb` round trip. `undefined` and `null` are the same type to TypeScript's eye at
 *     `?:`, and `null` is what the store hands back — `stripAbsent` removes it and nothing proved that it does.
 *   • A key that survives inside a `Record<string, unknown>` or a `jsonb` payload passed through. `assurance.hygiene`
 *     and `by_severity` are maps by design, and a translation writing a camelCase key into one type-checks.
 *   • Whether the report ever REACHES the branch that emits a field. A declaration says what a function returns; only
 *     a report built against a database says what it returned for a real row.
 *
 * EVERY FIELD LIST BELOW IS COMPILER-CHECKED, which is what stops this file rotting into a stale copy of the
 * contract. `Record<keyof T, true>` fails to build when a field is added, renamed or removed in `src/lib/types.ts`,
 * and `Record<RequiredKeys<T>, true>` fails when one changes between required and optional — the pattern
 * `observation.test.ts` established for one shape, applied here to the twenty-six the reports emit.
 *
 * SEPARATE FROM `report-rows.test.ts` because its fixtures are a different thing. That file states the minimum a case
 * needs and asserts one figure; this one needs a repository with EVERY source populated, or the key sets it compares
 * are the key sets of an empty row.
 */

const ORGANIZATION = "hmcts";
const PULL_REQUESTS = sourceSignature(EvidenceSource.PullRequests);
const DIRECT_COMMITS = sourceSignature(EvidenceSource.DirectCommits);

/**
 * The policy the reports below are built under, written so every optional field has an answer.
 *
 * `alpha` is owned by two teams, so the row's optional `teams` list is populated rather than absent; it is named in
 * `production_repositories`, so the production pair is answered; `dtsse` carries a `display_name`, so the team card's
 * one is not the slug falling back to itself; and `minimum_merges: 1` lets the policy grade a six-merge cohort, which
 * is what makes the substantial counts and both timing medians present.
 */
const CONFIGURATION = parseConfiguration(`
version: 1
organization: hmcts
cohort:
  visibilities:
    - public
  include_archived: false
assessment:
  minimum_merges: 1
production_repositories:
  - alpha
teams:
  - identifier: dtsse
    display_name: Developer Tools
    repositories:
      - alpha
`);

const REFERENCE = new Date(Date.UTC(2026, 8, 1));
const ANCHOR = new Date(Date.UTC(2026, 8, 1));

/**
 * Every field the contract declares on one shape, and which of them it declares REQUIRED.
 *
 * The two lists are separate because they catch different mistakes. `declared` catches a key the report emits and
 * the contract does not name — `display_name` and the four row figures were in that state. `required` catches the
 * reverse: a key the contract promises and the report never sends, which is how `RepositoryDetail.contributors` went
 * unpopulated for months and how `TrendPeriod.alert_observations` was omitted entirely.
 */
interface Shape<T> {
  declared: Record<keyof T, true>;
  required: Record<RequiredKeys<T>, true>;
}

/** The keys `T` declares without a `?`, so a required field the report skips is nameable at compile time. */
type RequiredKeys<T> = { [K in keyof T]-?: Record<string, never> extends Pick<T, K> ? never : K }[keyof T];

/**
 * That one emitted object says exactly what the contract names, and nothing else.
 *
 * The path is carried so a failure names WHICH row and which nested block, the way `findNulls` does: a report is
 * hundreds of rows deep and "a key is wrong" is not a finding anybody can act on.
 */
function assertShape<T>(name: string, shape: Shape<T>, value: unknown, path: string): void {
  expect(typeof value, `${path} should be an object the contract describes`).toBe("object");
  expect(value, `${path} should not be null — absent is a missing key`).not.toBeNull();
  const emitted = Object.keys(value as Record<string, unknown>);
  const declared = Object.keys(shape.declared);
  const undeclared = emitted.filter((key) => !declared.includes(key));
  expect(undeclared, `${path} emits keys ${name} does not declare`).toEqual([]);
  const missing = Object.keys(shape.required).filter((key) => !emitted.includes(key));
  expect(missing, `${path} omits keys ${name} declares as required`).toEqual([]);
}

const REPOSITORY_ROW: Shape<contract.RepositoryRow> = {
  declared: {
    repository: true,
    team: true,
    teams: true,
    owner_kind: true,
    pushed_at: true,
    visibility: true,
    archived: true,
    unmaintained: true,
    assurance: true,
    readiness: true,
    merged_pull_requests: true,
    direct_commits: true,
    currently_open: true,
    stale_open: true,
    finding_occurrences: true,
    required_approving_reviews: true,
    required_status_checks: true,
    unreviewed_substantial: true,
    unreviewed_substantial_merges: true,
    substantial_merges: true,
    time_to_first_review_hours: true,
    merge_cycle_time_hours: true,
    sonar_coverage: true,
    sonar_reported: true,
    security: true,
    sonar_security_rating: true,
    sonar_security_issues: true,
    detail: true,
    production: true,
    production_source: true
  },
  required: { repository: true, team: true }
};

const ASSURANCE_REPORT: Shape<contract.AssuranceReport> = {
  declared: { grade: true, criteria: true, hygiene: true, oldest_severe_alert_days: true },
  required: { grade: true, criteria: true }
};

const ASSURANCE_CRITERION: Shape<contract.AssuranceCriterionResult> = {
  declared: { criterion: true, outcome: true, detail: true },
  required: { criterion: true, outcome: true, detail: true }
};

const SECURITY_ALERTS: Shape<contract.SecurityAlertEvidence> = {
  declared: { dependabot: true, code_scanning: true, secret_scanning: true },
  required: { dependabot: true, code_scanning: true, secret_scanning: true }
};

const ALERT_COUNT: Shape<contract.OpenAlertCount> = {
  declared: { open: true, by_severity: true, detail: true },
  required: { by_severity: true }
};

const OVERVIEW: Shape<contract.OverviewSummary> = {
  declared: {
    organization: true,
    weeks: true,
    starts_at: true,
    ends_at: true,
    built_at: true,
    collected_through: true,
    repositories: true,
    unavailable: true,
    teams: true,
    actors: true,
    merged_pull_requests: true,
    direct_commits: true,
    labels: true
  },
  required: {
    organization: true,
    weeks: true,
    starts_at: true,
    ends_at: true,
    built_at: true,
    repositories: true,
    unavailable: true,
    teams: true,
    actors: true,
    merged_pull_requests: true,
    direct_commits: true,
    labels: true
  }
};

const TEAM_ROW: Shape<contract.TeamRow> = {
  declared: { team: true, display_name: true, repositories: true, unavailable: true, actors: true, practice: true, labels: true },
  required: { team: true, repositories: true, unavailable: true, actors: true, labels: true }
};

const TEAM_PRACTICE: Shape<contract.TeamPractice> = {
  declared: {
    gates_measured: true,
    enforces_review: true,
    checks_measured: true,
    enforces_checks: true,
    unreviewed_measured: true,
    unreviewed_clear: true,
    unreviewed_within: true,
    unreviewed_above: true,
    unreviewed_substantial_merges: true,
    substantial_merges: true,
    merged_pull_requests: true,
    direct_commits: true,
    time_to_first_review_hours: true,
    merge_cycle_time_hours: true
  },
  required: {
    gates_measured: true,
    enforces_review: true,
    checks_measured: true,
    enforces_checks: true,
    unreviewed_measured: true,
    unreviewed_clear: true,
    unreviewed_within: true,
    unreviewed_above: true,
    merged_pull_requests: true,
    direct_commits: true
  }
};

const ACTOR_ROW: Shape<contract.ActorRow> = {
  declared: { login: true, name: true, repositories: true, labels: true },
  required: { login: true, repositories: true }
};

const MERGE_ROW: Shape<contract.TeamMergeRow> = {
  declared: { repository: true, number: true, merged_at: true, author: true, reviewed: true, ci: true, lines: true, files: true },
  required: { repository: true, number: true, merged_at: true }
};

const DIRECT_PUSH_ROW: Shape<contract.TeamDirectPushRow> = {
  declared: { repository: true, sha: true, committed_at: true, author: true, ci: true, lines: true, files: true },
  required: { repository: true, sha: true, committed_at: true }
};

const WINDOW_OPTIONS: Shape<contract.WindowOptions> = {
  declared: { options: true, default: true, trend_periods: true, collected_through: true, collection_stale: true },
  required: { options: true, default: true, trend_periods: true, collection_stale: true }
};

const PRACTICE_EVIDENCE: Shape<contract.RepositoryPracticeEvidence> = {
  declared: {
    repository: true,
    team: true,
    starts_at: true,
    ends_at: true,
    provenance: true,
    cohort: true,
    assessment: true,
    unreviewed_substantial: true,
    merge_gate: true,
    open_pull_requests: true,
    security: true,
    codeowners: true,
    maintenance: true,
    sonar: true,
    metrics: true,
    behaviour: true
  },
  required: {
    repository: true,
    team: true,
    starts_at: true,
    ends_at: true,
    provenance: true,
    cohort: true,
    merge_gate: true,
    open_pull_requests: true,
    security: true,
    codeowners: true,
    maintenance: true,
    sonar: true,
    metrics: true,
    behaviour: true
  }
};

const PROVENANCE: Shape<contract.WindowProvenance> = {
  declared: { offline: true, intervals_fetched: true },
  required: { offline: true, intervals_fetched: true }
};

const COHORT_SUMMARY: Shape<contract.CohortSummary> = {
  declared: { merged: true, reported: true, excluded_authors: true, direct_commits: true },
  required: { excluded_authors: true }
};

const ASSESSMENT: Shape<contract.ReadinessAssessment> = {
  declared: { label: true, blocking: true, caution: true, clear: true },
  required: { label: true, blocking: true, caution: true, clear: true }
};

const CONDITION: Shape<contract.ReadinessCondition> = {
  declared: { condition: true, label: true, detail: true, informational: true },
  required: { condition: true, detail: true }
};

const GATE_REPORT: Shape<contract.MergeGateReport> = {
  declared: { fetched_at: true, gate: true, detail: true },
  required: {}
};

const GATE_EVIDENCE: Shape<contract.MergeGateEvidence> = {
  declared: {
    branch: true,
    protected: true,
    pull_requests: true,
    status_checks: true,
    restricts_deletions: true,
    blocks_force_pushes: true,
    applies_to_administrators: true,
    rules_observed: true,
    requires_linear_history: true,
    restricts_branch_names: true,
    unmodelled_rules: true
  },
  required: {
    branch: true,
    protected: true,
    pull_requests: true,
    status_checks: true,
    restricts_deletions: true,
    blocks_force_pushes: true,
    rules_observed: true,
    requires_linear_history: true,
    restricts_branch_names: true,
    unmodelled_rules: true
  }
};

const PULL_REQUEST_RULE: Shape<contract.PullRequestRule> = {
  declared: {
    dismiss_stale_reviews_on_push: true,
    require_code_owner_review: true,
    require_last_push_approval: true,
    required_approving_review_count: true,
    required_review_thread_resolution: true
  },
  required: {
    dismiss_stale_reviews_on_push: true,
    require_code_owner_review: true,
    require_last_push_approval: true,
    required_approving_review_count: true
  }
};

const STATUS_CHECKS_RULE: Shape<contract.StatusChecksRule> = {
  declared: { strict_required_status_checks_policy: true, required_status_checks: true },
  required: { strict_required_status_checks_policy: true, required_status_checks: true }
};

const STATUS_CHECK: Shape<contract.StatusCheck> = {
  declared: { context: true, integration_id: true },
  required: { context: true }
};

const SECURITY_REPORT: Shape<contract.SecurityAlertReport> = {
  declared: { fetched_at: true, alerts: true, detail: true },
  required: {}
};

const CODEOWNERS_REPORT: Shape<contract.CodeownersReport> = {
  declared: { fetched_at: true, codeowners: true, detail: true },
  required: {}
};

const MAINTENANCE_REPORT: Shape<contract.MaintenanceReport> = {
  declared: { fetched_at: true, maintenance: true, windows: true, detail: true },
  required: { windows: true }
};

const SONAR_REPORT: Shape<contract.SonarReport> = {
  declared: { fetched_at: true, mapping: true, measures: true, detail: true },
  required: {}
};

const OPEN_PULL_REQUEST_REPORT: Shape<contract.OpenPullRequestReport> = {
  declared: { fetched_at: true, starts_at: true, ends_at: true, summary: true, detail: true },
  required: {}
};

const METRIC_SUMMARY: Shape<contract.BehaviourMetricSummary> = {
  declared: { metric: true, summary: true, classifications: true },
  required: { metric: true, summary: true, classifications: true }
};

const RATE: Shape<contract.RateObservation> = {
  declared: { status: true, numerator: true, denominator: true },
  required: { status: true, numerator: true, denominator: true }
};

const DISTRIBUTION: Shape<contract.DistributionObservation> = {
  declared: { status: true, sample_size: true, unit: true, median: true, percentile_75: true, percentile_90: true },
  required: { status: true, sample_size: true, unit: true }
};

/** A rate carries no `unit`; a distribution carries one even when it observed nothing. The contract's own rule. */
function assertObservation(value: unknown, path: string): void {
  if (value !== null && typeof value === "object" && "unit" in value) {
    assertShape("DistributionObservation", DISTRIBUTION, value, path);
    return;
  }
  assertShape("RateObservation", RATE, value, path);
}

function assertAssessment(value: unknown, path: string): void {
  assertShape("ReadinessAssessment", ASSESSMENT, value, path);
  const assessment = value as contract.ReadinessAssessment;
  for (const group of ["blocking", "caution", "clear"] as const) {
    for (const [index, condition] of assessment[group].entries()) {
      assertShape("ReadinessCondition", CONDITION, condition, `${path}.${group}[${index}]`);
    }
  }
}

function assertAlerts(value: unknown, path: string): void {
  assertShape("SecurityAlertEvidence", SECURITY_ALERTS, value, path);
  const alerts = value as contract.SecurityAlertEvidence;
  for (const family of ["dependabot", "code_scanning", "secret_scanning"] as const) {
    assertShape("OpenAlertCount", ALERT_COUNT, alerts[family], `${path}.${family}`);
  }
}

function assertRepositoryRow(row: contract.RepositoryRow, path: string): void {
  assertShape("RepositoryRow", REPOSITORY_ROW, row, path);
  if (row.assurance !== undefined) {
    assertShape("AssuranceReport", ASSURANCE_REPORT, row.assurance, `${path}.assurance`);
    for (const [index, criterion] of row.assurance.criteria.entries()) {
      assertShape("AssuranceCriterionResult", ASSURANCE_CRITERION, criterion, `${path}.assurance.criteria[${index}]`);
    }
  }
  if (row.security !== undefined) {
    assertAlerts(row.security, `${path}.security`);
  }
}

/** One owner of one repository, as the ownership ladder resolved it. */
async function graphOwnership(repository: string, ownerKind: string, owner: string, rung: string): Promise<void> {
  await prisma.repositoryOwnership.create({
    data: {
      organization: ORGANIZATION,
      repository,
      ownerKind,
      owner,
      rung,
      payload: {},
      observedAt: new Date(Date.UTC(2026, 7, 15)),
      lastObservedAt: new Date(Date.UTC(2026, 7, 15)),
      digest: `${repository}-${ownerKind}-${owner}-digest`
    }
  });
}

async function graphRepository(repository: string, owners: readonly string[] = ["dtsse"]): Promise<void> {
  await prisma.orgRepository.create({
    data: {
      organization: ORGANIZATION,
      repository,
      archived: false,
      visibility: "PUBLIC",
      pushedAt: new Date(Date.UTC(2026, 7, 20)),
      payload: { defaultBranch: "main", isFork: false },
      observedAt: new Date(Date.UTC(2026, 7, 15)),
      lastObservedAt: new Date(Date.UTC(2026, 7, 15)),
      digest: `${repository}-digest`
    }
  });
  for (const owner of owners) {
    await graphOwnership(repository, "team", owner, "teams-api-admin");
  }
}

/**
 * A collected state with EVERY source the collector writes populated.
 *
 * The point of this fixture, and what separates it from `report-rows.test.ts`'s `readableGate`: a row assembled from
 * a payload holding only a default branch takes the absent branch of nearly every field, so the key set it emits is
 * the key set of a row that could report nothing. The assurance evidence, the three alert families and a gate with
 * both rule kinds are what make the assertions below reach the fields they are about.
 */
function collectedPayload() {
  return {
    defaultBranch: "main",
    deploysToProduction: true,
    mergeGate: {
      gate: {
        branch: "main",
        protected: true,
        rulesObserved: true,
        appliesToAdministrators: true,
        pullRequests: [{ requiredApprovingReviewCount: 2, dismissStaleReviewsOnPush: true, requireCodeOwnerReview: false, requireLastPushApproval: true }],
        statusChecks: [{ contexts: ["build", "lint"], strictRequiredStatusChecksPolicy: true }],
        restrictsDeletions: true,
        blocksForcePushes: true,
        requiresLinearHistory: false,
        restrictsBranchNames: false,
        unmodelledRules: ["some_future_rule"]
      }
    },
    securityAlerts: {
      dependabot: { open: 3, bySeverity: { critical: 1, high: 2 } },
      codeScanning: { open: 0, bySeverity: {} },
      // A family GitHub refused, which is the shape that carries a `detail` and no `open`.
      secretScanning: { bySeverity: {}, detail: "secret scanning could not be read for this repository" }
    },
    assurance: {
      hygiene: { secretScanning: true, pushProtection: false, vulnerabilityAlerts: true, dependabotSecurityUpdates: true, updateConfiguration: true },
      severeAlertsRead: true,
      secretsRead: true,
      securityPolicy: true,
      oldestSevereAlertDays: 41,
      secrets: { open: 0, oldestOpenDays: undefined }
    }
  };
}

/** The coverage a finished walk of both sources leaves, which is what says a repository was READ. */
async function walked(repository: string): Promise<void> {
  await prisma.sourceCoverage.createMany({
    data: [EvidenceSource.PullRequests, EvidenceSource.DirectCommits].map((source) => ({
      organization: ORGANIZATION,
      repository,
      source,
      queryHash: source === EvidenceSource.PullRequests ? PULL_REQUESTS : DIRECT_COMMITS,
      startsAt: new Date(Date.UTC(2026, 0, 1)),
      endsAt: ANCHOR,
      accessedAt: new Date()
    }))
  });
}

/**
 * One merged pull request with reviews and checks, so the metrics observe distributions rather than empty samples.
 *
 * Sized differently per identifier so the percentiles are placeable and distinct — a cohort of identical merges
 * reports a median and no p75, which would leave two of the fields this file is about unexercised.
 */
async function mergedPullRequest(repository: string, identifier: number): Promise<void> {
  const mergedAt = new Date(Date.UTC(2026, 7, 10, identifier));
  const readyAt = new Date(mergedAt.getTime() - 4 * 3_600_000);
  const reviewedAt = new Date(mergedAt.getTime() - 2 * 3_600_000);
  await prisma.pullRequestFact.create({
    data: {
      organization: ORGANIZATION,
      repository,
      queryHash: PULL_REQUESTS,
      identifier: BigInt(identifier),
      mergedAt,
      payload: {
        identifier,
        number: identifier,
        createdAt: readyAt.toISOString(),
        readyForReviewAt: readyAt.toISOString(),
        mergedAt: mergedAt.toISOString(),
        authorLogin: "ada",
        authorType: "User",
        additions: identifier * 30,
        deletions: 2,
        changedFiles: 3,
        draft: false,
        reviews: [{ identifier, submittedAt: reviewedAt.toISOString(), state: "APPROVED", authorLogin: "grace", authorType: "User", commentCount: 2 }],
        checks: [{ name: "build", conclusion: "SUCCESS", completedAt: reviewedAt.toISOString() }]
      }
    }
  });
}

async function directCommit(repository: string, sha: string): Promise<void> {
  const committedAt = new Date(Date.UTC(2026, 7, 12));
  await prisma.directCommitFact.create({
    data: {
      organization: ORGANIZATION,
      repository,
      queryHash: DIRECT_COMMITS,
      sha,
      committedAt,
      payload: {
        sha,
        repository,
        committedAt: committedAt.toISOString(),
        authorLogin: "alan",
        authorType: "User",
        checkState: "SUCCESS",
        additions: 4,
        deletions: 1,
        changedFiles: 1
      }
    }
  });
}

/**
 * The estate every case below reports over: one repository with everything, and one with nothing.
 *
 * BOTH BRANCHES OF `repositoryRow`, because they build different objects. The reportable branch is where a field can
 * be misnamed; the unavailable branch is where a REQUIRED field can be forgotten — which is exactly what happened to
 * `TeamRow.actors` and `unavailable`, and it took `/teams/<team>` down for every team on the estate.
 */
async function seedEstate(): Promise<void> {
  await graphRepository("alpha", ["dtsse", "platform"]);
  await prisma.repositoryState.create({
    data: { organization: ORGANIZATION, repository: "alpha", fetchedAt: new Date(Date.UTC(2026, 7, 25)), payload: collectedPayload() }
  });
  await walked("alpha");
  for (let identifier = 1; identifier <= 6; identifier += 1) {
    await mergedPullRequest("alpha", identifier);
  }
  await directCommit("alpha", "aaaaaaa");
  await prisma.repositoryProduction.create({ data: { organization: ORGANIZATION, repository: "alpha", production: true } });

  await graphRepository("beta");
}

async function clear(): Promise<void> {
  await prisma.pullRequestFact.deleteMany();
  await prisma.directCommitFact.deleteMany();
  await prisma.repositoryState.deleteMany();
  await prisma.repositoryOwnership.deleteMany();
  await prisma.orgRepository.deleteMany();
  await prisma.sourceCoverage.deleteMany();
  await prisma.repositoryProduction.deleteMany();
}

beforeEach(async () => {
  forgetBuiltRows();
  await clear();
  await seedEstate();
});

afterAll(async () => {
  await clear();
  await prisma.$disconnect();
});

describe("the key set every report emits", () => {
  it("should emit only the fields RepositoryRow declares, on both the reported and the unavailable row", async () => {
    const rows = await repositoryRows(CONFIGURATION, 26, REFERENCE);

    expect(rows.map((row) => row.repository).sort()).toEqual(["alpha", "beta"]);
    for (const row of rows) {
      assertRepositoryRow(row, `repositoryRows[${row.repository}]`);
    }
    // The populated row reaches the fields this file exists to check: without these the assertions above would be
    // passing over a row that emitted almost nothing.
    const alpha = rows.find((row) => row.repository === "alpha");
    expect(alpha).toMatchObject({ team: "dtsse", owner_kind: "team", visibility: "public", archived: false, production: true, production_source: "marked" });
    expect(alpha?.teams).toEqual(["dtsse", "platform"]);
    expect(alpha?.merged_pull_requests).toBe(6);
    expect(alpha?.direct_commits).toBe(1);
    expect(alpha?.required_approving_reviews).toBe(2);
    expect(alpha?.required_status_checks).toBe(2);
    expect(alpha?.time_to_first_review_hours).toBe(2);
    expect(alpha?.assurance?.criteria.length).toBeGreaterThan(0);
    expect(alpha?.security?.dependabot.open).toBe(3);
  });

  it("should emit only the fields OverviewSummary declares", async () => {
    const summary = await overviewSummary(CONFIGURATION, 26, REFERENCE);

    assertShape("OverviewSummary", OVERVIEW, summary, "overviewSummary");
    expect(summary).toMatchObject({ organization: "hmcts", repositories: 2, merged_pull_requests: 6 });
  });

  it("should emit only the fields TeamRow and TeamPractice declare", async () => {
    const cards = await teamRows(CONFIGURATION, 26, REFERENCE);

    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards) {
      assertShape("TeamRow", TEAM_ROW, card, `teamRows[${card.team}]`);
      if (card.practice !== undefined) {
        assertShape("TeamPractice", TEAM_PRACTICE, card.practice, `teamRows[${card.team}].practice`);
      }
    }
    // `actors` IS A NUMBER on a card and a list on `TeamDetail`, which is the collision that blanked all 154 cards.
    // A shape assertion cannot see it — both are declared — so the type is stated here.
    const dtsse = cards.find((card) => card.team === "dtsse");
    expect(typeof dtsse?.actors).toBe("number");
    expect(dtsse?.actors).toBe(2);
    expect(dtsse?.display_name).toBe("Developer Tools");
  });

  it("should emit only the fields ActorRow declares", async () => {
    const actors = await actorRows(CONFIGURATION, 26, REFERENCE);

    expect(actors.map((actor) => actor.login)).toEqual(["ada", "alan"]);
    for (const actor of actors) {
      assertShape("ActorRow", ACTOR_ROW, actor, `actorRows[${actor.login}]`);
    }
  });

  it("should emit only the fields the two activity rows declare", async () => {
    const merges = await mergeRows(CONFIGURATION, 26, REFERENCE);
    const pushes = await directPushRows(CONFIGURATION, 26, REFERENCE);

    expect(merges).toHaveLength(6);
    expect(pushes).toHaveLength(1);
    for (const [index, row] of merges.entries()) {
      assertShape("TeamMergeRow", MERGE_ROW, row, `mergeRows[${index}]`);
    }
    for (const [index, row] of pushes.entries()) {
      assertShape("TeamDirectPushRow", DIRECT_PUSH_ROW, row, `directPushRows[${index}]`);
    }
  });

  it("should emit only the fields WindowOptions declares", async () => {
    const options = await windowOptions(CONFIGURATION, REFERENCE);

    assertShape("WindowOptions", WINDOW_OPTIONS, options, "windowOptions");
    expect(options.options).toEqual([1, 4, 8, 12, 26]);
  });

  it("should emit only the fields RepositoryPracticeEvidence declares, section by section", async () => {
    // THE DEEPEST OBJECT THE CONTRACT DECLARES, and the one two shipped defects were inside. `merge_gate.gate` and
    // `security.alerts` are the two translations that took `/repositories/[repository]` down — each read as the
    // domain's identically-named interface, each type-checking, each throwing at the `.map` a component made.
    const evidence = await repositoryEvidence(CONFIGURATION, "alpha", 26, { pullRequests: true, directCommits: true }, REFERENCE);

    expect(evidence).toBeDefined();
    if (evidence === undefined) {
      return;
    }
    assertShape("RepositoryPracticeEvidence", PRACTICE_EVIDENCE, evidence, "repositoryEvidence");
    assertShape("WindowProvenance", PROVENANCE, evidence.provenance, "repositoryEvidence.provenance");
    assertShape("CohortSummary", COHORT_SUMMARY, evidence.cohort, "repositoryEvidence.cohort");
    assertAssessment(evidence.assessment, "repositoryEvidence.assessment");

    assertShape("MergeGateReport", GATE_REPORT, evidence.merge_gate, "repositoryEvidence.merge_gate");
    const gate = evidence.merge_gate.gate;
    expect(gate, "the fixture states a readable gate, so the report has one to translate").toBeDefined();
    if (gate !== undefined) {
      assertShape("MergeGateEvidence", GATE_EVIDENCE, gate, "repositoryEvidence.merge_gate.gate");
      for (const [index, rule] of gate.pull_requests.entries()) {
        assertShape("PullRequestRule", PULL_REQUEST_RULE, rule, `repositoryEvidence.merge_gate.gate.pull_requests[${index}]`);
      }
      for (const [index, rule] of gate.status_checks.entries()) {
        assertShape("StatusChecksRule", STATUS_CHECKS_RULE, rule, `repositoryEvidence.merge_gate.gate.status_checks[${index}]`);
        // THE STRUCTURAL HALF of that translation, which a rename would not have caught: the domain holds a rule's
        // contexts as `string[]` and the contract declares a list of objects with a `context` each.
        for (const [position, check] of rule.required_status_checks.entries()) {
          assertShape("StatusCheck", STATUS_CHECK, check, `repositoryEvidence.merge_gate.gate.status_checks[${index}].required_status_checks[${position}]`);
        }
      }
    }

    assertShape("SecurityAlertReport", SECURITY_REPORT, evidence.security, "repositoryEvidence.security");
    expect(evidence.security.alerts).toBeDefined();
    if (evidence.security.alerts !== undefined) {
      assertAlerts(evidence.security.alerts, "repositoryEvidence.security.alerts");
    }

    assertShape("CodeownersReport", CODEOWNERS_REPORT, evidence.codeowners, "repositoryEvidence.codeowners");
    assertShape("MaintenanceReport", MAINTENANCE_REPORT, evidence.maintenance, "repositoryEvidence.maintenance");
    assertShape("SonarReport", SONAR_REPORT, evidence.sonar, "repositoryEvidence.sonar");
    assertShape("OpenPullRequestReport", OPEN_PULL_REQUEST_REPORT, evidence.open_pull_requests, "repositoryEvidence.open_pull_requests");

    expect(evidence.metrics.length).toBeGreaterThan(0);
    for (const [index, metric] of evidence.metrics.entries()) {
      assertShape("BehaviourMetricSummary", METRIC_SUMMARY, metric, `repositoryEvidence.metrics[${index}]`);
      // `sampleSize` reaching here is what printed "undefined samples" under three of the nine cards on every
      // repository page, and it type-checked because both files call the interface `DistributionObservation`.
      assertObservation(metric.summary, `repositoryEvidence.metrics[${index}].summary`);
    }
    // Both observation shapes are reached, so neither arm of `assertObservation` is asserting nothing: the rates and
    // the distributions are different translations and a cohort producing only one kind would exercise only one.
    const kinds = new Set(evidence.metrics.map((metric) => ("unit" in metric.summary ? "distribution" : "rate")));
    expect([...kinds].sort()).toEqual(["distribution", "rate"]);
  });
});

/**
 * The `null` half of the contract, which is what `findNulls` was written to assert and nothing asserted.
 *
 * `stripAbsent` runs on the way out of every report because Prisma and a `jsonb` round trip both hand back `null`,
 * and a `null` reaching a component renders as `0` or throws on a `.toFixed()`. TypeScript cannot see the difference
 * at a `?:`, so this is the one rule in the whole contract that only a report built against a database can prove.
 */
describe("the absent-versus-null rule the reports emit under", () => {
  it("should carry no null anywhere in any of the six estate reports", async () => {
    const reports: [string, unknown][] = [
      ["repositoryRows", await repositoryRows(CONFIGURATION, 26, REFERENCE)],
      ["overviewSummary", await overviewSummary(CONFIGURATION, 26, REFERENCE)],
      ["teamRows", await teamRows(CONFIGURATION, 26, REFERENCE)],
      ["actorRows", await actorRows(CONFIGURATION, 26, REFERENCE)],
      ["mergeRows", await mergeRows(CONFIGURATION, 26, REFERENCE)],
      ["directPushRows", await directPushRows(CONFIGURATION, 26, REFERENCE)],
      ["windowOptions", await windowOptions(CONFIGURATION, REFERENCE)]
    ];

    for (const [name, report] of reports) {
      expect(findNulls(report), `${name} carries a null, which the contract says is a missing key`).toEqual([]);
    }
  });

  it("should carry no null anywhere in the evidence block, which is the deepest thing a page reads", async () => {
    const evidence = await repositoryEvidence(CONFIGURATION, "alpha", 26, { pullRequests: true, directCommits: true }, REFERENCE);

    expect(findNulls(evidence)).toEqual([]);
  });

  it("should find the null a report would have carried, so the two cases above can fail", async () => {
    // THE GATE'S OWN GATE. `findNulls` returning `[]` for everything would pass both cases above whatever the
    // reports emitted, and a helper nothing can distrust is a helper nothing is checking. A row with a `null` where
    // the store would have put one is what the assertions are meant to catch.
    const rows = await repositoryRows(CONFIGURATION, 26, REFERENCE);
    const tampered = rows.map((row) => ({ ...row, sonar_coverage: null }));

    expect(findNulls(tampered)).toEqual(["[0].sonar_coverage", "[1].sonar_coverage"]);
  });
});
