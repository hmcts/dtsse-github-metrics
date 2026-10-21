"use client";

import clsx from "clsx";
import { usePathname, useSearchParams } from "next/navigation";
import { ToggleTick } from "@/components/ToggleTick";
import {
  CIVIL_SERVANT_DOT,
  CIVIL_SERVANT_PARAMETER,
  CIVIL_SERVANT_TOGGLE_ACTIVE,
  CIVIL_SERVANT_TOGGLE_INACTIVE,
  CIVIL_SERVANT_VALUE,
  parseCivilServantFilter
} from "@/lib/civil-servant";
import { filterTarget } from "@/lib/filter";

/**
 * The toggle that narrows a list to what is flagged as civil servants': the people on `/contributors`, the teams on
 * `/teams`.
 *
 * The estate table's Production toggle in another colour: `aria-pressed` and no ×, a count beside the word, and a
 * `replaceState` rather than a navigation because the list filters rows it already holds. On writes the
 * value; off is the parameter's absence.
 *
 * THE COUNT DOES NOT MOVE WITH THE OTHER FILTERS: it is everything flagged in this window, whatever the filter
 * box or the tiles say.
 */
export function CivilServantFilter({ label, count }: Readonly<{ label: string; count: number }>) {
  const pathname = usePathname();
  const parameters = useSearchParams();
  const on = parseCivilServantFilter((parameter) => parameters.get(parameter));

  /** `window.location.search` rather than the hook, for `ReadinessFilter.toggle`'s reason. */
  function toggle() {
    window.history.replaceState(null, "", filterTarget(pathname, window.location.search, CIVIL_SERVANT_PARAMETER, on ? "" : CIVIL_SERVANT_VALUE));
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={on}
      className={clsx(
        "flex items-center gap-1.5 rounded px-2 py-1 text-xs transition-colors",
        "focus:outline-none focus-visible:ring-1 focus-visible:ring-indigo-500",
        on ? CIVIL_SERVANT_TOGGLE_ACTIVE : CIVIL_SERVANT_TOGGLE_INACTIVE
      )}
    >
      <span className={clsx("shrink-0 w-2 h-2 rounded-full", CIVIL_SERVANT_DOT)} aria-hidden="true" />
      {label}
      <ToggleTick on={on} />
      <span className="tabular-nums text-slate-400">{count}</span>
    </button>
  );
}
