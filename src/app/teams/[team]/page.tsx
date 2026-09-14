import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { CollectionNotice } from "@/components/CollectionNotice";
import { SummaryPieChart } from "@/components/charts/SummaryPieChart";
import { EmptyState } from "@/components/EmptyState";
import { EntityHeader } from "@/components/EntityHeader";
import { FilterSearchBox } from "@/components/FilterSearchBox";
import { NavWeekSelector } from "@/components/NavWeekSelector";
import { RepositoriesTable, TERM_PARAMETER } from "@/components/RepositoriesTable";
import { Section } from "@/components/Section";
import { TeamActorsTable } from "@/components/TeamActorsTable";
import { TeamPractice, TeamThroughput } from "@/components/TeamPractice";
import { getTeam, getWindows, isNotFound } from "@/lib/api";
import { distributionSlices } from "@/lib/chart";
import { holdings, people, unreported } from "@/lib/team";
import type { TeamDetail } from "@/lib/types";
import { resolveWeeks, type SearchValue, WEEKS_COOKIE } from "@/lib/weeks";

/**
 * One team's window: what it owns, how those repositories are labelled, and who worked in them.
 *
 * The label distribution is a count per label and stops there. There is no combined team label, no
 * team score, and no comparison against another team anywhere on this page — the reversal of
 * 2026-09-01 permitted per-team COUNTS for display and nothing beyond them (architecture.md, "Scope
 * boundaries"). The contributor list is alphabetical: its rows are two counts inside this team and
 * carry no label to order by, which is what the `/contributors` list orders on instead.
 *
 * The repositories table is the shared component, handed this team's rows: a team page and the
 * repositories list then agree about what a repository row says, and the search box, the donut's
 * filter and the chip it raises all work here exactly as they do there.
 */
export const dynamic = "force-dynamic";

export default async function TeamPage({ params, searchParams }: { params: Promise<{ team: string }>; searchParams?: Promise<{ weeks?: SearchValue }> }) {
  const windows = await getWindows();
  const weeks = resolveWeeks((await searchParams)?.weeks, (await cookies()).get(WEEKS_COOKIE)?.value, windows.options, windows.default);
  const detail = await readTeam((await params).team, weeks);
  const missing = unreported(detail);

  return (
    <div className="space-y-8">
      <CollectionNotice windows={windows} />

      <EntityHeader
        kind="team"
        name={detail.team}
        action={<NavWeekSelector options={windows.options} active={weeks} />}
        context={
          <>
            <span>{holdings(detail)}</span>
            <span>{people(detail)}</span>
            {missing ? <span className="text-slate-500">{missing}</span> : null}
          </>
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* NOT CLICKABLE ANY MORE, and the reason is the repositories table rather than this page. It used to
            filter on `?label=`, which the shared table read back through `ESTATE_FILTERS`; those filters went
            with the donuts on `/repositories`, so a wedge here would write a parameter nothing reads. A control
            that silently does nothing is worse than a picture, so it is a picture. The term box below still
            narrows the list, which is what a reader of one team's repositories actually reaches for. */}
        <SummaryPieChart
          title="Readiness"
          // `detail.labels` distributes the reported repositories only while the table below holds
          // every configured one, so the unreportable ones are added here: without them the legend would
          // total less than the table beneath it.
          data={distributionSlices(detail.labels, detail.unavailable)}
          // NAMES WHICH QUESTION IT GRADES, from 2026-09-14, because there are now two and they are not versions
          // of each other. This one is readiness for AI enablement, judged from the ways of working below it;
          // `/repositories` grades whether a repository meets the assurance criteria for coding in the open.
          tooltip="How many of this team’s repositories carry each readiness label for AI enablement at this span, judged from the ways of working below. This is not the coding-in-the-open assurance grade, which the repositories list carries. The counts are per repository: they are not combined into a label for the team, and no team is ranked against another."
        />
      </div>

      {/* HOW THIS TEAM WORKS, which is what moved here from the repositories table. That page answers whether a
          repository meets the assurance criteria for coding in the open; this answers the merge-gate and review
          mechanics, which are a fact about the team rather than about any one repository. Counts over stated
          denominators and nothing combined — see `TeamPractice`. */}
      {detail.practice === undefined ? null : (
        <Section heading="Ways of working" detail="counted across this team’s repositories">
          <TeamPractice practice={detail.practice} />
          <TeamThroughput practice={detail.practice} />
        </Section>
      )}

      <Section
        heading="Repositories"
        detail="most recently pushed first"
        action={<FilterSearchBox parameter={TERM_PARAMETER} placeholder="Filter by repository…" />}
      >
        {detail.repositories.length === 0 ? (
          <EmptyState
            message={`No repository is configured for ${detail.team}.`}
            detail="Add repositories to this team in the configuration the service was started with."
          />
        ) : (
          <RepositoriesTable rows={detail.repositories} weeks={weeks} />
        )}
      </Section>

      <Section heading="Contributors" detail="alphabetical, counted within this team’s repositories">
        {detail.actors.length === 0 ? (
          <EmptyState
            message={`Nobody authored a reported merge in ${detail.team}’s repositories at this span.`}
            detail="Read the team at a longer span, or run metrics collect for the span being asked for."
          />
        ) : (
          <TeamActorsTable rows={detail.actors} weeks={weeks} />
        )}
      </Section>
    </div>
  );
}

/**
 * Read one team, answering not-found for an identifier the configuration does not hold.
 *
 * Only a 404 becomes a not-found page: a team is configured or it is not, and every other refusal is
 * a fault in the service or the network that should surface as one rather than as a team nobody has
 * heard of.
 */
async function readTeam(team: string, weeks: number): Promise<TeamDetail> {
  try {
    return await getTeam(team, weeks);
  } catch (error) {
    if (isNotFound(error)) {
      notFound();
    }
    throw error;
  }
}
