/**
 * What the team page states about a team, and what it refuses to state.
 *
 * COUNTS, NEVER A VERDICT. A team's repositories carry labels and this page lists how many carry
 * each of them — permitted from 2026-09-01 — but the counts are never reduced to one team label, one
 * score, or one position against another team. Nothing here returns a figure two teams could be
 * ordered by, which is why there is no "worst label" and no share of green.
 *
 * The repository count is of CONFIGURED repositories, and the unreported count says how many of them
 * this span holds no evidence for, so a team whose collection is half missing reads as a team with
 * missing collection rather than as a small team.
 *
 * MEMBERSHIP AND CONTRIBUTION ARE TWO COUNTS AND NOT ONE. `members` is what GitHub says about who is in the team;
 * `contributors` is who authored a change in the repositories attributed to it. Each is stated in its own words
 * wherever it appears, because a single "people" figure is read as membership and is not.
 */

import { count } from "@/lib/format";
import type { TeamDetail, TeamMemberRow, TeamPractice } from "@/lib/types";

/** What the team owns: every repository the configuration gives it, reported or not. */
export function holdings(detail: TeamDetail): string {
  return count(detail.repositories.length, "repository", "repositories");
}

/**
 * How many people GitHub says are in this team, or nothing to say where no membership was read.
 *
 * TWO COUNTS OF PEOPLE THAT ARE NOT THE SAME COUNT, and this is the half that answers "who is in the team".
 * `contributors` below answers "who worked in its repositories", and the header states both so that neither
 * figure can be read as the other — on this estate `platform-operations` has 56 members and several hundred
 * contributors, because it holds admin on 328 repositories.
 *
 * Absent reads as NOTHING STATED rather than as `0 members`, which would claim GitHub puts nobody in the team.
 * See `TeamDetail.members` for why the graph cannot tell those two apart.
 */
export function members(detail: TeamDetail): string | undefined {
  return detail.members === undefined ? undefined : count(detail.members.length, "member", "members");
}

/** How many people authored a reported merge or direct push in this team's repositories at this span. */
export function contributors(detail: TeamDetail): string {
  return count(detail.actors.length, "contributor", "contributors");
}

/**
 * One member's standing in the team, in the reader's words rather than GitHub's.
 *
 * `MEMBER` and `MAINTAINER` are what the API answers and what the graph stores, and neither belongs on a page in
 * capitals. Anything else GitHub grows here is shown VERBATIM rather than mapped to one of the two: a role this
 * does not know is a fact it should not restate as a role it does.
 */
export function memberRole(member: TeamMemberRow): string {
  if (member.role === "MAINTAINER") {
    return "Maintainer";
  }
  return member.role === "MEMBER" ? "Member" : member.role;
}

/**
 * How much of the team the span could not report, or nothing to say where it reported all of it.
 *
 * Stated beside the other two counts because it is what makes them readable: six repositories with
 * two unreported is a different window from six repositories with none, and the label counts under
 * the header are taken over the reported four either way.
 */
export function unreported(detail: TeamDetail): string | undefined {
  if (detail.unavailable === 0) {
    return undefined;
  }
  return `${count(detail.unavailable, "repository", "repositories")} not reported at this span`;
}

/**
 * One ways-of-working figure: what it counts, the count over its own denominator, and what qualifies it.
 *
 * `detail` is REQUIRED rather than optional, which is a small decision worth stating because the obvious shape is
 * the other one. Every figure here has something to qualify it — the stronger review requirement, what a required
 * check buys, how the allowance was spent — and where a figure was not measured the detail is what says WHY, which
 * is the more useful half of the answer. Making it optional would put an unreachable branch in the component that
 * renders it, and an unreachable branch is either dead code or a coverage exemption nobody can justify.
 */
export interface PracticeFigure {
  label: string;
  /** Always "n of m", never a share — see `TeamPractice` for why no percentage is computed. */
  value: string;
  detail: string;
}

/**
 * How a team works, as the lines the team page prints.
 *
 * EVERY VALUE CARRIES ITS OWN DENOMINATOR, and the denominator is what was MEASURED rather than what the team
 * holds: a repository whose merge gate GitHub withheld has no answer, and counting it against the holding would
 * report a missing permission as a repository that fails. Where nothing was measured the line says so in words
 * instead of printing "0 of 0", which reads as a finding about the team.
 *
 * Here rather than in the component for this file's stated reason: it is what the team page STATES about a team,
 * and what it refuses to state. Nothing here reduces the figures to one number two teams could be ordered by.
 */
export function practiceFigures(practice: TeamPractice): PracticeFigure[] {
  const outOf = (counted: number, measured: number): string => (measured === 0 ? "not measured" : `${counted} of ${measured}`);
  return [
    {
      label: "Peer review enforced",
      value: outOf(practice.enforces_review, practice.gates_measured),
      detail: practice.gates_measured === 0 ? "no merge gate could be read" : "the gate requires at least one approving review"
    },
    {
      label: "Enforces CI",
      value: outOf(practice.enforces_checks, practice.checks_measured),
      detail: practice.checks_measured === 0 ? "no merge gate could be read" : "a required status check can block a merge"
    },
    {
      label: "Repositories reviewing substantial changes",
      value: outOf(practice.unreviewed_clear, practice.unreviewed_measured),
      // The policy's own three words rather than a pass and a fail: `within` is the allowance forgiving what it
      // was configured to forgive, which is a different fact from nothing having merged unreviewed.
      detail:
        practice.unreviewed_measured === 0
          ? "too few merges to grade"
          : `${practice.unreviewed_within} within the allowance, ${practice.unreviewed_above} above it`
    },
    {
      // THE CHANGES, not the repositories, which is the figure with teeth. The line above counts how many of a
      // team's repositories the policy graded clear; this counts how many substantial changes actually reached the
      // default branch with nobody else's eyes on them. A team can be "8 of 24 clear" with two such merges or
      // two hundred, and only this line tells them apart.
      //
      // READ THROUGH ONE GUARD rather than defaulting each field. The report layer emits the pair together or not
      // at all — `substantialCounts` returns both or `{}` — so a `?? 0` on the second is a branch nothing can
      // reach, and an unreachable branch is either dead code or a coverage exemption nobody can justify.
      label: "Substantial changes reviewed",
      ...substantialChanges(practice)
    },
    {
      label: "Direct pushes to the default branch",
      // A COUNT WITH ITS OWN DENOMINATOR, which for this one is every change that reached the branch: a direct
      // commit bypassed review entirely, so what qualifies it is how much of the team's traffic it was. 4 of 400
      // and 4 of 6 are different findings.
      value: `${practice.direct_commits} of ${practice.direct_commits + practice.merged_pull_requests}`,
      detail: practice.direct_commits === 0 ? "every change arrived through a pull request" : `${practice.merged_pull_requests} arrived through a pull request`
    },
    {
      label: "Time to first review",
      value: hours(practice.time_to_first_review_hours),
      // NAMED AS A MEDIAN OF MEDIANS rather than presented as the team's median wait, because it is not the same
      // thing — see `timings` in the report layer. Stating it is what stops a reader taking it for the latter.
      detail: practice.time_to_first_review_hours === undefined ? "no repository observed an independent review" : "typical repository’s typical wait"
    },
    {
      label: "Merge cycle time",
      value: hours(practice.merge_cycle_time_hours),
      detail: practice.merge_cycle_time_hours === undefined ? "no repository observed a merge" : "ready for review until merged"
    }
  ];
}

/**
 * The reviewed-changes figure, or a stated absence where the policy graded nothing.
 *
 * ONE GUARD OVER THE PAIR, because the pair is what the report layer emits: `substantialCounts` returns both counts
 * or neither, so reading them through a single check is what keeps every branch here reachable. A team with zero
 * substantial changes is "not measured" too — the policy had nothing to grade, which is a different statement from
 * a team that reviewed none of them.
 */
function substantialChanges(practice: TeamPractice): { value: string; detail: string } {
  const total = practice.substantial_merges;
  const unreviewed = practice.unreviewed_substantial_merges;
  if (total === undefined || unreviewed === undefined || total === 0) {
    return { value: "not measured", detail: "no substantial change was graded at this span" };
  }
  return { value: `${total - unreviewed} of ${total}`, detail: `${unreviewed} merged with no independent review` };
}

/**
 * One duration in hours, or a stated absence.
 *
 * ROUNDED TO ONE DECIMAL, because these are medians of medians over a window and further precision would imply an
 * accuracy the aggregation does not have. Absent reads as "not measured" and never as `0 hours`, which would say a
 * team reviews instantly when in fact nothing was measured.
 */
function hours(value: number | undefined): string {
  if (value === undefined) {
    return "not measured";
  }
  const rounded = Math.round(value * 10) / 10;
  // Pluralised against the ROUNDED figure rather than the raw one, so the words match the number printed beside
  // them: a median of 1.03 hours reads "1 hour", and pluralising on the unrounded value would print "1 hours".
  // Found on the real estate, where `platform-operations` reports exactly that.
  return `${rounded} ${rounded === 1 ? "hour" : "hours"}`;
}
