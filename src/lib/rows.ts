/**
 * What a repository list shows, and in what order, before any of it reaches a component.
 *
 * The filtering and ordering live here rather than in `RepositoriesTable` because they are the part
 * that can be wrong in a way nobody notices: a term that only matched repository names would quietly
 * hide a team the reader searched for, and a readiness filter that resolved an unknown key to "no
 * matches" would show an empty table for a mistyped URL instead of the whole list.
 *
 * The default order is MOST RECENTLY PUSHED FIRST, from 2026-09-14, where it was team then repository
 * before. It is still deliberately not an order by any figure the page grades: the reader can sort by
 * any column, but the list does not open ranked by how well repositories do against the criteria, which
 * would read as a league table. When a repository was last pushed to is not a grade.
 */

import { matches } from "@/lib/filter";
import { ABSENT } from "@/lib/format";
import type { RAGState } from "@/lib/rag";
import { compare, type SortValue } from "@/lib/sort";
import type {
  AlertScanState,
  AssuranceCriterion,
  AssuranceCriterionResult,
  AssuranceGrade,
  AssuranceHygieneSignals,
  AssuranceOutcome,
  CveCount,
  CveEvidence,
  CveSeverity,
  OpenAlertCount,
  RepositoryRow,
  Visibility
} from "@/lib/types";
import { UNCOLLECTED_DETAIL } from "@/lib/types";

/**
 * Every team that owns the row, which is not always the one name its team cell prints.
 *
 * 390 repositories on the estate have MORE THAN ONE OWNER, and `teams` is ABSENT on the ordinary single-owner row —
 * deliberately, so that an estate where sharing is the exception does not carry a one-element list restating `team`
 * on every row. So an absent `teams` folds to the primary rather than to "owned by nobody", which is the reading
 * that made `/teams/<team>` list fewer repositories than the card linking to it had counted.
 *
 * The same fold the report layer's `teamRows` counts ownership by, so a repository cannot be counted for a team
 * whose page then refuses to list it.
 */
export function owners(row: Pick<RepositoryRow, "team" | "teams">): readonly string[] {
  return row.teams ?? [row.team];
}

/**
 * The word the estate table marks an individually-owned repository with.
 *
 * "Individual" rather than "person" or "no team": it is the reader's word for the finding, which is that this
 * repository is one person's rather than a team's. `owner_kind` keeps the contract's own vocabulary.
 */
export const INDIVIDUAL_LABEL = "Individual";

/**
 * Whether the row's owner is one person rather than a team.
 *
 * ABSENT READS AS A TEAM, which is the one guess in here and it is the safe direction. The field only exists
 * from 2026-09-11 and `RepositoryRow` documents why it is optional; before it, every owner name was rendered
 * as a team, and 1,499 of the estate's 1,846 owned repositories are team-owned — so treating an absent value
 * as an individual would mark most of the estate as somebody's personal project on a deployment that simply
 * predates the field.
 *
 * The unowned bucket is NOT an individual and gets no marker: it has a name of its own (`unowned`) and a card
 * of its own, so "nobody owns this" is already stated where a reader meets it. What the marker adds is the
 * thing a name cannot say — that `a1i-hussain` is a person and not a team whose page is missing.
 */
export function ownedByIndividual(row: Pick<RepositoryRow, "owner_kind">): boolean {
  return row.owner_kind === "person";
}

/**
 * Whether NOTHING owns the repository, which is a destination rather than an unread field.
 *
 * `none` is the unowned bucket the ownership graph resolves to, so this is an exact test against it and never
 * "no team name" — `team` carries the bucket's own name for these rows. Absence reads as OWNED, in the same
 * direction and for the same reason `ownedByIndividual` reads it as a team: an absent `owner_kind` means a
 * deployment older than the field, and reporting most of the estate as unowned on that basis would be the
 * sharpest possible wrong answer.
 */
export function unowned(row: Pick<RepositoryRow, "owner_kind">): boolean {
  return row.owner_kind === "none";
}

/**
 * The row's reason where it is one this list can honestly print, and nothing where it is not.
 *
 * A REASON IS ONLY WORTH PRINTING BESIDE THE FIGURES IT EXPLAINS, which is what this selects on. `detail` carries two
 * unrelated kinds of sentence — see `RepositoryRow.detail` — and `/repositories` renders CONTROL STATE only: no
 * merged-pull-request column, no direct-commit column, no merge gate. So "no merge history was read for this
 * repository, so its merges are unmeasured rather than none" explained nothing a reader of this page could see, and
 * printed under the name of every repository whose private-and-internal walk the App installation does not cover
 * (VIBE-590) it read as a fault in the row rather than in a column that is not there.
 *
 * `UNCOLLECTED_DETAIL` is the one that stays, because nothing collected means every column this table draws is
 * empty — which is exactly what the sentence says. The repository and team pages keep rendering `detail` whole:
 * they show the merge figures, so there the merge reasons are the load-bearing half of the answer.
 */
export function uncollectedDetail(row: Pick<RepositoryRow, "detail">): string | undefined {
  return row.detail === UNCOLLECTED_DETAIL ? row.detail : undefined;
}

/**
 * How many of these rows this list has a reason for, which is how many it could report nothing about.
 *
 * COUNTED OFF THE ROWS AND NOT READ OFF `OverviewSummary.unavailable`, because the two answer different questions
 * now. `unavailable` counts every row carrying any `detail`, so it includes the merge-history gap this page no
 * longer shows — leaving the header able to announce 870 unreported repositories above a table where not one row
 * gave a reason. The other list pages still read `unavailable`, and correctly: they state a window, and the figure
 * is about what that window could report.
 */
export function uncollectedCount(rows: readonly Pick<RepositoryRow, "detail">[]): number {
  return rows.filter((row) => uncollectedDetail(row) !== undefined).length;
}

/**
 * The default order: MOST RECENTLY COMMITTED ON THE DEFAULT BRANCH FIRST.
 *
 * This replaced an order by `(team, repository)`, whose reasoning was that a reader scanning the list reads one
 * team's repositories together. At 1,880 rows that is not what a reader arriving at the page is doing: they are
 * asking what has been happening, and the alphabet answers with whichever team begins with `a`. A team's own
 * repositories are still readable together — the term filters on the team name and the Team header still sorts —
 * so what changed is only which question the page opens on.
 *
 * IT ORDERS ON THE DEFAULT BRANCH'S DATE AND NOT ON GITHUB'S `pushedAt`, which is what the page opened on until
 * this changed. `pushedAt` moves on a push to ANY ref, so an estate ordered by it led with repositories whose only
 * recent activity was an unmerged feature branch — which is not "what has been happening" for a reader asking what
 * is being released. See `RepositoryRow.default_branch_committed_at`.
 *
 * A ROW WITH NO DATE SORTS LAST, both here and under a header click. GitHub omits the default branch ref for a
 * repository with no commits, and its absence is meaningful: it must not be defaulted to the epoch, which would put
 * every empty repository at the bottom as though it were the stalest, nor to now, which would put it at the top.
 * `sorted` already holds `undefined` back from both ends and this follows that precedent explicitly.
 *
 * THE TIEBREAK IS THE REPOSITORY NAME AND IT IS LOAD-BEARING. Two repositories committed to at the same instant is
 * not hypothetical — the instant has second resolution and a `for_each` Terraform apply touches many at once — and
 * "two reports of one window must not differ" is a rule this codebase states in three other places. Without it,
 * two renders of one estate could order those rows differently.
 *
 * The old order's reasoning about shared repositories is PRESERVED and still applies: a repository appears once,
 * at one position. It just no longer appears under a heading.
 */
export function orderRepositories(rows: readonly RepositoryRow[]): RepositoryRow[] {
  const dated = rows.filter((row) => row.default_branch_committed_at !== undefined);
  const undated = rows.filter((row) => row.default_branch_committed_at === undefined);
  // Descending on the instant, ascending on the name: `compare` orders text and instants alike, and an ISO-8601
  // string sorts lexicographically in instant order, which is why the contract carries these as strings.
  const ordered = [...dated].sort(
    (left, right) => -compare(left.default_branch_committed_at, right.default_branch_committed_at) || compare(left.repository, right.repository)
  );
  return [...ordered, ...[...undated].sort((left, right) => compare(left.repository, right.repository))];
}

/**
 * A term matches a row on either name a reader would type: the repository or ANY of its owning teams.
 *
 * Any owner rather than the primary, because a reader searching a team's name is asking which repositories that
 * team is on the hook for, and on a shared repository that question is not settled by which owner happens to lead
 * the reporting order.
 */
export function matchesRepository(row: RepositoryRow, term: string): boolean {
  return matches(row.repository, term) || owners(row).some((owner) => matches(owner, term));
}

/**
 * The parameter the estate table's filter box reads and writes.
 *
 * Beside the other three filter parameters rather than in the component, which is where it was until the export
 * control became a second reader of it. The parameters, their values and their parsers are one decision — a
 * control reading `?repository=` while another wrote `?term=` would filter two different tables on one page — and
 * `RepositoriesTable` re-exports it so the pages that name it in a `FilterSearchBox` are unchanged.
 */
export const TERM_PARAMETER = "repository";

/**
 * The production toggle's parameter.
 *
 * IT USED TO BE DEFINED AS "NOT ONE OF THE DONUT DIMENSIONS", and that framing is worth recording because the
 * donuts are gone from 2026-09-14 and with them `ESTATE_FILTERS`, the band-function filters and the dismissible
 * chips. Every filter on this table is now a toggle of exactly this shape: a control with its own affordance,
 * `aria-pressed`, and no × to remove it. What was special about production is now the rule.
 */
export const PRODUCTION_PARAMETER = "production";

/**
 * The only value the toggle ever writes, and so the only one that reads back as on.
 *
 * A two-state control needs no vocabulary, but it does need one spelling: matching on anything
 * truthy would make `?production=0` an odd way of saying yes.
 */
export const PRODUCTION_VALUE = "true";

/** Whether the production filter is on, read off the URL as the visibility toggles are. */
export function parseProduction(read: (parameter: string) => string | null): boolean {
  return read(PRODUCTION_PARAMETER) === PRODUCTION_VALUE;
}

/**
 * The rows a reader is looking at: the term, the visibilities, the production toggle and the clicked wedges.
 *
 * ONE AND OVER EVERY CONTROL, which is what stacking them means — the public repositories whose name matches,
 * which deploy to production, and which are in the wedge the reader clicked. The wheels' dimensions AND here
 * because the wheels are controls again: what removed them from this expression was that the charts above the
 * table had gone and nothing was left to APPLY them with, and a filter a reader can dismiss but cannot set is a
 * half-wired control surface.
 *
 * A row whose production answer could not be read is EXCLUDED while the toggle is on, rather than
 * kept on the chance that it is one. The toggle says "show me the production services", and a
 * repository nobody could classify is not an answer to that — leaving it in would put rows under a
 * count that did not count them, and letting it in as `false` would be the same guess in reverse.
 */
export function filterRepositories(
  rows: readonly RepositoryRow[],
  term: string,
  production = false,
  visibilities: ReadonlySet<Visibility> = new Set(VISIBILITIES),
  selections: EstateSelections = new Map()
): RepositoryRow[] {
  return rows.filter(
    (row) =>
      matchesRepository(row, term) && matchesVisibility(row, visibilities) && (!production || row.production === true) && matchesSelections(row, selections)
  );
}

/**
 * How many production repositories the reader's OTHER controls leave, which is what the toggle counts.
 *
 * The production dimension itself is excluded from its own count. A count that included its own filter would
 * read `n` before the click and `n` after it, which tells a reader nothing: the number is there to say what
 * turning the toggle on would leave.
 */
export function productionCount(rows: readonly RepositoryRow[], term: string, visibilities?: ReadonlySet<Visibility>, selections?: EstateSelections): number {
  return filterRepositories(rows, term, true, visibilities, selections).length;
}

/**
 * The visibilities the table can show, each its own INDEPENDENT TOGGLE.
 *
 * Three, not two, and not a tri-state. `INTERNAL` is a real GitHub visibility and the estate's second largest —
 * 1,043 public, 441 internal, 396 private among the non-archived — so a two-way control could not name 441
 * repositories, and a single tri-state could not express "public and internal but not private", which is the
 * obvious thing somebody reviewing what HMCTS publishes wants to ask.
 *
 * Ordered most-open first, which is the order the assurance question reads in: "coding in the open" is about what
 * is public, so public leads and private is the exception.
 */
export const VISIBILITIES: readonly Visibility[] = ["public", "internal", "private"];

/**
 * The visibilities shown when the URL says nothing: PUBLIC ONLY.
 *
 * A deliberate narrowing rather than the whole estate, and the argument is what the page is for. `/repositories`
 * answers whether repositories meet the criteria for coding IN THE OPEN, and a private repository is not coding in
 * the open — it is not failing the criteria, it is outside them. Opening on all three would put 837 rows the
 * question does not apply to in front of a reader who has not asked for them.
 *
 * The other two are one click away and the chips say which are showing, so nothing is hidden — the default states
 * a question rather than restricting an answer.
 */
export const DEFAULT_VISIBILITIES: readonly Visibility[] = ["public"];

/** The parameter each visibility toggle reads and writes, one per visibility. */
export function visibilityParameter(visibility: Visibility): string {
  return visibility;
}

/**
 * The value a toggle writes, and the only one that reads back as on.
 *
 * `false` is written EXPLICITLY rather than being the parameter's absence, which is the one place this control
 * differs from the production toggle. Absence has to mean "the reader has said nothing", so it can fall back to
 * the public-only default — and if turning public off were expressed as absence, `?public=` and a bare URL would
 * be the same string and the reader could never turn the default off.
 */
export const VISIBILITY_ON = "true";

export const VISIBILITY_OFF = "false";

/**
 * Which visibilities the reader has selected, or the default where they have selected nothing.
 *
 * A URL naming EVERY visibility as off returns an empty set, which filters the table to nothing. That is the
 * honest answer rather than a silent fallback to the default: the reader turned all three off, and showing them
 * the whole estate instead would be ignoring three clicks. `filterRepositories` says the same for a dimension
 * nothing satisfies.
 */
export function parseVisibilities(read: (parameter: string) => string | null): Set<Visibility> {
  const stated = VISIBILITIES.filter((visibility) => read(visibilityParameter(visibility)) !== null);
  if (stated.length === 0) {
    return new Set(DEFAULT_VISIBILITIES);
  }
  return new Set(stated.filter((visibility) => read(visibilityParameter(visibility)) === VISIBILITY_ON));
}

/**
 * Whether a row's visibility is one the reader is showing.
 *
 * A row whose visibility the service did not send is KEPT. The field only exists from 2026-09-14, and a
 * deployment serving rows without it would otherwise show an empty table — the same guess `ownedByIndividual`
 * makes for `owner_kind` and in the same direction: absent means "this predates the field", never "exclude it".
 */
export function matchesVisibility(row: RepositoryRow, showing: ReadonlySet<Visibility>): boolean {
  return row.visibility === undefined || showing.has(row.visibility);
}

/**
 * The cohort the estate summary wheels are drawn over: PUBLIC ONLY.
 *
 * NOT THE TABLE'S VISIBILITY TOGGLES, though the table opens on the same narrowing. The wheels are a statement
 * about the public estate and say so beside themselves, so they must not move when a reader turns internal on to
 * look something up — a figure that changed under a control it does not name would be worse than one whose
 * denominator is stated.
 *
 * THE REASON IS A LICENSING BOUNDARY AND NOT A SAMPLE. Secret scanning is free on public repositories and needs
 * GitHub Advanced Security on internal and private ones, so all 446 internal and all 401 private repositories
 * legitimately report the security controls off. A coverage wheel over the whole estate would draw that as a gap
 * in the estate, and the same applies to everything alert-derived.
 *
 * AN ABSENT VISIBILITY IS EXCLUDED, which is the opposite of what `matchesVisibility` does with one and is right
 * for the opposite reason. The table keeps such a row because dropping it would show an empty list against a
 * deployment predating the field; a wheel counting it would put a repository whose visibility nobody read inside
 * a figure whose whole claim is that every member is public.
 */
export function publicRepositories(rows: readonly RepositoryRow[]): RepositoryRow[] {
  return rows.filter((row) => row.visibility === "public");
}

/**
 * GitHub's "you never turned this on" answer, in the words the collector records it in.
 *
 * RESTATED AND NOT IMPORTED, for `ASSURANCE_CRITERIA`'s reason: `FEATURE_NOT_ENABLED` lives in
 * `evidence/domain/security-alerts.ts` and `src/lib/**` imports nothing from `src/evidence/**`. The two spellings
 * have to agree, because this sentence is the ONLY thing separating a family GitHub says is off from one nobody
 * could read — `alertScanState` in `evidence/domain/alert-detail.ts` is the other end of the same comparison, and
 * that is why the sentence is a named constant at both ends rather than a literal at either.
 */
const FEATURE_NOT_ENABLED = "is not enabled for this repository";

/**
 * Whether one alert family was READ for this row, is switched OFF, or said nothing either way.
 *
 * `alertScanState`'s rule over the contract's count block rather than over the stored one, and deliberately the
 * same rule: `open` is the primary signal, because a number means somebody looked whatever else the block says,
 * and the sentence is consulted only when there is no number. The two absences then have to be told apart, and
 * prose is where the collection recorded the difference.
 *
 * READ OFF THE ROW AND NOT OFF `SecurityAlertReport.scans`, which is the fuller answer and is not on a row: the
 * scans are assembled per repository for a repository's own page, and an estate of 1,046 rows cannot pay a query
 * each. `RepositoryRow.security` is emitted on every collected row and carries the same three-state answer, which
 * is why this reads it there — see `SecurityAlertEvidence` on the contract.
 */
export function scanState(count: OpenAlertCount | undefined): AlertScanState {
  if (count?.open !== undefined) {
    return "read";
  }
  return count?.detail?.endsWith(FEATURE_NOT_ENABLED) === true ? "not-enabled" : "unmeasured";
}

/** One estate wheel's slice: what it counts, the word beside it, and the state it is drawn in. */
export interface EstateSlice {
  /**
   * The slice's key IN THE URL, which a wedge writes and `filterRepositories` reads back.
   *
   * Separate from `label` for `PieSlice.key`'s reason: the words move and the key must not, so a link shared
   * with `?owner=team` in it keeps working when somebody rewords the legend.
   */
  key: string;
  label: string;
  /**
   * Which `RAGState` the slice is drawn in, rather than a hex.
   *
   * THE WHEELS HAVE NO PALETTE OF THEIR OWN. `rag.ts` already holds the four colours this page reads every
   * verdict in, and `lib/chart.ts` resolves the state to `RAG_HEX` at the point a mark needs a value — so a
   * wedge and the table cell under it are the same colour for the same answer, and this module stays free of
   * presentation literals as the rest of it is.
   */
  state: RAGState;
  /** Whether this row belongs to this slice. */
  holds: (row: RepositoryRow) => boolean;
}

/** One wheel: the parameter it filters on, what it is called, what it means, and its slices. */
export interface EstateDimension {
  parameter: string;
  title: string;
  hint: string;
  /**
   * Every slice, in best-to-worst order with the unmeasured one last.
   *
   * TOTAL OVER THE ROWS, which is the property the whole summary rests on and the one a test asserts: every
   * repository lands in exactly one slice of every wheel, so a wheel's counts sum to the cohort it was drawn
   * over. A row falling through would be counted nowhere and the wheel would silently under-total against the
   * denominator stated beside it.
   */
  slices: readonly EstateSlice[];
}

export const OWNER_PARAMETER = "owner";

export const MAINTAINED_PARAMETER = "maintained";

export const SCANNING_PARAMETER = "scanning";

export const CVE_PARAMETER = "cve";

/**
 * The word an unmeasured slice is labelled with, shared by the three wheels that have one.
 *
 * "NO STATE STATED" AND NOT "UNSCANNED" OR "UNKNOWN". Nothing here is a claim that nobody has looked: what is
 * true is that this report holds no answer, and the two readings take different actions. One wording per wheel
 * would have let the sharpest of them drift into blame.
 */
const NOT_STATED = "No state stated";

/**
 * The four questions this page answers, drawn as wheels over the public estate.
 *
 * FOUR AND NOT THE SIX THAT WERE REMOVED. Five of those were ways-of-working dimensions — the readiness
 * distribution, the declared gate's two halves, unreviewed substantial merges — which are questions about a TEAM
 * and are reported on `/teams` now. The sixth read a field the report layer has never emitted and drew an
 * all-unknown circle. These four are stewardship and security, which is what this page is about, and every slice
 * below reads a field the report layer emits on every row.
 *
 * EACH WHEEL IS A CONTROL AND NOT A PICTURE. Its `parameter` is what a wedge writes, `filterRepositories` reads
 * it back, and the table under it narrows — which is the difference between a chart and a filter, and the reason
 * the dismissible chips had to go when the previous charts did.
 *
 * THE COLOURS RUN GREEN, AMBER, THEN SLATE ON EVERY WHEEL, so four wheels side by side read as one thing: the
 * first slice is the answer that reads well, the second is the one worth weighing, and slate is the absence of an
 * answer. `Code owner` is the one wheel that reaches red, because it is the one whose last slice is a criterion
 * READ AND FAILED with nobody to ask about it rather than a fact to weigh.
 */
export const ESTATE_DIMENSIONS: readonly EstateDimension[] = [
  {
    parameter: OWNER_PARAMETER,
    title: "Code owner",
    hint: "What owns the repository: a GitHub team, one named individual, or nothing. An individually-owned repository still MEETS the Code owner criterion — there is somebody to ask — so amber here is the bus factor worth weighing rather than a criterion that failed. Nothing owning it is the criterion unmet.",
    slices: [
      // Neither of the other two, so an absent `owner_kind` lands here — `ownedByIndividual` and `unowned` both
      // document why that is the safe direction, and this slice is where their agreement shows.
      { key: "team", label: "Team", state: "green", holds: (row) => !unowned(row) && !ownedByIndividual(row) },
      { key: "individual", label: INDIVIDUAL_LABEL, state: "amber", holds: ownedByIndividual },
      { key: "nobody", label: "Nobody", state: "red", holds: unowned }
    ]
  },
  {
    parameter: MAINTAINED_PARAMETER,
    title: "Maintained",
    hint: "Whether anything has been pushed to ANY branch inside the policy's window. Deliberately a different question from the Default branch pushed column, which reads the default branch alone — a repository with a busy feature branch is alive here and stale there, and both answers are true of it.",
    slices: [
      { key: "maintained", label: "Maintained", state: "green", holds: (row) => row.unmaintained === false },
      { key: "unmaintained", label: "Unmaintained", state: "amber", holds: (row) => row.unmaintained === true },
      // COUNTED AT ZERO ON EVERY CURRENT ROW, and drawn all the same. `unmaintained` is required on the cohort
      // entry and emitted on both branches of measured-ness, so only a deployment older than the field reaches
      // here — but a wheel with no slice for that row would drop it from a total the page states as the public
      // estate, which is the one failure a summary must not have. Dimmed in the legend at zero, like any other
      // empty slice.
      { key: "unstated", label: NOT_STATED, state: "none", holds: (row) => row.unmaintained === undefined }
    ]
  },
  {
    parameter: SCANNING_PARAMETER,
    title: "Code scanning",
    hint: "Whether GitHub's code scanning answered for this repository. On means its alerts were read, however many there were. Off means GitHub answered that the feature is not enabled — over public repositories that is a real gap rather than the licensing boundary it would be on an internal or private one. No state stated means nothing said either way.",
    slices: [
      { key: "on", label: "On", state: "green", holds: (row) => scanState(row.security?.code_scanning) === "read" },
      { key: "off", label: "Off", state: "amber", holds: (row) => scanState(row.security?.code_scanning) === "not-enabled" },
      { key: "unstated", label: NOT_STATED, state: "none", holds: (row) => scanState(row.security?.code_scanning) === "unmeasured" }
    ]
  },
  {
    parameter: CVE_PARAMETER,
    title: "Unsuppressed CVEs",
    hint: "What the build pipeline's own dependency scan last found and nobody has suppressed. NO REPORT IS NOT UNSCANNED: a repository with no Java, Node or Python dependency tree has nothing for that stage to scan, and Dependabot may be watching it regardless — so it is its own slice and is folded into neither of the other two.",
    slices: [
      // A MEASURED ZERO, which is the whole reason this wheel has three slices: a scan that ran and found nothing
      // is the finding, and it is not the same answer as a repository no scan has ever covered.
      { key: "clean", label: "Reported clean", state: "green", holds: (row) => cveEvidence(row)?.live.total === 0 },
      { key: "live", label: "At least one live CVE", state: "amber", holds: (row) => (cveEvidence(row)?.live.total ?? 0) > 0 },
      { key: "unreported", label: "No dependency-scan report", state: "none", holds: (row) => cveEvidence(row) === undefined }
    ]
  }
];

/**
 * Which slice each wheel is filtered on, keyed by the wheel's own parameter. An absent entry is unfiltered.
 *
 * A MAP RATHER THAN FOUR NAMED FLAGS, because the wheels are generated from `ESTATE_DIMENSIONS` and a fifth
 * question added there has to reach the filter without a second edit here.
 */
export type EstateSelections = ReadonlyMap<string, string>;

/**
 * Which wedge each wheel is filtered on, read off the URL as every other control on this table is.
 *
 * A VALUE NO SLICE HAS IS IGNORED rather than matching nothing. A mistyped or stale `?owner=` would otherwise
 * show an empty table for a filter the reader cannot see, which is the failure this module's own header names —
 * the same reason `parseVisibilities` falls back rather than emptying the list.
 */
export function parseSelections(read: (parameter: string) => string | null): EstateSelections {
  const chosen = new Map<string, string>();
  for (const dimension of ESTATE_DIMENSIONS) {
    const stated = read(dimension.parameter);
    if (stated !== null && dimension.slices.some((slice) => slice.key === stated)) {
      chosen.set(dimension.parameter, stated);
    }
  }
  return chosen;
}

/** Whether a row is in every wedge the reader has clicked — the wheels' own half of the AND. */
export function matchesSelections(row: RepositoryRow, selections: EstateSelections): boolean {
  return ESTATE_DIMENSIONS.every((dimension) => {
    const chosen = selections.get(dimension.parameter);
    return chosen === undefined || dimension.slices.some((slice) => slice.key === chosen && slice.holds(row));
  });
}

/**
 * Order a Yes/No/dash cell: No below Yes, and an unreadable answer last in either direction.
 *
 * `undefined` passes straight through rather than becoming a number, because that is the value
 * `sorted` holds back from both ends — the same rule the numeric columns sort an unmeasured count by.
 */
export function answerOrder(answer: boolean | undefined): SortValue {
  return answer === undefined ? undefined : Number(answer);
}

/**
 * The assurance criteria in the order the table's columns read, so a column and a grade cannot disagree.
 *
 * Mirrors `domain.AssuranceCriteria`. Restated here rather than imported because `src/lib/**` is the UI half of
 * the contract and imports nothing from `src/evidence/**` — the same separation `types.ts` keeps.
 */
export const ASSURANCE_CRITERIA: readonly AssuranceCriterion[] = [
  "named-owner",
  "automated-hygiene",
  "no-committed-secrets",
  "security-contact",
  "patching",
  "maintained"
];

/**
 * The heading each criterion's column carries, in the criteria's own words rather than the field's.
 *
 * NAMED FOR THE CRITERION AND NOT THE FIELD, which is the convention worth keeping as this map grows. "Patching
 * cycle" rather than "Oldest alert": the column happens to print an age, but what a reader is checking is whether
 * the team patches, and the age is the evidence for it. "Secrets" rather than "Secret scanning" for the same
 * reason — the criterion is about what is committed, and scanning is the instrument.
 */
export const ASSURANCE_LABEL: Record<AssuranceCriterion, string> = {
  "named-owner": "Code owner",
  "automated-hygiene": "Hygiene",
  "no-committed-secrets": "Secrets",
  "security-contact": "Security contact",
  patching: "Patching cycle",
  maintained: "Maintained"
};

/**
 * The one criterion whose column states what was FOUND rather than whether it passed.
 *
 * Named rather than compared inline, so the table's cell, its sort order and this decision are all pointing at one
 * constant — three separate string literals is how a column ends up sorting by the opposite of what it prints.
 */
export const SECRETS_CRITERION: AssuranceCriterion = "no-committed-secrets";

/**
 * What each criterion column answers, for the hint beside its heading.
 *
 * BESIDE THE LABELS RATHER THAN IN THE COMPONENT, so a criterion added to the domain cannot get a column and a
 * heading while going unexplained — the same reason `ASSURANCE_LABEL` lives here.
 *
 * These say what a cell MEANS, not what the criterion is called. Two of them therefore carry a caveat: `Secrets`
 * evidences committed credentials and not sensitive operational detail, and `security-contact` is reported without
 * being graded. Both were a paragraph under the table until 2026-09-15; per column and on demand is where a reader
 * meets them at the moment they read the cell.
 */
export const ASSURANCE_HINT: Record<AssuranceCriterion, string> = {
  "named-owner":
    "Yes when the repository has an owner at all — a GitHub team, including one named by a CODEOWNERS file, or a named individual. No when nothing owns it, so there is nobody to ask about it.",
  "automated-hygiene":
    "Yes when every readable signal is on: secret scanning, push protection, vulnerability alerts, and automated dependency updates — which either Renovate or Dependabot satisfies. Hover a cell to see which are missing, or expand the column into a check apiece.",
  // Reads as the FINDING and not the verdict — see `findingOrder` and the `Finding` cell for the one column whose
  // Yes is the bad answer.
  "no-committed-secrets": "Yes if potential secrets have been found by the secret scanner.",
  "security-contact": "Whether GitHub reports a security policy. Most will inherit the organisation policy in the hmcts .github repository.",
  patching: "Age in days of the oldest open severe alert.",
  maintained:
    "Yes when the repository is archived, or has been pushed to within the last year. No means it is unarchived and has had no commit for over a year, so it should probably be archived."
};

/**
 * The one CRITERION that is an aggregate, and so the only criterion column that expands.
 *
 * The other five are not aggregates and are deliberately left alone. `Assurance` sums the four graded criteria and
 * each of those is already a column, so expanding it would draw them twice; `patching` is one number; the remaining
 * three are one signal apiece. Hygiene is four checks over five signals, which is the only criterion column where a
 * reader seeing "No" cannot tell from the page which control is missing.
 *
 * The CVE column is the estate table's other aggregate — see `CVE_AGGREGATE` — and one toggle expands both.
 */
export const HYGIENE_CRITERION: AssuranceCriterion = "automated-hygiene";

/**
 * The expand toggle's parameter, beside the four filters' rather than in the component.
 *
 * ONE PARAMETER FOR EVERY AGGREGATE COLUMN. The table has two — Hygiene and the live critical CVE count — and both
 * break down on this one value, because a reader asking for the detail behind one aggregate is asking to see the
 * table in detail. Its spelling is narrower than what it governs; the name is not worth breaking a shared URL over.
 *
 * IN THE URL, WHICH SORT DELIBERATELY IS NOT. The rule this page keeps is that a fact about the window worth
 * sending to somebody goes in the URL and how one reader is looking at the list stays in state — and expansion
 * changes WHAT the table reports where sort changes only the order it reports it in. The consequence is the reason
 * it had to go here: `RepositoriesExport` can read the URL and cannot read component state, so a file whose columns
 * follow the toggle is only possible with the toggle in the query string.
 *
 * Its VALUE is written on and dropped off, exactly as the Production toggle's is: absence needs no meaning here
 * beyond "not expanded", so there is no default for an empty parameter to have to be told apart from.
 */
export const EXPANDED_PARAMETER = "hygiene";

export const EXPANDED_VALUE = "true";

/** Whether the aggregate columns are expanded, read off the URL by both the table and the export. */
export function parseExpanded(read: (parameter: string) => string | null): boolean {
  return read(EXPANDED_PARAMETER) === EXPANDED_VALUE;
}

/**
 * The word on the expand toggle: WHAT IT DOES, which is the one control on this bar named that way.
 *
 * The four filter toggles are named for what they bring IN — `public`, `internal`, `Production` — because each names
 * a set of rows the reader has not got. This one names an action instead, and deliberately: it opens two columns
 * whose own headings are a few centimetres to its left, so naming the control after its content would put one of
 * those words on the page twice with no way to tell the heading from the button — and could not name the other.
 *
 * Beside the parameter it writes, so the control and the state it carries are one decision.
 */
export const EXPAND_LABEL = "Expand";

/**
 * Whether one of two signals answers yes, for a requirement either tool satisfies.
 *
 * `domain/assurance.ts`'s `either` restated, for `ASSURANCE_CRITERIA`'s reason: `src/lib/**` is the UI half of the
 * contract and imports nothing from `src/evidence/**`. The rule has to be the same one, because the column a reader
 * sees and the criterion the grade is built from must agree — `true` beats everything, since one tool doing the job
 * is the requirement met; `false` needs both known and neither doing it; anything else is UNREAD, because a
 * repository whose Dependabot state is off and whose default branch could not be listed has not been shown to lack
 * dependency updates.
 */
function eitherSignal(left: boolean | undefined, right: boolean | undefined): boolean | undefined {
  if (left === true || right === true) {
    return true;
  }
  return left === false && right === false ? false : undefined;
}

/** One check behind the hygiene criterion: its column's heading, what it answers, and the signals it reads. */
export interface HygieneCheck {
  key: string;
  label: string;
  hint: string;
  /** The check's three-valued answer. `undefined` where the signals it needs were not read. */
  read: (signals: AssuranceHygieneSignals | undefined) => boolean | undefined;
}

/**
 * The FOUR CHECKS over FIVE SIGNALS the hygiene criterion is graded on, in `hygieneJudgement`'s own order.
 *
 * THE LAST ONE IS TWO SIGNALS SATISFYING ONE REQUIREMENT, and it is one column for that reason. Rendering
 * Dependabot security updates and the presence of an update configuration as two independent columns would draw
 * the bug the `either` merge fixed: Renovate does not turn GitHub's Dependabot setting on, so a reader would meet a
 * "No" against 244 repositories that keep their dependencies perfectly current. The requirement is that SOMETHING
 * updates them.
 *
 * Beside the criteria's labels and hints rather than in the component, so the table's columns and the export's
 * cannot drift: one definition heads both and reads both.
 */
export const HYGIENE_CHECKS: readonly HygieneCheck[] = [
  {
    key: "secret-scanning",
    label: "Secret scanning",
    hint: "Whether GitHub's secret scanning is switched on. A dash means GitHub did not disclose it, which is not the same as it being off.",
    read: (signals) => signals?.secret_scanning
  },
  {
    key: "push-protection",
    label: "Push protection",
    hint: "Whether secret-scanning push protection is on, which refuses a credential at the push rather than reporting it once it is committed.",
    read: (signals) => signals?.push_protection
  },
  {
    key: "vulnerability-alerts",
    label: "Vulnerability alerts",
    hint: "Whether Dependabot vulnerability alerts are enabled, which is what raises the alerts the patching column ages.",
    read: (signals) => signals?.vulnerability_alerts
  },
  {
    key: "dependency-updates",
    label: "Dependency updates",
    hint: "Yes when something keeps the dependencies current: Dependabot security updates, or a Renovate or Dependabot configuration on the default branch. Either tool satisfies it, so No means both were read and neither is doing it.",
    read: (signals) => eitherSignal(signals?.dependabot_security_updates, signals?.update_configuration)
  }
];

/** The hygiene signals off a row, or nothing where the report collected none for it. */
export function hygieneSignals(row: RepositoryRow): AssuranceHygieneSignals | undefined {
  return row.assurance?.hygiene;
}

/**
 * One CVE column: its heading, what it answers, and which part of the split it counts.
 *
 * THE PART AND THE BANDS ARE DATA RATHER THAN A READER FUNCTION, so the one test that separates "nobody scanned
 * this" from "a scan found none" lives in `cveCount` alone. A column carrying its own `(row) => number | undefined`
 * would be six places that test could be got wrong, and getting it wrong reads as a clean repository.
 */
export interface CveColumn {
  key: string;
  label: string;
  hint: string;
  /** Which half of the split this column counts. `live` and `suppressed` partition `all` — see `CveEvidence`. */
  part: (evidence: CveEvidence) => CveCount;
  /** The severity bands counted, or nothing for a column that counts its part whole. */
  severities?: readonly CveSeverity[];
}

/**
 * The bands the `Other` column folds together: every severity the two named columns do not carry.
 *
 * `unknown` IS IN HERE AND IS NOT A MISSING VALUE. uv audit states no severity at all and a few dependency-check
 * findings carry no CVSS block, so those findings are real and have to be counted somewhere — see `CveSeverity`.
 * Dropping them would make `Total` larger than `Crit + High + Other`, which is the sum this breakdown promises.
 */
const CVE_OTHER_SEVERITIES: readonly CveSeverity[] = ["medium", "low", "unknown"];

/**
 * The critical live count, which is both the aggregate column and one of the parts it breaks into.
 *
 * ONE DEFINITION SPREAD INTO TWO COLUMNS rather than two definitions that happen to agree. `Crit` repeating the
 * aggregate is deliberate — see `CVE_AGGREGATE` — and a second literal here is how the aggregate and its own part
 * would come to count different things.
 */
const CVE_CRITICAL: CveColumn = {
  key: "cve-critical",
  label: "Crit",
  hint: "The critical unsuppressed CVEs. The same figure as the aggregate to its left, repeated so that Crit, High and Other add up to Total.",
  part: (evidence) => evidence.live,
  severities: ["critical"]
};

/**
 * The CVE column the table draws without being expanded: the LIVE CRITICAL count.
 *
 * ONE FIGURE OF THE FIVE, because it is the one a reader acts on. A critical CVE nobody has suppressed is the thing
 * to fix this week, and a column of totals would rank an estate by how much it depends on rather than by exposure.
 *
 * ITS HEADING NAMES THE SUPPRESSION STATE, which no shorter wording can leave out. "Critical CVEs" would be read as
 * every critical the scan found, and the figures disagree: a team that has reviewed and accepted a finding has done
 * the work this column is asking for, and counting it against them reports a judgement somebody already made as an
 * outstanding risk.
 */
export const CVE_AGGREGATE: CveColumn = {
  ...CVE_CRITICAL,
  key: "cves",
  label: "Unsuppressed Crit CVEs",
  hint: "How many distinct critical CVEs the build pipeline's own dependency scan last found and nobody has suppressed. A dash means no report has been published for this repository, which is unmeasured rather than clean; 0 means a scan ran and found none. Expand the column for the whole position."
};

/**
 * The five figures the CVE aggregate expands into, in the order they read.
 *
 * TOTAL, CRIT, HIGH AND OTHER COUNT THE UNSUPPRESSED FINDINGS ONLY, and `Suppressed` is a separate count beside
 * them rather than part of the run. So `Total === Crit + High + Other` and a reader who adds the row up gets the
 * right answer — which is the arithmetic the heading promises and the reason `Suppressed` is last rather than
 * folded in. `CveEvidence.all` is therefore drawn nowhere: it is `Total + Suppressed`, and a sixth column whose
 * value is the sum of two others invites the reader to add all five.
 *
 * Beside the criteria's labels and the hygiene checks' rather than in the component, on their reason: one
 * definition heads the table and the export, so the file and the page cannot drift.
 */
export const CVE_COLUMNS: readonly CveColumn[] = [
  {
    key: "cve-total",
    label: "Total",
    hint: "Every unsuppressed CVE the scan found, whatever its severity. Crit, High and Other are this figure broken down, so the three of them sum to it.",
    part: (evidence) => evidence.live
  },
  CVE_CRITICAL,
  {
    key: "cve-high",
    label: "High",
    hint: "The high-severity unsuppressed CVEs.",
    part: (evidence) => evidence.live,
    severities: ["high"]
  },
  {
    key: "cve-other",
    label: "Other",
    hint: "The unsuppressed CVEs of medium, low or unstated severity. Some scanners state no severity at all, and those findings are counted here rather than dropped.",
    part: (evidence) => evidence.live,
    severities: CVE_OTHER_SEVERITIES
  },
  {
    key: "cve-suppressed",
    label: "Suppressed",
    hint: "CVEs suppressed everywhere they appear, at any severity — reviewed and accepted, so counted beside the live figures rather than among them.",
    part: (evidence) => evidence.suppressed
  }
];

/**
 * The CVE figures off a row, or nothing where no report has been published for it.
 *
 * THIS IS THE MEASUREMENT TEST AND THE ONLY ONE. Roughly 1,529 repositories of 1,890 reach here with nothing,
 * because only three CNP builders publish a report at all — so an absence folded to `0` anywhere downstream would
 * report four fifths of the estate as carrying no critical CVEs when nothing has ever looked at it.
 */
export function cveEvidence(row: Pick<RepositoryRow, "cves">): CveEvidence | undefined {
  return row.cves?.cves;
}

/**
 * Why a repository has no CVE figures, for the hover on its dash.
 *
 * EXACTLY ONE OF THE FIGURES AND THE REASON ARRIVES — see `CveReport` — so this is set precisely where
 * `cveEvidence` is not, and the dash a reader hovers is the one it explains. The criteria cells surface their own
 * detail the same way.
 */
export function cveDetail(row: Pick<RepositoryRow, "cves">): string | undefined {
  return row.cves?.detail;
}

/**
 * How many distinct CVEs the named bands of one part hold.
 *
 * A BAND WITH NOTHING IN IT IS ABSENT FROM `by_severity` AND READS AS ZERO HERE, which is the one place `?? 0` is
 * right in this module: a `CveCount` only exists inside a report that has a scan behind it, so the measurement has
 * already happened and an empty band is a measured nothing. Whether the scan happened at all is `cveEvidence`'s
 * question, answered before this is ever called.
 */
function severityCount(counts: CveCount, severities: readonly CveSeverity[]): number {
  return severities.reduce((running, severity) => running + (counts.by_severity[severity] ?? 0), 0);
}

/**
 * One CVE column's figure for one row: a count where a scan ran, and nothing where none has.
 *
 * `undefined` AND `0` ARE DIFFERENT ANSWERS and this is where they are told apart, once, for every column and for
 * both the table and the export.
 */
export function cveCount(row: Pick<RepositoryRow, "cves">, column: CveColumn): number | undefined {
  const evidence = cveEvidence(row);
  if (evidence === undefined) {
    return undefined;
  }
  const part = column.part(evidence);
  return column.severities === undefined ? part.total : severityCount(part, column.severities);
}

/**
 * Where a CVE count sorts: the MOST findings first on one ascending click.
 *
 * NEGATED, which is `findingOrder`'s rule applied to a number. One click has to open on the repositories a reader
 * is looking for, and on these columns those are the ones with the most to fix; sorted as it reads, the useful end
 * of the column would need two clicks.
 *
 * An unmeasured repository stays `undefined`, which `sorted` holds back from BOTH ends — the same treatment an
 * unread hygiene signal and an unobserved figure get. "Which repositories carry the most live criticals" is a
 * question about the ones somebody scanned, and a repository nobody scanned is not the answer to it either way up.
 */
export function cveOrder(count: number | undefined): SortValue {
  return count === undefined ? undefined : -count;
}

/**
 * The four grades, IN THE ORDER A READER MEANS BY "sort by assurance", which every map below is total over.
 *
 * `RAG_STATES`'s counterpart, and here for its reason: the order the grades are drawn in, labelled in and sorted
 * by is one decision, and three separately-ordered maps is how a column comes to sort by the opposite of what it
 * prints. A grade added to `AssuranceGrade` then has to be given a place here, a word and a colour, rather than
 * silently sorting as if it had none.
 */
export const ASSURANCE_GRADES: readonly AssuranceGrade[] = ["met", "partly-read", "partial", "unknown"];

/**
 * How each assurance grade reads.
 *
 * DELIBERATELY NOT `RAG_LABEL`'s WORDS. That map reads "Ready / Caution / Blocked" about readiness for AI
 * enablement, and a repository can be ready for that and still fail the assurance criteria. These say what they
 * are about: whether the criteria are met.
 *
 * "MEETS WHAT WAS READ" IS ABOUT THE EVIDENCE AND "PARTLY MEETS" IS ABOUT THE REPOSITORY, which is the whole
 * point of there being two of them. The first has no shortfall to report and some criterion nobody could look at;
 * the second failed one that was looked at. They read `met` as one word until 2026-09-15 — so a failed org-wide
 * secret-scanning call graded the entire estate "Meets criteria" on three criteria out of four, and no reader
 * could tell from the page that a claim had shrunk.
 *
 * IN `ASSURANCE_GRADES` ORDER rather than alphabetically, so the words and the sort cannot disagree.
 */
export const ASSURANCE_GRADE_LABEL: Record<AssuranceGrade, string> = {
  met: "Meets criteria",
  "partly-read": "Meets what was read",
  partial: "Partly meets",
  unknown: "Cannot assess"
};

/**
 * The RAG state each assurance grade is DRAWN in, so the colours are `rag.ts`'s and the words are not.
 *
 * `partial` is amber rather than red on the domain's own reasoning: none of the four criteria is a disqualifier
 * on its own, so a shortfall is something to act on and not a repository to stop using. `unknown` maps to
 * `cannot_assess`, which `rag.ts` already draws slate for exactly this reason — a half-read question must not be
 * coloured warm, or a missing permission reads as a bad result.
 *
 * `partly-read` IS SLATE ON THAT SAME RULE, and it is the case the rule was written for: the unread half of the
 * question is what makes the grade short of `met`, and nothing about the repository is wanting. Green would be
 * the old bug in a new colour and amber would blame a failed org-wide call on the team. It shares its colour with
 * `unknown` and not its word — `rag.ts` already has `cannot_assess` and `none` sharing slate for the same reason,
 * the bar being decoration and the label the information.
 */
export const ASSURANCE_GRADE_STATE: Record<AssuranceGrade, RAGState> = {
  met: "green",
  "partly-read": "cannot_assess",
  partial: "amber",
  unknown: "cannot_assess"
};

/** One criterion's result off a row, or nothing where the report sent no assurance block. */
export function criterionResult(row: RepositoryRow, criterion: AssuranceCriterion): AssuranceCriterionResult | undefined {
  return row.assurance?.criteria.find((entry) => entry.criterion === criterion);
}

/**
 * Where an assurance grade sorts: met, then met-as-far-as-read, then partly, then the one nothing could be read for.
 *
 * The same shape as `severity` in `rag.ts` and for its reason — the English words sort as "Cannot assess, Meets,
 * Meets what was read, Partly", which is an order about spelling. `unknown` sorts as unmeasured, which `sorted`
 * holds back from both ends: "which repositories fail the criteria" is a question about the graded ones.
 *
 * `partly-read` SORTS AND `unknown` DOES NOT, though both are short of a full read, because one of them has
 * answers and the other has none. Held back with `unknown` it would take most of the estate out of the column the
 * moment an org-wide read failed, which is the reader's own way of finding the repositories that fail.
 *
 * It sorts BELOW `met` AND ABOVE `partial`: less assured than a repository read in full, and not a finding
 * against the repository the way a criterion read and failed is.
 */
export function assuranceOrder(grade: AssuranceGrade | undefined): SortValue {
  if (grade === undefined || grade === "unknown") {
    return undefined;
  }
  return ASSURANCE_GRADES.indexOf(grade);
}

/**
 * Where one criterion's outcome sorts: met, then unmet, then unreadable.
 *
 * Met FIRST so that clicking a criterion's header ascending opens on the repositories that satisfy it and
 * descending on the ones that do not — which is the way round a reader means by "sort by this column". Reversed,
 * the useful end would need two clicks.
 */
export function outcomeOrder(outcome: AssuranceOutcome | undefined): SortValue {
  if (outcome === undefined || outcome === "unknown") {
    return undefined;
  }
  return outcome === "met" ? 0 : 1;
}

/**
 * Whether one criterion's outcome is a FINDING, for the column that states what was found rather than whether the
 * criterion was met.
 *
 * `Secrets` answers "were potential secrets found", from 2026-09-15, where it used to answer "is this repository
 * clean". The criterion underneath is unchanged and still grades a repository DOWN for open alerts — it is only
 * the cell that speaks the finding's language, because "Secrets: Yes" reading as "no secrets" was backwards.
 *
 * `undefined` where nothing could be read, so an unreadable repository is not reported as clean.
 */
export function foundOutcome(outcome: AssuranceOutcome | undefined): boolean | undefined {
  if (outcome === undefined || outcome === "unknown") {
    return undefined;
  }
  return outcome === "unmet";
}

/**
 * Where a finding sorts: found first, then not found, then unreadable.
 *
 * Found FIRST for `outcomeOrder`'s reason turned round. One click ascending has to open on the repositories a
 * reader is looking for, and on this column those are the ones with something to fix.
 */
export function findingOrder(outcome: AssuranceOutcome | undefined): SortValue {
  const found = foundOutcome(outcome);
  return found === undefined ? undefined : found ? 0 : 1;
}

/**
 * Whether one criterion was MET, as the three-valued answer its cell prints.
 *
 * `foundOutcome`'s counterpart for the five columns that answer whether the criterion passed rather than what was
 * found. Same shape and the same treatment of `unknown`: nobody could read it, so it is neither met nor unmet, and
 * folding it into `false` would report a missing permission as a repository that fails.
 */
export function metOutcome(outcome: AssuranceOutcome | undefined): boolean | undefined {
  return outcome === undefined || outcome === "unknown" ? undefined : outcome === "met";
}

/**
 * Yes, No, or a dash: the words every three-valued answer on the estate table prints.
 *
 * ONE DEFINITION FOR FOUR COLUMNS AND THE EXPORT. The criteria, the finding and the production attribute each
 * spelled these words for themselves, which was harmless while they were only rendered — and stopped being
 * harmless the moment a CSV had to say the same thing about the same row, because a fifth copy is how a file comes
 * to disagree with the page it was exported from.
 *
 * The dash rather than a blank, here as everywhere: `false` is an answer and an unreadable field is not, and only
 * a visible mark keeps the two apart in a column of otherwise short words.
 */
export function answerWord(answer: boolean | undefined): string {
  return answer === undefined ? ABSENT : answer ? "Yes" : "No";
}

/**
 * The patching criterion's age, in the days-suffixed form its column prints.
 *
 * A dash rather than `0d` where nothing severe is open, which would claim an alert was raised today. Whether
 * nothing is open or nothing could be read is the `patching` criterion's own outcome to say, not this cell's.
 */
export function alertAge(days: number | undefined): string {
  return days === undefined ? ABSENT : `${days}d`;
}
