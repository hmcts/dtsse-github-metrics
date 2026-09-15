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
import type { RAGState } from "@/lib/rag";
import { compare, type SortValue } from "@/lib/sort";
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
 * The rows a reader is looking at: the term, the visibilities, and the production toggle together.
 *
 * THE THREE AND, which is what stacking controls means — the public repositories whose name matches AND which
 * deploy to production. The six donut dimensions used to AND here too; they went with the charts, since a filter
 * a reader can dismiss but has no way to apply is a half-wired control surface.
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
  visibilities: ReadonlySet<Visibility> = new Set(VISIBILITIES)
): RepositoryRow[] {
  return rows.filter((row) => matchesRepository(row, term) && matchesVisibility(row, visibilities) && (!production || row.production === true));
}

/**
 * How many production repositories the reader's OTHER controls leave, which is what the toggle counts.
 *
 * The production dimension itself is excluded from its own count. A count that included its own filter would
 * read `n` before the click and `n` after it, which tells a reader nothing: the number is there to say what
 * turning the toggle on would leave.
 */
export function productionCount(rows: readonly RepositoryRow[], term: string, visibilities?: ReadonlySet<Visibility>): number {
  return filterRepositories(rows, term, true, visibilities).length;
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
    "Yes when the repository is attributed to a GitHub team, including by a CODEOWNERS file naming one, or to an individual who is still a member of the hmcts organisation. No when its only owner has left the organisation, or when nothing owns it at all.",
  "automated-hygiene":
    "Yes when every readable signal is on: secret scanning, push protection, vulnerability alerts, and automated dependency updates — which either Renovate or Dependabot satisfies. Hover a cell to see which are missing.",
  // Reads as the FINDING and not the verdict — see `findingOrder` and the `Finding` cell for the one column whose
  // Yes is the bad answer.
  "no-committed-secrets": "Yes if potential secrets have been found by the secret scanner.",
  "security-contact": "Whether GitHub reports a security policy. Most will inherit the organisation policy in the hmcts .github repository.",
  patching: "Age in days of the oldest open severe alert.",
  maintained:
    "Yes when the repository is archived, or has been pushed to within the last year. No means it is unarchived and has had no commit for over a year, so it should probably be archived."
};

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
