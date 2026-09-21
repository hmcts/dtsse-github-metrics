import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { EmptyState } from "@/components/EmptyState";
import { EntityHeader } from "@/components/EntityHeader";
import { FilterSearchBox } from "@/components/FilterSearchBox";
import { NavWeekSelector } from "@/components/NavWeekSelector";
import { RepositoriesTable, TERM_PARAMETER } from "@/components/RepositoriesTable";
import { Section } from "@/components/Section";
import { TeamActorsTable } from "@/components/TeamActorsTable";
import { TeamDirectPushesTable } from "@/components/TeamDirectPushesTable";
import { TeamMembersTable } from "@/components/TeamMembersTable";
import { TeamMergesTable } from "@/components/TeamMergesTable";
import { TeamPractice, TeamThroughput } from "@/components/TeamPractice";
import { getTeam, getWindows, isNotFound } from "@/lib/api";
import { contributors, holdings, members, unreported } from "@/lib/team";
import type { TeamDetail } from "@/lib/types";
import { resolveWeeks, type SearchValue, WEEKS_COOKIE } from "@/lib/weeks";

/**
 * One team's window: what it owns, how it works, what it merged, who is in it, and who worked in it.
 *
 * TWO SECTIONS ABOUT PEOPLE, ANSWERING TWO QUESTIONS. `Members` is GitHub's own team membership, out of
 * `org_team_memberships`; `Contributors` is who authored a merge or a direct push in the repositories attributed to
 * this team. Neither is the other's subset in either direction — a member who wrote nothing this window is on the
 * first list only, and somebody from another team who merged into a repository this one owns is on the second only.
 * Both the heading and the detail of each section name its source, because one section headed for the team's people
 * and filled from its repositories' authors is the confusion this page had: `platform-operations` is attributed 328
 * repositories, 217 of them by holding the only `admin` team, so most of the organisation appeared under it.
 *
 * NO READINESS DONUT, from 2026-09-15. It distributed `detail.labels` across this team's repositories and was the
 * last chart on the page; it went the way the ones on `/repositories` did, and for the same reason — it had already
 * stopped being a control when the `?label=` filters were removed, so it was a picture of a figure the sections
 * below state in words. `TeamDetail.labels` is untouched and still on the contract.
 *
 * There is no combined team label, no team score, and no comparison against another team anywhere on this page —
 * the reversal of 2026-09-01 permitted per-team COUNTS for display and nothing beyond them (architecture.md,
 * "Scope boundaries"). The contributor list is alphabetical: its rows are two counts inside this team and carry no
 * label to order by, which is what the `/contributors` list orders on instead.
 *
 * The repositories table is the shared component, handed this team's rows, so a team page and the repositories list
 * agree about what a repository row says and the search box behaves here exactly as it does there.
 */
export const dynamic = "force-dynamic";

export default async function TeamPage({ params, searchParams }: { params: Promise<{ team: string }>; searchParams?: Promise<{ weeks?: SearchValue }> }) {
  const windows = await getWindows();
  const weeks = resolveWeeks((await searchParams)?.weeks, (await cookies()).get(WEEKS_COOKIE)?.value, windows.options, windows.default);
  const detail = await readTeam((await params).team, weeks);
  const missing = unreported(detail);
  const membership = members(detail);

  return (
    <div className="space-y-8">
      <EntityHeader
        kind="team"
        name={detail.team}
        action={<NavWeekSelector options={windows.options} active={weeks} />}
        context={
          <>
            <span>{holdings(detail)}</span>
            {/* BOTH COUNTS OF PEOPLE, in the order the sections below appear in. One figure headed neither way is
                read as membership whichever it is, so the header states which is which or states only the one it
                has — see `members`, which is absent where no membership was read. */}
            {membership === undefined ? null : <span>{membership}</span>}
            <span>{contributors(detail)}</span>
            {missing ? <span className="text-slate-500">{missing}</span> : null}
          </>
        }
      />

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

      {/* THE CHANGES THEMSELVES, under the figures that summarise them. Two tables rather than one, because a
          merged pull request and a direct push are different events with different evidence — the second has no
          review to report, which is why it is counted rather than excused. */}
      <Section heading="Merges" detail="merged pull requests, most recent first">
        {(detail.merges ?? []).length === 0 ? (
          <EmptyState
            message={`No pull request was merged in ${detail.team}’s repositories at this span.`}
            detail="Read the team at a longer span, or run metrics collect for the span being asked for."
          />
        ) : (
          <TeamMergesTable rows={detail.merges ?? []} weeks={weeks} />
        )}
      </Section>

      <Section heading="Direct pushes" detail="commits that reached a default branch with no pull request">
        {(detail.direct_pushes ?? []).length === 0 ? (
          // The good answer, said as one. An empty merges table means nothing was collected; an empty table here
          // means every change went through a pull request, which is what the team is being asked to do.
          <EmptyState
            message={`Nothing was pushed straight to a default branch in ${detail.team}’s repositories at this span.`}
            detail="Every change in the window arrived through a pull request."
          />
        ) : (
          <TeamDirectPushesTable rows={detail.direct_pushes ?? []} weeks={weeks} />
        )}
      </Section>

      {/* WHO IS IN THE TEAM, which is GitHub's answer and not this service's. It does not depend on the span, and
          says nothing about whether any of these people did anything: a member who wrote no code this window is
          listed here in full standing and is absent from the section below. */}
      <Section heading="Members" detail="who GitHub says is in this team, whatever they worked on">
        {detail.members === undefined ? (
          // UNMEASURED, NOT EMPTY, and there is no third branch because the report layer cannot emit one: a team
          // with no stored membership row is absent from what it sends rather than carried as an empty list, since
          // nothing records which teams a collection walked in full. `unowned` arrives here too, it being a
          // reporting bucket rather than a GitHub team.
          <EmptyState
            message={`No membership has been read for ${detail.team}.`}
            detail="Members come from GitHub’s own team membership, which metrics collect-org reads. Nothing read is not the same as nobody in the team."
          />
        ) : (
          <TeamMembersTable rows={detail.members} />
        )}
      </Section>

      {/* WHO WORKED IN ITS REPOSITORIES, which is a different list and is named as one. Somebody in no team at all
          appears here as soon as they merge into a repository attributed to this one. */}
      <Section heading="Contributors to its repositories" detail="alphabetical — authors of the changes above, in or out of the team">
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
