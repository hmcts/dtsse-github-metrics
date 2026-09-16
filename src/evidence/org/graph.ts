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
 *
 * `authoringTeam` is the one rung here that reads something stronger than either: who ACTUALLY MERGES. It
 * sits at the top of the collected rungs for that reason — access and review expectations are both
 * declarations somebody configured once, and authorship is behaviour observed over a window.
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
 * THE CODEOWNERS RUNGS ARE A FALLBACK OF LAST RESORT, above `unowned` and `name-prefix` only. That
 * REVERSES the order this ladder shipped with, where `codeowners-sole` outranked every contested access
 * claim on the argument that a file naming one team is less ambiguous than three teams holding `push`. The
 * argument was about ambiguity and the answer it produced was about staleness: a CODEOWNERS file is a
 * REVIEW ROUTING RULE somebody committed once and nobody revisits, while access is administered
 * continuously and authorship is observed. Where the two disagree, the live signal is now preferred and
 * the committed file answers only when no access rung will.
 *
 * The distinction the old comments drew still holds and is still why the rung exists: access says who CAN
 * merge and CODEOWNERS says who is EXPECTED to review. What changed is which wins when both answer.
 * Measured on AAT, 70 repositories were decided by a CODEOWNERS rung — 31 of them have team access and are
 * now decided by it, and 39 have none at all, which is why the rungs are demoted rather than deleted:
 * removing them would move those 39 to `unowned` and take that bucket from 141 to 180.
 *
 * `codeownersPerson` and `directCollaborator` are NEW here and have no counterpart in the Python script,
 * which had no concept of a repository owned by a person.
 *
 * `directCollaborator` sits ABOVE the CODEOWNERS rungs, which reverses the other half of the old order and
 * is the one placement worth arguing. It names a PERSON, and this ladder's stated rule is that an
 * individual owner is the outlier a ladder falls back to rather than a competitor to a team — so putting
 * one above a named team looks wrong. It is not, on this estate: `admin` granted directly to a login is a
 * grant somebody made to that person for this repository, administered in the same place as team access and
 * revoked when they leave, and it answers 203 repositories. A CODEOWNERS file is neither current nor
 * per-person. The rule the old order encoded — team before person — is preserved where it means something:
 * every rung above this one names a team, so a person only wins once no team's access claims the
 * repository at all.
 */
export const OwnershipRung = {
  /** A reviewed `metrics.yaml` entry. An override short-circuits every collected rung. */
  Configured: "configured",
  /**
   * A team with access whose OWN MEMBERS author the merges in this repository.
   *
   * ABOVE `teams-api-admin` deliberately, and it is the rung that fixed this ladder's largest error.
   * `teams-api-admin` names whoever holds `admin`, and at HMCTS `admin` is granted to an ACCESS
   * ADMINISTRATOR rather than to a delivery team: measured on AAT, 1,346 of 1,846 attributed
   * repositories were decided by that rung, and its largest owners were `platform-operations` (288),
   * `cpp-development-admin` (178), `idam-admins` (139) and `bots` (44). `aac-manage-case-assignment`
   * read `cdm-admin` while `cdm` held `push` and wrote all five of the window's merges;
   * `adoption-cos-api` read `fpl-admins` while `reform-adoption` wrote 23 of its 40.
   *
   * NOT A NAME BLOCKLIST. A `-admin`/`-admins`/`-tl` suffix rule is brittle in both directions: it
   * misses `bots` and `platform-operations`, and it would strip any team legitimately named that way.
   * What separates an administrator from a delivery team is not the slug but whether the people in it
   * merge code here, which is a fact the collector already holds — `pull_request_facts` carries
   * `authorLogin`, and `org_team_memberships` says who is in what.
   */
  AuthoringTeam: "authoring-team",
  /** Exactly one GitHub team holds `admin`: the closest thing to a declared owner the API has. */
  TeamsApiAdmin: "teams-api-admin",
  /** Several teams hold write-or-better; most permissive wins, ties to the smallest team. */
  TeamsApiWrite: "teams-api-write",
  /** A direct collaborator holding admin, once no team's access claims the repository. */
  DirectCollaborator: "direct-collaborator-admin",
  /** CODEOWNERS names exactly one team, once no access rung has answered. */
  CodeownersSole: "codeowners-sole",
  /** CODEOWNERS names several teams; the one owning fewest wins, then alphabetical order. */
  CodeownersFirst: "codeowners-first",
  /** A bare `@login` in CODEOWNERS, once no team the file names has answered. */
  CodeownersPerson: "codeowners-person",
  /**
   * The name shares a family prefix with repositories the evidenced rungs agreed on.
   *
   * Last before `unowned` and BELOW every CODEOWNERS rung, unchanged by the demotion: an inferred name
   * family is a guess this codebase makes, and a committed CODEOWNERS file is at least something a human
   * wrote about this repository. A stale statement outranks an inference.
   */
  NamePrefix: "name-prefix",
  /** No rung answered. A normal outcome, and not a failure. */
  Unowned: "unowned"
} as const;

export type OwnershipRung = (typeof OwnershipRung)[keyof typeof OwnershipRung];

/** Every rung in precedence order, so a report reads as the order it describes. */
export const RungOrder: readonly OwnershipRung[] = [
  OwnershipRung.Configured,
  OwnershipRung.AuthoringTeam,
  OwnershipRung.TeamsApiAdmin,
  OwnershipRung.TeamsApiWrite,
  OwnershipRung.DirectCollaborator,
  OwnershipRung.CodeownersSole,
  OwnershipRung.CodeownersFirst,
  OwnershipRung.CodeownersPerson,
  OwnershipRung.NamePrefix,
  OwnershipRung.Unowned
];

/** The rungs decided from evidence alone, before the name pass may run. */
export const EvidenceRungs: readonly OwnershipRung[] = [
  OwnershipRung.Configured,
  OwnershipRung.AuthoringTeam,
  OwnershipRung.TeamsApiAdmin,
  OwnershipRung.TeamsApiWrite,
  OwnershipRung.DirectCollaborator,
  OwnershipRung.CodeownersSole,
  OwnershipRung.CodeownersFirst,
  OwnershipRung.CodeownersPerson
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
  /**
   * What this person is called, resolved from the Entra SSO identity mapping rather than self-reported.
   *
   * THE RESOLVED NAME AND NOTHING ELSE. The two sources it comes from — the SAML `nameId` and the SCIM record —
   * are both keyed on a work email address for some 800 named people, and NEITHER THE UPN NOR THE EMAIL IS
   * STORED ANYWHERE. The dashboard needs a name to put beside a login; it does not need a way to email
   * everybody in the organisation, and the less personal data a reporting database holds the better. Do not add
   * the address here later because it happened to be in hand at the join.
   *
   * Absent where nothing resolved, which is what lets a reader fall back — see `contributorNames`.
   */
  displayName?: string;
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
 * Who authored the merges in one repository, and how many each of them wrote.
 *
 * READ FROM THE COLLECTED FACTS RATHER THAN FETCHED. `pull_request_facts.payload->>'authorLogin'` is
 * already stored by every `collect` run, so the `authoring-team` rung costs no GitHub call at all — it is
 * a database read of evidence somebody has already paid for.
 *
 * Logins are FOLDED, on `canonical`'s rule: the memberships this is joined against are folded too, and a
 * person whose commits are attributed to `Alice` must not fail to match their membership as `alice`.
 */
export interface RepositoryAuthorship {
  repository: string;
  /** Folded login → how many merges in the window that person authored. Never zero. */
  merges: Map<string, number>;
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
  /**
   * Who authored merges in each repository, keyed by repository.
   *
   * EMPTY IS A LEGITIMATE STATE and not a degraded one: a repository with no recent merges has no
   * authorship to read, and the `authoring-team` rung simply declines for it and lets the rungs below
   * answer. That is why the rung is an ADDITION above `teams-api-admin` rather than a replacement of it —
   * measured on AAT, authorship answers 457 of 1,880 non-archived repositories, and the `UiPath-*` family
   * has none at all.
   */
  authorship: Map<string, RepositoryAuthorship>;
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
  /**
   * How many merges a team's members must have authored before the team is read as the authoring one.
   *
   * MEASURED, not chosen freely. The distribution of "merges by the best-scoring team with access" over
   * this estate has a long tail at one: 310 of 1,124 team-repository pairs sit at exactly one merge, and
   * one merge is a person passing through — somebody fixing a typo in a repository their team happens to
   * hold access to. At two the rung answers 498 repositories rather than 614, and it drops precisely the
   * pairs that cannot distinguish an owner from a visitor.
   *
   * This is a FLOOR on merges rather than on distinct authors, because a one-person team is a real thing
   * on this estate — `cdm-tl` has 2 members and 38 repositories — and requiring two authors would disown
   * them for their size. The author COUNT is still the leading tie-break, where it is the informative
   * signal.
   */
  minimumAuthoredMerges: number;
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
 * How many merges a team's members must have authored before it is read as the authoring team.
 *
 * Two, and the figure comes from the measurement `OwnershipOptions.minimumAuthoredMerges` records: one
 * merge is the mode of the tail and is a visitor rather than an owner.
 */
export const DefaultMinimumAuthoredMerges = 2;

/**
 * How far back authorship is read, in days.
 *
 * Matches `lookback.operational_days`' own default rather than being a second window nobody reconciles:
 * "who works in this repository" is the same question the operational window asks, and `collect` fills the
 * fact cache over exactly that span — so a wider window here would read a cache that does not reach and a
 * narrower one would discard evidence already paid for. Ownership is a fact about NOW, so a team that
 * stopped merging two years ago is not the answer; 90 days is a working quarter, which survives a holiday
 * and a release freeze without surviving a reorganisation.
 */
export const DefaultAuthorshipDays = 90;

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

/**
 * Compare two handles by code point, which is what Python's `min` over a tuple does.
 *
 * DELIBERATELY NOT `localeCompare`, and stated as a comparator rather than left to a bare `sort()` so that the
 * choice is visible to a reader and to a linter. A locale collation ignores or reorders the hyphen, so
 * `sscs-api` and `sscsapi` sort differently under the two rules — and this is the tie-break that decides which
 * team owns a contested repository, so a different order is a different answer.
 *
 * It is also what makes two runs over an unchanged organisation produce byte-identical facts, which is what
 * lets the stored digest say "nothing changed" rather than "the order changed".
 */
export function byCodePoint(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}
