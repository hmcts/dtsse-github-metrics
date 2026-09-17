/**
 * What the pages say about the collection every figure on them is anchored to.
 *
 * A reporting window ends where the caches end, not at today's midnight, so a page read this afternoon
 * shows the window last night's collection covers. That is the honest window — the figures are the
 * ones the collection actually supports — but it is only honest if the page SAYS so, otherwise a
 * reader takes a fortnight-old window for this morning's.
 *
 * Three statements, deliberately separate. The label goes in the organisation header beside the window and
 * is printed whenever there is a collection to name; the notice is a warning and appears only when
 * the last collection is older than the configured cadence, which is the service's decision
 * (`collection_stale`) rather than one taken again here against a threshold this side would have to
 * keep in step. The third counts the repositories the collection did not reach at all, which is a fact about
 * one import rather than about its age — see `unreportedLabel`.
 *
 * Instants are formatted through `format.ts` rather than here: a collection edge is a midnight, so
 * the day is the whole of it, and it must read as the same day the window's own dates do.
 */

import { count, day } from "@/lib/format";
import type { WindowOptions } from "@/lib/types";

/**
 * The warning for a collection the service has reported as stale, or `null` when it is current.
 *
 * `collected_through` is absent — not null, under `response_model_exclude_none` — when nothing has
 * been collected under the current query signature, which is the one stale case with no day to name.
 */
export function collectionNotice(windows: WindowOptions): string | null {
  if (!windows.collection_stale) {
    return null;
  }
  if (windows.collected_through == null) {
    return "Nothing has been collected for this organisation, so no repository can be reported at any span. Run metrics collect.";
  }
  return `The last collection reaches ${day(windows.collected_through)}. Every figure here covers the window ending there rather than one ending today. Run metrics collect.`;
}

/** The header's label for the collection a window is anchored to, or nothing to label. */
export function collectedLabel(collected: string | null | undefined): string | null {
  return collected == null ? null : `Collected through ${day(collected)}`;
}

/**
 * How many repositories the header says went unreported, worded for the claim the page is making.
 *
 * TWO WORDINGS OF ONE FIGURE, and neither is a statement about a span — which is worth spelling out, because the
 * older wording says it is. Whichever page states it, the figure counts rows the last collection did not reach:
 * `measuredSources` marks a repository unmeasured when its coverage edge falls short of `endsAt`, and `spanWindow`
 * anchors EVERY span at the same `collectedAnchor`, varying only `startsAt`. So the comparison is against an
 * identical `endsAt` at one week and at twenty-six, and returns the identical answer. "Not reported at this span"
 * was therefore never true of the span; it named the import.
 *
 * The windowed pages keep those words all the same. A reader there meets the figure beside a stated span, where it
 * reads as a qualification of the window's own coverage and is not wrong so much as imprecise. `/repositories`
 * states no window from 2026-09-17, so on it the old phrasing would be a window nothing else on the page mentions —
 * it says what the figure has always meant instead.
 */
export function unreportedLabel(unavailable: number, snapshot = false): string | null {
  if (unavailable === 0) {
    return null;
  }
  const repositories = count(unavailable, "repository", "repositories");
  return snapshot ? `${repositories} the last import did not reach` : `${repositories} not reported at this span`;
}
