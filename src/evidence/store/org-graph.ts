import { createHash } from "node:crypto";
import type { PersonFact, RepositoryFact, ResolvedOwnership, TeamFact, TeamMembershipFact, TeamRepositoryFact } from "../org/graph.ts";
import type { JsonValue } from "./facts.ts";
import { prisma } from "./prisma.ts";
import { StorageError } from "./storage-error.ts";

/**
 * Writing and reading the organisation graph, which is CHANGE-VERSIONED rather than replaced.
 *
 * `repository-state.ts` replaces its row on every collection because a merge gate has no history worth
 * keeping — the current setting is the whole answer. The graph is the opposite case, for the reason
 * `alert_observations` and `prune.ts` already give: GitHub serves only the present. A membership deleted
 * this morning cannot be asked about again, so nobody will ever be able to ask GitHub who was in
 * `civil-admins` last June. Overwriting is therefore not a cheaper way to store the same thing; it is
 * throwing away the only copy.
 *
 * It is NOT a snapshot per run either. Each row spans `[observedAt, supersededAt)`, and a run that sees a
 * fact unchanged moves `lastObservedAt` and writes no row at all — which is what makes weekly collection
 * of 336 teams and 3,277 repositories affordable to keep for ever. `digest` is what makes "unchanged" one
 * comparison rather than a field-by-field diff of a jsonb document.
 *
 * Every writer here is one `$transaction` implementing the same three-way reconcile, and the reconcile is
 * driven by A SINGLE READ of the live rows for that organisation — see `planGraphWrite`.
 */

/** What one reconcile did, so a run can report what it actually changed rather than that it ran. */
export interface GraphWriteSummary {
  /** Keys that were not live, now inserted. */
  inserted: number;
  /** Keys live with the same digest. Only `lastObservedAt` moved. */
  unchanged: number;
  /** Keys live with a different digest: the old row was closed and a new one opened. */
  changed: number;
  /**
   * Keys live but absent from this run's facts, now closed.
   *
   * A CHANGED key is counted under `changed` alone even though a row of its was closed too: it did not
   * disappear, and reporting it as both would make a rename look like a departure and an arrival.
   */
  superseded: number;
}

/** One row's identity beyond `organization`, paired with the hash of everything that may vary under it. */
export interface GraphCandidate<Key> {
  key: Key;
  digest: string;
}

/** The three statements one reconcile resolves to, and what they add up to. */
export interface GraphWritePlan<Key, Candidate> {
  /** New keys and the new versions of changed ones. Runs AFTER `toClose`, or the live index rejects it. */
  toInsert: Candidate[];
  /** Live keys whose digest matched: `lastObservedAt` and nothing else. */
  toTouch: Key[];
  /** Live keys to stamp `supersededAt` on — the changed ones plus, when `complete`, the absent ones. */
  toClose: Key[];
  summary: GraphWriteSummary;
}

/**
 * Decides the reconcile from one read of the live rows. Pure, so the decision is testable without Postgres.
 *
 * `complete` IS THE WHOLE SAFETY OF THIS FUNCTION, and it is the same argument `facts.ts` makes for why
 * writing facts and recording coverage are one operation. The "live but absent from this run" branch reads
 * an absence as a deletion, which is only true if the run saw everything there was to see. A collection
 * that fetched half the teams before its token was rate-limited must write the half it saw and supersede
 * NOTHING: read the other way round, one failed run closes the entire graph, and since GitHub serves only
 * the present, re-running does not restore the intervals it wrongly ended — it opens new ones.
 *
 * Candidates are deduplicated on identity, keeping the first. Two candidates for one key would otherwise
 * violate the live unique index, and choosing between them is the collector's decision — `canonical` folds
 * the handles and `mostPermissiveAccess` picks the level — not the store's. Merging here would quietly
 * make a second decision after the first one had been taken.
 *
 * Callers join a composite key's parts with a NUL, WRITTEN AS THE `\u0000` ESCAPE AND NEVER AS A LITERAL.
 * A NUL cannot occur in a team slug, a login or a repository name, so it is the one separator that cannot
 * collide with the data — where a hyphen would make `a-b`/`c` and `a`/`b-c` the same key. Written literally
 * it also makes this file binary to git and grep, which costs every later reviewer the diff.
 */
export function planGraphWrite<Key, Candidate extends GraphCandidate<Key>>(
  live: readonly GraphCandidate<Key>[],
  candidates: readonly Candidate[],
  identityOf: (key: Key) => string,
  complete: boolean
): GraphWritePlan<Key, Candidate> {
  const liveByIdentity = new Map(live.map((row) => [identityOf(row.key), row.digest]));
  const seen = new Set<string>();
  const toInsert: Candidate[] = [];
  const toTouch: Key[] = [];
  const toClose: Key[] = [];
  let inserted = 0;
  let changed = 0;

  for (const candidate of candidates) {
    const identity = identityOf(candidate.key);
    if (seen.has(identity)) {
      continue;
    }
    seen.add(identity);
    const liveDigest = liveByIdentity.get(identity);
    if (liveDigest === undefined) {
      toInsert.push(candidate);
      inserted += 1;
    } else if (liveDigest === candidate.digest) {
      toTouch.push(candidate.key);
    } else {
      toClose.push(candidate.key);
      toInsert.push(candidate);
      changed += 1;
    }
  }

  const absent = complete ? live.filter((row) => !seen.has(identityOf(row.key))).map((row) => row.key) : [];
  toClose.push(...absent);

  return { toInsert, toTouch, toClose, summary: { inserted, unchanged: toTouch.length, changed, superseded: absent.length } };
}

/**
 * A short hash of everything that may change without the identity changing.
 *
 * Sixteen hex characters over a key-sorted serialisation, matching `querySignature()`'s precedent in
 * behaviour/queries.ts — long enough that a collision across an estate this size is not a thing that
 * happens, short enough to read in a row. Sorting the keys is what makes it stable: an object built in a
 * different field order is the same fact, and hashing `JSON.stringify` output directly would supersede
 * every row the day somebody reorders a literal.
 *
 * Absent and `undefined` fields hash identically, because they mean the same thing here — GitHub omits an
 * empty description rather than sending an empty one, and the two arrive from different code paths.
 */
export function digestOf(content: unknown): string {
  return createHash("sha256").update(stableJson(content)).digest("hex").slice(0, 16);
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, raw) => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return raw;
    }
    const entries = Object.entries(raw as Record<string, unknown>).filter(([, field]) => field !== undefined);
    entries.sort((left, right) => (left[0] < right[0] ? -1 : 1));
    return Object.fromEntries(entries);
  });
}

/** Drops absent fields, so what is stored says nothing about a value GitHub never sent. */
function payloadOf(content: Record<string, JsonValue | undefined>): { [key: string]: JsonValue } {
  const kept: { [key: string]: JsonValue } = {};
  for (const [field, value] of Object.entries(content)) {
    if (value !== undefined) {
      kept[field] = value;
    }
  }
  return kept;
}

/**
 * Records the organisation's teams.
 *
 * `parentSlug` is versioned along with the rest: a team moved under a different parent is a different fact
 * about ownership rollup, not a detail of the old one.
 */
export async function recordOrgTeams(organization: string, observedAt: Date, facts: readonly TeamFact[], complete: boolean): Promise<GraphWriteSummary> {
  try {
    return await prisma.$transaction(async (tx) => {
      const live = await tx.orgTeam.findMany({ where: { organization, supersededAt: null }, select: { teamSlug: true, digest: true } });
      const plan = planGraphWrite(
        live.map((row) => ({ key: { teamSlug: row.teamSlug }, digest: row.digest })),
        facts.map((fact) => ({
          key: { teamSlug: fact.slug },
          digest: digestOf({ parentSlug: fact.parentSlug, name: fact.name, description: fact.description, privacy: fact.privacy }),
          fact
        })),
        (key) => key.teamSlug,
        complete
      );
      if (plan.toClose.length > 0) {
        await tx.orgTeam.updateMany({ where: { organization, supersededAt: null, OR: plan.toClose }, data: { supersededAt: observedAt } });
      }
      if (plan.toInsert.length > 0) {
        await tx.orgTeam.createMany({
          data: plan.toInsert.map((candidate) => ({
            organization,
            teamSlug: candidate.key.teamSlug,
            parentSlug: candidate.fact.parentSlug,
            payload: payloadOf({ name: candidate.fact.name, description: candidate.fact.description, privacy: candidate.fact.privacy }),
            observedAt,
            lastObservedAt: observedAt,
            digest: candidate.digest
          }))
        });
      }
      if (plan.toTouch.length > 0) {
        await tx.orgTeam.updateMany({ where: { organization, supersededAt: null, OR: plan.toTouch }, data: { lastObservedAt: observedAt } });
      }
      return plan.summary;
    });
  } catch (error) {
    throw new StorageError("could not update the organisation graph", error);
  }
}

/**
 * Records who is in which team.
 *
 * COLLECTED WITH `membership: IMMEDIATE`, and the facts handed here must be too. GitHub's default of `ALL`
 * folds every descendant team's people into the parent, which across 336 nested teams makes a parent look
 * as though it employs its whole subtree, and turns "which teams is this person in" into the ancestry of
 * the one team they actually joined. That rollup is a DERIVATION a reader may compute by walking
 * `OrgTeam.parentSlug`; it is not a fact, and storing it would record an edge nobody ever made.
 */
export async function recordOrgTeamMemberships(
  organization: string,
  observedAt: Date,
  facts: readonly TeamMembershipFact[],
  complete: boolean
): Promise<GraphWriteSummary> {
  try {
    return await prisma.$transaction(async (tx) => {
      const live = await tx.orgTeamMembership.findMany({
        where: { organization, supersededAt: null },
        select: { teamSlug: true, login: true, digest: true }
      });
      const plan = planGraphWrite(
        live.map((row) => ({ key: { teamSlug: row.teamSlug, login: row.login }, digest: row.digest })),
        facts.map((fact) => ({
          key: { teamSlug: fact.teamSlug, login: fact.login },
          digest: digestOf({ role: fact.role }),
          fact
        })),
        (key) => `${key.teamSlug}\u0000${key.login}`,
        complete
      );
      if (plan.toClose.length > 0) {
        await tx.orgTeamMembership.updateMany({ where: { organization, supersededAt: null, OR: plan.toClose }, data: { supersededAt: observedAt } });
      }
      if (plan.toInsert.length > 0) {
        await tx.orgTeamMembership.createMany({
          data: plan.toInsert.map((candidate) => ({
            organization,
            teamSlug: candidate.key.teamSlug,
            login: candidate.key.login,
            role: candidate.fact.role,
            observedAt,
            lastObservedAt: observedAt,
            digest: candidate.digest
          }))
        });
      }
      if (plan.toTouch.length > 0) {
        await tx.orgTeamMembership.updateMany({ where: { organization, supersededAt: null, OR: plan.toTouch }, data: { lastObservedAt: observedAt } });
      }
      return plan.summary;
    });
  } catch (error) {
    throw new StorageError("could not update the organisation graph", error);
  }
}

/**
 * Records which teams hold which repositories, at what access level.
 *
 * The access level is versioned rather than kept only in the digest because it is the first rungs of the
 * ownership ladder — `admin` and `maintain` are ownership, `push` is contested — and a team demoted from
 * `admin` to `pull` is the drift somebody wants to be able to read afterwards.
 */
export async function recordOrgTeamRepositories(
  organization: string,
  observedAt: Date,
  facts: readonly TeamRepositoryFact[],
  complete: boolean
): Promise<GraphWriteSummary> {
  try {
    return await prisma.$transaction(async (tx) => {
      const live = await tx.orgTeamRepository.findMany({
        where: { organization, supersededAt: null },
        select: { teamSlug: true, repository: true, digest: true }
      });
      const plan = planGraphWrite(
        live.map((row) => ({ key: { teamSlug: row.teamSlug, repository: row.repository }, digest: row.digest })),
        facts.map((fact) => ({
          key: { teamSlug: fact.teamSlug, repository: fact.repository },
          digest: digestOf({ permission: fact.access }),
          fact
        })),
        (key) => `${key.teamSlug}\u0000${key.repository}`,
        complete
      );
      if (plan.toClose.length > 0) {
        await tx.orgTeamRepository.updateMany({ where: { organization, supersededAt: null, OR: plan.toClose }, data: { supersededAt: observedAt } });
      }
      if (plan.toInsert.length > 0) {
        await tx.orgTeamRepository.createMany({
          data: plan.toInsert.map((candidate) => ({
            organization,
            teamSlug: candidate.key.teamSlug,
            repository: candidate.key.repository,
            permission: candidate.fact.access,
            observedAt,
            lastObservedAt: observedAt,
            digest: candidate.digest
          }))
        });
      }
      if (plan.toTouch.length > 0) {
        await tx.orgTeamRepository.updateMany({ where: { organization, supersededAt: null, OR: plan.toTouch }, data: { lastObservedAt: observedAt } });
      }
      return plan.summary;
    });
  } catch (error) {
    throw new StorageError("could not update the organisation graph", error);
  }
}

/**
 * Records every repository the organisation holds, which is what makes "unowned" answerable at all.
 *
 * `pushedAt` IS DELIBERATELY NOT STORED, though `RepositoryFact` carries it. It moves on every push, so
 * versioning on it would supersede and re-insert every active repository in the estate weekly — which
 * turns a change history into the snapshot series this table exists not to be, for a value that is current
 * state and already has a home in `repository_state`.
 */
export async function recordOrgRepositories(
  organization: string,
  observedAt: Date,
  facts: readonly RepositoryFact[],
  complete: boolean
): Promise<GraphWriteSummary> {
  try {
    return await prisma.$transaction(async (tx) => {
      const live = await tx.orgRepository.findMany({ where: { organization, supersededAt: null }, select: { repository: true, digest: true } });
      const plan = planGraphWrite(
        live.map((row) => ({ key: { repository: row.repository }, digest: row.digest })),
        facts.map((fact) => ({
          key: { repository: fact.name },
          digest: digestOf({ archived: fact.archived, visibility: fact.visibility, isFork: fact.isFork, defaultBranch: fact.defaultBranch }),
          fact
        })),
        (key) => key.repository,
        complete
      );
      if (plan.toClose.length > 0) {
        await tx.orgRepository.updateMany({ where: { organization, supersededAt: null, OR: plan.toClose }, data: { supersededAt: observedAt } });
      }
      if (plan.toInsert.length > 0) {
        await tx.orgRepository.createMany({
          data: plan.toInsert.map((candidate) => ({
            organization,
            repository: candidate.key.repository,
            archived: candidate.fact.archived,
            visibility: candidate.fact.visibility,
            payload: payloadOf({ isFork: candidate.fact.isFork, defaultBranch: candidate.fact.defaultBranch }),
            observedAt,
            lastObservedAt: observedAt,
            digest: candidate.digest
          }))
        });
      }
      if (plan.toTouch.length > 0) {
        await tx.orgRepository.updateMany({ where: { organization, supersededAt: null, OR: plan.toTouch }, data: { lastObservedAt: observedAt } });
      }
      return plan.summary;
    });
  } catch (error) {
    throw new StorageError("could not update the organisation graph", error);
  }
}

/**
 * Records the organisation's members.
 *
 * A superseded row here is a person who has LEFT THE ORGANISATION, which is the fact the login alone
 * cannot carry: the GitHub account still exists, and asking GitHub about it later says nothing about when
 * their membership ended.
 */
export async function recordOrgPeople(organization: string, observedAt: Date, facts: readonly PersonFact[], complete: boolean): Promise<GraphWriteSummary> {
  try {
    return await prisma.$transaction(async (tx) => {
      const live = await tx.orgPerson.findMany({ where: { organization, supersededAt: null }, select: { login: true, digest: true } });
      const plan = planGraphWrite(
        live.map((row) => ({ key: { login: row.login }, digest: row.digest })),
        facts.map((fact) => ({
          key: { login: fact.login },
          digest: digestOf({ role: fact.role, name: fact.name, email: fact.email, company: fact.company }),
          fact
        })),
        (key) => key.login,
        complete
      );
      if (plan.toClose.length > 0) {
        await tx.orgPerson.updateMany({ where: { organization, supersededAt: null, OR: plan.toClose }, data: { supersededAt: observedAt } });
      }
      if (plan.toInsert.length > 0) {
        await tx.orgPerson.createMany({
          data: plan.toInsert.map((candidate) => ({
            organization,
            login: candidate.key.login,
            role: candidate.fact.role,
            payload: payloadOf({ name: candidate.fact.name, email: candidate.fact.email, company: candidate.fact.company }),
            observedAt,
            lastObservedAt: observedAt,
            digest: candidate.digest
          }))
        });
      }
      if (plan.toTouch.length > 0) {
        await tx.orgPerson.updateMany({ where: { organization, supersededAt: null, OR: plan.toTouch }, data: { lastObservedAt: observedAt } });
      }
      return plan.summary;
    });
  } catch (error) {
    throw new StorageError("could not update the organisation graph", error);
  }
}

/**
 * Records what the ownership ladder decided, one row per owner.
 *
 * `ResolvedOwnership.owners` is never empty, so a repository nothing owns arrives here as a row of kind
 * `none` — a REMEMBERED NEGATIVE in the sense `sonar_project_map` uses the phrase. Flattening the set to
 * rows is what makes "how many repositories does nobody own" one `COUNT` rather than a set difference
 * somebody has to remember to compute.
 *
 * `primary` is written onto each row rather than left to be recomputed: it is a property of the SET, and a
 * reader that has selected one owner of a repository would otherwise have to fetch its siblings to learn
 * whether the row it is holding is the one that leads.
 */
export async function recordRepositoryOwnership(
  organization: string,
  observedAt: Date,
  resolved: readonly ResolvedOwnership[],
  complete: boolean
): Promise<GraphWriteSummary> {
  const candidates = resolved.flatMap((repository) =>
    repository.owners.map((owner) => {
      const primary = owner.kind === repository.primary.kind && owner.owner === repository.primary.owner;
      return {
        key: { repository: repository.repository, ownerKind: owner.kind as string, owner: owner.owner },
        digest: digestOf({ rung: owner.rung, detail: owner.detail, primary }),
        rung: owner.rung as string,
        detail: owner.detail,
        primary
      };
    })
  );
  try {
    return await prisma.$transaction(async (tx) => {
      const live = await tx.repositoryOwnership.findMany({
        where: { organization, supersededAt: null },
        select: { repository: true, ownerKind: true, owner: true, digest: true }
      });
      const plan = planGraphWrite(
        live.map((row) => ({ key: { repository: row.repository, ownerKind: row.ownerKind, owner: row.owner }, digest: row.digest })),
        candidates,
        (key) => `${key.repository}\u0000${key.ownerKind}\u0000${key.owner}`,
        complete
      );
      if (plan.toClose.length > 0) {
        await tx.repositoryOwnership.updateMany({ where: { organization, supersededAt: null, OR: plan.toClose }, data: { supersededAt: observedAt } });
      }
      if (plan.toInsert.length > 0) {
        await tx.repositoryOwnership.createMany({
          data: plan.toInsert.map((candidate) => ({
            organization,
            repository: candidate.key.repository,
            ownerKind: candidate.key.ownerKind,
            owner: candidate.key.owner,
            rung: candidate.rung,
            payload: payloadOf({ detail: candidate.detail, primary: candidate.primary }),
            observedAt,
            lastObservedAt: observedAt,
            digest: candidate.digest
          }))
        });
      }
      if (plan.toTouch.length > 0) {
        await tx.repositoryOwnership.updateMany({ where: { organization, supersededAt: null, OR: plan.toTouch }, data: { lastObservedAt: observedAt } });
      }
      return plan.summary;
    });
  } catch (error) {
    throw new StorageError("could not update the organisation graph", error);
  }
}

/**
 * The readers.
 *
 * Every one of them is `WHERE superseded_at IS NULL` and nothing else, which is only unambiguous because
 * the partial unique indexes in the org-graph migration guarantee at most one live row per key. Without
 * them each of these would need a `DISTINCT ON` and a tie-break nobody could justify.
 *
 * Each returns a stable order, for the reason `loadCachedPullRequestFacts` gives: two reports of the same
 * database must not differ.
 */

/** Live teams, in slug order. */
export async function liveOrgTeams(organization: string): Promise<LiveOrgTeam[]> {
  try {
    const rows = await prisma.orgTeam.findMany({ where: { organization, supersededAt: null }, orderBy: { teamSlug: "asc" } });
    return rows.map((row) => ({
      teamSlug: row.teamSlug,
      parentSlug: row.parentSlug ?? undefined,
      payload: row.payload,
      observedAt: row.observedAt,
      lastObservedAt: row.lastObservedAt
    }));
  } catch (error) {
    throw new StorageError("could not read the organisation graph", error);
  }
}

/** Live memberships, in team-then-login order. */
export async function liveTeamMemberships(organization: string): Promise<LiveTeamMembership[]> {
  try {
    const rows = await prisma.orgTeamMembership.findMany({
      where: { organization, supersededAt: null },
      orderBy: [{ teamSlug: "asc" }, { login: "asc" }]
    });
    return rows.map((row) => ({
      teamSlug: row.teamSlug,
      login: row.login,
      role: row.role,
      observedAt: row.observedAt,
      lastObservedAt: row.lastObservedAt
    }));
  } catch (error) {
    throw new StorageError("could not read the organisation graph", error);
  }
}

/** Live team access edges, in team-then-repository order. */
export async function liveTeamRepositories(organization: string): Promise<LiveTeamRepository[]> {
  try {
    const rows = await prisma.orgTeamRepository.findMany({
      where: { organization, supersededAt: null },
      orderBy: [{ teamSlug: "asc" }, { repository: "asc" }]
    });
    return rows.map((row) => ({
      teamSlug: row.teamSlug,
      repository: row.repository,
      permission: row.permission,
      observedAt: row.observedAt,
      lastObservedAt: row.lastObservedAt
    }));
  } catch (error) {
    throw new StorageError("could not read the organisation graph", error);
  }
}

/** Live repositories, in name order. The denominator every ownership figure is a share of. */
export async function liveOrgRepositories(organization: string): Promise<LiveOrgRepository[]> {
  try {
    const rows = await prisma.orgRepository.findMany({ where: { organization, supersededAt: null }, orderBy: { repository: "asc" } });
    return rows.map((row) => ({
      repository: row.repository,
      archived: row.archived,
      visibility: row.visibility,
      payload: row.payload,
      observedAt: row.observedAt,
      lastObservedAt: row.lastObservedAt
    }));
  } catch (error) {
    throw new StorageError("could not read the organisation graph", error);
  }
}

/** Live organisation members, in login order. */
export async function liveOrgPeople(organization: string): Promise<LiveOrgPerson[]> {
  try {
    const rows = await prisma.orgPerson.findMany({ where: { organization, supersededAt: null }, orderBy: { login: "asc" } });
    return rows.map((row) => ({
      login: row.login,
      role: row.role,
      payload: row.payload,
      observedAt: row.observedAt,
      lastObservedAt: row.lastObservedAt
    }));
  } catch (error) {
    throw new StorageError("could not read the organisation graph", error);
  }
}

/** Live ownership, in repository-then-owner order. Several rows per repository is the normal case. */
export async function liveRepositoryOwnership(organization: string): Promise<LiveRepositoryOwnership[]> {
  try {
    const rows = await prisma.repositoryOwnership.findMany({
      where: { organization, supersededAt: null },
      orderBy: [{ repository: "asc" }, { ownerKind: "asc" }, { owner: "asc" }]
    });
    return rows.map((row) => ({
      repository: row.repository,
      ownerKind: row.ownerKind,
      owner: row.owner,
      rung: row.rung,
      payload: row.payload,
      observedAt: row.observedAt,
      lastObservedAt: row.lastObservedAt
    }));
  } catch (error) {
    throw new StorageError("could not read the organisation graph", error);
  }
}

/**
 * What a live row carries, beyond the fact itself.
 *
 * `supersededAt` is absent from every one of these by construction — it is null on every row a reader here
 * can see, so returning it would be a column that is always the same. `observedAt` is NOT absent: "in this
 * team since March" is the answer versioning was paid for.
 */
export interface LiveInterval {
  observedAt: Date;
  lastObservedAt: Date;
}

export interface LiveOrgTeam extends LiveInterval {
  teamSlug: string;
  parentSlug?: string;
  payload: unknown;
}

export interface LiveTeamMembership extends LiveInterval {
  teamSlug: string;
  login: string;
  role: string;
}

export interface LiveTeamRepository extends LiveInterval {
  teamSlug: string;
  repository: string;
  permission: string;
}

export interface LiveOrgRepository extends LiveInterval {
  repository: string;
  archived: boolean;
  visibility: string;
  payload: unknown;
}

export interface LiveOrgPerson extends LiveInterval {
  login: string;
  role: string;
  payload: unknown;
}

export interface LiveRepositoryOwnership extends LiveInterval {
  repository: string;
  ownerKind: string;
  owner: string;
  rung: string;
  payload: unknown;
}
