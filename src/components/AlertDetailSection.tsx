import clsx from "clsx";
import { EmptyState } from "@/components/EmptyState";
import { Section } from "@/components/Section";
import { instant } from "@/lib/format";
import { type AlertScanSummary, alertActionLabel, alertIdentifier, alertLocation, alertScanSummaries, alertState, alertSubject } from "@/lib/repository";
import { borderClass, valueClass } from "@/lib/tone";
import type { SecurityAlertFamilyScan } from "@/lib/types";

/**
 * Each alert family's own alerts, under the state that says whether anybody looked.
 *
 * SEPARATE FROM THE COUNT CARDS ABOVE IT, and the split is which question is being asked. "Security alerts" answers
 * how many are open per family; this answers which ones, and it is the second that a reader can act on — a type, a
 * path and a link to the alert on GitHub.
 *
 * THE STATE IS DRAWN EVEN WHERE A FAMILY HAS NO ALERTS, which is the failure this whole section exists to avoid. A
 * family that is switched off, a family nobody could read and a family read and found clean are one empty table and
 * three different facts, and on this estate two of the three are the common case: code scanning is unmeasured for 651
 * repositories and not enabled for 1,074, secret scanning not enabled for 893. So each family states its own position
 * in words before any table is drawn, and the words for the two absences never say "no alerts".
 *
 * NO WARNING STYLING ON AN ABSENCE. `tone.alertScanTone` gives both unread states `neutral`, so an unmeasured family
 * is a statement rather than an alarm — the reader cannot install the App that was refused, and a page that shouts
 * about it every time is a page they learn to skip. What a colour is spent on is the one thing it can honestly grade:
 * green for a family read and clean, amber or red for one with alerts open.
 */
export function AlertDetailSection({ scans }: { scans: readonly SecurityAlertFamilyScan[] }) {
  return (
    <Section heading="Alert detail" detail="open alerts, longest-exposed first">
      <div className="space-y-6">
        {alertScanSummaries(scans).map((summary) => (
          <FamilyBlock key={summary.family} summary={summary} />
        ))}
      </div>
    </Section>
  );
}

/**
 * One family: its state as a heading, and either its open alerts or what the empty list means.
 *
 * `<h3>` UNDER THE SECTION'S OWN `<h2>`, so the three families are navigable headings rather than three bold lines: a
 * screen reader's heading list is how a reader reaches the family they came for, and this section is the one place on
 * the page with three peers inside it.
 *
 * The state word is in the heading row and the reason under it, both as text. Nothing here is a `title` — the reason a
 * criterion's sentence moved off the estate table is that a tooltip is not readable on touch and is not reliably
 * announced, and reproducing one here would repeat the fault in the place it was being fixed.
 */
function FamilyBlock({ summary }: { summary: AlertScanSummary }) {
  return (
    <div className={clsx("bg-slate-900/50 rounded-r py-3 pl-3 pr-4", borderClass(summary.tone))}>
      <div className="flex flex-wrap items-baseline gap-x-3">
        <h3 className="text-sm font-medium text-slate-200">{summary.family}</h3>
        <span className={clsx("text-xs", valueClass(summary.tone))}>{summary.state}</span>
      </div>
      <p className="text-xs text-slate-500 mt-0.5">{summary.detail}</p>
      <div className="mt-3">{summary.alerts.length === 0 ? <EmptyState message={summary.empty} /> : <AlertTable summary={summary} />}</div>
    </div>
  );
}

/**
 * One family's open alerts as a table: what it is, where, when it was raised, its state, and the link.
 *
 * A TABLE AND NOT A LIST, unlike every other block on this page: there are five facts per alert and a reader compares
 * them DOWN rather than reading each alert as a paragraph — which path is worst, which has been open longest. That is
 * the one thing that makes a `<table>` right rather than a `<dl>`, and the `caption` names which family's alerts these
 * are so the table is not orphaned from the heading above it when a screen reader lists it alone.
 *
 * THE LINK IS THE ONLY ACTION, and for secret scanning its label says so: resolving a false positive happens on
 * GitHub, our count follows at the next collection, and there is deliberately nothing here to click instead. See
 * `alertActionLabel`.
 */
function AlertTable({ summary }: { summary: AlertScanSummary }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <caption className="sr-only">{`Open ${summary.family} alerts`}</caption>
        <thead className="text-slate-400 border-b border-slate-800">
          <tr>
            <th scope="col" className="py-2 pr-3 text-left font-medium">
              Type
            </th>
            <th scope="col" className="py-2 pr-3 text-left font-medium">
              Location
            </th>
            <th scope="col" className="py-2 pr-3 text-left font-medium">
              Detected
            </th>
            <th scope="col" className="py-2 pr-3 text-left font-medium">
              State
            </th>
            <th scope="col" className="py-2 text-left font-medium">
              GitHub
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800/50">
          {summary.alerts.map((alert) => (
            <tr key={alert.number} className="hover:bg-slate-800/30">
              <td className="py-2 pr-3 align-top">
                <span className="font-mono text-slate-200 break-all">{alertSubject(alert)}</span>
                {/* The advisory identifier under the package it is about, which is the Dependabot shape: the subject
                    is what a reader acts on and the identifier is what they look up. */}
                {alertIdentifier(alert) ? <p className="font-mono text-slate-500 mt-0.5 break-all">{alertIdentifier(alert)}</p> : null}
              </td>
              <td className="py-2 pr-3 align-top font-mono text-slate-300 break-all">{alertLocation(alert)}</td>
              <td className="py-2 pr-3 align-top text-slate-300 whitespace-nowrap">{instant(alert.created_at)}</td>
              <td className="py-2 pr-3 align-top text-slate-300">{alertState(alert)}</td>
              <td className="py-2 align-top">
                {alert.html_url === undefined ? (
                  // Never a dead link and never an empty cell: an alert whose URL was not stored is still an alert,
                  // and a blank cell here would read as one that needs no attention.
                  <span className="text-slate-500">no link was stored</span>
                ) : (
                  <a href={alert.html_url} className="text-indigo-400 hover:text-indigo-300 whitespace-nowrap">
                    {alertActionLabel(summary.family)}
                  </a>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
