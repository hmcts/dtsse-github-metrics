/**
 * CODEOWNERS and maintenance evidence. Ported from `metrics.domain`.
 */

/**
 * Each checked CODEOWNERS location: its query alias, its path, and whether GitHub reads it.
 *
 * The minimum-standards request names `CODEOWNERS` or `CODEOWNERS.md` in the repository root, `.github/` or
 * `docs/`; GITHUB ITSELF READS ONLY THE THREE EXTENSIONLESS PATHS. Both facts are carried so the report can
 * say a `.md` variant satisfies the letter of the standard while doing nothing on GitHub.
 */
export const CODEOWNERS_LOCATIONS: readonly { alias: string; path: string; recognisedByGitHub: boolean }[] = [
  { alias: "githubCodeowners", path: ".github/CODEOWNERS", recognisedByGitHub: true },
  { alias: "rootCodeowners", path: "CODEOWNERS", recognisedByGitHub: true },
  { alias: "docsCodeowners", path: "docs/CODEOWNERS", recognisedByGitHub: true },
  { alias: "githubCodeownersMd", path: ".github/CODEOWNERS.md", recognisedByGitHub: false },
  { alias: "rootCodeownersMd", path: "CODEOWNERS.md", recognisedByGitHub: false },
  { alias: "docsCodeownersMd", path: "docs/CODEOWNERS.md", recognisedByGitHub: false }
];

/** One CODEOWNERS file that was found. `byteSize` of 0 is found-but-empty, which is not the same as absent. */
export interface CodeownersFile {
  path: string;
  byteSize: number;
  recognisedByGitHub: boolean;
}

export interface CodeownersEvidence {
  files: CodeownersFile[];
}

/**
 * When one repository's default branch last received a commit, by anyone and by a person.
 *
 * `lastCommitAt` is the newest commit on the default branch, and absent when the branch holds no commits. It
 * is deliberately NOT `pushed_at`/`updated_at`, which move when a bot pushes a pull-request branch that never
 * merges.
 *
 * `lastHumanCommitAt` is the newest commit whose author passes the shared human predicate, and is absent when
 * the bounded search found none. `searchedBackTo` is the oldest instant the search examined, recorded exactly
 * when no human commit was found, so a report can keep "none within the window" apart from "unknown beyond
 * the commits examined" — THE SEARCH IS BOUNDED BY A PAGE CAP, AND THE TWO ABSENCES ARE DIFFERENT ANSWERS.
 *
 * No ordering between `lastHumanCommitAt` and `lastCommitAt` is enforced: history is walked in topological
 * order and the commit date is whatever the committer's clock said, so a rebased or skewed commit deeper in
 * the history may legitimately carry the later instant.
 */
export interface MaintenanceEvidence {
  branch: string;
  lastCommitAt?: Date;
  lastHumanCommitAt?: Date;
  searchedBackTo?: Date;
}

/**
 * Builds maintenance evidence, holding the three instants to the shapes the bounded search can produce.
 *
 * Upstream enforced this with a model validator on every construction; nothing in structural typing gives it
 * for free, so every construction goes through here.
 */
export function maintenanceEvidence(evidence: MaintenanceEvidence): MaintenanceEvidence {
  if (evidence.lastCommitAt === undefined) {
    if (evidence.lastHumanCommitAt !== undefined || evidence.searchedBackTo !== undefined) {
      throw new RangeError("a branch with no commits has nothing to have searched");
    }
    return evidence;
  }
  if (evidence.lastHumanCommitAt === undefined) {
    if (evidence.searchedBackTo === undefined) {
      throw new RangeError("an absent human commit must say how far back the search examined");
    }
    return evidence;
  }
  if (evidence.searchedBackTo !== undefined) {
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
    return evidence.lastCommitAt === undefined ? false : undefined;
  }
  return evidence.searchedBackTo.getTime() <= cutoff.getTime() ? false : undefined;
}

/** Every window's answer for one repository, against the instant the evidence was observed. */
export function maintenanceWindows(evidence: MaintenanceEvidence, fetchedAt: Date): MaintenanceWindowStatus[] {
  return MAINTENANCE_WINDOWS.map((window) => {
    const cutoff = new Date(fetchedAt.getTime() - window.days * 86_400_000);
    const humanAnswer = humanWindowAnswer(evidence, cutoff);
    return {
      months: window.months,
      committedWithin: evidence.lastCommitAt !== undefined && evidence.lastCommitAt.getTime() >= cutoff.getTime(),
      ...(humanAnswer === undefined ? {} : { humanCommittedWithin: humanAnswer })
    };
  });
}
