import type * as contract from "../../../lib/types.ts";
import { type MaintenanceEvidence, maintenanceEvidence, maintenanceWindows } from "../../domain/standards.ts";
import type { CohortEntry } from "../../org/cohort.ts";

/**
 * The Maintenance section of one repository's page, in the shape the UI declares.
 *
 * IN `report/contract/` for `./observation.ts`'s reason: a pure function of its arguments, so the suite that runs
 * on every build holds it rather than the integration run.
 *
 * TWO SOURCES, as `./assurance.ts` has. Whether anyone pushed is `CohortEntry.pushedAt` from the organisation
 * listing — any branch, and the same instant the Maintained criterion is judged against, so the section and the
 * criterion cannot disagree. Whether a PERSON committed is the answer `collect` stored on the payload. The first is
 * always answerable; the second is absent wherever no collection stored it, and then the human column says
 * "unknown" rather than "no" — a repository nobody searched is not one nobody worked on.
 */

/** No collection has stored a last human commit for this repository, which is not the same as there being none. */
export const HUMAN_COMMIT_UNCOLLECTED_DETAIL = "the last human commit was not collected for this repository";

interface StoredMaintenance {
  lastHumanCommitAt?: unknown;
  searchedBackTo?: unknown;
}

/** A stored instant, which a `jsonb` round trip turned into a string, or nothing where it is absent or unreadable. */
function stored(value: unknown): Date | undefined {
  if (typeof value !== "string" && !(value instanceof Date)) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * The stored human answer, or nothing where no collection stored one.
 *
 * A found commit wins over a search bound: `maintenanceEvidence` refuses the pair, and a found commit is the
 * stronger of the two claims.
 */
function storedEvidence(payload: unknown): MaintenanceEvidence | undefined {
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }
  const block = (payload as { maintenance?: unknown }).maintenance;
  if (typeof block !== "object" || block === null) {
    return undefined;
  }
  const state = block as StoredMaintenance;
  const lastHumanCommitAt = stored(state.lastHumanCommitAt);
  if (lastHumanCommitAt !== undefined) {
    return maintenanceEvidence({ lastHumanCommitAt });
  }
  const searchedBackTo = stored(state.searchedBackTo);
  return maintenanceEvidence(searchedBackTo === undefined ? {} : { searchedBackTo });
}

/**
 * The Maintenance section from the cohort entry's push instant and the stored human answer.
 *
 * WITH NO STORED ANSWER the push column is still reported and the human one is left absent, with a `detail`
 * saying why: `maintenanceWindows` would read a missing answer as an empty branch and say "no".
 */
export function storedMaintenance(entry: CohortEntry, payload: unknown, fetched: Date): contract.MaintenanceReport {
  const evidence = storedEvidence(payload);
  const windows = maintenanceWindows(evidence ?? {}, entry.pushedAt, fetched).map(
    (window): contract.MaintenanceWindowStatus => ({
      months: window.months,
      committed_within: window.committedWithin,
      ...(evidence === undefined || window.humanCommittedWithin === undefined ? {} : { human_committed_within: window.humanCommittedWithin }),
      // A search that stopped short of this window's cutoff says where it stopped, which is the reason the answer
      // is unknown rather than no.
      ...(evidence?.searchedBackTo !== undefined && window.humanCommittedWithin === undefined
        ? { human_detail: `the search stopped at ${evidence.searchedBackTo.toISOString().slice(0, 10)}` }
        : {})
    })
  );
  return {
    fetched_at: fetched.toISOString(),
    maintenance: {
      ...(entry.pushedAt === undefined ? {} : { last_push_at: entry.pushedAt.toISOString() }),
      ...(evidence?.lastHumanCommitAt === undefined ? {} : { last_human_commit_at: evidence.lastHumanCommitAt.toISOString() }),
      ...(evidence?.searchedBackTo === undefined ? {} : { searched_back_to: evidence.searchedBackTo.toISOString() })
    },
    windows,
    ...(evidence === undefined ? { detail: HUMAN_COMMIT_UNCOLLECTED_DETAIL } : {})
  };
}
