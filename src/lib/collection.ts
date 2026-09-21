/**
 * What the pages say about the collection every figure on them is anchored to.
 *
 * A reporting window ends where the caches end rather than at today's midnight, so a page read this afternoon
 * shows the window the last collection covers. The header STATES that date and stops there.
 *
 * NO WARNING IS RAISED ON A STALE COLLECTION, and that is deliberate. This estate's collectors do not run at
 * weekends — the environment is shut down — so a banner keyed off the age of the last collection fired every
 * Monday by design, on every page, and told the reader to run a command that is a CronJob they cannot invoke. A
 * warning that appears when nothing is wrong teaches a reader to ignore warnings. "Collected through <date>" is
 * the whole fact; anyone who needs to know whether that is recent can read it.
 *
 * Instants are formatted through `format.ts` rather than here: a collection edge is a midnight, so
 * the day is the whole of it, and it must read as the same day the window's own dates do.
 */

import { count, day } from "@/lib/format";

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
