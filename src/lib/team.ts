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
 */

import { count } from "@/lib/format";
import type { TeamDetail, TeamPractice } from "@/lib/types";

/** What the team owns: every repository the configuration gives it, reported or not. */
export function holdings(detail: TeamDetail): string {
  return count(detail.repositories.length, "repository", "repositories");
}

/** How many people authored a reported merge in this team's repositories at this span. */
export function people(detail: TeamDetail): string {
  return count(detail.actors.length, "contributor", "contributors");
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
      label: "Enforces review",
      value: outOf(practice.enforces_review, practice.gates_measured),
      detail: practice.gates_measured === 0 ? "no merge gate could be read" : `${practice.requires_multiple_reviews} require two or more approvals`
    },
    {
      label: "Enforces CI",
      value: outOf(practice.enforces_checks, practice.checks_measured),
      detail: practice.checks_measured === 0 ? "no merge gate could be read" : "a required status check can block a merge"
    },
    {
      label: "Substantial merges reviewed",
      value: outOf(practice.unreviewed_clear, practice.unreviewed_measured),
      // The policy's own three words rather than a pass and a fail: `within` is the allowance forgiving what it
      // was configured to forgive, which is a different fact from nothing having merged unreviewed.
      detail:
        practice.unreviewed_measured === 0
          ? "too few merges to grade"
          : `${practice.unreviewed_within} within the allowance, ${practice.unreviewed_above} above it`
    }
  ];
}
