/**
 * Maintenance evidence. Ported from `metrics.domain`.
 *
 * Two answers make up the repository page's Maintenance section, and only one of them is collected here. Whether
 * ANYONE pushed within a window is read off `pushed_at` from the organisation listing, which the cohort already
 * holds as `CohortEntry.pushedAt` and which is the same instant the Maintained assurance criterion is judged
 * against. Whether a PERSON committed is not in that listing, so `collect` stores the answer below on the
 * repository's state: from the window's cached merges where they hold a human one, and from a bounded walk of
 * the default branch's history where they do not — bounded by `HUMAN_MAINTENANCE_SEARCH_DAYS`, which is why that
 * bound is derived from the widest reported window rather than stated.
 *
 * The CODEOWNERS presence check that used to live here went on 2026-10-08: the repository page shows active
 * contributors in its place, and `org/codeowners.ts` — which PARSES a CODEOWNERS file for the ownership
 * ladder — is unrelated and stays.
 */

/**
 * When a person last committed to one repository's default branch, as the bounded search answered it.
 *
 * `lastHumanCommitAt` is the newest commit whose author passes the shared human predicate, and is absent when
 * the bounded search found none. `searchedBackTo` is the oldest instant the search examined, recorded exactly
 * when no human commit was found, so a report can keep "none within the window" apart from "unknown beyond
 * the commits examined" — THE SEARCH IS BOUNDED BY A PAGE CAP, AND THE TWO ABSENCES ARE DIFFERENT ANSWERS.
 *
 * NEITHER present is a branch with no commits at all: nothing to have searched, and nobody committed.
 */
export interface MaintenanceEvidence {
  lastHumanCommitAt?: Date;
  searchedBackTo?: Date;
}

/**
 * Builds maintenance evidence, holding the two instants to the shapes the bounded search can produce.
 *
 * Upstream enforced this with a model validator on every construction; nothing in structural typing gives it
 * for free, so every construction goes through here.
 */
export function maintenanceEvidence(evidence: MaintenanceEvidence): MaintenanceEvidence {
  if (evidence.lastHumanCommitAt !== undefined && evidence.searchedBackTo !== undefined) {
    throw new RangeError("a found human commit carries no search bound");
  }
  return evidence;
}

/**
 * The reported maintenance windows, as months paired with days.
 *
 * Day counts, because a month is not a fixed span; each window is the half-open interval
 * `[fetchedAt - days, fetchedAt)` against the stored observation instant, so the derived rows reproduce
 * offline from the stored evidence alone. Declared here, beside the evidence it is derived from, so the
 * collector's search bound and the report's widest window are one number rather than two that drift.
 */
export const MAINTENANCE_WINDOWS: readonly { months: number; days: number }[] = [
  { months: 6, days: 183 },
  { months: 12, days: 365 },
  { months: 24, days: 730 }
];

/**
 * How far back the human-commit search reaches: the widest reported window.
 *
 * Derived from the windows rather than restated, because the window answer decides `false` only where the
 * search is known to have reached that window's cutoff: a bound narrower than the widest window would
 * silently turn every exhausted-history answer for that window into "unknown".
 */
export const HUMAN_MAINTENANCE_SEARCH_DAYS = Math.max(...MAINTENANCE_WINDOWS.map((window) => window.days));

/** One maintenance window's answer, derived at report assembly from the stored instants. */
export interface MaintenanceWindowStatus {
  months: number;
  committedWithin: boolean;
  /** Three-valued: absent means the bounded search never reached this window's cutoff. */
  humanCommittedWithin?: boolean;
}

/**
 * Whether a human committed within one window, or `undefined` when the search cannot say.
 *
 * `false` is only ever returned where the search is KNOWN to have reached past the cutoff. Where it stopped
 * short — the page cap — the answer is absent, because "nobody committed in six months" and "we did not look
 * back six months" are different statements and only one of them is evidence.
 */
export function humanWindowAnswer(evidence: MaintenanceEvidence, cutoff: Date): boolean | undefined {
  if (evidence.lastHumanCommitAt !== undefined) {
    return evidence.lastHumanCommitAt.getTime() >= cutoff.getTime();
  }
  if (evidence.searchedBackTo === undefined) {
    // No commits at all on the branch: nothing to have searched, and nobody committed.
    return false;
  }
  return evidence.searchedBackTo.getTime() <= cutoff.getTime() ? false : undefined;
}

/**
 * Every window's answer for one repository, against the instant the evidence was observed.
 *
 * `lastPushAt` is the repository's `pushed_at`, absent where the listing did not carry one, which answers
 * `committedWithin` as false: nothing says anyone pushed. `evidence` is absent where no human answer was collected,
 * which leaves every window's `humanCommittedWithin` absent: unknown, not no.
 */
export function maintenanceWindows(evidence: MaintenanceEvidence | undefined, lastPushAt: Date | undefined, fetchedAt: Date): MaintenanceWindowStatus[] {
  return MAINTENANCE_WINDOWS.map((window) => {
    const cutoff = new Date(fetchedAt.getTime() - window.days * 86_400_000);
    const humanAnswer = evidence === undefined ? undefined : humanWindowAnswer(evidence, cutoff);
    return {
      months: window.months,
      committedWithin: lastPushAt !== undefined && lastPushAt.getTime() >= cutoff.getTime(),
      ...(humanAnswer === undefined ? {} : { humanCommittedWithin: humanAnswer })
    };
  });
}
