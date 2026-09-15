"use client";

import clsx from "clsx";
import { ChevronDown, ChevronUp } from "lucide-react";
import { InfoTooltip } from "@/components/InfoTooltip";
import type { Direction } from "@/lib/sort";

/** Which edge a column reads from: its cells and its header have to agree. */
export type Align = "left" | "right" | "center";

const ALIGNMENT: Record<Align, string> = {
  left: "text-left",
  right: "text-right",
  center: "text-center"
};

/**
 * A sortable column header: a real `<button>` inside the `<th>`, not a click handler on the cell.
 *
 * The predecessor made the whole `<th>` clickable, which is unreachable by keyboard and announces as
 * a plain column header. `aria-sort` stays on the `<th>` — it is a property of the column, and a
 * screen reader looks for it on the header cell, not on the control inside — while the button is
 * what takes focus and the Enter key.
 *
 * The chevron is decoration: `aria-sort` already states the direction, so announcing the icon too
 * would say it twice.
 *
 * Alignment is stated per column rather than inferred from a `numeric` flag, because a column can
 * want the middle: the two governance answers are one short word each and read as a column when they
 * are centred under their headers, while a count still reads down its last digit on the right.
 *
 * The padding matches the body cells' `pr-3` (and `pl-3` on the first column), so titles as long as
 * CODEOWNERS and Sonar stop touching the one beside them.
 */
export function SortHeader({
  label,
  active,
  direction,
  onSort,
  align = "left",
  first,
  hint
}: {
  label: string;
  active: boolean;
  direction: Direction;
  onSort: () => void;
  /** Where the column's content sits; left unless the column says otherwise. */
  align?: Align;
  /** The leading column, which takes the table's left inset as its body cell does. */
  first?: boolean;
  /**
   * What the column answers, for a reader who cannot tell from its one-or-two-word heading.
   *
   * Rendered BESIDE the sort control rather than on it. `InfoTooltip` is itself a `<button>`, and a button inside
   * a button is invalid markup that browsers reflow unpredictably — so the two controls are siblings, which also
   * keeps them separately reachable: Tab to sort, Tab again to read what you are sorting.
   */
  hint?: string;
}) {
  const Chevron = direction === "ascending" ? ChevronUp : ChevronDown;
  return (
    // NAMED EXPLICITLY, so the column announces "Team" and not "Team" followed by the whole hint. `InfoTooltip`
    // carries its text in an `aria-label` and repeats it in a visually hidden bubble, both of which land inside
    // this cell — and a `columnheader` whose accessible name is two sentences of prose is read out in full every
    // time a screen reader enters a cell beneath it. The hint stays reachable as the control beside the label.
    <th
      scope="col"
      aria-label={label}
      aria-sort={active ? direction : "none"}
      className={clsx("py-2 pr-3 font-medium", first ? "pl-3" : null, ALIGNMENT[align])}
    >
      <span className="inline-flex items-center gap-1">
        <button
          type="button"
          onClick={onSort}
          className={clsx(
            "inline-flex items-center gap-1 rounded transition-colors hover:text-slate-200",
            "focus:outline-none focus-visible:ring-1 focus-visible:ring-indigo-500",
            active ? "text-slate-200" : null
          )}
        >
          {label}
          {active ? <Chevron className="w-3 h-3" aria-hidden="true" /> : null}
        </button>
        {hint === undefined ? null : <InfoTooltip text={hint} />}
      </span>
    </th>
  );
}
