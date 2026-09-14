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
import { distributionState, RAG_HEX, RAG_LABEL, RAG_STATES, type RAGState, state } from "@/lib/rag";
import { compare, type SortValue } from "@/lib/sort";
import {
  type Band,
  CHECKS_BANDS,
  COVERAGE_BANDS,
  checksBand,
  coverageBand,
  REVIEW_BANDS,
  reviewBand,
  SECURITY_BANDS,
  securityBand,
  UNREVIEWED_BANDS,
  unreviewedBand
} from "@/lib/tone";
import type { AssuranceCriterion, AssuranceCriterionResult, AssuranceGrade, AssuranceOutcome, RepositoryRow, Visibility } from "@/lib/types";

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
 * The default order: MOST RECENTLY PUSHED FIRST.
 *
 * This replaced an order by `(team, repository)`, whose reasoning was that a reader scanning the list reads one
 * team's repositories together. At 1,880 rows that is not what a reader arriving at the page is doing: they are
 * asking what has been happening, and the alphabet answers with whichever team begins with `a`. A team's own
 * repositories are still readable together — the term filters on the team name and the Team header still sorts —
 * so what changed is only which question the page opens on.
 *
 * A ROW WITH NO `pushed_at` SORTS LAST, both here and under a header click. GitHub omits it for a repository never
 * pushed to, and its absence is meaningful: it must not be defaulted to the epoch, which would put every empty
 * repository at the bottom as though it were the stalest, nor to now, which would put it at the top. `sorted`
 * already holds `undefined` back from both ends and this follows that precedent explicitly.
 *
 * THE TIEBREAK IS THE REPOSITORY NAME AND IT IS LOAD-BEARING. Two repositories pushed at the same instant is not
 * hypothetical — the instant has second resolution and a `for_each` Terraform apply touches many at once — and
 * "two reports of one window must not differ" is a rule this codebase states in three other places. Without it,
 * two renders of one estate could order those rows differently.
 *
 * The old order's reasoning about shared repositories is PRESERVED and still applies: a repository appears once,
 * at one position. It just no longer appears under a heading.
 */
export function orderRepositories(rows: readonly RepositoryRow[]): RepositoryRow[] {
  const pushed = rows.filter((row) => row.pushed_at !== undefined);
  const never = rows.filter((row) => row.pushed_at === undefined);
  // Descending on the instant, ascending on the name: `compare` orders text and instants alike, and an ISO-8601
  // string sorts lexicographically in instant order, which is why the contract carries these as strings.
  const ordered = [...pushed].sort((left, right) => -compare(left.pushed_at, right.pushed_at) || compare(left.repository, right.repository));
  return [...ordered, ...[...never].sort((left, right) => compare(left.repository, right.repository))];
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

/** The six dimensions the estate can be filtered by, one per donut and one per URL parameter. */
export type FilterParameter = "label" | "review" | "checks" | "unreviewed" | "coverage" | "security";

/** One value a dimension can be filtered to: the slice a reader clicked, in the slice's own words. */
export interface FilterOption {
  /** The value that goes in the URL — a `RAGState` or a band key, never the words beside it. */
  key: string;
  name: string;
  /** A colour value, not a class: the chip's dot is the mark its donut drew the slice with. */
  color: string;
}

/**
 * One filterable dimension: its parameter, the words a chip reads it as, its values, and how a row
 * is placed in one of them.
 */
export interface EstateFilter {
  parameter: FilterParameter;
  /** The title a chip prints before the value, and the donut's own heading. */
  title: string;
  options: readonly FilterOption[];
  /** Which option a row falls in, by the same function the donut counted it with. */
  band: (row: RepositoryRow) => string;
}

/** Read a band table as filter options, so a legend entry and a chip can never say different words. */
function bandOptions(bands: readonly Band[]): FilterOption[] {
  return bands.map((entry) => ({ key: entry.key, name: entry.name, color: entry.mark }));
}

/**
 * The six donuts as filters, each classifying a row with the function its own donut counts by.
 *
 * The `band` functions are `tone.ts`'s, not copies of them: the filtered row count has to equal the
 * legend count of the slice that was clicked, and a second definition of "moderate coverage" is how
 * a table shows nine rows under a wedge that says eleven. Readiness comes from `rag.ts` for the same
 * reason — the donut is drawn from `RAG_HEX` and the chip's dot is the same hex.
 *
 * `label` keeps the parameter name the readiness filter has always used, so links shared before the
 * other five dimensions existed still filter what they filtered.
 */
export const ESTATE_FILTERS: readonly EstateFilter[] = [
  {
    parameter: "label",
    title: "Readiness",
    options: RAG_STATES.map((readiness) => ({
      key: readiness,
      name: RAG_LABEL[readiness],
      color: RAG_HEX[readiness]
    })),
    // Folded through `distributionState`, as the donut counts through it: a label this build does
    // not know is counted under "Not assessed" in the slice, so it has to be selected by that slice
    // too. Without the fold the row falls in no option and the table shows one row fewer than the
    // wedge said — the one divergence every other band function here is written to avoid.
    band: (row) => distributionState(state(row.readiness))
  },
  {
    parameter: "review",
    title: "Enforces review",
    options: bandOptions(REVIEW_BANDS),
    band: (row) => reviewBand(row.required_approving_reviews)
  },
  {
    parameter: "checks",
    title: "Enforces CI",
    options: bandOptions(CHECKS_BANDS),
    band: (row) => checksBand(row.required_status_checks)
  },
  {
    parameter: "unreviewed",
    title: "Unreviewed substantial merges",
    options: bandOptions(UNREVIEWED_BANDS),
    band: (row) => unreviewedBand(row.unreviewed_substantial)
  },
  {
    parameter: "coverage",
    title: "Test coverage",
    options: bandOptions(COVERAGE_BANDS),
    band: (row) => coverageBand(row.sonar_coverage)
  },
  {
    parameter: "security",
    title: "Security issues",
    options: bandOptions(SECURITY_BANDS),
    band: (row) => securityBand(row)
  }
];

export const FILTER_PARAMETERS: readonly FilterParameter[] = ESTATE_FILTERS.map((filter) => filter.parameter);

/**
 * The production filter's parameter, DELIBERATELY OUTSIDE `ESTATE_FILTERS`.
 *
 * Every entry in that list is a donut's dimension: it has options, each with a colour its own slice
 * was drawn in, a band function that places a row in one of them, and — because of all that — a
 * dismissible chip in the bar under the charts. Production has none of it. It is one two-state
 * toggle over an attribute nothing graphs, and folding it into the list would give it a chip with an
 * × on it, which is the one control it must not have: the toggle is part of the bar rather than
 * something a reader has added to it.
 */
export const PRODUCTION_PARAMETER = "production";

/**
 * The only value the toggle ever writes, and so the only one that reads back as on.
 *
 * A two-state control needs no vocabulary, but it does need one spelling: matching on anything
 * truthy would make `?production=0` an odd way of saying yes.
 */
export const PRODUCTION_VALUE = "true";

/** Whether the production filter is on, read off the URL the same way the six dimensions are. */
export function parseProduction(read: (parameter: string) => string | null): boolean {
  return read(PRODUCTION_PARAMETER) === PRODUCTION_VALUE;
}

/** Which value each dimension is filtered to, where the dimension is filtered at all. */
export type RepositoryFilters = Partial<Record<FilterParameter, string>>;

/**
 * Read every dimension's filter off the URL, keeping only the values that name one of its options.
 *
 * A value in no option is dropped rather than kept: six parameters typed by hand and shared in links
 * is six ways to arrive at a table filtered to a value nothing can carry, and an empty list is a
 * worse answer than the whole one.
 */
export function parseFilters(read: (parameter: string) => string | null): RepositoryFilters {
  const filters: RepositoryFilters = {};
  for (const filter of ESTATE_FILTERS) {
    const raw = read(filter.parameter);
    if (raw !== null && filter.options.some((option) => option.key === raw)) {
      filters[filter.parameter] = raw;
    }
  }
  return filters;
}

/**
 * The rows a reader is looking at: the term, the production toggle, and every dimension they have
 * filtered, all together.
 *
 * Dimensions AND, because that is what clicking a second donut means — the repositories that are
 * blocked AND enforce no review — and each is checked with its own donut's band function, so the
 * table under a wedge holds exactly the rows the wedge counted. The production toggle ANDs with them
 * for the same reason.
 *
 * A row whose production answer could not be read is EXCLUDED while the toggle is on, rather than
 * kept on the chance that it is one. The toggle says "show me the production services", and a
 * repository nobody could classify is not an answer to that — leaving it in would put rows under a
 * count that did not count them, and letting it in as `false` would be the same guess in reverse.
 */
export function filterRepositories(
  rows: readonly RepositoryRow[],
  term: string,
  filters: RepositoryFilters,
  production = false,
  visibilities: ReadonlySet<Visibility> = new Set(VISIBILITIES)
): RepositoryRow[] {
  const active = ESTATE_FILTERS.filter((filter) => filters[filter.parameter] !== undefined);
  return rows.filter(
    (row) =>
      matchesRepository(row, term) &&
      matchesVisibility(row, visibilities) &&
      (!production || row.production === true) &&
      active.every((filter) => filter.band(row) === filters[filter.parameter])
  );
}

/**
 * How many production repositories the reader's OTHER filters leave, which is what the toggle counts.
 *
 * The production dimension itself is excluded from its own count — the rule the readiness bar
 * counted by before the donuts replaced it, where the counts came off
 * `filterRepositories(rows, term, null)`. A count that included its own filter would read `n` before
 * the click and `n` after it, which tells a reader nothing: the number is there to say what turning
 * the toggle on would leave.
 */
export function productionCount(rows: readonly RepositoryRow[], term: string, filters: RepositoryFilters): number {
  return filterRepositories(rows, term, filters, true).length;
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
export const ASSURANCE_CRITERIA: readonly AssuranceCriterion[] = ["named-owner", "automated-hygiene", "patching", "maintained"];

/** The heading each criterion's column carries, in the criteria's own words rather than the field's. */
export const ASSURANCE_LABEL: Record<AssuranceCriterion, string> = {
  "named-owner": "Team owner",
  "automated-hygiene": "Hygiene",
  patching: "Oldest alert",
  maintained: "Maintained"
};

/**
 * How each assurance grade reads.
 *
 * DELIBERATELY NOT `RAG_LABEL`'s WORDS. That map reads "Ready / Caution / Blocked" about readiness for AI
 * enablement, and a repository can be ready for that and still fail the assurance criteria. These say what they
 * are about: whether the criteria are met.
 */
export const ASSURANCE_GRADE_LABEL: Record<AssuranceGrade, string> = {
  met: "Meets criteria",
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
 */
export const ASSURANCE_GRADE_STATE: Record<AssuranceGrade, RAGState> = {
  met: "green",
  partial: "amber",
  unknown: "cannot_assess"
};

/** One criterion's result off a row, or nothing where the report sent no assurance block. */
export function criterionResult(row: RepositoryRow, criterion: AssuranceCriterion): AssuranceCriterionResult | undefined {
  return row.assurance?.criteria.find((entry) => entry.criterion === criterion);
}

/**
 * Where an assurance grade sorts: met, then partly, then the one that could not be read.
 *
 * The same shape as `severity` in `rag.ts` and for its reason — the English words sort as "Cannot assess, Meets,
 * Partly", which is an order about spelling. `unknown` sorts as unmeasured, which `sorted` holds back from both
 * ends: "which repositories fail the criteria" is a question about the graded ones.
 */
export function assuranceOrder(grade: AssuranceGrade | undefined): SortValue {
  if (grade === undefined || grade === "unknown") {
    return undefined;
  }
  return grade === "met" ? 0 : 1;
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
