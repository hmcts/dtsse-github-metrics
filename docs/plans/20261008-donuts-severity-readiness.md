# Plan: Donut focus, alert severity colours and AI readiness on /repositories

## Overview
Make the estate donuts show which slice is selected, colour and label security alerts by their severity,
relabel the Vulnerabilities wheel by severity, bring back the AI readiness, Enforces review, Enforces CI and
Test coverage wheels from the previous version (counted over every repository, not just public ones), and add
an AI readiness column to the repositories table.

## Context
- Files involved: src/components/charts/SummaryPieChart.tsx, src/components/EstateSummary.tsx,
  src/components/AlertDetailSection.tsx, src/components/RepositoriesTable.tsx, src/app/repositories/page.tsx,
  src/lib/rows.ts (ESTATE_DIMENSIONS, EstateDimension, EstateSlice, vulnerabilityPosition, publicRepositories),
  src/lib/chart.ts (dimensionSlices), src/lib/tone.ts (alertTone, alertScanTone, coverageTone),
  src/lib/repository.ts (alertScanSummaries), src/lib/rag.ts (state, severity, RAG_STATES, RAG_LABEL, RAG_HEX),
  src/components/RAGCard.tsx (RAGLabel)
- Reference implementation: previous-metrics/ui/src/lib/tone.ts (REVIEW_BANDS, CHECKS_BANDS, COVERAGE_BANDS,
  reviewBand, checksBand, coverageBand, STRONG_GOOD_HEX '#16a34a'), previous-metrics/ui/src/lib/rows.ts
  (ESTATE_FILTERS), previous-metrics/ui/src/app/repositories/page.tsx (wheel titles and tooltips),
  old-metrics.png
- Related patterns: wheels are generated from ESTATE_DIMENSIONS (parameter, title, hint, slices that cover every
  row); slice colours come from RAG_HEX through dimensionSlices; URL filters go through
  parseSelections/matchesSelections; table columns are entries with key/label/read/hint
- Dependencies: none new (recharts is already used)

## Development Approach
- Code first, then tests, task by task, using the existing vitest suites (src/lib/__tests__/estate.test.ts,
  chart.test.ts, tone.test.ts, repository.test.ts, src/components/__tests__/AlertDetailSection.test.tsx,
  RepositoriesTable.test.tsx, repositories-url-state.test.tsx, list-pages.test.ts,
  src/components/charts/__tests__/SummaryPieChart.test.tsx)
- Every wheel stays total over its own cohort: each repository in the cohort lands in exactly one slice
- Cohorts: AI readiness, Enforces review, Enforces CI and Test coverage count ALL repositories the page lists
  (unarchived). Code owner, Maintained, Hygiene and Vulnerabilities stay PUBLIC ONLY, for the GitHub Advanced
  Security licensing reason in EstateSummary's SCOPE_HINT. Each group states its own denominator
- Secret-scanning alerts have no GitHub severity. They stay red, and the Level column reads "Secret"
- Complete each task fully before moving to the next

## Validation Commands
- `yarn test`
- `yarn lint`
- `yarn typecheck`

## Implementation Steps

### Task 1: Dim inactive slices when a donut is filtered
- [x] in SummaryPieChart, when `active` is set, give every wedge whose key is not `active` a reduced opacity
      (e.g. `fillOpacity` 0.35 on its `Cell`) and leave the active wedge at full opacity
- [x] apply the same dimming to the legend entries of non-active slices, keeping the existing 0.38 for
      zero-count slices
- [x] leave all slices at full opacity when nothing is selected
- [x] write tests in SummaryPieChart.test.tsx for selected, unselected and no-selection rendering
- [x] run the project test suite - must pass before task 2

### Task 2: Severity colours and a Level column in the alert detail lists
- [x] add a helper in src/lib/tone.ts that grades one alert record: critical/high → "bad", medium/low → "warn",
      secret-scanning (no severity) → "bad"; an alert with no severity in another family → "neutral"
- [x] have alertScanTone build on that helper, so a family's border is the worst of its alerts' tones and
      Dependabot and code scanning holding only medium/low alerts read amber
- [x] add a helper in src/lib/repository.ts giving an alert's level word: "Critical", "High", "Medium", "Low",
      "Secret" for secret scanning, and "Not graded" where a graded family's alert has no severity
- [x] add a "Level" column to AlertTable in AlertDetailSection.tsx as the second column, right after Type,
      showing the word in its tone colour (valueClass)
- [x] write tests in tone.test.ts, repository.test.ts and AlertDetailSection.test.tsx: column order,
      level words, red for critical/high/secret, amber for medium/low
- [x] run the project test suite - must pass before task 3

### Task 3: Relabel the Vulnerabilities wheel by severity
- [x] extend vulnerabilityPosition in src/lib/rows.ts to track whether any live finding is critical or high,
      across both the Jenkins CVE `live.by_severity` and Dependabot `by_severity`
- [x] replace the slices with: "High" (red, any live critical/high), "Medium" (amber, live findings but none
      critical/high — including the CVE `unknown` band and Dependabot alerts counted in `open` but not in
      `by_severity`), "Clear" (green, read and nothing live), "Unscanned" (slate, neither source read it), in
      that order, with keys `high`, `medium`, `clear`, `unscanned`
- [x] update the wheel's hint and the NOT_STATED comment to match the new wording
- [x] update estate.test.ts: slices cover every row, and each row falls in the expected slice for critical,
      high, medium-only, unknown-only, clean and unscanned fixtures
- [x] run the project test suite - must pass before task 4

### Task 4: Give each estate wheel its own cohort
- [x] add a `cohort: "all" | "public"` field to EstateDimension in src/lib/rows.ts, set to "public" on the
      four existing wheels, and add a helper that returns a dimension's rows (`publicRepositories(rows)` or
      `rows`)
- [x] split EstateSummary into two labelled groups, each with its own denominator line: an "all repositories"
      group (counted over every row it is handed) and the existing "public repositories" group; the public
      group keeps SCOPE_HINT, the all group gets a hint saying it counts every unarchived repository listed,
      including ones the span could not be reported for, which land in the unknown / not-assessed slice
- [x] show the "No public repository" empty state for the public group only, so the all-repositories group
      still draws when the estate has nothing public
- [x] check parseSelections/matchesSelections still filter the table correctly regardless of a wheel's cohort
- [x] write tests in estate.test.ts (each cohort helper) and list-pages.test.ts or a component test (both
      groups render with their own counts; public empty state does not hide the all group)
- [x] run the project test suite - must pass before task 5

### Task 5: AI readiness, Enforces review, Enforces CI and Test coverage wheels
- [x] let an EstateSlice override its colour with an optional hex, and have dimensionSlices in
      src/lib/chart.ts use it, so "Multiple" can be drawn in STRONG_GOOD_HEX '#16a34a'
- [x] add four entries with `cohort: "all"` to ESTATE_DIMENSIONS in src/lib/rows.ts, ported from
      previous-metrics: "AI readiness" (parameter `label`, slices Ready/Caution/Blocked/Cannot assess/Not
      assessed from RAG_STATES through `state(row.readiness)`), "Enforces review" (parameter `review`:
      Multiple/Enforced/Unenforced/Unknown from `required_approving_reviews`), "Enforces CI" (parameter
      `checks`: Enforced/Unenforced/Unknown from `required_status_checks`) and "Test coverage" (parameter
      `coverage`: 90% or more / 80% to under 90% / Below 80% / Unknown through coverageTone(sonar_coverage))
- [x] carry over the previous version's tooltips as each wheel's hint
- [x] order them AI readiness, Enforces review, Enforces CI, Test coverage in the all-repositories group, and
      update the comments in EstateSummary.tsx, rows.ts and src/app/repositories/page.tsx that say "four wheels"
      or "public estate" about all of them
- [x] make a wedge or legend click on an `all`-cohort wheel also show every visibility in the table, so the
      filtered row count matches the slice count: add a pure helper beside `filterTarget` in src/lib/filter.ts
      (or in src/lib/rows.ts) that, when SELECTING a slice, writes the slice parameter and sets each of
      `visibilityParameter(v)` for `VISIBILITIES` to `VISIBILITY_ON` in the same URL; CLEARING the slice
      removes only the slice parameter and leaves the visibility toggles as the reader now has them
- [x] pass the dimension's cohort to SummaryPieChart from EstateSummary (e.g. a `showsAllVisibilities`
      prop) and have its `toggle` use the helper when the cohort is `all`; public-cohort wheels keep the
      current behaviour and do not touch the visibility toggles
- [x] write tests in estate.test.ts (each new wheel covers every row, with boundary rows for 2/1/0/absent
      approvals, 1/0/absent checks, 90/89.9/80/79.9/absent coverage, and an uncollected row landing in the
      unknown slice), chart.test.ts (hex override), filter.test.ts (the helper sets all three visibilities on
      select, keeps other parameters, and leaves visibilities alone on clear) and
      repositories-url-state.test.tsx (clicking a new wedge turns internal and private on and the table row
      count equals the slice count; clicking a public-cohort wedge leaves the visibility toggles unchanged)
- [x] run the project test suite - must pass before task 6

### Task 6: AI readiness column in the repositories table
- [x] add an "AI readiness" column to RepositoriesTable directly left of "Assurance", rendering
      `<RAGLabel label={row.readiness} />` and sorting by `severity(row.readiness)` from src/lib/rag.ts
- [x] give the column a hint saying it is the readiness policy's label for the repository
- [x] write tests in RepositoriesTable.test.tsx for the column's position, badge text and sort order
- [x] run the project test suite - must pass before task 7

### Task 7: Verify acceptance criteria
- [ ] run the full test suite
- [ ] run the linter
- [ ] run the typecheck
- [ ] update README.md if it describes the estate wheels, the alert detail table or the repositories table columns
