# Plan: Secure by design checks for Actions policy and public issue creation

## Overview

Add two readiness conditions the secure design team asked for: a repository that allows any GitHub Action
(`allowed_actions: all`), and a repository where anyone can open an issue. Each condition's severity is set in
config. Both start as `caution`, which shows amber and does not change the readiness label. Setting either to
`amber` or `red` later makes it a blocking condition that imposes that label.

## Context

- Files involved:
  - src/evidence/policy/schema.ts (`assessment` block), metrics.example.yaml, metrics.yaml
  - src/evidence/domain/readiness.ts, new src/evidence/domain/repository-settings.ts
  - src/evidence/assessment/assessment.ts (`createPolicy`, `assess`, `governance`)
  - new src/evidence/inventory/repository-settings.ts (Actions permissions REST read); src/evidence/inventory/assurance.ts (issue creation fields)
  - src/cli/index.ts (per-repository collect beside `collectMergeGate` ~L263; estate-wide batch beside
    `collectAssuranceSignals` ~L681; the `assess` caller ~L1857)
  - src/evidence/report/rows/repository.ts (~L113) and src/evidence/report/repository-evidence.ts (~L83), the
    other `policy.assess` callers
- Related patterns:
  - caution/blocking judgements: `caution()` and `blocking()` in assessment.ts; the label comes from blocking
    conditions only, so a caution never moves it
  - per-repository REST read that treats 404/403 "feature off" as an answer rather than a failure:
    `collectMergeGate` and `FEATURE_NOT_CONFIGURED` in src/evidence/inventory/merge-gate.ts
  - aliased GraphQL batch with variables, echoed `name` check, per-alias refusal handling and re-asks:
    `assuranceQuery` / `collectAssuranceSignals` / `readAliasedBatch` in src/evidence/inventory/assurance.ts
  - stored state lives in the `repository_state.payload` JSON (`recordRepositoryState`), so no migration is needed
- GitHub API:
  - `GET /repos/{owner}/{repo}/actions/permissions` → `{ enabled, allowed_actions: "all" | "local_only" | "selected" }`;
    `allowed_actions` is absent when Actions is disabled. Needs `administration=read`, which the App holds:
    confirmed with the App's installation token on 2026-11-13, when hmcts/cnp-flux-config answered 200 with
    `{"enabled": true, "allowed_actions": "all", "sha_pinning_required": false}`. Use that body as a test fixture
  - GraphQL `Repository.hasIssuesEnabled` and `Repository.issueCreationPolicy` (`ALL` | `COLLABORATORS_ONLY`), added
    by GitHub in June 2026. REST has no equivalent field. Confirmed live on 2026-11-13: hmcts/dtsse-github-metrics
    answered `hasIssuesEnabled: true, issueCreationPolicy: "COLLABORATORS_ONLY"`. Both are scalars, so they are
    read in the existing `assuranceQuery` document at no extra call cost
- Dependencies: none new

## Development Approach

- Code first, then tests, task by task, in the existing vitest suites beside each file
- Severity values: `caution` (amber caution, label unaffected), `amber` and `red` (blocking, imposing that label).
  Both default to `caution`
- Flag rules:
  - Actions: flag only when Actions is enabled AND `allowed_actions` is `all`. `local_only`, `selected` or Actions
    disabled → clear
  - Issues: flag only when issues are enabled AND the creation policy is `ALL`. Issues off or `COLLABORATORS_ONLY` → clear
- An unread setting (refused, not collected, or stored before this change) is reported as an informational clear
  condition saying it was not read. It is never flagged: an unread setting is not evidence of a weak one, and
  flagging it would put a caution on every repository collected before this shipped
- Complete each task fully before moving to the next

## Validation Commands

- `yarn test`
- `yarn lint`
- `yarn typecheck`

## Implementation Steps

### Task 1: Configurable severity in the policy schema

- [x] add a `secureDesignSeverity` zod enum `caution | amber | red` in src/evidence/policy/schema.ts
- [x] add a strict `secure-by-design` object to the `assessment` block with `actions-allow-all` and
      `public-issue-creation`, each defaulting to `caution`, with a comment saying `caution` leaves the label alone
      and `amber`/`red` block
- [x] document the block in metrics.example.yaml and state it explicitly in metrics.yaml with both set to `caution`
- [x] write tests in src/evidence/policy/policy.test.ts: defaults, each accepted value, an unknown value rejected,
      an unknown key rejected
- [x] run the project test suite - must pass before task 2

### Task 2: Domain type and readiness conditions

- [x] add src/evidence/domain/repository-settings.ts with `RepositorySettings { actions?: { enabled: boolean;
      allowedActions?: string }; issues?: { enabled: boolean; creationPolicy?: string } }`, where an absent block
      means unread
- [x] add `assess(merges, gate, settings?)` in assessment.ts with two judgement functions:
      `actions-allow-all` / `actions-restricted` / `actions-policy-not-read` and `issues-open-to-public` /
      `issues-restricted` / `issue-policy-not-read`; a failing check becomes `caution(...)` or
      `blocking(..., ReadinessLabel.Amber|Red, ...)` per the configured severity
- [x] keep the detail sentences specific (for example "any GitHub Action from any source can run in this
      repository's workflows"; "anyone with a GitHub account can open an issue")
- [x] write tests in src/evidence/assessment/assessment.test.ts covering every row of the flag rules above, each
      severity (a caution leaves a green label green; `amber` gives amber; `red` gives red), and unread settings
      as informational clear
- [x] run the project test suite - must pass before task 3

### Task 3: Collect the Actions permissions

- [x] in src/evidence/inventory/repository-settings.ts, add `collectActionsPermissions(client, organization,
      repository)` reading `/repos/{org}/{repo}/actions/permissions` with a zod schema (`enabled`, nullish
      `allowed_actions`), returning `undefined` on refusal or failure and recording no failure for the
      `FEATURE_NOT_CONFIGURED` answers, as merge-gate.ts does
- [x] call it on both collect paths in src/cli/index.ts next to `collectMergeGate`, and store the result in the
      payload as `settings.actions`
- [x] write tests for the reader (all / local_only / selected / disabled with no `allowed_actions` / 403 / 404 /
      malformed body) and update src/cli/index.test.ts so both paths store `settings.actions`
- [x] run the project test suite - must pass before task 4

### Task 4: Collect the issue creation policy

- [x] add `hasIssuesEnabled` and `issueCreationPolicy` to each repository in `assuranceQuery` and to
      `assuranceEntrySchema` (both nullish) in src/evidence/inventory/assurance.ts
- [x] carry them on `GraphAssurance` as an `issues` block, set only when `hasIssuesEnabled` was answered, and lift
      it out in `assuranceEvidence` the way `securityPolicy` is, so it never reaches the hygiene composite
- [x] store each repository's answer as `settings.issues` in the payload on both collect paths in src/cli/index.ts
- [x] write tests in src/evidence/inventory/assurance.test.ts: query text, ALL / COLLABORATORS_ONLY / issues
      disabled / null policy, and hygiene signals unchanged by the new fields; update src/cli/index.test.ts so
      both paths store `settings.issues`
- [x] run the project test suite - must pass before task 5

### Task 5: Pass stored settings to every assessment

- [x] add a `storedSettings(payload)` reader (beside `storedGate` in src/evidence/report/contract/merge-gate.ts or
      in its own contract file) that validates `payload.settings` and returns `undefined` for anything else
- [x] pass it to `policy.assess` in src/evidence/report/rows/repository.ts,
      src/evidence/report/repository-evidence.ts and src/cli/index.ts (~L1857)
- [x] check the new conditions render in the repository page's assessment section without UI changes; if the
      condition list needs labels or tooltips for new names, add them in src/components/AssessmentSection.tsx
- [x] write tests: `storedSettings` on missing, malformed and valid payloads; a repository row and a repository
      page that carry the new caution, and a payload with no `settings` showing the "not read" clear conditions
- [x] run the project test suite - must pass before task 6

### Task 6: Verify acceptance criteria

- [x] run the full test suite
- [x] run the linter
- [x] run the typecheck
- [x] update README.md: the two new readiness conditions, the `assessment.secure-by-design` severity setting, and
      that reading Actions permissions needs the App's repository `administration: read` permission
