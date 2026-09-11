import Link from "next/link";
import { INDIVIDUAL_LABEL, ownedByIndividual } from "@/lib/rows";
import type { RepositoryRow } from "@/lib/types";
import { withWeeks } from "@/lib/weeks";

/**
 * Who owns a repository: a link to the owning team, or one person's login marked as an individual.
 *
 * A PERSON IS NOT LINKED, because there is nothing to link to. `/teams` lists teams only from
 * 2026-09-11, so `/teams/a1i-hussain` is a not-found page and a link to it would be a dead one on the
 * 206 repositories of this estate that one person owns. Nor is the login linked to
 * `/contributors/<login>`: that is the same person and not the same claim — that page is about who
 * authored merges in the window, and owning a repository is neither necessary nor sufficient for
 * appearing on it. So the name is plain text, and the marker beside it says what the name is.
 *
 * THE MARKER IS A WORD, for `RAGLabel`'s reason: the word is the information and a colour or an icon
 * alone would not survive a monochrome print or a screen reader. It is slate rather than any of the
 * report's palettes because it is not a grade — a repository owned by one person is a fact about the
 * estate's shape, in the sense `production.ts` argues its own attribute is, and neither better nor
 * worse than a team-owned one. Slate also keeps it out of `rag.ts` and `production.ts` both, so
 * nothing here reaches into a vocabulary that carries a verdict.
 *
 * THE UNOWNED BUCKET KEEPS ITS LINK. `unowned` is a card on `/teams` and 141 repositories are reported
 * under it, so the link goes somewhere — and the name already says what it is, which is why it needs no
 * marker. "Owned by nobody" and "owned by one person" are different findings and this is where they
 * stay apart.
 *
 * One component for both places the owner is drawn — the estate table's Team cell and the repository
 * page's header — because the rule that a person is unlinked is the whole point, and two copies of it
 * is how one of them ends up linked again.
 */
export function OwnerName({ row, weeks }: { row: Pick<RepositoryRow, "team" | "owner_kind">; weeks: number }) {
  if (ownedByIndividual(row)) {
    return (
      <span className="inline-flex flex-wrap items-center gap-1.5">
        <span className="text-slate-300">{row.team}</span>
        <span className="rounded bg-slate-800 px-1.5 py-0.5 text-xs text-slate-400 uppercase tracking-wide whitespace-nowrap">{INDIVIDUAL_LABEL}</span>
      </span>
    );
  }
  return (
    <Link href={withWeeks(`/teams/${encodeURIComponent(row.team)}`, weeks)} className="text-indigo-400 hover:text-indigo-300">
      {row.team}
    </Link>
  );
}
