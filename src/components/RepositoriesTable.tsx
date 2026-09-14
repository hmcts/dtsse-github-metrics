"use client";

import clsx from "clsx";
import { X } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { EmptyState } from "@/components/EmptyState";
import { OwnerName } from "@/components/OwnerName";
import { ProductionBadge } from "@/components/ProductionBadge";
import { type Align, SortHeader } from "@/components/SortHeader";
import { filterTarget } from "@/lib/filter";
import { ABSENT, day } from "@/lib/format";
import { PRODUCTION_DOT, PRODUCTION_LABEL, PRODUCTION_TOGGLE_ACTIVE, PRODUCTION_TOGGLE_INACTIVE } from "@/lib/production";
import { RAG_BADGE, RAG_BORDER } from "@/lib/rag";
import {
  ASSURANCE_CRITERIA,
  ASSURANCE_GRADE_LABEL,
  ASSURANCE_GRADE_STATE,
  ASSURANCE_LABEL,
  answerOrder,
  assuranceOrder,
  criterionResult,
  ESTATE_FILTERS,
  type EstateFilter,
  type FilterOption,
  filterRepositories,
  orderRepositories,
  outcomeOrder,
  PRODUCTION_PARAMETER,
  PRODUCTION_VALUE,
  parseFilters,
  parseProduction,
  parseVisibilities,
  productionCount,
  VISIBILITIES,
  VISIBILITY_OFF,
  VISIBILITY_ON,
  visibilityParameter
} from "@/lib/rows";
import { type Direction, nextDirection, type SortValue, sorted } from "@/lib/sort";
import type { AssuranceGrade, AssuranceOutcome, RepositoryRow, Visibility } from "@/lib/types";
import { withWeeks } from "@/lib/weeks";

/**
 * Every configured repository in one table: what was found in this window, and what was not.
 *
 * A repository the window has no evidence for keeps its row and states its reason under the name,
 * with dashes in place of counts. Dropping it would make the list read as the whole estate when it is
 * the reportable part of it, and filling zeros in would claim nothing was merged there.
 *
 * The filter term and every donut's filter live in the URL, so a filtered table is a thing that can
 * be reloaded and shared. Sorting stays in component state: it is how one reader is looking at the
 * list right now, not a fact about the window worth sending to somebody.
 *
 * The bar above the table is ALWAYS THERE, because it holds a control of its own: the Production
 * toggle, first in the row and with no way to remove it. The donuts above it are the other controls,
 * and the rest of the bar shows what they have been set to — one chip per filtered dimension, each
 * dismissable on its own, so a reader who has stacked three of them can see all three and drop the
 * one they did not mean. A bar that appeared and vanished with those chips read as a status line; a
 * permanent one reads as the control it now is, with the chips as additions to it.
 */
export const TERM_PARAMETER = "repository";

export const LABEL_PARAMETER = "label";

interface Column {
  key: string;
  label: string;
  align?: Align;
  read: (row: RepositoryRow) => SortValue;
}

/**
 * The columns, from 2026-09-14: basic identity, then one per assurance criterion.
 *
 * EIGHT COLUMNS WENT AND FIVE OF THEM WERE ALREADY EMPTY. Readiness, Merged and Direct commits carried real
 * figures; Open, Stale, Sonar, Findings and CODEOWNERS rendered a dash for every repository in the estate,
 * because the report layer emits none of the fields they read — verified against the deployed page, where the
 * strings `>Yes<` and `>No<` appear zero times. So "we removed eight columns" is really "we removed three and
 * cleared five that were never populated".
 *
 * Readiness is the one whose removal is a decision rather than a tidy-up. It grades READINESS FOR AI ENABLEMENT
 * off ways-of-working conditions, which is a different question from the assurance criteria this page now
 * answers — so it moves to `/teams`, where the ways-of-working material belongs, and to a repository's own page.
 * It is not deleted and its thresholds are untouched.
 *
 * `Last pushed` and `Visibility` are the "basic info" the page still carries, and both are load-bearing rather
 * than decoration: the first is the default sort and the second the default filter, so a reader can see what
 * they are being ordered and narrowed by.
 */
const COLUMNS: readonly Column[] = [
  { key: "team", label: "Team", read: (row) => row.team },
  { key: "repository", label: "Repository", read: (row) => row.repository },
  // The default sort's own column, so what the table opens on is visible rather than implicit. Sorts on the ISO
  // string, which orders lexicographically in instant order — see `RepositoryRow.pushed_at` for why the contract
  // carries it as text and not as a `Date`.
  { key: "pushed", label: "Last pushed", read: (row) => row.pushed_at },
  { key: "visibility", label: "Visibility", read: (row) => row.visibility },
  // The one grade on this page. Its own vocabulary rather than readiness's — see `ASSURANCE_GRADE_LABEL`.
  { key: "assurance", label: "Assurance", read: (row) => assuranceOrder(row.assurance?.grade) },
  // One per criterion, in the criteria's own order, generated rather than listed so a criterion added to the
  // domain cannot appear in the grade and be missing from the table.
  ...ASSURANCE_CRITERIA.map((criterion) => ({
    key: criterion,
    label: ASSURANCE_LABEL[criterion],
    // Patching prints a NUMBER OF DAYS and sorts on it; the other three print an outcome and sort on that. The
    // criterion reports an age against no threshold, so ordering it by its outcome would sort every repository
    // level — the age is the whole information.
    align: (criterion === "patching" ? "right" : "center") as Align,
    read:
      criterion === "patching"
        ? (row: RepositoryRow) => row.assurance?.oldest_severe_alert_days
        : (row: RepositoryRow) => outcomeOrder(criterionResult(row, criterion)?.outcome)
  })),
  // Kept from the old table, and the only one of the eight that was both populated and not ways-of-working:
  // whether a repository deploys to production qualifies every assurance answer beside it.
  { key: "production", label: "Production", align: "center", read: (row) => answerOrder(row.production) }
];

export function RepositoriesTable({ rows, weeks }: { rows: readonly RepositoryRow[]; weeks: number }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParameters = useSearchParams();
  const [column, setColumn] = useState<Column | null>(null);
  const [direction, setDirection] = useState<Direction>("ascending");

  const term = searchParameters.get(TERM_PARAMETER) ?? "";
  const filters = parseFilters((parameter) => searchParameters.get(parameter));
  const production = parseProduction((parameter) => searchParameters.get(parameter));
  const visibilities = parseVisibilities((parameter) => searchParameters.get(parameter));
  const found = filterRepositories(rows, term, filters, production, visibilities);
  const ordered = column === null ? orderRepositories(found) : sorted(found, column.read, direction);
  const chips = activeChips(filters);
  const produced = productionCount(rows, term, filters);

  function sort(next: Column) {
    setDirection(nextDirection(column, next, direction));
    setColumn(next);
  }

  function toggleVisibility(visibility: Visibility) {
    // WRITTEN EXPLICITLY IN BOTH DIRECTIONS, unlike the production toggle whose off state is the parameter's
    // absence. Absence here has to keep meaning "the reader has said nothing", so it can fall back to public-only;
    // were off expressed as absence, turning public off would produce the same URL as never having touched it.
    const chosen = visibilities.has(visibility) ? VISIBILITY_OFF : VISIBILITY_ON;
    router.replace(filterTarget(pathname, window.location.search, visibilityParameter(visibility), chosen), {
      scroll: false
    });
  }

  function clear(parameter: string) {
    // Clearing a filter is the parameter's absence rather than an empty value, which would read back
    // as a filter for the empty string. `window.location.search`, so the other chips, the term and
    // the span all come through — this drops one dimension, not the reader's whole view.
    router.replace(filterTarget(pathname, window.location.search, parameter, ""), {
      scroll: false
    });
  }

  function toggleProduction() {
    // The same navigation the chips make, in the toggle's one value: on writes it, off is the
    // parameter's absence rather than an empty value. `window.location.search` keeps the span, the
    // term and every chip — this control owns one parameter and touches nothing else.
    const chosen = production ? "" : PRODUCTION_VALUE;
    router.replace(filterTarget(pathname, window.location.search, PRODUCTION_PARAMETER, chosen), {
      scroll: false
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Repository filters">
        {/* The readiness bar's shape before the donuts replaced it: a dot, the word, and a count in
            `tabular-nums` so the figure does not shift as it changes. `aria-pressed` rather than a
            chip with an ×, because this is a state a reader turns on and off and not one they
            arrived at by clicking a slice. */}
        <button
          type="button"
          onClick={toggleProduction}
          aria-pressed={production}
          className={clsx(
            "flex items-center gap-1.5 rounded px-2 py-1 text-xs transition-colors",
            "focus:outline-none focus-visible:ring-1 focus-visible:ring-indigo-500",
            production ? PRODUCTION_TOGGLE_ACTIVE : PRODUCTION_TOGGLE_INACTIVE
          )}
        >
          <span className={clsx("shrink-0 w-2 h-2 rounded-full", PRODUCTION_DOT)} aria-hidden="true" />
          {PRODUCTION_LABEL}
          <span className="tabular-nums text-slate-500">{produced}</span>
        </button>

        {/* THREE INDEPENDENT TOGGLES rather than one tri-state, so "public and internal but not private" is
            expressible — which is the obvious question for a page about coding in the open. They read as the
            Production toggle does, `aria-pressed` and no ×, because each is a state a reader turns on and off
            rather than a filter they arrived at by clicking a slice. */}
        {VISIBILITIES.map((visibility) => (
          <button
            key={visibility}
            type="button"
            onClick={() => toggleVisibility(visibility)}
            aria-pressed={visibilities.has(visibility)}
            className={clsx(
              "flex items-center gap-1.5 rounded px-2 py-1 text-xs capitalize transition-colors",
              "focus:outline-none focus-visible:ring-1 focus-visible:ring-indigo-500",
              visibilities.has(visibility) ? "bg-slate-700 text-slate-100" : "bg-slate-800 text-slate-500 hover:bg-slate-700 hover:text-slate-300"
            )}
          >
            {visibility}
            <span className="tabular-nums text-slate-500">{rows.filter((row) => row.visibility === visibility).length}</span>
          </button>
        ))}

        {chips.map(({ filter, option }) => (
          <span key={filter.parameter} className="flex items-center gap-1.5 rounded bg-slate-800 py-1 pl-2 pr-1 text-xs text-slate-200">
            <span className="shrink-0 w-2 h-2 rounded-full" style={{ backgroundColor: option.color }} aria-hidden="true" />
            <span className="text-slate-400 uppercase tracking-wide">{`${filter.title}: `}</span>
            {option.name}
            <button
              type="button"
              onClick={() => clear(filter.parameter)}
              aria-label={`Remove ${filter.title} filter`}
              className="rounded text-slate-500 transition-colors hover:text-slate-200 focus:outline-none focus-visible:ring-1 focus-visible:ring-indigo-500"
            >
              <X className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          </span>
        ))}
      </div>

      {ordered.length === 0 ? (
        <EmptyState message="No repository matches this filter." detail="Clear the term, the Production toggle, or a filter above, to see the whole estate." />
      ) : (
        // No border of its own: the table sits inside a `Section` panel that already draws one.
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-slate-400 border-b border-slate-800">
              <tr>
                {COLUMNS.map((entry, index) => (
                  <SortHeader
                    key={entry.key}
                    label={entry.label}
                    active={entry === column}
                    direction={direction}
                    align={entry.align}
                    first={index === 0}
                    onSort={() => sort(entry)}
                  />
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/50">
              {ordered.map((row) => (
                <tr key={row.repository} className="hover:bg-slate-800/30">
                  {/* The left bar is the ASSURANCE grade's now, not readiness's: this page grades one question
                      and the bar has to be about the same one as the column beside it. */}
                  <td className={clsx("py-2 pl-3 pr-3", RAG_BORDER[ASSURANCE_GRADE_STATE[row.assurance?.grade ?? "unknown"]])}>
                    <OwnerName row={row} weeks={weeks} />
                  </td>
                  <td className="py-2 pr-3">
                    <Link
                      href={withWeeks(`/repositories/${encodeURIComponent(row.repository)}`, weeks)}
                      className="font-mono text-indigo-400 hover:text-indigo-300 break-all"
                    >
                      {row.repository}
                    </Link>
                    {row.detail ? <p className="text-slate-500 mt-0.5">{row.detail}</p> : null}
                  </td>
                  {/* The UTC day rather than the instant: a table of 1,880 rows is scanned for how long ago,
                      and `day` is the same formatter every other date on the site reads through. */}
                  <td className="py-2 pr-3 tabular-nums text-slate-300">{day(row.pushed_at)}</td>
                  <td className="py-2 pr-3 capitalize text-slate-400">{row.visibility ?? ABSENT}</td>
                  <td className="py-2 pr-3">
                    <AssuranceLabel grade={row.assurance?.grade} />
                  </td>
                  {ASSURANCE_CRITERIA.map((criterion) =>
                    criterion === "patching" ? (
                      // The AGE, with no colouring and no threshold. "Measurement first": the number is the
                      // finding and the reader is the judge, so a tone here would publish an SLA nobody chose.
                      <td key={criterion} className="py-2 pr-3 text-right tabular-nums text-slate-300">
                        {row.assurance?.oldest_severe_alert_days === undefined ? ABSENT : `${row.assurance.oldest_severe_alert_days}d`}
                      </td>
                    ) : (
                      <Outcome key={criterion} result={criterionResult(row, criterion)} />
                    )
                  )}
                  {/* Yes/No/dash like every other governance answer on this row, rather than the badge the
                      entity headers carry: in a column of columns, a lone badge reads as decoration and its
                      absence reads as an empty cell rather than as "no". The dash keeps "not in the list" apart
                      from "the list could not be read", which a blank could not say. */}
                  <Answer value={row.production} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * The dimensions filtered right now, each with the option it is filtered to.
 *
 * In `ESTATE_FILTERS` order rather than in the order the parameters were clicked, so the chips sit
 * in the order the donuts above them do and a chip does not move when another is dropped. A
 * dimension whose value named no option was already dropped by `parseFilters`, which is why the
 * lookup here cannot come back empty.
 */
function activeChips(filters: ReturnType<typeof parseFilters>): { filter: EstateFilter; option: FilterOption }[] {
  return ESTATE_FILTERS.flatMap((filter) => {
    const option = filter.options.find((entry) => entry.key === filters[filter.parameter]);
    return option === undefined ? [] : [{ filter, option }];
  });
}

/**
 * One criterion's outcome, as a word with the detail behind it.
 *
 * TONED, unlike every cell in the old table, and that is the difference this page makes: these ARE the grade
 * rather than figures beside one. The colours are `rag.ts`'s so a criterion cell and the grade column agree, and
 * the word carries the information — `RAGLabel`'s rule, so it survives a monochrome print and a screen reader.
 *
 * The `title` is the judgement's own detail, which is what names the missing control on a composite: a reader
 * seeing "No" under Hygiene can hover for "not configured: Dependabot security updates".
 */
/**
 * A three-valued answer: Yes, No, or a dash where nothing could be read.
 *
 * UNCOLOURED, unlike `Outcome`. Deploying to production is an attribute rather than a verdict — it qualifies
 * every assurance answer beside it without being one — so it is stated in the same words as the graded columns
 * and deliberately not in their colours. A green Yes here would read as a criterion met.
 *
 * The dash is load-bearing: a repository the production list was read for and does not name answers No, and one
 * whose list could not be read answers neither. A blank cell could not tell those apart.
 */
function Answer({ value }: { value?: boolean }) {
  return <td className="py-2 pr-3 text-center text-slate-300">{value === undefined ? ABSENT : value ? "Yes" : "No"}</td>;
}

function Outcome({ result }: { result?: { outcome: AssuranceOutcome; detail: string } }) {
  const outcome = result?.outcome;
  return (
    <td className="py-2 pr-3 text-center" title={result?.detail}>
      <span
        className={clsx(
          outcome === "met" ? "text-rag-green" : null,
          outcome === "unmet" ? "text-rag-amber" : null,
          outcome === undefined || outcome === "unknown" ? "text-slate-500" : null
        )}
      >
        {outcome === undefined || outcome === "unknown" ? ABSENT : outcome === "met" ? "Yes" : "No"}
      </span>
    </td>
  );
}

/**
 * The assurance grade as a badge, in `RAG_BADGE`'s shape and its OWN WORDS.
 *
 * Not `RAGLabel`, which reads readiness's vocabulary — "Ready", "Blocked" — about a different question. Same
 * shape and same palette so the page looks like one thing; different words so it says the true thing.
 */
function AssuranceLabel({ grade }: { grade?: AssuranceGrade }) {
  const resolved = grade ?? "unknown";
  return (
    <span className={clsx("inline-block rounded px-1.5 py-0.5 text-xs whitespace-nowrap", RAG_BADGE[ASSURANCE_GRADE_STATE[resolved]])}>
      {ASSURANCE_GRADE_LABEL[resolved]}
    </span>
  );
}
