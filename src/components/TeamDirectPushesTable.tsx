"use client";

import Link from "next/link";
import { useState } from "react";
import { Absent } from "@/components/Absent";
import { type Align, SortHeader } from "@/components/SortHeader";
import { day } from "@/lib/format";
import { type Direction, nextDirection, type SortValue, sorted } from "@/lib/sort";
import type { TeamDirectPushRow } from "@/lib/types";
import { withWeeks } from "@/lib/weeks";

/**
 * Every commit that reached a default branch in this team's repositories without a pull request.
 *
 * A LIST WITH NO REVIEWED COLUMN, which is the whole point of it: a direct push had no pull request, so there was
 * nothing for anybody to review. That is why these are counted in the merge cohort's denominator rather than
 * excused from it — see `DirectCommitFact`. The absence of the column is the finding.
 *
 * The sha is shown short and linked to nothing. A commit URL would be a fourth link shape on a page that already
 * links repositories and people, and the seven characters are what somebody pastes into `git show`.
 */
interface Column {
  key: string;
  label: string;
  align?: Align;
  read: (row: TeamDirectPushRow) => SortValue;
}

const COLUMNS: readonly Column[] = [
  { key: "pushed", label: "Pushed", read: (row) => row.committed_at },
  { key: "repository", label: "Repository", read: (row) => row.repository },
  { key: "commit", label: "Commit", read: (row) => row.sha },
  { key: "author", label: "Author", read: (row) => row.author },
  { key: "ci", label: "CI", align: "center", read: (row) => (row.ci === undefined ? undefined : row.ci ? 1 : 0) },
  { key: "lines", label: "Lines", align: "right", read: (row) => row.lines },
  { key: "files", label: "Files", align: "right", read: (row) => row.files }
];

const DEFAULT_COLUMN = COLUMNS[0] as Column;

export function TeamDirectPushesTable({ rows, weeks }: { rows: readonly TeamDirectPushRow[]; weeks: number }) {
  const [column, setColumn] = useState<Column | null>(null);
  const [direction, setDirection] = useState<Direction>("descending");

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
            <tr key={`${row.repository}@${row.sha}`} className="hover:bg-slate-800/30">
              <td className="py-2 pl-3 pr-3 tabular-nums text-slate-300">{day(row.committed_at)}</td>
              <td className="py-2 pr-3">
                <Link
                  href={withWeeks(`/repositories/${encodeURIComponent(row.repository)}`, weeks)}
                  className="font-mono text-indigo-400 hover:text-indigo-300 break-all"
                >
                  {row.repository}
                </Link>
              </td>
              <td className="py-2 pr-3 font-mono text-slate-400">{row.sha.slice(0, 7)}</td>
              {/* The git author NAME where GitHub linked no account, which is why this is not a link: a name is
                  not a login and has no contributor page. See `directPushRows` for the fallback. */}
              <td className="py-2 pr-3 font-mono text-slate-400 break-all">{row.author ?? <Absent />}</td>
              <td className="py-2 pr-3 text-center">
                <span className={row.ci === undefined ? "text-slate-500" : row.ci ? "text-rag-green" : "text-rag-amber"}>
                  {row.ci === undefined ? <Absent /> : row.ci ? "Yes" : "No"}
                </span>
              </td>
              <td className="py-2 pr-3 text-right tabular-nums text-slate-300">{row.lines === undefined ? <Absent /> : row.lines.toLocaleString("en-GB")}</td>
              <td className="py-2 pr-3 text-right tabular-nums text-slate-300">{row.files ?? <Absent />}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
