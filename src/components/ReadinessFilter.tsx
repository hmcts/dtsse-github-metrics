"use client";

import clsx from "clsx";
import { usePathname, useSearchParams } from "next/navigation";
import { ToggleTick } from "@/components/ToggleTick";
import { filterTarget } from "@/lib/filter";
import { RAG_BORDER, RAG_DOT } from "@/lib/rag";
import { isReadinessKey, READINESS_PARAMETER, type ReadinessCount, type ReadinessTile } from "@/lib/readiness";

/** How far a count outside the active filter fades, as a wheel's unselected slice does. */
const UNSELECTED_OPACITY = 0.35;

/** How far a count of zero fades, whatever is selected. */
const EMPTY_OPACITY = 0.38;

/**
 * The four readiness groups as counts, each count a filter on the list beneath it — `/teams` and `/contributors`
 * alike.
 *
 * Every count is a button: a group's figure and each subgroup's beneath it write their key to `readiness`, and the
 * list reads it back through `matchesReadiness`. Clicking the count already filtered on clears it. The write is a
 * `replaceState` and not a navigation, for `SummaryPieChart.toggle`'s reason: the list filters rows it already
 * holds, so a router round trip would refetch the window to answer a question answered here.
 *
 * THE COUNTS DO NOT MOVE WITH THE FILTER BOX, as the estate wheels do not with the table's: they are counted by the
 * page over every row it holds, so a figure can be quoted whatever a reader has typed.
 *
 * Each subgroup names its combination in words beside the dots in its labels' colours, so colour is never the only
 * thing telling two of them apart, and an applied filter wears `ToggleTick` as well as its fill.
 */
export function ReadinessFilter({ tiles }: Readonly<{ tiles: readonly ReadinessTile[] }>) {
  const pathname = usePathname();
  const requested = useSearchParams().get(READINESS_PARAMETER) ?? "";
  const active = isReadinessKey(requested) ? requested : "";

  /** Whether a count sits outside the active filter. Nothing does while the list is unfiltered. */
  const outside = (keys: readonly string[]) => active !== "" && !keys.includes(active);

  /** `window.location.search` rather than the hook, which lags a transition and would drop the filter box's term. */
  function toggle(key: string) {
    window.history.replaceState(null, "", filterTarget(pathname, window.location.search, READINESS_PARAMETER, key === active ? "" : key));
  }

  return (
    <div role="group" aria-label="Readiness filter" className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
      {tiles.map((tile) => {
        const keys = [tile.key, ...tile.subgroups.map((subgroup) => subgroup.key)];
        return (
          <div
            key={tile.key}
            className={clsx("rounded-md bg-slate-900 p-3 flex flex-col gap-2 transition-opacity", RAG_BORDER[tile.state])}
            style={{ opacity: outside(keys) ? UNSELECTED_OPACITY : 1 }}
          >
            <CountButton entry={tile} active={active} onToggle={toggle} className="flex-col items-start">
              <span className="flex items-center gap-1.5 text-xs text-slate-400 uppercase tracking-wide group-hover:text-slate-200">
                {tile.name}
                <ToggleTick on={tile.key === active} />
              </span>
              <span className="text-2xl font-semibold tabular-nums text-slate-100">{tile.count}</span>
            </CountButton>

            {tile.subgroups.length > 0 ? (
              <div className="flex flex-col gap-0.5 border-t border-slate-800 pt-2">
                {tile.subgroups.map((subgroup) => (
                  <CountButton
                    key={subgroup.key}
                    entry={subgroup}
                    active={active}
                    onToggle={toggle}
                    // A sibling subgroup fades inside the tile the filter is on; the whole tile fading covers the rest.
                    faded={active !== "" && active !== tile.key && active !== subgroup.key}
                    className="items-center gap-1.5"
                  >
                    <span className="flex shrink-0 gap-0.5" aria-hidden="true">
                      {subgroup.labels.map((label) => (
                        <span key={label} className={clsx("w-2 h-2 rounded-full", RAG_DOT[label])} />
                      ))}
                    </span>
                    <span className="text-xs text-slate-400 text-left group-hover:text-slate-200">{subgroup.name}</span>
                    <ToggleTick on={subgroup.key === active} />
                    <span className="ml-auto text-xs text-slate-300 tabular-nums">{subgroup.count}</span>
                  </CountButton>
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** One clickable count: pressed where it is the filter, and dimmed where it counted nothing. */
function CountButton({
  entry,
  active,
  onToggle,
  faded = false,
  className,
  children
}: Readonly<{
  entry: ReadinessCount;
  active: string;
  onToggle: (key: string) => void;
  faded?: boolean;
  className: string;
  children: React.ReactNode;
}>) {
  return (
    <button
      type="button"
      onClick={() => onToggle(entry.key)}
      aria-pressed={entry.key === active}
      aria-label={`${entry.name}: ${entry.count}`}
      className={clsx(
        "group flex w-full px-1 rounded transition-colors",
        "focus:outline-none focus-visible:ring-1 focus-visible:ring-indigo-500",
        entry.key === active ? "bg-slate-800" : "hover:bg-slate-800/50",
        className
      )}
      style={{ opacity: Math.min(entry.count === 0 ? EMPTY_OPACITY : 1, faded ? UNSELECTED_OPACITY : 1) }}
    >
      {children}
    </button>
  );
}
