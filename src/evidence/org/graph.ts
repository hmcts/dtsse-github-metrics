/**
 * The organisation graph: who the teams are, who is in them, and what they own.
 *
 * Ported from `scripts/build_team_configuration.py` in `hmcts/github-metrics`, which was left behind when the
 * collector was rewritten. That script wrote the `teams:` block of a configuration file and exited; this
 * module collects the same evidence into Postgres, so ownership is answerable continuously rather than
 * whenever somebody last ran a script and pasted the output.
 *
 * ATTRIBUTION IS BEST EFFORT AND SOME OF IT IS WRONG, and that sentence is carried over from the generated
 * file's own header rather than softened. `teamsApiAdmin` and `teamsApiWrite` read GitHub team ACCESS, which
 * says who CAN merge; `codeownersSole` and `codeownersFirst` read who is EXPECTED to review. Neither is a
 * declaration of ownership, because GitHub has no field for one. Every row therefore carries the rung that
 * produced it, so a reader can weigh the answer instead of trusting it.
 */

/**
 * A team's access to a repository, strongest first.
 *
 * The order IS the semantics: `mostPermissiveAccess` and `mostSpecificClaim` both index into this tuple, so
 * reordering it silently reverses which claim wins.
 */
export const AccessLevels = ["admin", "maintain", "push", "triage", "pull"] as const;

export type AccessLevel = (typeof AccessLevels)[number];

/**
 * The access levels that count as ownership.
 *
 * Ownership is a write-or-better relationship. Read access only says a team may look, which platform and
 * security teams hold across a whole organisation, and counting it would drown every specific claim in the
 * same handful of org-wide handles.
 */
export const OwningAccessLevels: readonly AccessLevel[] = ["admin", "maintain", "push"];

/**
 * Which rung of the ladder attributed a repository, in precedence order.
 *
 * A sole `admin` team outranks CODEOWNERS, but a sole CODEOWNERS team outranks any contested API claim:
 * where the two disagree, the less ambiguous of them is the better guess.
 *
 * `codeownersPerson` and `directCollaborator` are NEW here and have no counterpart in the Python script,
 * which had no concept of a repository owned by a person. They sit below every team rung deliberately — an
 * individual owner is the outlier the ladder falls back to, never a competitor to a team.
 */
export const OwnershipRung = {
  /** A reviewed `metrics.yaml` entry. An override short-circuits every collected rung. */
  Configured: "configured",
  /** Exactly one GitHub team holds `admin`: the closest thing to a declared owner the API has. */
  TeamsApiAdmin: "teams-api-admin",
  /** CODEOWNERS names exactly one team, so there is nothing to choose between. */
  CodeownersSole: "codeowners-sole",
  /** Several teams hold write-or-better; most permissive wins, ties to the smallest team. */
  TeamsApiWrite: "teams-api-write",
  /** CODEOWNERS names several teams; the one owning fewest wins, then alphabetical order. */
  CodeownersFirst: "codeowners-first",
  /** A bare `@login` in CODEOWNERS, once no team rung has answered. */
  CodeownersPerson: "codeowners-person",
  /** A direct collaborator holding admin, once CODEOWNERS names nobody. */
  DirectCollaborator: "direct-collaborator-admin",
  /** The name shares a family prefix with repositories the evidenced rungs agreed on. */
  NamePrefix: "name-prefix",
  /** No rung answered. A normal outcome, and not a failure. */
  Unowned: "unowned"
} as const;

export type OwnershipRung = (typeof OwnershipRung)[keyof typeof OwnershipRung];

/** Every rung in precedence order, so a report reads as the order it describes. */
export const RungOrder: readonly OwnershipRung[] = [
  OwnershipRung.Configured,
  OwnershipRung.TeamsApiAdmin,
  OwnershipRung.CodeownersSole,
  OwnershipRung.TeamsApiWrite,
  OwnershipRung.CodeownersFirst,
  OwnershipRung.CodeownersPerson,
  OwnershipRung.DirectCollaborator,
  OwnershipRung.NamePrefix,
  OwnershipRung.Unowned
];

/** The rungs decided from evidence alone, before the name pass may run. */
export const EvidenceRungs: readonly OwnershipRung[] = [
  OwnershipRung.Configured,
  OwnershipRung.TeamsApiAdmin,
  OwnershipRung.CodeownersSole,
  OwnershipRung.TeamsApiWrite,
  OwnershipRung.CodeownersFirst,
  OwnershipRung.CodeownersPerson,
  OwnershipRung.DirectCollaborator
];

/** What an owner IS, since a repository may be owned by a team or — the outlier — by a person. */
export const OwnerKind = {
  Team: "team",
  Person: "person",
  /** Nobody. Stored as a row, not as an absence — see `ResolvedOwnership`. */
  None: "none"
} as const;

export type OwnerKind = (typeof OwnerKind)[keyof typeof OwnerKind];

/** One GitHub team, as the organisation listed it. */
export interface TeamFact {
  slug: string;
  name: string;
  description?: string;
  privacy?: string;
  /** Teams nest, and a child's repositories are the child's. Read `parentSlug` before rolling anything up. */
  parentSlug?: string;
}

/** One person's membership of one team. */
export interface TeamMembershipFact {
  teamSlug: string;
  login: string;
  /** `MEMBER` or `MAINTAINER`, as GitHub words it. */
  role: string;
}

/** One team's access to one repository. */
export interface TeamRepositoryFact {
  teamSlug: string;
  repository: string;
  access: AccessLevel;
}

/** One repository the organisation owns, whether any team holds it or not. */
export interface RepositoryFact {
  name: string;
  archived: boolean;
  visibility: string;
  isFork: boolean;
  defaultBranch?: string;
  pushedAt?: Date;
}

/**
 * One organisation member.
 *
 * `name`, `email` and `company` are all SELF-REPORTED and frequently blank, and `email` is the account's
 * PUBLIC email rather than a work address. None of the three is an identity; the login is.
 */
export interface PersonFact {
  login: string;
  /** `ADMIN` or `MEMBER`. An owner reads differently from a member on every row. */
  role: string;
  name?: string;
  email?: string;
  company?: string;
}

/**
 * What one repository's CODEOWNERS files named, or why nobody could look.
 *
 * A file that is absent and a file that was refused are DIFFERENT ANSWERS and are kept apart: reporting the
 * second as the first would claim a repository names no owner when in fact nobody was allowed to ask.
 * `refusal` set means unread; `teams`/`people` empty with no `refusal` means read and naming nobody.
 */
export interface CodeownersFact {
  repository: string;
  /** Team handles with the organisation's own prefix dropped; a foreign org keeps its `owner/team` form. */
  teams: string[];
  /** Bare `@login` handles. A person is not a team, and the ladder treats them differently. */
  people: string[];
  /** The paths that were found, for the `detail` a stored row carries. */
  paths: string[];
  refusal?: string;
}

/**
 * Everything collected, before anything is decided.
 *
 * `teamsRead` is kept separate from an empty `teams` so that a token which was not permitted to list teams
 * is never reported as an organisation whose teams claim nothing — the two look identical downstream and
 * mean opposite things.
 *
 * `knownTeams` holds EVERY team the organisation listed, not only those holding access somewhere: it is the
 * authority a handle read out of a CODEOWNERS file is checked against, and a team that administers nothing
 * still exists.
 */
export interface OrgFacts {
  organization: string;
  teamsRead: boolean;
  knownTeams: Set<string>;
  teams: TeamFact[];
  memberships: TeamMembershipFact[];
  teamRepositories: TeamRepositoryFact[];
  repositories: RepositoryFact[];
  people: PersonFact[];
  codeowners: Map<string, CodeownersFact>;
  /** Direct collaborators holding admin, keyed by repository. Only fetched for what CODEOWNERS left open. */
  directAdmins: Map<string, string[]>;
}

/** One owner of one repository, and which rung said so. */
export interface ResolvedOwner {
  kind: OwnerKind;
  /** A team slug, a login, or `""` when `kind` is `none`. */
  owner: string;
  rung: OwnershipRung;
  /** Why this rung answered — the access level, the CODEOWNERS path, the prefix and its support. */
  detail: string;
}

/**
 * One repository and every owner resolved for it.
 *
 * `owners` is NEVER EMPTY. A repository nothing owns carries one owner of kind `none`, whose `detail` names
 * the rungs that were walked — a remembered negative in the sense `sonar_project_map` uses the phrase. Two
 * reasons: "how many repositories does nobody own" becomes one count rather than a set difference somebody
 * has to remember to compute, and "nothing owns it" stays distinguishable from "we never looked".
 *
 * Several owners is the normal case, not an exception: a repository with two `admin` teams has two owners,
 * and collapsing that to one would invent a tie-break nobody made. `primary` names the one that leads, so
 * per-team reporting has a stable answer without the set pretending to be a scalar.
 */
export interface ResolvedOwnership {
  repository: string;
  owners: ResolvedOwner[];
  /** The first owner in reporting order. A stated convention, not a claim that there is only one. */
  primary: ResolvedOwner;
}

/** How far the name-prefix pass may reach, and which handles are not owners. */
export interface OwnershipOptions {
  /** Attributed repositories a prefix needs before it may attribute others. */
  prefixSupport: number;
  /** Proportion of a prefix that must agree on one team, 0 to 1. */
  prefixDominance: number;
  /** Above this share of the estate, a team holds access administratively and is not read as a claim. */
  maximumTeamShare: number;
  /** Above this many members, a team is a population rather than an owner. */
  maximumTeamMembers: number;
  /** Handles that are not teams in the sense this file means, by identity rather than by size. */
  excludedTeams: Set<string>;
  /** Reviewed `metrics.yaml` ownership, which outranks every collected rung. */
  configured: Map<string, string[]>;
}

/**
 * How many leading hyphen-separated segments of a repository name may stand as a prefix.
 *
 * Three reaches `api-cp-crime` without reaching whole names, which match nothing but themselves.
 */
export const MaximumPrefixSegments = 3;

/** A one- or two-character prefix is an accident of naming rather than a family. */
export const MinimumPrefixLength = 3;

export const DefaultPrefixSupport = 3;
export const DefaultPrefixDominance = 0.8;

/**
 * A quarter of an organisation is far past any team that could be said to own what it holds.
 *
 * On an estate of 3,277 repositories that is over 800, which no service team reaches.
 */
export const DefaultMaximumTeamShare = 0.25;

/**
 * Handles that are not teams in the sense this file means.
 *
 * `all-org-members` is every member of the organisation, so attributing a repository to it says only that
 * the repository is in the organisation — which the graph already says by listing it. Excluded by identity
 * rather than by size because it would still be the wrong answer if it held two repositories: no threshold
 * makes an org-wide membership group into an owner.
 */
export const DefaultExcludedTeams: readonly string[] = ["all-org-members"];

/**
 * Above how many members a team is read as a population rather than as an owner.
 *
 * The third filter, and it answers a question neither of the others can. `excludedTeams` catches a population
 * BY NAME, which only works for the ones somebody thought to name; `maximumTeamShare` catches a team holding
 * access across the estate, which misses a large team holding a normal number of repositories. An
 * "all developers" group is neither: it is a coherent set of repositories held by a team that is really the
 * whole engineering department, and its size is the only thing that gives it away.
 *
 * MEASURED ON THIS ESTATE, which is why the number is 100 and not the 50 first proposed. Only eight of 336
 * teams hold more than 50 immediate members, and half of those are ordinary product teams that are simply
 * large — `opal` at 69 members and 24 repositories, `possession-claim-service` at 65 and 8,
 * `enforcement-service` at 57 and 2. A ceiling of 50 would disown about 44 repositories that have a perfectly
 * good owning team. The distribution then jumps from 92 to 217, and everything above that gap is a population
 * or a blanket grant: `all-org-members` at 757 and `cpp-development` at 217, whose 318 repositories come from
 * one Terraform `for_each` granting `maintain` across every CPP repository.
 *
 * Counted over IMMEDIATE membership, matching what is collected and stored. A parent team's descendants are
 * not folded in, because the access being weighed was granted to the team named, not to its subtree.
 */
export const DefaultMaximumTeamMembers = 100;

/**
 * CODEOWNERS handles that are not people, however they are written.
 *
 * Measured on this estate: `@global-owner1` and `@global-owner2` appear 18 times across 97 CODEOWNERS files,
 * copied verbatim out of GitHub's own documentation. They are the single most common "individual owner" in
 * the estate and neither is a person, so left in they would be the ladder's most confident wrong answer.
 */
export const PlaceholderLogins: readonly string[] = ["global-owner1", "global-owner2"];

/**
 * Where CODEOWNERS may live, in the order GitHub itself resolves them.
 *
 * `docs/` is GitHub's third location and is included for completeness; the Python script read only the first
 * two, so a repository owning its file there was previously invisible.
 */
export const CodeownersPaths: readonly string[] = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];

/**
 * Fold a team handle to the slug GitHub itself resolves it to, which is lower case.
 *
 * GitHub team slugs are case-insensitive, and the two sources disagree about case: the teams API returns
 * `appreg`, while CODEOWNERS returns whatever the author typed — `@hmcts/AppReg`. Grouped as written, one
 * team is emitted twice under two identifiers, each holding part of its estate, which is both wrong and hard
 * to see at this scale. Folding here rather than at either source keeps the collected facts faithful to what
 * was fetched.
 *
 * This is the same rule `contributorLogins` applies to logins in `behaviour/analysis.ts` — one definition of
 * "the same handle" for the whole codebase.
 */
export function canonical(handle: string): string {
  return handle.toLowerCase();
}

/** Keep the higher of two access levels, for a team that arrived twice under different case. */
export function mostPermissiveAccess(existing: AccessLevel | undefined, access: AccessLevel): AccessLevel {
  if (existing === undefined) {
    return access;
  }
  return AccessLevels.indexOf(existing) <= AccessLevels.indexOf(access) ? existing : access;
}

/** Whether an access level is ownership rather than permission to look. */
export function isOwningAccess(access: string): access is AccessLevel {
  return (OwningAccessLevels as readonly string[]).includes(access);
}
