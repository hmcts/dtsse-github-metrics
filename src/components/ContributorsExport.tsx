"use client";

import { Download } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { filterActors, orderActors } from "@/lib/actors";
import { CSV_BYTE_ORDER_MARK, csvDocument, csvFilename } from "@/lib/csv";
import { contributorExportRows } from "@/lib/export";
import { day } from "@/lib/format";
import { isReadinessKey, READINESS_PARAMETER } from "@/lib/readiness";
import type { ActorRow } from "@/lib/types";

/**
 * `/contributors`' list as a CSV, by GitHub username — `RepositoriesExport`'s control for the people rather than the
 * repositories, built the same way and for the same reasons: client-side, out of the rows already on the page.
 *
 * SCOPE IS THE READER'S FILTERS, read through `filterActors` as the table reads them, so clicking the Ready tile and
 * exporting hands over exactly the people the tile counted. The order is the one the table opens on.
 *
 * THE FILE IS NAMED AFTER THE TILE SELECTED, where one is. Exporting Ready and then Review on the same day over the
 * same window would otherwise produce two files of one name, and the second would arrive as "(1)".
 */
export function ContributorsExport({
  rows,
  labelled,
  window: reported
}: Readonly<{
  rows: readonly ActorRow[];
  labelled: boolean;
  /** The span the page states, which the file is named after so two exports are distinguishable. */
  window: string;
}>) {
  const searchParameters = useSearchParams();
  const read = (parameter: string) => searchParameters.get(parameter);
  const shown = orderActors(filterActors(rows, read, labelled));
  const readiness = read(READINESS_PARAMETER) ?? "";

  function download() {
    const content = CSV_BYTE_ORDER_MARK + csvDocument(contributorExportRows(shown, labelled));
    const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = csvFilename(isReadinessKey(readiness) ? `contributors-${readiness}` : "contributors", reported, day(new Date().toISOString()));
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <button
      type="button"
      onClick={download}
      // Disabled rather than exporting a header row alone, for `RepositoriesExport`'s reason.
      disabled={shown.length === 0}
      className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs transition-colors bg-slate-800 text-slate-300 hover:bg-slate-700 hover:text-slate-100 focus:outline-none focus-visible:ring-1 focus-visible:ring-indigo-500 disabled:opacity-50 disabled:hover:bg-slate-800 disabled:hover:text-slate-300"
    >
      <Download className="shrink-0 w-3 h-3" aria-hidden="true" />
      Export CSV
    </button>
  );
}
