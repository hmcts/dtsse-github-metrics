import { Check } from "lucide-react";

/**
 * The tick an applied filter wears, so its state is not carried by fill colour alone.
 *
 * COLOUR IS NEVER THE SOLE SIGHTED SIGNAL. Every filter on `/repositories` said "on" by changing its background —
 * royal for Production, `slate-800` for a visibility or for a summary wheel's active slice — which is exactly the
 * rule this codebase holds everywhere it grades something. A reader who cannot separate two dark fills could not
 * tell which of nine controls was filtering the table.
 *
 * `aria-hidden`, because the state is already on the button as `aria-pressed` and a screen reader would otherwise
 * be told twice. The two channels are deliberately separate — the attribute is the accessible answer, the tick is
 * the visible one, and neither substitutes for the other.
 *
 * Renders nothing when off rather than a dimmed tick: a half-visible tick is the colour-only signal again, one step
 * quieter.
 *
 * IN A FILE OF ITS OWN because two unrelated components need it — the estate table's four toggles and the four
 * summary wheels' legends — and a second copy is how one of the two would come to say "on" a different way.
 */
export function ToggleTick({ on }: { on: boolean }) {
  return on ? <Check className="shrink-0 w-3 h-3" aria-hidden="true" /> : null;
}
