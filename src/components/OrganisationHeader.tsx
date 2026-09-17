import { collectedLabel, unreportedLabel } from "@/lib/collection";
import { count, instant, span } from "@/lib/format";
import type { OverviewSummary } from "@/lib/types";

/**
 * The head of each estate list: which organisation, over what, built from which collection.
 *
 * One component rather than a copy per list page, from 2026-09-02 when the three lists became three
 * routes. `/contributors` and `/teams` state the same window over a different third of the same bundle, so a
 * header kept per page could claim different things about one span — and the claim is the point of
 * the block. `EntityHeader` is the same block for a page about one repository, contributor or team,
 * and this takes its `action` the same way, so the two headers behave alike where they overlap.
 *
 * TWO CLAIMS IT CAN MAKE, from 2026-09-17, and `snapshot` picks which. A windowed page states the span and its
 * week count; a snapshot page states neither, because it has no window to state and printing one would invite the
 * reader to take the whole page as covering it. What both always state is PROVENANCE — the collection the figures
 * are anchored at, and when this bundle was built from it — since that is true of a page either way.
 *
 * The organisation is named in mono, as every entity name on this site is: it is an identifier
 * somebody wrote in a configuration file, not a title.
 */
export function OrganisationHeader({
  overview,
  action,
  snapshot = false,
  unavailable
}: {
  overview: OverviewSummary;
  /** The header's own control — the week selector, on the pages that have a window to select. */
  action?: React.ReactNode;
  /**
   * Whether this page reports the estate's current state rather than a window over it.
   *
   * `/repositories` is that page: every column it draws is control state, so it pins a span internally and states
   * none. Drops the span line and rewords the unreported figure — see `unreportedLabel`.
   */
  snapshot?: boolean;
  /**
   * The unreported count to state, where the page counts it differently from the overview.
   *
   * `/repositories` shows only the rows nothing was collected for, so it counts those rather than every row
   * carrying any `detail` — otherwise the header announces repositories the table gives no reason for. Defaults to
   * `OverviewSummary.unavailable`, which is what the windowed pages mean by it.
   */
  unavailable?: number;
}) {
  const collected = collectedLabel(overview.collected_through);
  const unreported = unreportedLabel(unavailable ?? overview.unavailable, snapshot);

  return (
    <header className="bg-slate-900 border border-slate-800 rounded-lg p-5 space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">organization</span>
        <h1 className="font-mono text-xl text-slate-100 break-all">{overview.organization}</h1>
        {action ? <div className="ml-auto">{action}</div> : null}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-400">
        {snapshot ? null : (
          <>
            <span>{span(overview.starts_at, overview.ends_at)}</span>
            <span>{count(overview.weeks, "week", "weeks")}</span>
          </>
        )}
        {/* Beside the window rather than in place of the build stamp: the window ends where the
            caches end, and the two instants answer different questions — what the figures cover,
            and when this bundle was assembled from them. On a snapshot page these two are the whole
            provenance, which is why they are outside the branch above. */}
        {collected ? <span>{collected}</span> : null}
        <span className="text-slate-500">Report built {instant(overview.built_at)}</span>
        {unreported ? <span className="text-slate-500">{unreported}</span> : null}
      </div>
    </header>
  );
}
