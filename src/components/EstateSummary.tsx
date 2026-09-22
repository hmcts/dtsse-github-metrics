"use client";

import { SummaryPieChart } from "@/components/charts/SummaryPieChart";
import { EmptyState } from "@/components/EmptyState";
import { InfoTooltip } from "@/components/InfoTooltip";
import { Section } from "@/components/Section";
import { dimensionSlices } from "@/lib/chart";
import { count } from "@/lib/format";
import { ESTATE_DIMENSIONS, publicRepositories } from "@/lib/rows";
import type { RepositoryRow } from "@/lib/types";

/**
 * Why the wheels count public repositories and nothing else, in the words the page shows a reader.
 *
 * ON THE HINT AND NOT IN A PARAGRAPH, on the criterion columns' precedent: the reason is specific, it is longer
 * than a heading, and a reader wants it at the moment they doubt a figure rather than on the way past. What the
 * heading itself carries is the DENOMINATOR, because that is the part a figure is misread without.
 */
const SCOPE_HINT =
  "Public repositories only. Internal and private repositories are excluded because secret scanning is free on a public repository and needs GitHub Advanced Security elsewhere — so they report the security controls off for a licensing reason rather than a shortfall, and a wheel counting them would draw that boundary as a gap in the estate. These figures do not move with the table's own filters.";

/**
 * The four wheels over the public estate, each a filter on the table below it.
 *
 * DRAWN OVER `publicRepositories(rows)` AND OVER NOTHING ELSE — not the term, not the production toggle, not the
 * visibility toggles. These are a statement about the public estate and the heading names the denominator; a figure
 * that moved as a reader typed in the filter box would be a different chart on every keystroke and could not be
 * quoted. What a wedge does is narrow the LIST, which is a separate thing from what the wheels count.
 *
 * THE CONSEQUENCE IS THE ONE THING WORTH KNOWING HERE: the wheels' total and the table's row count are not the
 * same number once a reader has typed a term or turned internal on. That is why the cohort is stated beside the
 * heading rather than left to be inferred from the list.
 *
 * GENERATED FROM `ESTATE_DIMENSIONS` rather than written out four times, so a fifth question added there gets a
 * wheel, a parameter and a filter without a component being edited — the rule `ASSURANCE_CRITERIA` gives the
 * table's criterion columns.
 *
 * A CLIENT COMPONENT because each wheel reads and writes the query, and it is handed rows the page has already
 * fetched: the counting is `dimensionSlices` over an array in props, so no wheel costs a request to draw or to
 * click.
 *
 * NO WHEELS AT ALL WHERE THE COHORT IS EMPTY, and a sentence instead. Four rings each saying "No data" under a
 * heading reading "no public repositories" is the same fact four times over, and the reason — an estate with
 * nothing public in it — is not a fault in any one of the four questions.
 */
export function EstateSummary({ rows }: { rows: readonly RepositoryRow[] }) {
  const cohort = publicRepositories(rows);

  if (cohort.length === 0) {
    return (
      <Section heading="Estate summary" action={<InfoTooltip text={SCOPE_HINT} />}>
        <EmptyState
          message="No public repository is reported for this organisation."
          detail="These four questions are asked of the public estate only, so there is nothing to distribute."
        />
      </Section>
    );
  }

  return (
    <Section
      // Counted off the same rows the wheels are drawn over, so the number beside the heading and the number the
      // slices sum to cannot come apart.
      heading="Estate summary"
      detail={`${count(cohort.length, "public repository", "public repositories")}; click a slice to filter the list`}
      action={<InfoTooltip text={SCOPE_HINT} />}
    >
      {/* TWO UP ON A TABLET AND FOUR ACROSS ON A DESKTOP, matching the metric cards above. Four rings in a row on
          a narrow viewport would each be too small to aim at, and it is the legend under each rather than the ring
          itself that sets the minimum width. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        {ESTATE_DIMENSIONS.map((dimension) => (
          <SummaryPieChart
            key={dimension.parameter}
            title={dimension.title}
            data={dimensionSlices(dimension, cohort)}
            tooltip={dimension.hint}
            parameter={dimension.parameter}
          />
        ))}
      </div>
    </Section>
  );
}
