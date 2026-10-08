# Plan: Repository page — restore missing evidence, drop unwanted sections

## Overview
Bring the repository page back to parity with the previous Python version where it matters, and remove what
is not wanted. Replace the CODEOWNERS card with an Active contributors card, delete the unwired Open pull
requests section and its dormant collector, make the Maintenance section report again (any-branch push
activity from `pushed_at`, matching the Maintained assurance criterion, plus a human-commit column), and
restore the per-contributor counts in the Contributors table, which needs no new GitHub calls.

## Context
- Files involved:
  - `src/app/repositories/[repository]/page.tsx` — the page; renders cohort cards, Open pull requests, Maintenance
  - `src/lib/repository.ts` — `cohortCards`, `codeownersCard`, `openPullRequestCards`, `maintenanceRows`, `maintenanceSummary`
  - `src/lib/tone.ts` — `codeownersTone`, `openPullRequestTone`, `maintenanceTone`
  - `src/lib/types.ts` — contract: `CohortSummary`, `CodeownersReport`, `OpenPullRequestReport`, `MaintenanceReport`, `MaintenanceEvidence`, `RepositoryPracticeEvidence`
  - `src/evidence/report/repository-evidence.ts` — `builtRepositoryEvidence`, `cohortSummary`, `metricSummaries`; hardcodes the three "not collected" sections
  - `src/evidence/report/reports.ts` — `repositoryEvidence` (loads state, cohort entry, cached merges)
  - `src/evidence/report/trend.ts:376` — existing active-contributors derivation
  - `src/evidence/domain/standards.ts` — unwired CODEOWNERS + maintenance domain logic
  - `src/evidence/behaviour/collect.ts`, `queries.ts`, `responses.ts` — `collectOpenPullRequestState` and its three queries/schemas (unwired)
  - `src/evidence/behaviour/analysis.ts` — `contributorLogins`, `isHumanCommitAuthor`, `reportedCohort`, `excludedAuthors`, `botAccounts`
  - `src/evidence/behaviour/fill.ts` — `loadCachedMerges`
  - `src/evidence/store/repository-state.ts` — `RepositoryStatePayload` (jsonb, new optional fields need no migration)
  - `src/cli/index.ts` — `collectRepository` (shallow and full paths)
  - `src/evidence/org/cohort.ts` — `CohortEntry.pushedAt`, `unmaintainedSince`
  - `src/lib/api.ts` — `repositoryContributors` (sets `metrics: []`, the cause of the dashes)
  - `src/lib/contributor.ts` — `contributorFigures` (derives the four columns from `independent-review-coverage` and `pull-request-size`)
  - Tests: `src/lib/__tests__/repository.test.ts`, `src/lib/__tests__/tone.test.ts`, `src/components/__tests__/repository.test.ts`, `src/components/__tests__/repository-page.test.ts`, `src/evidence/report/repository-evidence.test.ts`, `src/evidence/behaviour/collect.test.ts`, `src/cli/index.test.ts`, `test/integration/report-rows.test.ts`, `test/integration/contract-seam.test.ts`
- Related patterns:
  - `storedSonar(payload, fetched)` in `src/evidence/report/contract/sonar.ts`: read an optional stored payload field and turn absence into "not collected"
  - `commitHistoryQuery` / `collectDirectCommits`: GraphQL document in `queries.ts`, zod schema in `responses.ts`, walker in `collect.ts`, `parseResponse` + `GitHubError(…, AvailabilityReason.CollectionFailed)`
  - Absent means unmeasured: optional fields, never zero-filled
  - `src/evidence/org/codeowners.ts` parses CODEOWNERS for ownership and is unrelated; leave it alone
- Dependencies: none new

## Development Approach
- Code first, then tests, within each task; update existing tests that assert the removed sections
- Keep the existing comment style (block comments explaining why); remove or rewrite comments that describe removed behaviour
- Complete each task fully before moving to the next

## Validation Commands
- `yarn test`
- `yarn typecheck`
- `yarn lint`

## Implementation Steps

### Task 1: Replace the CODEOWNERS card with Active contributors
- [x] add optional `active_contributors?: number` to `CohortSummary` in `src/lib/types.ts`
- [x] in `cohortSummary` (`src/evidence/report/repository-evidence.ts`), set `active_contributors` to `contributorLogins([...reported.merges.pullRequests, ...reported.merges.directCommits], bots).size`, using the same bot set `reportedCohort` is given, present only where at least one of `measured.pullRequests` / `measured.directCommits` is true; thread the bot set in through the existing call sites (here and `trend.ts`)
- [x] add an "Active contributors" card to `cohortCards` in `src/lib/repository.ts` (dash where absent, detail "authored the reported merges and direct commits"); remove `codeownersCard` and `codeownersTone`
- [x] remove `CodeownersReport`, `CodeownersFile` and the `codeowners` field from the contract types and from `builtRepositoryEvidence`; remove `CODEOWNERS_LOCATIONS`, `CodeownersFile` and `CodeownersEvidence` from `src/evidence/domain/standards.ts` and update its header comment
- [x] update `page.tsx` to render `cohortCards(evidence.cohort)` alone
- [x] write/update tests: `cohortSummary` active count (bots excluded, gated on measured), `cohortCards` card, and remove CODEOWNERS assertions in the listed test files
- [x] run `yarn test` - must pass before task 2

### Task 2: Remove the Open pull requests section and its dormant collector
- [x] remove the Open pull requests `Section` from `page.tsx`; render the Merge gate as a full-width `Section` (no longer in a `SectionPair`) and fix the comment above it
- [x] remove `openPullRequestCards` from `src/lib/repository.ts`, `openPullRequestTone` from `src/lib/tone.ts`, `OpenPullRequestReport` / `OpenPullRequestSummary` and the `open_pull_requests` field from `src/lib/types.ts`, and the hardcoded `open_pull_requests` line from `builtRepositoryEvidence`
- [x] remove `collectOpenPullRequestState`, `countWithin`, `openPullRequestQuery`, `createdPullRequestQuery`, `abandonedPullRequestQuery` and their response schemas from `src/evidence/behaviour/`, along with any other now-unused exports (check with `yarn typecheck`/`yarn lint`)
- [x] remove the corresponding tests (`collectOpenPullRequestState` describe block and open-PR assertions in the listed test files)
- [x] run `yarn test` - must pass before task 3

### Task 3: Collect the last human commit
- [x] reshape `MaintenanceEvidence` in `src/evidence/domain/standards.ts` to the stored human answer only: `{ lastHumanCommitAt?: Date; searchedBackTo?: Date }` (exactly one present, or neither for an empty branch); update `maintenanceEvidence` validation accordingly
- [x] add `humanCommitHistoryQuery` to `queries.ts`: `defaultBranchRef.target.history(first: 100, since: $since, after: $cursor)` selecting only `committedDate author { name user { login __typename } }`, plus `rateLimit`; add its zod schema to `responses.ts`
- [x] add `findLastHumanCommit(client, organization, repository, since, excluded, bots)` in `collect.ts`: walks pages until the first commit passing `isHumanCommitAuthor`, capped at 10 pages; returns `lastHumanCommitAt`, or `searchedBackTo` (the oldest instant examined) when none was found; nothing for an empty branch
- [x] add `cachedLastHumanCommit(merges, excluded, bots)`: the latest `mergedAt` of a human-authored merged PR or `committedAt` of a human direct commit (via `isHumanCommitAuthor`), or undefined
- [x] wire into `collectRepository` (`src/cli/index.ts`): on the full path, after the fills, `loadCachedMerges(organization, repository, window)` and use the cached answer if present, otherwise `findLastHumanCommit` with `since = reference − HUMAN_MAINTENANCE_SEARCH_DAYS`; on the shallow path always call `findLastHumanCommit`; a failure warns, counts one failure and leaves the field absent; store as optional `maintenance` on `RepositoryStatePayload`
- [x] write tests: walker (human on first page, human on a later page, none within cap → `searchedBackTo`, empty branch, malformed response), cached shortcut (bot-only, human PR, human direct commit, latest wins), and `collectRepository` storing/omitting `maintenance` with no history call when the cache answers
- [x] run `yarn test` - must pass before task 4

### Task 4: Report the Maintenance section from pushed_at and the stored human answer
- [x] change the contract `MaintenanceEvidence` in `src/lib/types.ts` to `{ last_push_at?: string; last_human_commit_at?: string; searched_back_to?: string }` (drop `branch` and `last_commit_at`)
- [x] rewrite `maintenanceWindows` so `committedWithin` comes from the last push instant (`CohortEntry.pushedAt`) and `humanCommittedWithin` from `humanWindowAnswer` on the stored evidence, both against the state's `fetchedAt`
- [x] add `storedMaintenance(entry, payload, fetched)` beside `storedSonar` and use it in `builtRepositoryEvidence` in place of the hardcoded line; with no stored `maintenance` it still reports the push-based column and leaves `human_committed_within` absent, with a `detail` saying the human commit was not collected
- [x] update `maintenanceSummary` in `src/lib/repository.ts` to "last push … · last human commit …" (plus "searched back to …" where present), with no "branch <name>" part; update the row labels/details in `maintenanceRows` if they mention the branch
- [x] write/update tests: `storedMaintenance` (stored human found, searched-back-to, not stored, no `pushedAt`), `maintenanceWindows` boundaries at 183/365/730 days, `maintenanceSummary` text, and the page test
- [x] run `yarn test` - must pass before task 5

### Task 5: Restore per-contributor counts in the Contributors table
- [x] in `src/evidence/report/repository-evidence.ts`, export `contributorMetrics(configuration, merges)` that splits the reported cohort's pull requests and direct commits by folded `authorLogin` and returns a `Map<string, BehaviourMetricSummary[]>` built with the existing `metricSummaries`
- [x] add a report function in `src/evidence/report/reports.ts` (or extend `repositoryEvidence`'s return) that loads the window's cached merges once, applies `reportedCohort`, and returns that map; reuse the load `repositoryEvidence` already does rather than adding a second fact query
- [x] in `repositoryContributors` (`src/lib/api.ts`), set each row's `metrics` from the map by folded login instead of `[]`, and update its doc comment
- [x] write tests: `contributorMetrics` grouping (case-folded logins, PR and direct-commit routes, excluded authors absent) and an api/component test showing `contributorFigures` yields merged, direct pushes, unreviewed and median size for a contributor
- [x] run `yarn test` - must pass before task 6

### Task 6: Verify acceptance criteria
- [ ] run `yarn test`
- [ ] run `yarn typecheck`
- [ ] run `yarn lint`
- [ ] run `yarn test:integration` if a database is reachable, otherwise confirm the edited integration tests compile under `yarn typecheck`
- [ ] update README.md if it mentions CODEOWNERS, open pull requests or the maintenance section
