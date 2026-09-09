import type { Configuration } from "../policy/schema.ts";
import { type LiveOrgRepository, type LiveRepositoryOwnership, liveOrgRepositories, liveRepositoryOwnership } from "../store/org-graph.ts";
import { OwnerKind } from "./graph.ts";

/**
 * The reporting cohort, read from the collected graph rather than from `metrics.yaml`.
 *
 * `metrics.yaml` used to list the estate under `teams:`, and `collect-org --propose-teams` generated that block
 * for somebody to commit. At 1,872 repositories a committed list is stale the day it lands: a repository created
 * on Tuesday is invisible until a human notices, and one archived on Wednesday keeps being collected. So the
 * graph is now the source of truth and the file states POLICY — which visibilities count, whether archived
 * repositories do, and how recently a repository must have been pushed to.
 *
 * WHAT THIS GIVES UP is deliberate and was the previous decision's stated reason for the opposite choice:
 * adding a team is no longer a reviewed change. Accepted, because a stale list is a worse failure than an
 * occasionally-wrong inference, and because the change-versioned tables make "what joined the cohort this week"
 * a query rather than a diff of a file nobody updated. Review the policy, not the membership.
 *
 * TWO THINGS SURVIVE FROM THE FILE. `excluded_repositories` still removes a repository outright, and `teams:`
 * still overrides ownership — it feeds the `configured` rung, so a hand-set owner still beats inference. What
 * it no longer does is decide who is IN.
 */

/**
 * The identifier a repository nothing owns is grouped under.
 *
 * Its own bucket rather than an omission, because dropping the unowned would quietly shrink the estate: 360 of
 * 1,872 repositories land here, and a further 54 are attributed only by name-prefix. An estate that reports
 * 1,512 repositories because 360 had no owner is wrong in the direction nobody checks.
 */
export const UnownedIdentifier = "unowned";

/** Every visibility GitHub reports, lower-cased as the graph stores it. */
export const Visibilities = ["public", "internal", "private"] as const;

export type Visibility = (typeof Visibilities)[number];

/** Which repositories the estate is, expressed as policy rather than as a list of names. */
export interface CohortPolicy {
  /**
   * Which visibilities count.
   *
   * Worth stating rather than defaulting to all three: measured on this estate, 830 of 1,796 active
   * repositories are private or internal, and every one of them is refused until the App's pending
   * `pull_requests: read` is approved. Narrowing to `public` is how a deployment reports figures it can
   * actually read instead of a cohort that is half `unavailable`.
   */
  visibilities: Set<string>;
  /** Whether an archived repository is still part of the estate. Normally not: nobody is working in it. */
  includeArchived: boolean;
  /**
   * How recently a repository must have been pushed to, in days, or `undefined` for no window.
   *
   * The cheapest single lever on cost and on noise: 90 days takes 1,872 repositories to roughly 1,210, and the
   * ones it drops are the ones whose figures would all be "no merges in the window" anyway.
   */
  activeWithinDays?: number;
  /** Repositories removed outright, whatever the graph says about them. */
  excluded: Set<string>;
}

/** One repository in the cohort, with the owners it is reported under. */
export interface CohortEntry {
  repository: string;
  /** Every owning team, in reporting order. Exactly `[UnownedIdentifier]` where nothing owns it. */
  owners: string[];
  archived: boolean;
  visibility: string;
  pushedAt?: Date;
}

/** Raised when the graph has nothing in it, which is a different problem from an estate of zero. */
export class CohortUncollectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CohortUncollectedError";
  }
}

/** Reads the policy out of a configuration, so the selector itself needs no `Configuration`. */
export function cohortPolicy(configuration: Configuration): CohortPolicy {
  const cohort = configuration.cohort;
  return {
    visibilities: new Set(cohort.visibilities.map((visibility) => visibility.toLowerCase())),
    includeArchived: cohort.include_archived,
    ...(cohort.active_within_days === null ? {} : { activeWithinDays: cohort.active_within_days }),
    excluded: new Set(configuration.excluded_repositories)
  };
}

/**
 * Whether a repository was pushed to inside the window.
 *
 * An ABSENT `pushedAt` is not active. GitHub omits it for a repository that has never been pushed to, and the
 * column is null on every row collected before it existed — so treating absence as active would, for one run
 * after the migration, quietly select the entire organisation. Selecting nothing is a visible failure; selecting
 * everything is a 3,277-repository collection nobody asked for.
 */
export function pushedWithin(pushedAt: Date | undefined, days: number, reference: Date): boolean {
  if (pushedAt === undefined) {
    return false;
  }
  return reference.getTime() - pushedAt.getTime() <= days * 24 * 60 * 60 * 1000;
}

/**
 * Which repositories the policy selects, and what each is owned by.
 *
 * Pure, so the whole of cohort selection is testable without Postgres — the two `live*` reads are the only
 * impure part and they happen in `readCohort`.
 *
 * THE ORDER IS (OWNER, REPOSITORY) AND THAT IS LOAD-BEARING. It reproduces exactly what the file-era
 * `ownedRepositories` produced, whose comment records that losing the order made two runs undiffable at
 * fourteen repositories. At 1,872 that matters more, not less: a report is read by diffing it against last
 * week's. `localeCompare` rather than the org module's `byCodePoint`, because this is the reporting order the
 * file era established and changing it would reorder every row for no gain.
 */
export function selectCohort(
  repositories: readonly LiveOrgRepository[],
  ownership: readonly LiveRepositoryOwnership[],
  policy: CohortPolicy,
  reference: Date
): CohortEntry[] {
  const owners = new Map<string, string[]>();
  for (const row of ownership) {
    // A `none` row is the ladder's remembered negative, and it is what puts the repository in the unowned
    // bucket rather than leaving it with an empty owner list that later code would have to interpret.
    const identifier = row.ownerKind === OwnerKind.None ? UnownedIdentifier : row.owner;
    const existing = owners.get(row.repository);
    if (existing === undefined) {
      owners.set(row.repository, [identifier]);
    } else if (!existing.includes(identifier)) {
      existing.push(identifier);
    }
  }

  const selected = repositories.filter((repository) => {
    if (policy.excluded.has(repository.repository)) {
      return false;
    }
    if (repository.archived && !policy.includeArchived) {
      return false;
    }
    // CASEFOLDED ON BOTH SIDES, and that is not defensive — the two sides genuinely disagree. GraphQL answers
    // its enum in capitals and the graph stores it verbatim: measured on this estate, `org_repositories` holds
    // `PUBLIC` 1,887 times, `PRIVATE` 962 and `INTERNAL` 547, and not one lower-case row. The configuration
    // enum is lower-case because that is what somebody writes in YAML. Compared as stored, the policy would
    // select nothing and the cohort would look like an uncollected graph.
    if (!policy.visibilities.has(repository.visibility.toLowerCase())) {
      return false;
    }
    return policy.activeWithinDays === undefined || pushedWithin(repository.pushedAt, policy.activeWithinDays, reference);
  });

  const entries = selected.map((repository) => ({
    repository: repository.repository,
    // A selected repository with no ownership row at all is unowned, not ownerless. The ladder writes a `none`
    // row for every repository it walks, so this is the case where the two tables disagree — a repository
    // collected after the last attribution — and it belongs in the estate rather than being dropped from it.
    owners: (owners.get(repository.repository) ?? [UnownedIdentifier]).slice().sort((left, right) => left.localeCompare(right)),
    archived: repository.archived,
    visibility: repository.visibility,
    ...(repository.pushedAt === undefined ? {} : { pushedAt: repository.pushedAt })
  }));

  return entries.sort((left, right) => {
    // `owners` is never empty by construction, but the fallback is stated rather than asserted away: if it ever
    // were, sorting under the bucket the entry would be reported in beats throwing inside a comparator.
    const leftOwner = left.owners[0] ?? UnownedIdentifier;
    const rightOwner = right.owners[0] ?? UnownedIdentifier;
    return leftOwner.localeCompare(rightOwner) || left.repository.localeCompare(right.repository);
  });
}

/**
 * The cohort as the graph currently has it.
 *
 * Throws `CohortUncollectedError` on an EMPTY GRAPH, and that is the point rather than defensiveness. `collect`
 * now depends on `collect-org` having run — the chart sequences them 14:00 then 15:00 — so on a fresh database
 * the honest answer is "no graph has been collected", not an estate of zero repositories. The second reads as
 * a successful run of an organisation that owns nothing, which is the failure that would go unnoticed for a
 * week.
 *
 * A graph that IS collected but which the policy empties is a different message, because it is a different
 * mistake: somebody narrowed `visibilities` or `active_within_days` too far, and the fix is in the file.
 */
export async function readCohort(configuration: Configuration, reference = new Date()): Promise<CohortEntry[]> {
  const policy = cohortPolicy(configuration);
  const [repositories, ownership] = await Promise.all([liveOrgRepositories(configuration.organization), liveRepositoryOwnership(configuration.organization)]);

  if (repositories.length === 0) {
    throw new CohortUncollectedError(
      `no organisation graph has been collected for ${configuration.organization}: run \`collect-org\` before anything that reports the cohort`
    );
  }

  const entries = selectCohort(repositories, ownership, policy, reference);
  if (entries.length === 0) {
    throw new CohortUncollectedError(
      `the graph holds ${repositories.length} repositories for ${configuration.organization} but the cohort policy selects none of them:` +
        ` widen cohort.visibilities, cohort.active_within_days or cohort.include_archived`
    );
  }
  return entries;
}

/**
 * Every repository in the cohort ONCE, in the reporting order.
 *
 * Deduplication is not needed here the way it was in the file era — `selectCohort` emits one entry per
 * repository — but the ordering is, and stating it in one place is what keeps `runCollect` and `repositoryRows`
 * walking the same estate in the same sequence.
 */
export async function cohortRepositories(configuration: Configuration, reference = new Date()): Promise<string[]> {
  return (await readCohort(configuration, reference)).map((entry) => entry.repository);
}

/** Each cohort repository mapped to the identifiers of the teams that own it, in reporting order. */
export async function cohortOwners(configuration: Configuration, reference = new Date()): Promise<Map<string, string[]>> {
  return new Map((await readCohort(configuration, reference)).map((entry) => [entry.repository, entry.owners]));
}

/**
 * Every team the cohort is reported under, in reporting order, `unowned` last.
 *
 * Derived from the cohort rather than from the file, which no longer lists teams. `unowned` sorts last because
 * it is a bucket rather than a team, and a reader scanning team cards wants the real ones first.
 */
export function cohortTeams(entries: readonly CohortEntry[]): string[] {
  const teams = new Set<string>();
  for (const entry of entries) {
    for (const owner of entry.owners) {
      teams.add(owner);
    }
  }
  return [...teams].sort((left, right) => {
    if (left === UnownedIdentifier || right === UnownedIdentifier) {
      return left === UnownedIdentifier ? 1 : -1;
    }
    return left.localeCompare(right);
  });
}
