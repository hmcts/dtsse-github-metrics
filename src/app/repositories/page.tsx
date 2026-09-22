import { EmptyState } from "@/components/EmptyState";
import { EstateSummary } from "@/components/EstateSummary";
import { FilterSearchBox } from "@/components/FilterSearchBox";
import { MetricCard } from "@/components/MetricCard";
import { OrganisationHeader } from "@/components/OrganisationHeader";
import { RepositoriesExport } from "@/components/RepositoriesExport";
import { RepositoriesTable, TERM_PARAMETER } from "@/components/RepositoriesTable";
import { Panel, Section } from "@/components/Section";
import { getOverview, getRepositories, getTeamContributors, getWindows } from "@/lib/api";
import { count, span } from "@/lib/format";
import { uncollectedCount } from "@/lib/rows";

/**
 * The estate as it stands: every repository's control state, and what was collected for it.
 *
 * A SNAPSHOT AND NOT A WINDOW, from 2026-09-17, which is why this page has no week selector where the other two
 * lists do. Everything the table draws is CONTROL STATE read from `repository_state` — the six assurance criteria,
 * the four hygiene checks behind one of them, ownership, visibility, last push, production — and none of it is
 * scoped to a reporting window. `ASSURANCE_CRITERIA` is the whole list and `evidence/domain/assurance.ts` consumes
 * no behaviour fact: grep it for `merges` and nothing answers. A selector over figures that do not move is a
 * control that invites the reader to believe they do.
 *
 * TWO CARDS ARE STILL WINDOWED AND SAY SO IN THEIR LABELS. `overview.merged_pull_requests`, `overview.direct_commits`
 * and `overview.actors` are folds over the window's merge cohort — see `builtOverviewSummary` — so they are the two
 * figures on this page that a different span would change. They are kept because the estate's throughput is worth
 * stating somewhere, and each carries the window it was counted over in its own heading. `Repositories` and `Teams`
 * carry no such label: they are cohort facts, counted off the ownership graph rather than off any window.
 *
 * NO `?weeks=` IS READ HERE, and a stray one is IGNORED rather than redirected away. This page has no parameter to
 * resolve, so an old bookmark cannot change what it renders; `proxy` has already turned the value into the reader's
 * remembered preference, which the pages that do state a window will honour; and the URL also carries the table's
 * own term, production, visibility and expand state and the four summary wheels' wedges, all written client-side
 * with `replaceState` — so a redirect would have to carry nine other parameters through or silently drop the
 * reader's filters.
 *
 * Rendered on every request. The service holds one built report per span and rebuilds it when a collection lands,
 * so a cached page here would show figures whose source has moved on with nothing on the page to say so.
 */
export const dynamic = "force-dynamic";

export default async function RepositoriesPage() {
  const windows = await getWindows();
  // THE SPAN THIS PAGE PINS, and the service's own default is chosen for one reason: it is the span every other
  // page opens at, so its bundle is the one already built. Asking for any other would force a cold build to answer
  // a page that reports no window. Nothing the table draws depends on the choice — the two throughput cards are
  // the only figures that move, and they state the window they were counted over.
  const weeks = windows.default;
  // Three requests against one bundle, fetched together rather than in sequence: they come from the
  // same built report in the service, so serialising them would only add a round trip to it. The third
  // is the export's alone — the table needs no contributors — and it is a fold over the same cached
  // span build rather than a query, so it costs the page no read.
  const [overview, repositories, teamContributors] = await Promise.all([getOverview(weeks), getRepositories(weeks), getTeamContributors(weeks)]);
  // Read off the report rather than recomputed from `weeks`, so the label states what the bundle actually covers.
  const window = span(overview.starts_at, overview.ends_at);
  const windowLabel = count(overview.weeks, "week", "weeks");
  // The rows this page has a reason for, which is not `overview.unavailable` — see `uncollectedCount`.
  const uncollected = uncollectedCount(repositories);

  return (
    <div className="space-y-8">
      {/* No control in the header: this page states no window, so it offers no way to change one. What it does
          state is provenance — the collection the figures are anchored at and when the report was built. */}
      <OrganisationHeader overview={overview} snapshot unavailable={uncollected} />

      {/* The estate's headline figures share the panel every section is drawn on: the cards
          themselves are flat now, and four unbounded figures would float on the page background. */}
      <Panel>
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-4 p-4">
          <MetricCard
            // The qualifier is on the LABEL and not in `detail`, which is spoken for: it carries how many of these
            // the last collection reached. `cohort.include_archived` defaults false and `metrics.yaml` does not
            // override it, so `selectCohort` drops every archived repository and this figure has never counted one.
            label="Repositories (excluding archived)"
            value={overview.repositories}
            detail={uncollected > 0 ? `${overview.repositories - uncollected} reported` : "all reported"}
          />
          <MetricCard label="Teams" value={overview.teams} />
          {/* THE TWO WINDOWED FIGURES, each labelled with the window it covers. The label rather than the detail,
              on the precedent of the archived qualifier above: `detail` is spoken for on both of these, and a
              window stated only in small print under a number is a window a reader scanning four cards will miss.
              Derived from `overview.weeks` rather than written out, so the pinned span and these headings cannot
              come apart. */}
          <MetricCard label={`Contributors (${windowLabel})`} value={overview.actors} detail="contributed to a reported repository" />
          <MetricCard
            label={`Merged pull requests (${windowLabel})`}
            value={overview.merged_pull_requests}
            detail={`${count(overview.direct_commits, "direct commit", "direct commits")} besides`}
          />
        </div>
      </Panel>

      {/* FOUR WHEELS, ON THE FOUR QUESTIONS THIS PAGE ANSWERS. Two are about stewardship and two about security;
          none of them is a ways-of-working question, which is what `/teams` reports and what took five of the six
          charts that used to stand here off this page. Each is a CONTROL as well as a chart — a wedge writes its
          slice to the query and the table below narrows — which is the half the previous charts took with them
          when they went, leaving the reader chips they could dismiss and had no way to set.

          THE COHORT IS STATED IN THE HEADING AND THE REASON IS ON THE HINT. A figure whose denominator is not the
          table's row count reads as disagreeing with the table, and this one is deliberately not: secret scanning
          is free on public repositories and needs GitHub Advanced Security on internal and private ones, so every
          internal and private repository legitimately reports the security controls off and a wheel including them
          would draw a licensing boundary as an estate-wide gap.

          NO BANNER AND NO WARNING TONE anywhere in here. Three of the four wheels have a slice for the state
          nobody stated — three quarters of the CVE wheel is repositories with no dependency-scan report — and that
          is the finding rather than something to apologise for on a strip across the page. */}
      <EstateSummary rows={repositories} />

      {/* "UNARCHIVED ONLY" IS A FACT ABOUT THE COHORT and belongs beside the list it qualifies. The estate is
          selected by `cohort.include_archived`, which `src/evidence/policy/schema.ts` defaults to `false` and
          `metrics.yaml` does not override — so `selectCohort` drops every archived repository and this table has
          never held one. Nothing on the page said so, which left "1,880 repositories" reading as the whole
          organisation. `detail` rather than the heading, because this is what the section was measured over.

          No span here either: what the table shows is not measured over one. */}
      <Section
        heading="Repositories"
        detail="unarchived only, most recently pushed first"
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
          //
          // NO `weeks` ON THE TABLE, so its links to a repository and to a team are bare. This page states no
          // window and must not push its pinned span onto a reader who chose another one — see `withWeeks`.
          <RepositoriesTable rows={repositories} action={<RepositoriesExport rows={repositories} teamContributors={teamContributors} window={window} />} />
        )}
      </Section>
    </div>
  );
}
