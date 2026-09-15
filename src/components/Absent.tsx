import { ABSENT } from "@/lib/format";

/**
 * An unmeasured value, in the dash a sighted reader knows and the words everybody else needs.
 *
 * "ABSENT MEANS UNMEASURED" IS THE CONTRACT'S CENTRAL RULE — `format.ts` opens with it, and every
 * table on this site leans on it: a dash is how "nobody read this" is kept apart from "the answer is
 * no" and from a zero. In a table cell the whole of that rule was being carried by one hyphen glyph,
 * which a screen reader announces as "hyphen" or, between two empty cells, skips entirely. So the one
 * distinction the tables are built on was the one thing not conveyed.
 *
 * The dash is `aria-hidden` and the phrase is `sr-only`, rather than an `aria-label` on the cell:
 * a label on a `<td>` replaces the cell's whole content for assistive technology, which would work
 * here but would silently swallow anything later placed beside the dash. Two spans keep the visual
 * and the spoken rendering independent, and each says the same thing in its own medium.
 *
 * The neighbouring Yes/No cells already honour "colour is never the sole carrier of meaning" by
 * printing the word as well as the tone. This is that same rule applied to the third answer.
 */
export function Absent() {
  return (
    <>
      <span aria-hidden="true">{ABSENT}</span>
      <span className="sr-only">not measured</span>
    </>
  );
}
