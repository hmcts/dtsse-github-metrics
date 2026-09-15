"use client";

import { Download } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { CSV_BYTE_ORDER_MARK, csvDocument, csvFilename } from "@/lib/csv";
import { repositoryExportRows } from "@/lib/export";
import { day } from "@/lib/format";
import { filterRepositories, orderRepositories, parseProduction, parseVisibilities, TERM_PARAMETER } from "@/lib/rows";
import type { Contributor, RepositoryRow } from "@/lib/types";

/**
 * A control that hands the reader the table they are looking at, as a CSV.
 *
 * WHOLLY CLIENT-SIDE, and no second fetch. Every row is already on the page — `/repositories` renders the estate
 * server-side and this component is handed the same array — so the file is built in the browser out of what has
 * already been transferred. A route handler would have had to reproduce the reader's filters from the query string
 * and read the estate again to answer a question the page has already answered.
 *
 * The one thing it is handed that the table is not is the owning teams' contributors, which are a fold over the
 * window's changes rather than a field on a row. They come from the same cached span build as the rows, in the same
 * server render, and cost no round trip either — see `getTeamContributors`.
 *
 * SCOPE IS THE READER'S FILTERS, which is what "the rows currently displayed" means: the term, the Production
 * toggle and the three visibility toggles all live in the URL, so this reads them through the same `useSearchParams`
 * and the same `filterRepositories` the table does. It cannot read the table's SORT, which is component state one
 * level away — so the file is ordered by `orderRepositories`, the order the table opens on and the one it is in
 * unless the reader has clicked a header. Rows and columns match either way; only their sequence can differ.
 *
 * NAMED BY ITS VISIBLE WORDS and nothing else, so the accessible name and the label a sighted reader reads are the
 * same string. The icon is decoration and is `aria-hidden`, as every other icon on the site is.
 */
export function RepositoriesExport({
  rows,
  teamContributors,
  window: reported
}: {
  rows: readonly RepositoryRow[];
  teamContributors: Readonly<Record<string, Contributor[]>>;
  /** The span the page states, which the file is named after so two exports are distinguishable. */
  window: string;
}) {
  const searchParameters = useSearchParams();
  const shown = orderRepositories(
    filterRepositories(
      rows,
      searchParameters.get(TERM_PARAMETER) ?? "",
      parseProduction((parameter) => searchParameters.get(parameter)),
      parseVisibilities((parameter) => searchParameters.get(parameter))
    )
  );

  function download() {
    const content = CSV_BYTE_ORDER_MARK + csvDocument(repositoryExportRows(shown, teamContributors));
    // An object URL rather than a `data:` URL: an estate of 1,880 rows is a few hundred kilobytes, and percent
    // encoding it into an href would push it past the length some browsers will follow for a download.
    const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = csvFilename("repositories", reported, day(new Date().toISOString()));
    anchor.click();
    // Released immediately. The download has the blob by the time `click` returns, and an object URL left behind
    // holds its bytes for the life of the document — which on a page a reader exports from twice is the estate
    // twice over.
    URL.revokeObjectURL(url);
  }

  return (
    <button
      type="button"
      onClick={download}
      // DISABLED RATHER THAN EXPORTING A HEADER ROW ALONE. Where the filters leave nothing the table renders its
      // "no repository matches this filter" state, and a file of column names with no rows under it looks like the
      // export failed rather than like the filter matched nothing.
      disabled={shown.length === 0}
      className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs transition-colors bg-slate-800 text-slate-300 hover:bg-slate-700 hover:text-slate-100 focus:outline-none focus-visible:ring-1 focus-visible:ring-indigo-500 disabled:opacity-50 disabled:hover:bg-slate-800 disabled:hover:text-slate-300"
    >
      <Download className="shrink-0 w-3 h-3" aria-hidden="true" />
      Export CSV
    </button>
  );
}
