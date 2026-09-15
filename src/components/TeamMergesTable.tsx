"use client";

import Link from "next/link";
import { useState } from "react";
import { type Align, SortHeader } from "@/components/SortHeader";
import { ABSENT, day } from "@/lib/format";
import { type Direction, nextDirection, type SortValue, sorted } from "@/lib/sort";
import type { TeamMergeRow } from "@/lib/types";
import { withWeeks } from "@/lib/weeks";

/**
 * Every merged pull request in one team's repositories over the window.
 *
 * THE EVIDENCE UNDER THE COUNTS. "Ways of working" above says 37 of 40 substantial changes were reviewed; this is
 * the list those figures are computed from, so a reader can find the three that were not instead of taking the
 * ratio on trust. Nothing here is a verdict about a person — the author column is attribution, and the table is
 * ordered by time rather than by anything somebody could be ranked on.
 *
 * SORTABLE, unlike `TeamActorsTable`, and for that component's own reason: these rows are changes rather than
 * people, and ordering changes by size or by whether they were reviewed is the question a reader came with.
 */
interface Column {
  key: string;
  label: string;
  align?: Align;
  read: (row: TeamMergeRow) => SortValue;
}

/**
 * A boolean sorts as a number so both directions group the two answers rather than interleaving them.
 *
 * `undefined` stays `undefined` so `sorted` puts an unmeasured merge last in BOTH directions, which is the rule
 * every other table here follows: "which merges went unreviewed" is a question about the merges somebody read the
 * reviews of, and one whose payload carries none is not an answer to it either way round.
 */
function flag(value: boolean | undefined): number | undefined {
  return value === undefined ? undefined : value ? 1 : 0;
}

const COLUMNS: readonly Column[] = [
  { key: "merged", label: "Merged", read: (row) => row.merged_at },
  { key: "repository", label: "Repository", read: (row) => row.repository },
  { key: "change", label: "Change", align: "right", read: (row) => row.number },
  { key: "author", label: "Author", read: (row) => row.author },
  { key: "reviewed", label: "Reviewed", align: "center", read: (row) => flag(row.reviewed) },
  { key: "ci", label: "CI", align: "center", read: (row) => flag(row.ci) },
  { key: "lines", label: "Lines", align: "right", read: (row) => row.lines },
  { key: "files", label: "Files", align: "right", read: (row) => row.files }
];

const DEFAULT_COLUMN = COLUMNS[0] as Column;

export function TeamMergesTable({ rows, weeks }: { rows: readonly TeamMergeRow[]; weeks: number }) {
  const [column, setColumn] = useState<Column | null>(null);
  const [direction, setDirection] = useState<Direction>("descending");

  // The served order is already newest-first, so an untouched table renders it rather than re-sorting to the
  // same answer. The header still reads active, so the order a reader is looking at is stated.
  const ordered = column === null ? rows : sorted(rows, column.read, direction);

  function sort(next: Column) {
    setDirection(nextDirection(column ?? DEFAULT_COLUMN, next, direction));
    setColumn(next);
  }

  return (
    // No border of its own: the table sits inside a `Section` panel that already draws one.
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="text-slate-400 border-b border-slate-800">
          <tr>
            {COLUMNS.map((entry, index) => (
              <SortHeader
                key={entry.key}
                label={entry.label}
                active={entry === (column ?? DEFAULT_COLUMN)}
                direction={direction}
                align={entry.align}
                first={index === 0}
                onSort={() => sort(entry)}
              />
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800/50">
          {ordered.map((row) => (
            <tr key={`${row.repository}#${row.number}`} className="hover:bg-slate-800/30">
              <td className="py-2 pl-3 pr-3 tabular-nums text-slate-300">{day(row.merged_at)}</td>
              <td className="py-2 pr-3">
                <Link
                  href={withWeeks(`/repositories/${encodeURIComponent(row.repository)}`, weeks)}
                  className="font-mono text-indigo-400 hover:text-indigo-300 break-all"
                >
                  {row.repository}
                </Link>
              </td>
              <td className="py-2 pr-3 text-right tabular-nums text-slate-400">#{row.number}</td>
              <td className="py-2 pr-3 font-mono text-slate-400 break-all">{row.author ?? ABSENT}</td>
              <Judgement value={row.reviewed} />
              <Judgement value={row.ci} />
              {/* Absent and never zero: GitHub does not size every merge, and `0 lines` would read as an
                  empty change rather than as one nobody measured. */}
              <td className="py-2 pr-3 text-right tabular-nums text-slate-300">{row.lines === undefined ? ABSENT : row.lines.toLocaleString("en-GB")}</td>
              <td className="py-2 pr-3 text-right tabular-nums text-slate-300">{row.files ?? ABSENT}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * One of the two governance answers on a merge, toned.
 *
 * COLOURED, unlike the size columns beside it, because these two ARE findings: a substantial change that reached
 * the default branch unreviewed is the thing the ways-of-working figures are counting. Amber rather than red, to
 * agree with `Outcome` on `/repositories` — an unmet criterion there is amber, and one merge is weaker evidence
 * than a repository-wide posture, not stronger.
 *
 * THREE-VALUED, because the fact cache is: a merge whose stored payload carries no reviews was not measured, which
 * is a different answer from one that went unreviewed. The dash keeps them apart where a `No` would accuse.
 */
function Judgement({ value }: { value?: boolean }) {
  return (
    <td className="py-2 pr-3 text-center">
      <span className={value === undefined ? "text-slate-500" : value ? "text-rag-green" : "text-rag-amber"}>
        {value === undefined ? ABSENT : value ? "Yes" : "No"}
      </span>
    </td>
  );
}
