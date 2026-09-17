import { describe, expect, it } from "vitest";
import { readinessPolicy } from "../../assessment/assessment.ts";
import type { Merges } from "../../domain/facts.ts";
import type { CohortEntry } from "../../org/cohort.ts";
import { OwnerKind } from "../../org/graph.ts";
import { parseConfiguration } from "../../policy/load.ts";
import { declaredProduction, type ProductionLayers } from "../../store/production-override.ts";
import type { MeasuredRow } from "../measured.ts";
import { repositoryRow } from "./repository.ts";

/**
 * One row of the estate table, on both branches of whether anything was collected for it.
 *
 * THE UNAVAILABLE BRANCH IS WHERE A REQUIRED FIELD GETS FORGOTTEN, which is exactly what happened to `TeamRow` and
 * took `/teams/<team>` down for every team on the estate. Both branches build different objects out of different
 * halves of the row, so both are asserted here.
 */

const CONFIGURATION = parseConfiguration(`
version: 1
organization: hmcts
assessment:
  minimum_merges: 1
production_repositories:
  - gamma
`);

const POLICY = readinessPolicy(CONFIGURATION);
const NO_MERGES: Merges = { pullRequests: [], directCommits: [] };
const BOTH: MeasuredRow = { pullRequests: true, directCommits: true };
const NO_PRODUCTION: ProductionLayers = { declared: new Set<string>(), marked: new Map<string, boolean>() };

function entry(overrides: Partial<CohortEntry> = {}): CohortEntry {
  return {
    repository: "alpha",
    owners: ["dtsse"],
    ownerKind: OwnerKind.Team,
    archived: false,
    visibility: "public",
    pushedAt: new Date(Date.UTC(2026, 7, 20, 9, 30)),
    behaviourCollectable: true,
    unmaintained: false,
    ...overrides
  };
}

function collected(payload: unknown = { defaultBranch: "main" }): { fetchedAt: Date; payload: unknown } {
  return { fetchedAt: new Date(Date.UTC(2026, 7, 25)), payload };
}

const READABLE_GATE = {
  defaultBranch: "main",
  mergeGate: {
    gate: {
      branch: "main",
      protected: true,
      pullRequests: [{ requiredApprovingReviewCount: 2, dismissStaleReviewsOnPush: true, requireCodeOwnerReview: false, requireLastPushApproval: true }],
      statusChecks: [{ contexts: ["build", "lint"], strictRequiredStatusChecksPolicy: true }],
      restrictsDeletions: true,
      blocksForcePushes: true,
      appliesToAdministrators: true,
      rulesObserved: true,
      requiresLinearHistory: false,
      restrictsBranchNames: false,
      unmodelledRules: []
    }
  }
};

describe("what a row says about the repository itself", () => {
  it("should report the first owner as the team and no list when one team owns it", () => {
    // A one-element list restating `team` on every row of an estate where sharing is the exception is noise.
    const row = repositoryRow(POLICY, entry(), collected(), NO_MERGES, NO_PRODUCTION, BOTH);

    expect(row.team).toBe("dtsse");
    expect(row.teams).toBeUndefined();
  });

  it("should report every owner as well as the primary when two teams own it", () => {
    const row = repositoryRow(POLICY, entry({ owners: ["dtsse", "platform"] }), collected(), NO_MERGES, NO_PRODUCTION, BOTH);

    expect(row.team).toBe("dtsse");
    expect(row.teams).toEqual(["dtsse", "platform"]);
  });

  it("should report an empty team rather than omit it when nothing owns the repository", () => {
    const row = repositoryRow(POLICY, entry({ owners: [] }), collected(), NO_MERGES, NO_PRODUCTION, BOTH);

    expect(row.team).toBe("");
  });

  it("should say what kind of thing the owner names on every row", () => {
    // A team slug and a login are the same shape, so a reader with the names alone cannot tell them apart.
    const team = repositoryRow(POLICY, entry(), collected(), NO_MERGES, NO_PRODUCTION, BOTH);
    const person = repositoryRow(POLICY, entry({ ownerKind: OwnerKind.Person, owners: ["ada"] }), undefined, NO_MERGES, NO_PRODUCTION, BOTH);

    expect(team.owner_kind).toBe("team");
    expect(person.owner_kind).toBe("person");
  });

  it("should report the push instant as an ISO string and never as a Date", () => {
    // `SortValue` has no `Date` case, so a raw one would sort alphabetically by weekday name.
    const row = repositoryRow(POLICY, entry(), collected(), NO_MERGES, NO_PRODUCTION, BOTH);

    expect(row.pushed_at).toBe("2026-08-20T09:30:00.000Z");
  });

  it("should leave the push instant absent when the graph holds none", () => {
    const row = repositoryRow(POLICY, entry({ pushedAt: undefined }), collected(), NO_MERGES, NO_PRODUCTION, BOTH);

    expect(row.pushed_at).toBeUndefined();
  });

  it("should fold the visibility to the case the contract compares by", () => {
    const row = repositoryRow(POLICY, entry({ visibility: "PUBLIC" }), collected(), NO_MERGES, NO_PRODUCTION, BOTH);

    expect(row.visibility).toBe("public");
  });

  it("should report a visibility the contract does not name as unmeasured rather than put it on the wire", () => {
    // `selectCohort` then leaves the row out of a visibility filter instead of admitting it under a word no filter
    // offers. Casting instead would take the filter down.
    const row = repositoryRow(POLICY, entry({ visibility: "SECRET" }), collected(), NO_MERGES, NO_PRODUCTION, BOTH);

    expect(row.visibility).toBeUndefined();
  });

  it("should report what a repository is on the branch where nothing was collected too", () => {
    // These are facts the GRAPH holds, so suppressing them would report a repository nobody walked as one whose
    // visibility and push date are unknown — and `pushed_at` is the table's default sort.
    const row = repositoryRow(POLICY, entry(), undefined, NO_MERGES, NO_PRODUCTION, BOTH);

    expect(row).toMatchObject({ owner_kind: "team", visibility: "public", archived: false, unmaintained: false });
    expect(row.pushed_at).toBe("2026-08-20T09:30:00.000Z");
    expect(row.assurance).toBeDefined();
  });
});

describe("what a row says about the window", () => {
  it("should state why it carries no figures when nothing was collected", () => {
    const row = repositoryRow(POLICY, entry(), undefined, NO_MERGES, NO_PRODUCTION, BOTH);

    expect(row.detail).toBe("nothing has been collected for this repository");
    expect("merged_pull_requests" in row).toBe(false);
  });

  it("should read the two gate figures off a readable gate", () => {
    const row = repositoryRow(POLICY, entry(), collected(READABLE_GATE), NO_MERGES, NO_PRODUCTION, BOTH);

    expect(row.required_approving_reviews).toBe(2);
    expect(row.required_status_checks).toBe(2);
  });

  it("should leave the two gate figures absent when there is no gate to read them off", () => {
    // A repository whose rules nobody may see is not a repository requiring no reviews.
    const row = repositoryRow(POLICY, entry(), collected(), NO_MERGES, NO_PRODUCTION, BOTH);

    expect(row.required_approving_reviews).toBeUndefined();
    expect(row.required_status_checks).toBeUndefined();
  });

  it("should grade readiness even where the merge history went unread", () => {
    // GRADED ON BOTH BRANCHES OF MEASURED-NESS: an unread history grades `cannot_assess`, which is the right
    // verdict, and suppressing it would take 650 repositories out of the readiness donut.
    const row = repositoryRow(POLICY, entry(), collected(READABLE_GATE), NO_MERGES, NO_PRODUCTION, { pullRequests: false, directCommits: false });

    expect(row.readiness).toBeDefined();
    expect("merged_pull_requests" in row).toBe(false);
  });

  it("should leave readiness absent when the policy is disabled", () => {
    const disabled = readinessPolicy(parseConfiguration("version: 1\norganization: hmcts\nassessment:\n  enabled: false\n"));

    expect(repositoryRow(disabled, entry(), collected(READABLE_GATE), NO_MERGES, NO_PRODUCTION, BOTH).readiness).toBeUndefined();
  });

  it("should always send the three alert families even when none was collected", () => {
    // The UI reads `security.code_scanning` unconditionally, so an absent family throws.
    const row = repositoryRow(POLICY, entry(), collected(), NO_MERGES, NO_PRODUCTION, BOTH);

    expect(Object.keys(row.security ?? {}).sort()).toEqual(["code_scanning", "dependabot", "secret_scanning"]);
  });
});

describe("what a row says about production", () => {
  it("should answer from the collected payload when nothing else has an opinion", () => {
    const row = repositoryRow(POLICY, entry(), collected({ deploysToProduction: true }), NO_MERGES, NO_PRODUCTION, BOTH);

    expect(row.production).toBe(true);
    expect(row.production_source).toBeDefined();
  });

  it("should answer nothing rather than a confident false when none of the three layers answered", () => {
    // The PAIR passes through as `undefined` for `stripAbsent` to drop at the boundary, rather than being spread
    // conditionally: it is absent or present together, and one test of that is enough.
    const row = repositoryRow(POLICY, entry(), collected(), NO_MERGES, NO_PRODUCTION, BOTH);

    expect(row.production).toBeUndefined();
    expect(row.production_source).toBeUndefined();
  });

  it("should answer from the configured list on the branch where nothing was collected", () => {
    // TWO OF THE THREE LAYERS ARE STATEMENTS rather than observations, so answering nothing here would make policy
    // conditional on a walk having happened.
    const layers: ProductionLayers = { declared: declaredProduction(CONFIGURATION.production_repositories), marked: new Map() };

    const row = repositoryRow(POLICY, entry({ repository: "gamma" }), undefined, NO_MERGES, layers, BOTH);

    expect(row.production).toBe(true);
  });

  it("should answer from the marked column ahead of the collected payload when somebody edited it", () => {
    const layers: ProductionLayers = { declared: new Set<string>(), marked: new Map([["alpha", false]]) };

    const row = repositoryRow(POLICY, entry(), collected({ deploysToProduction: true }), NO_MERGES, layers, BOTH);

    expect(row.production).toBe(false);
    expect(row.production_source).toBe("marked");
  });
});
