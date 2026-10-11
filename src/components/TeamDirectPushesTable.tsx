"use client";

import { type EvidenceColumn, EvidenceTable, flag, Judgement, RepositoryCell, SizeCells } from "@/components/EvidenceTable";
import { ABSENT, day } from "@/lib/format";
import type { TeamDirectPushRow } from "@/lib/types";

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
const COLUMNS: readonly EvidenceColumn<TeamDirectPushRow>[] = [
  { key: "pushed", label: "Pushed", read: (row) => row.committed_at },
  { key: "repository", label: "Repository", read: (row) => row.repository },
  { key: "commit", label: "Commit", read: (row) => row.sha },
  { key: "author", label: "Author", read: (row) => row.author },
  { key: "ci", label: "CI", align: "center", read: (row) => flag(row.ci) },
  { key: "lines", label: "Lines", align: "right", read: (row) => row.lines },
  { key: "files", label: "Files", align: "right", read: (row) => row.files }
];

export function TeamDirectPushesTable({ rows, weeks }: Readonly<{ rows: readonly TeamDirectPushRow[]; weeks: number }>) {
  return (
    <EvidenceTable
      columns={COLUMNS}
      rows={rows}
      rowKey={(row) => `${row.repository}@${row.sha}`}
      cells={(row) => (
        <>
          <td className="py-2 pl-3 pr-3 tabular-nums text-slate-300">{day(row.committed_at)}</td>
          <RepositoryCell repository={row.repository} weeks={weeks} />
          <td className="py-2 pr-3 font-mono text-slate-400">{row.sha.slice(0, 7)}</td>
          {/* The git author NAME where GitHub linked no account, which is why this is not a link: a name is
              not a login and has no contributor page. See `directPushRows` for the fallback. */}
          <td className="py-2 pr-3 font-mono text-slate-400 break-all">{row.author ?? ABSENT}</td>
          <Judgement value={row.ci} />
          <SizeCells lines={row.lines} files={row.files} />
        </>
      )}
    />
  );
}
