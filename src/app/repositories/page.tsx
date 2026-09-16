import { cookies } from "next/headers";
import { CollectionNotice } from "@/components/CollectionNotice";
import { EmptyState } from "@/components/EmptyState";
import { FilterSearchBox } from "@/components/FilterSearchBox";
import { MetricCard } from "@/components/MetricCard";
import { NavWeekSelector } from "@/components/NavWeekSelector";
import { OrganisationHeader } from "@/components/OrganisationHeader";
import { RepositoriesExport } from "@/components/RepositoriesExport";
import { RepositoriesTable, TERM_PARAMETER } from "@/components/RepositoriesTable";
import { Panel, Section } from "@/components/Section";
import { getOverview, getRepositories, getTeamContributors, getWindows } from "@/lib/api";
import { count, span } from "@/lib/format";
import { resolveWeeks, type SearchValue, WEEKS_COOKIE } from "@/lib/weeks";

/**
 * The estate at one window span: what was covered, how it is labelled, and every repository in it.
 *
 * The landing page, from 2026-09-02: the three lists that used to be sections of one overview are
 * three routes now, and this is the one a reader arrives at. The estate figures and the readiness
 * donut stay here rather than being repeated on the other two — they are counts over repositories,
 * which is what this page is a list of.
 *
 * Rendered on every request. The service holds one built report per span and rebuilds it when a
 * collection lands, so a cached page here would show figures whose source has moved on with nothing
 * on the page to say so — and `cookies()` is read for the span preference besides.
 */
export const dynamic = "force-dynamic";

export default async function RepositoriesPage({ searchParams }: { searchParams?: Promise<{ weeks?: SearchValue }> }) {
  const windows = await getWindows();
  const weeks = resolveWeeks((await searchParams)?.weeks, (await cookies()).get(WEEKS_COOKIE)?.value, windows.options, windows.default);
  // Three requests against one bundle, fetched together rather than in sequence: they come from the
  // same built report in the service, so serialising them would only add a round trip to it. The third
  // is the export's alone — the table needs no contributors — and it is a fold over the same cached
  // span build rather than a query, so it costs the page no read.
  const [overview, repositories, teamContributors] = await Promise.all([getOverview(weeks), getRepositories(weeks), getTeamContributors(weeks)]);
  const window = span(overview.starts_at, overview.ends_at);

  return (
    <div className="space-y-8">
      <CollectionNotice windows={windows} />

      <OrganisationHeader overview={overview} action={<NavWeekSelector options={windows.options} active={weeks} />} />

      {/* The estate's headline figures share the panel every section is drawn on: the cards
          themselves are flat now, and four unbounded figures would float on the page background. */}
      <Panel>
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-4 p-4">
          <MetricCard
            // The qualifier is on the LABEL and not in `detail`, which is spoken for: it carries how many of
            // these the window could be reported for. `cohort.include_archived` defaults false and `metrics.yaml`
            // does not override it, so `selectCohort` drops every archived repository and this figure has never
            // counted one — the count was accurate and only the name for it was not.
            label="Repositories (excluding archived)"
            value={overview.repositories}
            detail={overview.unavailable > 0 ? `${overview.repositories - overview.unavailable} reported` : "all reported"}
          />
          <MetricCard label="Teams" value={overview.teams} />
          <MetricCard label="Contributors" value={overview.actors} detail="contributed to a reported repository" />
          <MetricCard
            label="Merged pull requests"
            value={overview.merged_pull_requests}
            detail={`${count(overview.direct_commits, "direct commit", "direct commits")} besides`}
          />
        </div>
      </Panel>

      {/* THE SIX DONUTS ARE GONE, and what they drew is not lost — it moved. Five of the six were
          ways-of-working dimensions: the readiness distribution, the declared gate's two halves,
          unreviewed substantial merges. That is the same material `/teams` now reports per team,
          which is where a reader asks how a team works. The sixth, test coverage, read a field the
          report layer has never emitted and so drew an all-unknown circle.

          They were also the only way to CREATE a table filter — clicking a wedge wrote the query
          parameter the chips read back — so `ESTATE_FILTERS` and the chips went with them rather
          than leaving a reader able to dismiss a filter they had no way to apply. The controls that
          remain are the ones with their own affordance: the term box, the Production toggle and the
          three visibility toggles. */}

      {/* "UNARCHIVED ONLY" IS A FACT ABOUT THE COHORT and belongs beside the list it qualifies. The estate is
          selected by `cohort.include_archived`, which `src/evidence/policy/schema.ts` defaults to `false` and
          `metrics.yaml` does not override — so `selectCohort` drops every archived repository and this table has
          never held one. Nothing on the page said so, which left "1,880 repositories" reading as the whole
          organisation. `detail` rather than the heading, because this is what the section was measured over. */}
      <Section
        heading="Repositories"
        detail={`${window}, unarchived only, most recently pushed first`}
        action={<FilterSearchBox parameter={TERM_PARAMETER} placeholder="Filter by repository or team…" />}
      >
        {repositories.length === 0 ? (
          <EmptyState
            message="No repository is configured for this organisation."
            detail="Add repositories to the configuration the service was started with."
          />
        ) : (
          // THE EXPORT SITS AT THE END OF THE FILTER ROW because it is scoped BY those controls: what the
          // button hands the reader is what the term and the toggles have left, so it reads beside the state
          // it reflects rather than up in the section heading. Passed as a slot, so a team's page — the same
          // table — renders no export: the owning teams' contributors are its second column, and a team page
          // already lists its own people in a section of their own.
          <RepositoriesTable
            rows={repositories}
            weeks={weeks}
            action={<RepositoriesExport rows={repositories} teamContributors={teamContributors} window={window} />}
          />
        )}
      </Section>
    </div>
  );
}
