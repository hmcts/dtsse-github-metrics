"use client";

import clsx from "clsx";
import { usePathname, useSearchParams } from "next/navigation";
import type { CSSProperties } from "react";
import { Pie, PieChart, type PieSectorShapeProps, ResponsiveContainer, Sector, Tooltip, type TooltipContentProps } from "recharts";
import { InfoTooltip } from "@/components/InfoTooltip";
import { ToggleTick } from "@/components/ToggleTick";
import { activeSlices, type PieSlice, totalValue } from "@/lib/chart";
import { filterTarget } from "@/lib/filter";
import { percentageOf } from "@/lib/format";
import { allVisibilitiesTarget } from "@/lib/rows";

/** The hover card's frame, which is inline because recharts styles its tooltip wrapper directly. */
const TOOLTIP: CSSProperties = {
  backgroundColor: "#1e293b",
  border: "1px solid #334155",
  borderRadius: "6px",
  padding: "8px 12px"
};

/** How far a slice outside the active filter fades, wedge and legend entry alike. */
const UNSELECTED_OPACITY = 0.35;

/** How far a legend entry counted at zero fades, whatever is selected. */
const EMPTY_OPACITY = 0.38;

/**
 * A ring over a distribution, and the control that filters the list beneath it on the slice a reader clicks.
 *
 * Zero-count slices are kept out of the wedge — with `paddingAngle` on, a zero-width wedge draws as a
 * stray tick — but stay in the legend, dimmed. Dropping them instead would make "no repository is
 * unmaintained" and "unmaintained is not a state this report reaches" look the same, and the first is the
 * useful finding.
 *
 * The whole chart is skipped when nothing was counted: an empty ring is a shape readers try to
 * interpret, so the section says it has no data instead.
 *
 * IT IS A CONTROL AND NOT A PICTURE, which is the difference between this and the component it is descended
 * from. A legend entry and its wedge both write the slice's key to `parameter`, and the list below reads it
 * back; clicking the slice already filtered on clears it. The previous charts were removed partly because they
 * were the only way to APPLY the filters their chips displayed, so the chips had to go with them — a wheel that
 * did not filter would put that back.
 *
 * `parameter` IS REQUIRED for that reason. The upstream component made it optional and split itself in two so a
 * static ring mounted outside a router; nothing draws a static ring any more, and an optional mode is a branch
 * with no caller.
 *
 * THE MARKS ARE THIN AND THE CHROME IS ABSENT: a 20px ring rather than a filled pie, a 2px surface gap between
 * fills, no axes and no gridlines. The legend is always present and each entry carries its slice's word and its
 * count, so identity is never colour alone — which is also what makes the amber-against-green pair legal on a
 * dark surface at ΔE 7.3 under simulated protanopia. See `dimensionSlices` for that measurement.
 */
export function SummaryPieChart({
  title,
  data,
  height = 175,
  tooltip,
  parameter,
  showsAllVisibilities = false
}: Readonly<{
  title: string;
  /** Every slice, including the ones counted at zero. */
  data: readonly PieSlice[];
  /** Height of the chart canvas alone — the title and legend sit outside it. */
  height?: number;
  /** What the categories mean, shown on the heading's information control. */
  tooltip?: string;
  /** The query parameter this ring filters on. */
  parameter: string;
  /**
   * Whether selecting a slice also turns every visibility on in the table, for a wheel counted over all of them.
   *
   * Without it the table would stay on its public-only default under a wedge that counted internal and private
   * repositories too, and show fewer rows than the slice it was filtered by. See `allVisibilitiesTarget`.
   */
  showsAllVisibilities?: boolean;
}>) {
  const pathname = usePathname();
  const searchParameters = useSearchParams();
  const total = totalValue(data);
  const wedges = activeSlices(data);
  /**
   * The slice key in the URL, or the empty string where this dimension is unfiltered. A key naming no slice on this
   * wheel — a bookmark from before a slice was renamed — is unfiltered too, as `parseSelections` treats it for the
   * table, so the ring does not fade every wedge over a table showing every row.
   */
  const requested = searchParameters.get(parameter) ?? "";
  const active = data.some((slice) => slice.key === requested) ? requested : "";
  /**
   * Whether a slice sits outside the active filter, and so fades. Nothing fades while the dimension is
   * unfiltered: a ring with every slice dimmed would read as a ring with nothing in it.
   */
  const unselected = (key: string) => active !== "" && key !== active;

  /**
   * Puts the clicked slice in the URL, WITHOUT NAVIGATING.
   *
   * `history.replaceState` rather than `router.replace`, which is what this did upstream. The filter runs over
   * rows the browser is already holding — `filterRepositories` in `lib/rows.ts` reads the array the page handed
   * the table in props — so a router navigation would re-run the server component and refetch the whole estate
   * to answer a question already answered here. Five controls on this page were moved off that in #59 after it
   * was measured at one RSC fetch per click, and this is the sixth.
   *
   * The URL is still the source of truth. Next patches `replaceState` into its own router — see the "Native
   * History API" section of `next/dist/docs/01-app/01-getting-started/04-linking-and-navigating.md` — so
   * `useSearchParams` above reports what is written here, as it does in `RepositoriesTable` and in the export
   * beside it.
   *
   * `replaceState` and not `pushState`: a reader who has clicked three wedges should not have to press Back
   * three times to leave the page.
   *
   * Clicking the slice already filtered on CLEARS the filter, which is the parameter's absence rather than an
   * empty value — the same navigation the filter box makes when its box is emptied.
   *
   * `window.location.search` rather than `searchParameters`, so a parameter another control wrote a moment ago
   * is carried through: the hook catches up a React transition later, and reading it here would drop it.
   */
  function toggle(key: string) {
    const target = showsAllVisibilities ? allVisibilitiesTarget : filterTarget;
    window.history.replaceState(null, "", target(pathname, window.location.search, parameter, key === active ? "" : key));
  }

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-lg p-4 flex flex-col gap-3">
      <div className="flex items-center gap-1.5">
        <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide">{title}</h3>
        {tooltip ? <InfoTooltip text={tooltip} /> : null}
      </div>

      {total === 0 ? (
        <div className="flex items-center justify-center text-slate-400 text-sm" style={{ height }}>
          No data
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={height}>
          <PieChart>
            <Pie
              data={wedges.map((wedge) => ({ ...wedge, opacity: unselected(wedge.key) ? UNSELECTED_OPACITY : 1 }))}
              cx="50%"
              cy="50%"
              innerRadius={48}
              outerRadius={68}
              paddingAngle={wedges.length > 1 ? 2 : 0}
              dataKey="value"
              strokeWidth={0}
              className="cursor-pointer"
              onClick={(sector) => toggle(clickedKey(sector))}
              shape={Wedge}
            />
            <Tooltip content={<SliceTooltip total={total} />} />
          </PieChart>
        </ResponsiveContainer>
      )}

      <fieldset className="flex min-w-0 flex-wrap justify-center gap-x-3 gap-y-1.5" aria-label={`${title} filter`}>
        {data.map((slice) => (
          <button
            key={slice.key}
            type="button"
            onClick={() => toggle(slice.key)}
            aria-pressed={slice.key === active}
            // `-mx-1 px-1` so the highlight has room without the entry moving when it is applied.
            className={clsx(
              "group flex items-center gap-1.5 -mx-1 px-1 rounded transition-colors",
              "focus:outline-none focus-visible:ring-1 focus-visible:ring-indigo-500",
              slice.key === active ? "bg-slate-800" : null
            )}
            // Dimmed rather than hidden: the label exists in the report even when nothing is in it. An entry both
            // empty and outside the filter takes the fainter of the two.
            style={{ opacity: Math.min(slice.value === 0 ? EMPTY_OPACITY : 1, unselected(slice.key) ? UNSELECTED_OPACITY : 1) }}
          >
            <span className="shrink-0 w-2 h-2 rounded-full" style={{ backgroundColor: slice.color }} aria-hidden="true" />
            <span className="text-xs text-slate-400 group-hover:text-slate-200">{slice.name}</span>
            {/* `slate-400` and `tabular-nums`, which is what the estate table's own filter toggles set their counts
                in — these sit a few centimetres above those and a reader compares the two. Not the upstream
                legend's `slate-600` nor the `slate-500` this once was: neither reaches WCAG AA's 4.5:1 on this
                background, and a count is the half of an entry a reader is actually reading. */}
            <span className="text-xs text-slate-400 tabular-nums">{slice.value}</span>
            {/* The estate table's four toggles' own affordance, and here for their reason: a slate fill cannot be
                the only thing telling a sighted reader which slice the list is narrowed to. */}
            <ToggleTick on={slice.key === active} />
          </button>
        ))}
      </fieldset>
    </div>
  );
}

/**
 * The slice key of a clicked wedge.
 *
 * recharts spreads the datum it drew the sector from into the sector it hands the handler, so the
 * clicked wedge carries the slice's own `key` — read from there rather than by indexing the drawn
 * array, which is a position two things have to agree on and a lookup that can miss. The cast is
 * because the sector's declared type describes the geometry and not what was plotted.
 */
/** A wedge as a slice has it drawn: its own colour, faded where it sits outside the active filter. */
function Wedge(props: PieSectorShapeProps) {
  const wedge = props.payload as PieSlice & { opacity: number };
  return <Sector {...props} fill={wedge.color} fillOpacity={wedge.opacity} />;
}

/** The hover card over one wedge: its word, its count and its share of `total`. */
function SliceTooltip({ active, payload, total }: Readonly<Partial<TooltipContentProps<number, string>> & { total: number }>) {
  const slice = payload?.[0]?.payload as PieSlice | undefined;
  if (!active || slice === undefined) {
    return null;
  }
  return (
    <div style={TOOLTIP}>
      {/* THE MARK CARRIES THE COLOUR AND THE TEXT DOES NOT, which is the one thing here that
          differs from the legend entries' predecessor: a word set in its series colour is a
          value doing two jobs, and the slice colours are tuned for a fill on the panel rather
          than for type on the card's own darker surface. */}
      <p className="text-xs font-semibold mb-0.5 flex items-center gap-1.5 text-slate-200">
        <span className="shrink-0 w-2 h-2 rounded-full" style={{ backgroundColor: slice.color }} aria-hidden="true" />
        {slice.name}
      </p>
      <p className="text-xs text-slate-300 tabular-nums">
        {slice.value} &nbsp;&middot;&nbsp; {percentageOf(slice.value, total)}
      </p>
    </div>
  );
}

function clickedKey(sector: unknown): string {
  return (sector as PieSlice).key;
}
