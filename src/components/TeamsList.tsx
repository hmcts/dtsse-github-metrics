import Link from "next/link";
import { distributionSlices } from "@/lib/chart";
import { count } from "@/lib/format";
import type { TeamRow } from "@/lib/types";
import { withWeeks } from "@/lib/weeks";

/**
 * Every team, with what it owns, who worked in it, and its label counts.
 *
 * The label counts are a DISTRIBUTION, permitted from 2026-09-01: they say how many of a team's
 * repositories carry each readiness label. There is no combined team label and no team score.
 *
 * The rows arrive LARGEST HOLDING FIRST, which `cohortTeams` decides and this component keeps. That
 * reverses an earlier note here — that no order over these figures was allowed because it would be a
 * ranking whatever it was called — and the distinction it missed is which figure is being ordered by.
 * A team's repository count is not a grade: it is how much of the estate that team is on the hook for,
 * and no label, score or quality takes part in the order. Ordering by one of the LABEL counts would
 * still be a ranking and is still not done. What this buys is that a reader opening 154 cards meets
 * the teams with the largest estates rather than whichever slug begins with `a`.
 *
 * A CARD IS A TEAM. An individual who owns a repository gets none, from 2026-09-11: 126 of the 280
 * cards this drew were people. Where that ownership is is on `/repositories`, which marks the row.
 *
 * The counts are grouped through `distributionSlices`, the same function the donut is drawn from, so a
 * chart and a row can never disagree about which repositories fall under a label.
 *
 * The team cards are FLAT, for the reason `MetricCard` is: the list renders inside a `Section`, which
 * has drawn the box since 2026-09-02, and a grid of bordered cards nested in a bordered panel is the
 * pattern that change exists to remove. The gap does the separating and the hover tint says the whole
 * card is the target, which the border was carrying before.
 */
export function TeamsList({ rows, weeks }: { rows: readonly TeamRow[]; weeks: number }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
      {rows.map((row) => (
        <div key={row.team} className="rounded-lg p-3 space-y-3 hover:bg-slate-800/30 transition-colors">
          <Link href={withWeeks(`/teams/${encodeURIComponent(row.team)}`, weeks)} className="font-mono text-sm text-indigo-400 hover:text-indigo-300 break-all">
            {row.team}
          </Link>

          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-400">
            <span className="tabular-nums">{count(row.repositories, "repository", "repositories")}</span>
            <span className="tabular-nums">{count(row.actors, "contributor", "contributors")}</span>
            {row.unavailable > 0 ? <span className="tabular-nums text-slate-500">{row.unavailable} not reported</span> : null}
          </div>

          <dl className="flex flex-wrap gap-x-3 gap-y-1.5">
            {distributionSlices(row.labels).map((slice) => (
              <div
                key={slice.name}
                className="flex items-center gap-1.5"
                // Dimmed rather than dropped when nothing carries the label, as the donut legend does:
                // "no repository is blocked" is a finding, and an absent chip would not state it.
                style={{ opacity: slice.value === 0 ? 0.38 : 1 }}
              >
                <span className="shrink-0 w-2 h-2 rounded-full" style={{ backgroundColor: slice.color }} aria-hidden="true" />
                <dt className="text-xs text-slate-400">{slice.name}</dt>
                <dd className="text-xs text-slate-300 tabular-nums">{slice.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
    </div>
  );
}
