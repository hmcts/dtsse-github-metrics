"use client";

import { SummaryPieChart } from "@/components/charts/SummaryPieChart";
import { EmptyState } from "@/components/EmptyState";
import { InfoTooltip } from "@/components/InfoTooltip";
import { Section } from "@/components/Section";
import { dimensionSlices } from "@/lib/chart";
import { count } from "@/lib/format";
import { cohortRows, ESTATE_DIMENSIONS, type EstateCohort, type EstateDimension } from "@/lib/rows";
import type { RepositoryRow } from "@/lib/types";

/**
 * Why the public group's wheels count public repositories and nothing else, in the words the page shows a reader.
 *
 * ON THE HINT AND NOT IN A PARAGRAPH, on the criterion columns' precedent: the reason is specific, it is longer
 * than a heading, and a reader wants it at the moment they doubt a figure rather than on the way past. What the
 * heading itself carries is the DENOMINATOR, because that is the part a figure is misread without.
 */
const SCOPE_HINT =
  "Public repositories only. Internal and private repositories are excluded because secret scanning is free on a public repository and needs GitHub Advanced Security elsewhere — so they report the security controls off for a licensing reason rather than a shortfall, and a wheel counting them would draw that boundary as a gap in the estate. These figures do not move with the table's own filters.";

/**
 * Why the all-repositories wheels count what they count, beside the heading their denominator is stated in.
 *
 * THE UNREPORTED ROWS ARE COUNTED AND NOT DROPPED. A repository the span could not be reported for is still a
 * repository on the list, and a wheel that left it out would sum to a figure the table below does not show.
 */
const ALL_HINT =
  "Every unarchived repository listed, whatever its visibility — these questions are answered on the same terms by public, internal and private repositories. A repository the span could not be reported for is still counted, in the wheel's unknown or not-assessed slice, rather than left out. These figures do not move with the table's own filters.";

/** One group of wheels: the cohort it counts, the words its heading uses for that cohort, and its hint. */
interface Group {
  cohort: EstateCohort;
  heading: string;
  singular: string;
  plural: string;
  hint: string;
  /** Why an empty cohort draws no wheels, in the words the empty state shows. */
  empty: string;
}

/** All repositories first, then the public estate, matching the order the cohorts narrow in. */
const GROUPS: readonly Group[] = [
  {
    cohort: "all",
    heading: "Estate summary: all repositories",
    singular: "repository",
    plural: "repositories",
    hint: ALL_HINT,
    empty: "Nothing is listed, so there is nothing to distribute."
  },
  {
    cohort: "public",
    heading: "Estate summary: public repositories",
    singular: "public repository",
    plural: "public repositories",
    hint: SCOPE_HINT,
    empty: "These questions are asked of the public estate only, so there is nothing to distribute."
  }
];

/**
 * The estate wheels, in one group per cohort, each wheel a filter on the table below it.
 *
 * EACH GROUP STATES ITS OWN DENOMINATOR. The public group is drawn over `publicRepositories(rows)` for the
 * licensing reason `SCOPE_HINT` gives; the all group over every row it is handed. Neither moves with the term, the
 * production toggle or the visibility toggles. These are statements about the estate and the heading names the
 * denominator; a figure that moved as a reader typed in the filter box would be a different chart on every
 * keystroke and could not be quoted. What a wedge does is narrow the LIST, which is a separate thing from what the
 * wheels count.
 *
 * THE CONSEQUENCE IS THE ONE THING WORTH KNOWING HERE: a group's total and the table's row count are not the same
 * number once a reader has typed a term or changed a toggle. That is why each cohort is stated beside its heading
 * rather than left to be inferred from the list.
 *
 * GENERATED FROM `ESTATE_DIMENSIONS` rather than written out wheel by wheel, so a question added there gets a
 * wheel, a parameter and a filter in its cohort's group without a component being edited — the rule
 * `ASSURANCE_CRITERIA` gives the table's criterion columns. A cohort with no wheel draws no group.
 *
 * A CLIENT COMPONENT because each wheel reads and writes the query, and it is handed rows the page has already
 * fetched: the counting is `dimensionSlices` over an array in props, so no wheel costs a request to draw or to
 * click.
 *
 * NO WHEELS IN A GROUP WHOSE COHORT IS EMPTY, and a sentence instead. Rings each saying "No data" under a heading
 * reading "no public repositories" is the same fact repeated, and the reason — an estate with nothing public in
 * it — is not a fault in any one question. Only that group goes quiet: the all-repositories group still draws.
 */
export function EstateSummary({ rows, dimensions = ESTATE_DIMENSIONS }: { rows: readonly RepositoryRow[]; dimensions?: readonly EstateDimension[] }) {
  return (
    <>
      {GROUPS.map((group) => (
        <EstateGroup key={group.cohort} group={group} rows={rows} dimensions={dimensions.filter((dimension) => dimension.cohort === group.cohort)} />
      ))}
    </>
  );
}

function EstateGroup({ group, rows, dimensions }: { group: Group; rows: readonly RepositoryRow[]; dimensions: readonly EstateDimension[] }) {
  if (dimensions.length === 0) {
    return null;
  }

  const cohort = cohortRows(group.cohort, rows);

  if (cohort.length === 0) {
    return (
      <Section heading={group.heading} action={<InfoTooltip text={group.hint} />}>
        <EmptyState message={`No ${group.singular} is reported for this organisation.`} detail={group.empty} />
      </Section>
    );
  }

  return (
    <Section
      // Counted off the same rows the wheels are drawn over, so the number beside the heading and the number the
      // slices sum to cannot come apart.
      heading={group.heading}
      detail={`${count(cohort.length, group.singular, group.plural)}; click a slice to filter the list`}
      action={<InfoTooltip text={group.hint} />}
    >
      {/* TWO UP ON A TABLET AND FOUR ACROSS ON A DESKTOP, matching the metric cards above. Four rings in a row on
          a narrow viewport would each be too small to aim at, and it is the legend under each rather than the ring
          itself that sets the minimum width. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        {dimensions.map((dimension) => (
          <SummaryPieChart
            key={dimension.parameter}
            title={dimension.title}
            data={dimensionSlices(dimension, cohort)}
            tooltip={dimension.hint}
            parameter={dimension.parameter}
            showsAllVisibilities={dimension.cohort === "all"}
          />
        ))}
      </div>
    </Section>
  );
}
