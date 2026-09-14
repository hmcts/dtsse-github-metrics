import { count } from "@/lib/format";
import { practiceFigures } from "@/lib/team";
import type { TeamPractice as TeamPracticeFigures } from "@/lib/types";

/**
 * How one team works: the merge gate and review mechanics, counted over the repositories it owns.
 *
 * THIS IS THE WAYS-OF-WORKING MATERIAL, and it is here rather than on `/repositories` because the two pages ask
 * different questions. `/repositories` asks whether a repository meets the assurance criteria for coding in the
 * open — ownership, tooling, patching, whether the code is maintained. This asks how the team that owns it works.
 * A repository row cannot answer the second and a team card cannot answer the first.
 *
 * EVERY FIGURE IS "n OF m" AND NONE IS A SHARE. The denominator is stated on each because it is not the team's
 * repository count: a repository whose gate GitHub withheld has no answer, and dividing by the holding would
 * report an unreadable gate as a repository that fails. No percentage is computed and no figure is combined,
 * which is the boundary `TeamsList` states — per-team COUNTS are permitted, a team label or score is not.
 *
 * Untoned, deliberately, and this is the one place that decision is worth restating because the figures look
 * gradeable. `assessment.ts` already grades these conditions per repository and the readiness distribution above
 * carries its verdict; colouring them again here would be a second opinion on a judgement already given, and
 * colouring them per TEAM would be the team score this page does not have.
 */
export function TeamPractice({ practice }: { practice: TeamPracticeFigures }) {
  return (
    <dl className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-3 p-4">
      {practiceFigures(practice).map((figure) => (
        <div key={figure.label} className="space-y-0.5">
          <dt className="text-xs text-slate-400 uppercase tracking-wide">{figure.label}</dt>
          <dd className="text-sm text-slate-100 tabular-nums">{figure.value}</dd>
          {/* Unconditional, because `PracticeFigure.detail` is required — every figure has something that
              qualifies it, and where one was not measured the detail is what says why. */}
          <p className="text-xs text-slate-500">{figure.detail}</p>
        </div>
      ))}
    </dl>
  );
}

/** The throughput the figures above are read against, as one line under them. */
export function TeamThroughput({ practice }: { practice: TeamPracticeFigures }) {
  return (
    <p className="px-4 pb-4 text-xs text-slate-500">
      {`${count(practice.merged_pull_requests, "merged pull request", "merged pull requests")} and ${count(
        practice.direct_commits,
        "direct commit",
        "direct commits"
      )} reached the default branch across these repositories at this span.`}
    </p>
  );
}
