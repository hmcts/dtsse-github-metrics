import { describe, expect, it } from "vitest";
import type { Merges, PullRequestFact, ReviewFact } from "../domain/facts.ts";
import { ReviewState } from "../domain/facts.ts";
import type { CohortEntry } from "../org/cohort.ts";
import { OwnerKind } from "../org/graph.ts";
import { parseConfiguration } from "../policy/load.ts";
import { SONAR_UNATTEMPTED_DETAIL } from "./contract/sonar.ts";
import type { MeasuredRow } from "./measured.ts";
import { builtRepositoryEvidence, type RepositoryEvidenceInput } from "./repository-evidence.ts";

/**
 * One repository's evidence block, section by section.
 *
 * THREE SECTIONS CAN ONLY STATE AN ABSENCE and say so in their own `detail`: open pull requests, CODEOWNERS and
 * maintenance are not collected at all, and reporting them as empty would be indistinguishable from a repository
 * that genuinely has no CODEOWNERS file — which is the one confusion this contract exists to prevent. The Sonar
 * section left that group on 2026-09-17, and the two cases about its wording are what replaced it.
 */

const CONFIGURATION = parseConfiguration(`
version: 1
organization: hmcts
assessment:
  minimum_merges: 1
cohort:
  excluded_authors:
    - ignored-human
  bot_accounts:
    - renovate[bot]
`);

const WINDOW = { startsAt: new Date(Date.UTC(2026, 7, 20)), endsAt: new Date(Date.UTC(2026, 8, 17)) };
const FETCHED = new Date(Date.UTC(2026, 7, 25));
const BOTH: MeasuredRow = { pullRequests: true, directCommits: true };

const ENTRY: CohortEntry = {
  repository: "alpha",
  owners: ["dtsse", "platform"],
  ownerKind: OwnerKind.Team,
  archived: false,
  visibility: "public",
  behaviourCollectable: true,
  unmaintained: false
};

const GATE = {
  branch: "main",
  protected: true,
  pullRequests: [{ requiredApprovingReviewCount: 2, dismissStaleReviewsOnPush: true, requireCodeOwnerReview: false, requireLastPushApproval: true }],
  statusChecks: [{ contexts: ["build"], strictRequiredStatusChecksPolicy: true }],
  restrictsDeletions: true,
  blocksForcePushes: true,
  appliesToAdministrators: true,
  rulesObserved: true,
  requiresLinearHistory: false,
  restrictsBranchNames: false,
  unmodelledRules: []
};

function review(submittedAt: Date): ReviewFact {
  return { identifier: 1, submittedAt, state: ReviewState.Approved, authorLogin: "grace", authorType: "User", commentCount: 1 };
}

function merge(identifier: number, authorLogin = "ada"): PullRequestFact {
  const mergedAt = new Date(Date.UTC(2026, 7, 25, identifier));
  return {
    identifier,
    repository: "alpha",
    number: identifier,
    createdAt: new Date(mergedAt.getTime() - 4 * 3_600_000),
    readyForReviewAt: new Date(mergedAt.getTime() - 4 * 3_600_000),
    mergedAt,
    draft: false,
    authorLogin,
    authorType: "User",
    additions: 120,
    deletions: 4,
    changedFiles: 6,
    reviews: [review(new Date(mergedAt.getTime() - 2 * 3_600_000))],
    checks: []
  };
}

function input(overrides: Partial<RepositoryEvidenceInput> = {}): RepositoryEvidenceInput {
  const walked: Merges = { pullRequests: [merge(1), merge(2)], directCommits: [] };
  return {
    repository: "alpha",
    entry: ENTRY,
    state: { fetchedAt: FETCHED, payload: { defaultBranch: "main", mergeGate: { gate: GATE } } },
    walked,
    window: WINDOW,
    measured: BOTH,
    // NO SCAN ROW BY DEFAULT, which is what a repository nothing has walked since VIBE-597 looks like — and the
    // case whose three families must still all reach the contract rather than being omitted.
    scans: [],
    ...overrides
  };
}

describe("one repository's evidence block", () => {
  it("should name the repository, its leading owner and the window it covers", () => {
    const evidence = builtRepositoryEvidence(CONFIGURATION, input());

    expect(evidence).toMatchObject({
      repository: "alpha",
      team: "dtsse",
      starts_at: "2026-08-20T00:00:00.000Z",
      ends_at: "2026-09-17T00:00:00.000Z"
    });
  });

  it("should report an empty team rather than omit it when nothing owns the repository", () => {
    const evidence = builtRepositoryEvidence(CONFIGURATION, input({ entry: { ...ENTRY, owners: [] } }));

    expect(evidence.team).toBe("");
  });

  it("should state that no interval was fetched, because a report is served from what a collection left", () => {
    expect(builtRepositoryEvidence(CONFIGURATION, input()).provenance).toEqual({ offline: true, intervals_fetched: 0 });
  });

  it("should say in each section's own words that three of them are not collected", () => {
    // An empty section here would read as a repository with nothing to report, so each names the thing that would
    // have collected it.
    const evidence = builtRepositoryEvidence(CONFIGURATION, input());

    expect(evidence.open_pull_requests.detail).toBe("open pull-request state is not collected");
    expect(evidence.codeowners.detail).toContain("the CODEOWNERS file is not read for this report");
    expect(evidence.maintenance).toEqual({ windows: [], detail: "maintenance windows are not collected" });
  });

  it("should distinguish a repository nothing has looked at from one with no SonarCloud project", () => {
    // The wording every repository in the estate used to carry claimed the second while the truth was the first.
    const unattempted = builtRepositoryEvidence(CONFIGURATION, input());
    const looked = builtRepositoryEvidence(
      CONFIGURATION,
      input({ state: { fetchedAt: FETCHED, payload: { sonar: { detail: "no SonarCloud project in hmcts analyses this repository" } } } })
    );

    expect(unattempted.sonar).toEqual({ detail: SONAR_UNATTEMPTED_DETAIL });
    expect(looked.sonar.detail).toBe("no SonarCloud project in hmcts analyses this repository");
  });

  it("should carry a mapped project's measures through to the section that renders them", () => {
    const evidence = builtRepositoryEvidence(
      CONFIGURATION,
      input({
        state: {
          fetchedAt: FETCHED,
          payload: {
            sonar: {
              mapping: { projectKey: "hmcts.cath", repository: "cath-service", method: "analysis_revision" },
              measures: { projectKey: "hmcts.cath", coverage: 92.5, duplicatedLinesDensity: 1.2, securityRating: { value: 1 } }
            }
          }
        }
      })
    );

    expect(evidence.sonar.mapping).toEqual({ project_key: "hmcts.cath", repository: "cath-service", method: "analysis_revision" });
    expect(evidence.sonar.measures?.coverage).toBe(92.5);
    // The rename that would silently render a dash for a figure the collection holds.
    expect(evidence.sonar.measures?.duplicated_lines_density).toBe(1.2);
  });

  it("should report an empty findings list, which nothing produces and nothing configures", () => {
    expect(builtRepositoryEvidence(CONFIGURATION, input()).behaviour).toEqual([]);
  });
});

describe("the cohort cards on one repository's page", () => {
  it("should count what was walked and what is reported as two counts of one window", () => {
    const walked: Merges = { pullRequests: [merge(1), merge(2, "ignored-human")], directCommits: [] };

    const evidence = builtRepositoryEvidence(CONFIGURATION, input({ walked }));

    expect(evidence.cohort.merged).toBe(2);
    expect(evidence.cohort.reported).toBe(1);
  });

  it("should name every author the difference is owed to", () => {
    // A REAL SPLIT: `reported` used to equal `merged` and this map used to be empty, which was an honest statement
    // of a service that applied `cohort.excluded_authors` to nothing at all.
    const walked: Merges = { pullRequests: [merge(1), merge(2, "ignored-human")], directCommits: [] };

    expect(builtRepositoryEvidence(CONFIGURATION, input({ walked })).cohort.excluded_authors).toMatchObject({ "ignored-human": 1 });
  });

  it("should withhold the counts where the walk was refused, rather than draw three zeros", () => {
    // `/repositories/<name>` drew three zeros and "no author was excluded" for a repository whose merge walk was
    // refused — a measurement nobody made, stated as confidently as a real one.
    const evidence = builtRepositoryEvidence(CONFIGURATION, input({ measured: { pullRequests: false, directCommits: false } }));

    expect("merged" in evidence.cohort).toBe(false);
    expect("reported" in evidence.cohort).toBe(false);
    expect("direct_commits" in evidence.cohort).toBe(false);
  });

  it("should still account for the facts in the exclusion map where nothing was measured", () => {
    // THE MAP IS NOT GATED, because it accounts for facts rather than for a measurement: it says what was dropped
    // from the cohort the assessment still grades. `cohortCards` reads the absent COUNTS as the signal.
    const evidence = builtRepositoryEvidence(CONFIGURATION, input({ measured: { pullRequests: false, directCommits: false } }));

    expect(evidence.cohort.excluded_authors).toBeDefined();
  });
});

describe("the graded sections of one repository's page", () => {
  it("should grade the window through the contract's own assessment shape", () => {
    const assessment = builtRepositoryEvidence(CONFIGURATION, input()).assessment;

    expect(assessment).toBeDefined();
    expect(Object.keys(assessment ?? {}).sort()).toEqual(["blocking", "caution", "clear", "label"]);
  });

  it("should leave the assessment absent when the policy is disabled", () => {
    const disabled = parseConfiguration("version: 1\norganization: hmcts\nassessment:\n  enabled: false\n");

    expect(builtRepositoryEvidence(disabled, input()).assessment).toBeUndefined();
  });

  it("should drop a bot's direct commit from the reported cohort while counting the human's", () => {
    // THE OTHER HALF OF THE ONE SEAM. `excluded_authors` narrows the pull requests and the all-bots rule narrows the
    // direct commits, so the totals are not always `merged - reported`: a bot's commit leaves the direct-commit
    // figure instead. Every figure below the cards is graded over what this leaves.
    const walked: Merges = {
      pullRequests: [merge(1)],
      directCommits: [
        {
          sha: "bot",
          repository: "alpha",
          committedAt: new Date(Date.UTC(2026, 7, 26)),
          authorLogin: "renovate[bot]",
          authorType: "Bot",
          additions: 2,
          deletions: 0,
          changedFiles: 1
        },
        {
          sha: "human",
          repository: "alpha",
          committedAt: new Date(Date.UTC(2026, 7, 26)),
          authorLogin: "alan",
          authorType: "User",
          additions: 4,
          deletions: 1,
          changedFiles: 1
        }
      ]
    };

    const evidence = builtRepositoryEvidence(CONFIGURATION, input({ walked }));

    expect(evidence.cohort.direct_commits).toBe(1);
    expect(evidence.unreviewed_substantial).toBeDefined();
  });

  it("should translate the stored merge gate into the contract's spelling", () => {
    const gate = builtRepositoryEvidence(CONFIGURATION, input()).merge_gate.gate;

    expect(gate?.pull_requests[0]?.required_approving_review_count).toBe(2);
    expect(gate?.status_checks[0]?.required_status_checks).toEqual([{ context: "build" }]);
  });

  it("should report the gate's reason when the collection could not read one", () => {
    const state = { fetchedAt: new Date(Date.UTC(2026, 7, 25)), payload: { defaultBranch: "main" } };

    expect(builtRepositoryEvidence(CONFIGURATION, input({ state })).merge_gate).toEqual({ detail: "the merge gate has not been collected" });
  });

  it("should report the reason when no alert family was collected", () => {
    const state = { fetchedAt: new Date(Date.UTC(2026, 7, 25)), payload: { defaultBranch: "main" } };
    const security = builtRepositoryEvidence(CONFIGURATION, input({ state })).security;

    expect(security.detail).toBe("no security alert family was collected for this repository");
    // THE SCANS RIDE THIS ARM TOO. They come off a different table from the counts, so a repository can hold one and
    // not the other — and all three families are stated as unmeasured rather than left out.
    expect(security.scans.map((scan) => scan.state)).toEqual(["unmeasured", "unmeasured", "unmeasured"]);
  });

  it("should translate the alert families into the contract's spelling when they were collected", () => {
    const state = {
      fetchedAt: new Date(Date.UTC(2026, 7, 25)),
      payload: { defaultBranch: "main", securityAlerts: { dependabot: { open: 3, bySeverity: { critical: 1 } } } }
    };

    const alerts = builtRepositoryEvidence(CONFIGURATION, input({ state })).security.alerts;

    expect(alerts?.dependabot).toEqual({ open: 3, by_severity: { critical: 1 } });
  });

  it("should judge every assurance criterion with the sentence behind its outcome", () => {
    // ON THE BLOCK AS WELL AS ON THE ESTATE ROW, through one derivation. The page renders these as text; the table
    // can only carry them as a `title`, which is invisible on touch and not reliably announced.
    const assurance = builtRepositoryEvidence(CONFIGURATION, input()).assurance;

    expect(assurance.criteria).toHaveLength(6);
    for (const result of assurance.criteria) {
      expect(result.detail.length, `${result.criterion} should state a reason`).toBeGreaterThan(0);
    }
  });

  it("should read a criterion nobody could measure as unknown rather than as unmet", () => {
    // The fixture payload carries no `assurance` block at all, which is a repository whose hygiene signals GitHub
    // never disclosed. Grading that as a shortfall would blame a missing permission on the team.
    const hygiene = builtRepositoryEvidence(CONFIGURATION, input()).assurance.criteria.find((result) => result.criterion === "automated-hygiene");

    expect(hygiene).toMatchObject({ outcome: "unknown", detail: "nothing has been collected for this repository" });
  });

  it("should state all three families as unmeasured when no scan row was stored for the repository", () => {
    // A family with no row must not be OMITTED: an absent family renders as nothing, and nothing is indistinguishable
    // from a family read and found clean.
    const scans = builtRepositoryEvidence(CONFIGURATION, input()).security.scans;

    expect(scans.map((scan) => scan.family)).toEqual(["secret-scanning", "dependabot", "code-scanning"]);
    for (const scan of scans) {
      expect(scan).toMatchObject({ state: "unmeasured", alerts: [] });
    }
  });

  it("should summarise every behaviour metric through the contract's observation shape", () => {
    // THROUGH `contractObservation`: `sampleSize` reaching a card that reads `sample_size` printed the literal
    // string "undefined samples" under three of the nine cards on every repository page.
    const metrics = builtRepositoryEvidence(CONFIGURATION, input()).metrics;

    expect(metrics.length).toBeGreaterThan(0);
    for (const metric of metrics) {
      expect(Object.keys(metric).sort()).toEqual(["classifications", "metric", "summary"]);
      expect(metric.summary).not.toHaveProperty("sampleSize");
    }
    // Both observation shapes are reached, so the translation is exercised on each arm.
    expect([...new Set(metrics.map((metric) => ("unit" in metric.summary ? "distribution" : "rate")))].sort()).toEqual(["distribution", "rate"]);
  });

  it("should count how each merge classified under every metric", () => {
    const metrics = builtRepositoryEvidence(CONFIGURATION, input()).metrics;

    for (const metric of metrics) {
      expect(Object.values(metric.classifications).reduce((total, count) => total + count, 0)).toBeGreaterThan(0);
    }
  });

  it("should leave a direct push out of a metric that declines to count commits", () => {
    // The flow metrics do decline, since a direct push has no cycle to time, and those samples are left out rather
    // than counted as a zero.
    const walked: Merges = {
      pullRequests: [merge(1)],
      directCommits: [
        {
          sha: "aaaaaaa",
          repository: "alpha",
          committedAt: new Date(Date.UTC(2026, 7, 26)),
          authorLogin: "alan",
          authorType: "User",
          additions: 4,
          deletions: 1,
          changedFiles: 1
        }
      ]
    };

    const metrics = builtRepositoryEvidence(CONFIGURATION, input({ walked })).metrics;
    const counted = metrics.map((metric) => Object.values(metric.classifications).reduce((total, count) => total + count, 0));

    expect(Math.min(...counted)).toBe(1);
    expect(Math.max(...counted)).toBe(2);
  });
});
