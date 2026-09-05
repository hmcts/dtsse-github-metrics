import type { RateLimitBudget } from "../github/client.ts";

/**
 * Spacing one kind of call out in time, so a per-minute quota is respected rather than hit. Ported from
 * `metrics.sonar.CallPacer`.
 *
 * PACING RATHER THAN REACTING: GitHub answers a spent commit-search quota with a 403 whose window takes a full
 * minute to clear, so a run that sprints into the limit is slower than one that never reaches it — and it
 * burns a retry budget that a genuine failure then has none of.
 *
 * PACED OFF WHAT GITHUB REPORTS, NOT OFF WHAT GITHUB DOCUMENTS. The budget reads the client's record of the
 * live `x-ratelimit-*` headers, and the spacing is recomputed before every call as "the calls left, spread
 * over the time left in the window". A fixed interval cannot do this: the documented search allowance is 30 a
 * minute and the observed allowance for the token that ran a real `map-sonar` was 10, so a fixed pace tripped
 * a 403 every tenth search and waited a minute each time. The configured interval survives as the FLOOR.
 *
 * The clock and the pause are injected so a test can assert the spacing without waiting for it.
 */
export interface CallPacerOptions {
  /** The floor, in seconds: the fastest this will ever go, and the spacing used before any header is seen. */
  interval: number;
  /** Epoch seconds, matching GitHub's own reset header. */
  clock?: () => number;
  pause?: (ms: number) => Promise<void>;
  budget?: () => RateLimitBudget | undefined;
}

export function createCallPacer(options: CallPacerOptions) {
  const clock = options.clock ?? (() => Date.now() / 1000);
  const pause = options.pause ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let issuedAt: number | undefined;

  /**
   * The gap to leave before the next call, from the live budget where there is one.
   *
   * Three cases, and the floor applies to all of them:
   *
   * NO BUDGET YET, or one whose window has already closed — the headers say nothing usable, so the configured
   * interval stands. A closed window is not read as "0 remaining": GitHub refills at the reset instant and the
   * record is simply stale.
   *
   * SOMETHING LEFT — spread it. `remaining` calls over the seconds until the window resets is the pace that
   * arrives at the reset instant having spent exactly the allowance, and it self-corrects every call because
   * the next response reports both numbers again.
   *
   * NOTHING LEFT — wait out the window. The alternative is issuing a call certain to be refused, and then
   * sleeping through the same window anyway with a retry spent.
   */
  function spacing(): number {
    const budget = options.budget?.();
    if (budget === undefined) {
      return options.interval;
    }
    const window = budget.resetsAt - clock();
    if (window <= 0) {
      return options.interval;
    }
    if (budget.remaining <= 0) {
      return Math.max(window, options.interval);
    }
    return Math.max(window / budget.remaining, options.interval);
  }

  return {
    spacing,
    /**
     * Pauses until the interval since the previous call has passed, then claims this call's slot.
     *
     * No single wait ever exceeds the current spacing, because the elapsed time is floored at zero: a wall
     * clock being corrected backwards would otherwise stall a run for as long as the correction was large,
     * which is a hang and not a pause.
     */
    async wait(): Promise<void> {
      const now = clock();
      if (issuedAt === undefined) {
        issuedAt = now;
        return;
      }
      const interval = spacing();
      const delay = interval - Math.max(now - issuedAt, 0);
      if (delay <= 0) {
        issuedAt = now;
        return;
      }
      console.debug(`pacing the commit search: waiting ${delay.toFixed(1)}s`);
      await pause(delay * 1000);
      // Whichever is later: a real clock has advanced past the slot the pause bought, and a frozen clock must
      // still be seen to have consumed it or every later call would pause all over again.
      issuedAt = Math.max(clock(), issuedAt + interval);
    }
  };
}

export type CallPacer = ReturnType<typeof createCallPacer>;
