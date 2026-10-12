"use client";

import { type EvidenceColumn, EvidenceTable, flag, Judgement, RepositoryCell, SizeCells } from "@/components/EvidenceTable";
import { ABSENT, day } from "@/lib/format";
import type { TeamMergeRow } from "@/lib/types";

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
const COLUMNS: readonly EvidenceColumn<TeamMergeRow>[] = [
  { key: "merged", label: "Merged", read: (row) => row.merged_at },
  { key: "repository", label: "Repository", read: (row) => row.repository },
  { key: "change", label: "Change", align: "right", read: (row) => row.number },
  { key: "author", label: "Author", read: (row) => row.author },
  { key: "reviewed", label: "Reviewed", align: "center", read: (row) => flag(row.reviewed) },
  { key: "ci", label: "CI", align: "center", read: (row) => flag(row.ci) },
  { key: "lines", label: "Lines", align: "right", read: (row) => row.lines },
  { key: "files", label: "Files", align: "right", read: (row) => row.files }
];

export function TeamMergesTable({ rows, weeks }: Readonly<{ rows: readonly TeamMergeRow[]; weeks: number }>) {
  return (
    <EvidenceTable
      columns={COLUMNS}
      rows={rows}
      rowKey={(row) => `${row.repository}#${row.number}`}
      renderCells={(row) => (
        <>
          <td className="py-2 pl-3 pr-3 tabular-nums text-slate-300">{day(row.merged_at)}</td>
          <RepositoryCell repository={row.repository} weeks={weeks} />
          <td className="py-2 pr-3 text-right tabular-nums text-slate-400">#{row.number}</td>
          <td className="py-2 pr-3 font-mono text-slate-400 break-all">{row.author ?? ABSENT}</td>
          <Judgement value={row.reviewed} />
          <Judgement value={row.ci} />
          <SizeCells lines={row.lines} files={row.files} />
        </>
      )}
    />
  );
}
