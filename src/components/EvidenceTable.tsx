"use client";

import Link from "next/link";
import { type ReactNode, useState } from "react";
import { type Align, SortHeader } from "@/components/SortHeader";
import { ABSENT } from "@/lib/format";
import { answerWord } from "@/lib/rows";
import { type Direction, nextDirection, type SortValue, sorted } from "@/lib/sort";
import { withWeeks } from "@/lib/weeks";

/**
 * The sortable list of changes under a team's ways-of-working counts: one row per merge or per direct push.
 *
 * SHARED by `TeamMergesTable` and `TeamDirectPushesTable`, which differ only in their columns and in the cells a row
 * renders. The ordering, the header and the frame are one decision, so they are spelled once here.
 *
 * The first column is the default: an untouched table renders the served order, which is already newest-first, rather
 * than re-sorting to the same answer. The header still reads active, so the order a reader is looking at is stated.
 */
export interface EvidenceColumn<Row> {
  key: string;
  label: string;
  align?: Align;
  read: (row: Row) => SortValue;
}

export function EvidenceTable<Row>({
  columns,
  rows,
  rowKey,
  renderCells
}: Readonly<{
  columns: readonly EvidenceColumn<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  /** The `<td>`s of one row, in the order of `columns`. */
  renderCells: (row: Row) => ReactNode;
}>) {
  const [column, setColumn] = useState<EvidenceColumn<Row> | null>(null);
  const [direction, setDirection] = useState<Direction>("descending");
  const active = column ?? (columns[0] as EvidenceColumn<Row>);

  const ordered = column === null ? rows : sorted(rows, column.read, direction);

  function sort(next: EvidenceColumn<Row>) {
    setDirection(nextDirection(active, next, direction));
    setColumn(next);
  }

  return (
    // No border of its own: the table sits inside a `Section` panel that already draws one.
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="text-slate-400 border-b border-slate-800">
          <tr>
            {columns.map((entry, index) => (
              <SortHeader
                key={entry.key}
                label={entry.label}
                active={entry === active}
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
            <tr key={rowKey(row)} className="hover:bg-slate-800/30">
              {renderCells(row)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The repository a change landed in, linked to its page for the same window. */
export function RepositoryCell({ repository, weeks }: Readonly<{ repository: string; weeks: number }>) {
  return (
    <td className="py-2 pr-3">
      <Link href={withWeeks(`/repositories/${encodeURIComponent(repository)}`, weeks)} className="font-mono text-indigo-400 hover:text-indigo-300 break-all">
        {repository}
      </Link>
    </td>
  );
}

/**
 * The size of a change: its lines and its files.
 *
 * Absent and never zero: GitHub does not size every change, and `0 lines` would read as an empty change rather than
 * as one nobody measured.
 */
export function SizeCells({ lines, files }: Readonly<{ lines?: number; files?: number }>) {
  return (
    <>
      <td className="py-2 pr-3 text-right tabular-nums text-slate-300">{lines === undefined ? ABSENT : lines.toLocaleString("en-GB")}</td>
      <td className="py-2 pr-3 text-right tabular-nums text-slate-300">{files ?? ABSENT}</td>
    </>
  );
}

/**
 * A boolean sorts as a number so both directions group the two answers rather than interleaving them.
 *
 * `undefined` stays `undefined` so `sorted` puts an unmeasured change last in BOTH directions, which is the rule
 * every other table here follows: "which merges went unreviewed" is a question about the merges somebody read the
 * reviews of, and one whose payload carries none is not an answer to it either way round.
 */
export function flag(value: boolean | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value ? 1 : 0;
}

/**
 * One of the governance answers on a change, toned.
 *
 * COLOURED, unlike the size columns beside it, because these ARE findings: a substantial change that reached the
 * default branch unreviewed is the thing the ways-of-working figures are counting. Amber rather than red, to agree
 * with `Outcome` on `/repositories` — an unmet criterion there is amber, and one merge is weaker evidence than a
 * repository-wide posture, not stronger.
 *
 * THREE-VALUED, because the fact cache is: a merge whose stored payload carries no reviews was not measured, which
 * is a different answer from one that went unreviewed. The dash keeps them apart where a `No` would accuse.
 */
function judgementClass(value: boolean | undefined): string {
  if (value === undefined) {
    return "text-slate-400";
  }
  return value ? "text-rag-green" : "text-rag-amber";
}

export function Judgement({ value }: Readonly<{ value?: boolean }>) {
  return (
    <td className="py-2 pr-3 text-center">
      <span className={judgementClass(value)}>{answerWord(value)}</span>
    </td>
  );
}
