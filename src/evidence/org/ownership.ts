import {
  type AccessLevel,
  AccessLevels,
  byCodePoint,
  canonical,
  EvidenceRungs,
  isOwningAccess,
  MaximumPrefixSegments,
  MinimumPrefixLength,
  mostPermissiveAccess,
  type OrgFacts,
  OwnerKind,
  type OwnershipOptions,
  OwnershipRung,
  type ResolvedOwner,
  type ResolvedOwnership,
  RungOrder
} from "./graph.ts";

/**
 * Attribution: turning the collected organisation graph into one owner per repository, with its provenance.
 *
 * Originally a faithful port of the decision half of `scripts/build_team_configuration.py` in
 * `hmcts/github-metrics`, whose committed output was the bar the port was judged against: a 2,841-line
 * `config.yml` with the provenance counts `teams-api-admin 949 / codeowners-sole 200 / teams-api-write 324 /
 * codeowners-first 15 / name-prefix 56 / unknown 319`.
 *
 * THAT IS NO LONGER THE BAR, and this is where the port stops being one. Reproducing the Python script's
 * counts proved the mechanics were faithful and, in doing so, proved the ANSWER was wrong: reading `admin`
 * as ownership named an access administrator for most of the estate, which is what `authoring-team` fixes and
 * what the CODEOWNERS demotion follows from. Both departures are argued in `OwnershipRung`, with the AAT
 * measurements behind them. The rungs the script had still behave as it did; they just no longer decide
 * first.
 *
 * Three further departures, each named where it happens: several `admin` teams yield several owners rather
 * than being discarded as a tie (`decideFromEvidence`), a repository owned by a PERSON has rungs of its own,
 * and the `authoring-team` rung reads observed behaviour where every other rung reads a declaration.
 *
 * Everything here is a pure function of the facts. Nothing fetches, and the two rungs that need the expensive
 * fetches — CODEOWNERS and direct collaborators — are reached only for the residue `unresolvedRepositories`
 * names, which is the cost-control mechanism the collector depends on.
 */

/**
 * The facts reduced to what the rules actually consult, with the sizes they tie-break on.
 *
 * `teamSizes` keeps an entry for a team whose claims were suppressed as too broad, because the tie-breaks
 * index into it by slug and a suppressed team is still a team of that size.
 */
export interface Evidence {
  /** Owning claims per repository: repository → team slug → access. */
  claims: Map<string, Map<string, AccessLevel>>;
  /** How many repositories of THIS population each team holds. The `teams-api-write` tie-break reads this. */
  teamSizes: Map<string, number>;
  /** Teams CODEOWNERS names, per repository, folded and deduplicated. */
  codeowners: Map<string, string[]>;
  /** How many repositories name each team in CODEOWNERS. The `codeowners-first` tie-break reads this. */
  codeownerSizes: Map<string, number>;
  /** Teams holding access across more of the estate than `maximumTeamShare` allows, kept for reporting. */
  broadTeams: Set<string>;
  /**
   * Teams with more members than `maximumTeamMembers` allows, so read as populations rather than owners.
   *
   * Kept apart from `broadTeams` rather than merged into one "not an owner" set, because they are excluded
   * from different things — see the CODEOWNERS filter in `ownershipEvidence` — and because a run reports the
   * two separately: "holds access across half the estate" and "has 757 members" are different findings and a
   * reader fixes them differently.
   */
  populousTeams: Set<string>;
  /** How many members each team was observed to have, so a report can name the size that excluded it. */
  memberCounts: Map<string, number>;
  /** Bare `@login` handles CODEOWNERS names, per repository. */
  codeownerPeople: Map<string, string[]>;
  /**
   * The teams whose own members authored merges here, per repository, best first.
   *
   * Already reduced to the ranking the rung reads, rather than left as raw scores for
   * `decideFromEvidence` to sort: the ranking is over the whole estate's memberships and access, so
   * computing it per repository inside the ladder would be the same join 1,880 times.
   */
  authoringTeams: Map<string, AuthoringClaim[]>;
}

/**
 * One team's claim to be the authoring team of one repository, with the evidence behind it.
 *
 * All three figures are carried because all three are the `detail` a stored row keeps: a reader weighing
 * "attributed by authorship" needs to see how many people and how many merges, not just the rule's name.
 */
export interface AuthoringClaim {
  team: string;
  /** Distinct members of this team who authored a merge here. */
  authors: number;
  /** Merges those members authored between them. */
  merges: number;
}

/**
 * The per-repository facts the `Evidence` reduction deliberately does not carry.
 *
 * CODEOWNERS paths are evidence a READER needs and no rule consults, and direct collaborators are the last
 * rung's only input. Both are passed alongside rather than folded into `Evidence`, which stays the set of
 * things the rules tie-break on.
 */
export type OwnershipDetailFacts = Pick<OrgFacts, "codeowners" | "directAdmins">;

const NoDetailFacts: OwnershipDetailFacts = { codeowners: new Map(), directAdmins: new Map() };

/**
 * One team inferred from a name family, with the support that justified it.
 *
 * The counts come back with the slug because they are the `detail` the row carries: "attributed by name" is
 * only weighable by a reader who can see how many repositories agreed and how many did not.
 */
export interface NameInference {
  team: string;
  prefix: string;
  agreeing: number;
  total: number;
}

/**
 * Reduce facts to per-repository claims and the sizes the rules tie-break on.
 *
 * Read access is discarded HERE and not only where it is fetched, because this is where it would do harm: a
 * cache written by an older run, or a fetch filter someone loosens later, must not be able to turn permission
 * to look at a repository into a claim to own it.
 *
 * Both sizes are counted over THIS population only — the non-archived repositories. A team's weight ought to
 * be how much of the organisation it holds now, not how much it once held or holds in archived repositories.
 *
 * `claims` IS THE ONE DEFINITION OF "THIS HANDLE COULD OWN SOMETHING" and every access-based rung reads it,
 * `authoring-team` included. That is deliberate: the filters below are the whole reason a platform team holding
 * a fifth of the estate does not absorb it, and a rung reaching around them to the raw edges would reintroduce
 * exactly that.
 *
 * TWO FILTERS keep a team from being read as an owner, and they answer different questions. `excludedTeams` is
 * identity: `all-org-members` is not a team that owns things, it is the organisation wearing a team's clothes,
 * and no threshold can make it one — so it is named. It is applied to CODEOWNERS as well as to access, because
 * a handle that is not a team is not a team wherever it is written. `maximumTeamShare` is proportion: a team
 * holding write across the estate holds it administratively rather than editorially, and since it is the ONLY
 * claim on much of that estate, left in it absorbs every repository no service team happened to claim and a
 * confident wrong answer replaces an honest `unowned`. That one is deliberately NOT applied to CODEOWNERS,
 * where naming a team in one repository is a per-repository act rather than a blanket grant. The tie-break
 * already prefers the specific claim where a repository is contested; both filters are for where it is not.
 */
export function ownershipEvidence(facts: OrgFacts, options: OwnershipOptions): Evidence {
  const population = new Set(facts.repositories.filter((repository) => !repository.archived).map((repository) => repository.name));
  const owning = new Map<string, Map<string, AccessLevel>>();
  for (const fact of facts.teamRepositories) {
    const slug = canonical(fact.teamSlug);
    if (options.excludedTeams.has(slug) || !isOwningAccess(fact.access)) {
      continue;
    }
    let held = owning.get(slug);
    if (held === undefined) {
      held = new Map();
      owning.set(slug, held);
    }
    // Registered above but counted only in the population: a team holding admin on archived repositories
    // alone is a team of size zero, not an absent one, and the share filter must see it as such.
    if (population.has(fact.repository)) {
      held.set(fact.repository, mostPermissiveAccess(held.get(fact.repository), fact.access));
    }
  }

  const teamSizes = new Map<string, number>();
  for (const [slug, held] of owning) {
    teamSizes.set(slug, held.size);
  }
  const ceiling = options.maximumTeamShare * population.size;
  const broadTeams = new Set([...teamSizes].filter(([, size]) => size > ceiling).map(([slug]) => slug));

  // Counted from the memberships actually collected, not from a team's own `totalCount`, so the ceiling
  // weighs the same rows the graph stores. A team whose members could not be listed counts as zero and is
  // therefore never excluded by size: being refused the membership is not evidence of being large.
  const memberCounts = new Map<string, number>();
  for (const membership of facts.memberships) {
    const slug = canonical(membership.teamSlug);
    memberCounts.set(slug, (memberCounts.get(slug) ?? 0) + 1);
  }
  const populousTeams = new Set([...memberCounts].filter(([, size]) => size > options.maximumTeamMembers).map(([slug]) => slug));

  const claims = new Map<string, Map<string, AccessLevel>>();
  for (const [slug, held] of owning) {
    if (broadTeams.has(slug) || populousTeams.has(slug)) {
      continue;
    }
    for (const [repository, access] of held) {
      let holders = claims.get(repository);
      if (holders === undefined) {
        holders = new Map();
        claims.set(repository, holders);
      }
      holders.set(slug, access);
    }
  }

  const codeowners = new Map<string, string[]>();
  const codeownerPeople = new Map<string, string[]>();
  const codeownerSizes = new Map<string, number>();
  for (const [repository, fact] of facts.codeowners) {
    if (!population.has(repository)) {
      continue;
    }
    // Deduplicated AFTER folding, because a file naming both `@hmcts/AppReg` and `@hmcts/appreg` names ONE
    // team twice, and left as two the sole-owner rule would not fire.
    //
    // `populousTeams` is filtered here and `broadTeams` deliberately is NOT, because the two filters answer
    // different questions. Breadth of access is a fact about a blanket grant, and naming a team in one
    // repository's CODEOWNERS is the opposite — a per-repository act — so a broad team's explicit mention
    // still counts. Size is a fact about the team ITSELF: a 757-member group is everyone wherever it is
    // written, and `@hmcts/all-developers` on a review line means "somebody should look", never "this is
    // whose repository it is". That is the same argument `excludedTeams` makes, so it is filtered the same way.
    const teams = [...new Set(fact.teams.map(canonical))].filter((slug) => !options.excludedTeams.has(slug) && !populousTeams.has(slug));
    // An empty list is kept rather than dropped: "read, and names nobody" is an answer, and the row is what
    // keeps it distinguishable from a repository nobody was allowed to look at.
    codeowners.set(repository, teams);
    codeownerPeople.set(repository, [...new Set(fact.people.map(canonical))]);
    for (const slug of teams) {
      codeownerSizes.set(slug, (codeownerSizes.get(slug) ?? 0) + 1);
    }
  }

  const authoringTeams = rankAuthoringTeams(facts, claims, teamSizes, options);

  return { claims, teamSizes, codeowners, codeownerSizes, broadTeams, populousTeams, memberCounts, codeownerPeople, authoringTeams };
}

/**
 * Rank, per repository, the teams with access whose OWN MEMBERS authored merges in it.
 *
 * READ OFF `claims` RATHER THAN OFF THE RAW ACCESS EDGES, which is what makes the three exclusion filters
 * apply to this rung too. It matters most for the largest handles: `platform-operations` holds 397 of the
 * 1,880 non-archived repositories and 56 people are in it, so without the share filter it would win the
 * authorship comparison across a fifth of the estate on the strength of a platform engineer merging a
 * pipeline fix — the same "confident wrong answer replaces an honest one" failure `ownershipEvidence`
 * describes for the rungs below. Going through `claims` means one definition of "is this handle an owner at
 * all" serves every rung.
 *
 * THE THRESHOLD IS ON MERGES AND THE FIRST TIE-BREAK IS ON AUTHORS, which is not redundant. The floor
 * answers "is this evidence at all" and one merge is a visitor, so it is counted in merges — a one-person
 * team is a real owner on this estate and an author floor would disown it. The tie-break answers "which of
 * two teams is more plausibly the owner", and there the breadth of involvement is the better signal: five of
 * `cdm`'s people wrote `aac-manage-case-assignment`'s merges against four of `cdm-admin`'s, and the wider
 * team is the delivery one. Measured on AAT, ordering on merges first instead moves 12 repositories, all of
 * them onto a narrower admin-shaped team.
 *
 * The third key is TEAM SIZE ASCENDING, on `mostSpecificClaim`'s own reasoning: where two teams are equally
 * involved the more specific claim is the informative one. The fourth is the slug, so two runs over one
 * estate produce byte-identical rows.
 */
function rankAuthoringTeams(
  facts: OrgFacts,
  claims: ReadonlyMap<string, ReadonlyMap<string, AccessLevel>>,
  teamSizes: ReadonlyMap<string, number>,
  options: OwnershipOptions
): Map<string, AuthoringClaim[]> {
  const teamsByMember = new Map<string, string[]>();
  for (const membership of facts.memberships) {
    const login = canonical(membership.login);
    const slug = canonical(membership.teamSlug);
    const held = teamsByMember.get(login);
    if (held === undefined) {
      teamsByMember.set(login, [slug]);
    } else if (!held.includes(slug)) {
      held.push(slug);
    }
  }

  const ranked = new Map<string, AuthoringClaim[]>();
  for (const [repository, authorship] of facts.authorship) {
    const holders = claims.get(repository);
    if (holders === undefined) {
      // No team holds this repository in a way any rung would read as ownership, so there is nothing for
      // authorship to choose between. The rungs below still answer it.
      continue;
    }
    const scores = new Map<string, { authors: number; merges: number }>();
    for (const [login, merges] of authorship.merges) {
      for (const slug of teamsByMember.get(login) ?? []) {
        if (!holders.has(slug)) {
          continue;
        }
        const score = scores.get(slug) ?? { authors: 0, merges: 0 };
        score.authors += 1;
        score.merges += merges;
        scores.set(slug, score);
      }
    }
    const qualified = [...scores]
      .filter(([, score]) => score.merges >= options.minimumAuthoredMerges)
      .map(([team, score]) => ({ team, authors: score.authors, merges: score.merges }));
    if (qualified.length === 0) {
      continue;
    }
    qualified.sort(
      (left, right) =>
        right.authors - left.authors ||
        right.merges - left.merges ||
        (teamSizes.get(left.team) ?? 0) - (teamSizes.get(right.team) ?? 0) ||
        byCodePoint(left.team, right.team)
    );
    ranked.set(repository, qualified);
  }
  return ranked;
}

/** Name the one team holding admin, or nothing when none or several do. */
export function soleAdmin(claims: ReadonlyMap<string, AccessLevel>): string | undefined {
  const admins = [...claims].filter(([, access]) => access === "admin").map(([slug]) => slug);
  return admins.length === 1 ? admins[0] : undefined;
}

/** Every team holding admin, in code-point order. The multi-owner extension `decideFromEvidence` describes. */
export function adminTeams(claims: ReadonlyMap<string, AccessLevel>): string[] {
  return [...claims]
    .filter(([, access]) => access === "admin")
    .map(([slug]) => slug)
    .sort(byCodePoint);
}

/**
 * Choose between competing write-or-better claims: most permissive, then smallest team, then alphabetical.
 *
 * Where an organisation-wide platform team and a service team both hold `push` on that service, the specific
 * claim is the informative one, so the smaller team wins the tie.
 *
 * JavaScript has no tuple comparison, so the ordering is written out — and THE ORDERING IS THE SEMANTICS.
 * Swapping two of these three keys changes which team owns a contested repository.
 */
export function mostSpecificClaim(claims: ReadonlyMap<string, AccessLevel>, teamSizes: ReadonlyMap<string, number>): string {
  // Seeded with the first claim rather than reducing without one, so the precondition is stated instead of
  // arriving as `reduce of empty array with no initial value`. There is nothing to choose between no claims,
  // and the ladder only reaches here having found some — a caller that got that wrong wants to be told which
  // rung it was in, not to see a TypeError from inside the comparator.
  const [first, ...rest] = [...claims.keys()];
  if (first === undefined) {
    throw new Error("mostSpecificClaim was given no claims to choose between");
  }
  return rest.reduce((best, slug) => {
    const left = claims.get(slug) as AccessLevel;
    const right = claims.get(best) as AccessLevel;
    const byAccess = AccessLevels.indexOf(left) - AccessLevels.indexOf(right);
    if (byAccess !== 0) {
      return byAccess < 0 ? slug : best;
    }
    const bySize = (teamSizes.get(slug) ?? 0) - (teamSizes.get(best) ?? 0);
    if (bySize !== 0) {
      return bySize < 0 ? slug : best;
    }
    return byCodePoint(slug, best) < 0 ? slug : best;
  }, first);
}

/** Choose between the teams CODEOWNERS names: the one named in fewest repositories, then alphabetically. */
export function mostSpecificOwner(owners: readonly string[], codeownerSizes: ReadonlyMap<string, number>): string {
  const [first, ...rest] = owners;
  if (first === undefined) {
    throw new Error("mostSpecificOwner was given no owners to choose between");
  }
  return rest.reduce((best, slug) => {
    const bySize = (codeownerSizes.get(slug) ?? 0) - (codeownerSizes.get(best) ?? 0);
    if (bySize !== 0) {
      return bySize < 0 ? slug : best;
    }
    return byCodePoint(slug, best) < 0 ? slug : best;
  }, first);
}

/** The CODEOWNERS paths a row cites, or a stated absence rather than an empty string. */
function citedPaths(paths: readonly string[] | undefined): string {
  return paths !== undefined && paths.length > 0 ? paths.join(", ") : "no path recorded";
}

/**
 * Attribute one repository from evidence alone, or return `undefined` for the name pass to try.
 *
 * The rungs are in precedence order and the FIRST TO ANSWER DECIDES. The order encodes one judgement, stated
 * in full at `OwnershipRung`: OBSERVED BEHAVIOUR beats ADMINISTERED ACCESS beats A COMMITTED FILE. Authorship
 * is what a team did last quarter, access is a grant somebody maintains, and CODEOWNERS is a review-routing
 * rule written once — so the CODEOWNERS rungs answer only where nothing else will, which on AAT is 39 of the
 * 70 repositories they used to decide.
 *
 * `detail` carries the evidence the rung acted on — the access level, the paths read, how many claims it beat.
 * A reader weighing an attribution needs the thing that produced it, not just the name of the rule.
 *
 * The fourth parameter exists because two of these rungs need per-repository facts the `Evidence` reduction
 * does not carry; it defaults to empty so the three-argument form still decides every rung that consults
 * `Evidence` alone.
 */
export function decideFromEvidence(
  repository: string,
  evidence: Evidence,
  options: OwnershipOptions,
  detailFacts: OwnershipDetailFacts = NoDetailFacts
): ResolvedOwner[] | undefined {
  const claims = evidence.claims.get(repository) ?? new Map<string, AccessLevel>();
  const owners = evidence.codeowners.get(repository) ?? [];
  const paths = citedPaths(detailFacts.codeowners.get(repository)?.paths);

  // A reviewed `metrics.yaml` entry short-circuits every collected rung, on the same precedent
  // `sonar_projects` sets: resolution treats an override as the answer that ends the walk. Nothing collected
  // can outrank a human who looked.
  const configured = options.configured.get(repository) ?? [];
  if (configured.length > 0) {
    return configured.map((slug) => ({
      kind: OwnerKind.Team,
      owner: canonical(slug),
      rung: OwnershipRung.Configured,
      detail: "configured in metrics.yaml"
    }));
  }

  // THE TOP COLLECTED RUNG, and the fix for this ladder's largest error — see `OwnershipRung.AuthoringTeam`
  // for the measurements. ONE OWNER, unlike the admin rung below: several teams' members merging here is the
  // ordinary case on a platform repository, and every one of them is not an owner. The ranking has already
  // chosen, and `detail` carries what it beat so the choice is auditable.
  const authoring = evidence.authoringTeams.get(repository) ?? [];
  const authored = authoring[0];
  if (authored !== undefined) {
    const contested =
      authoring.length > 1 ? `, ahead of ${authoring.length - 1} other team${authoring.length === 2 ? "" : "s"} with access whose members merged here` : "";
    return [
      {
        kind: OwnerKind.Team,
        owner: authored.team,
        rung: OwnershipRung.AuthoringTeam,
        detail: `${authored.authors} member${authored.authors === 1 ? "" : "s"} authored ${authored.merges} merge${authored.merges === 1 ? "" : "s"} here${contested}`
      }
    ];
  }

  // EXTENSION over the Python script, which required a SOLE admin and discarded the repository to the next
  // rung whenever two teams held it. The schema here permits several owners, so both are returned: a
  // repository with two `admin` teams has two owners, and collapsing that to one invents a tie-break nobody
  // made. The sole case is still named separately in `detail`, because one administrator is stronger evidence
  // than one of two.
  const administrators = adminTeams(claims);
  if (administrators.length > 0) {
    const sole = soleAdmin(claims) !== undefined;
    return administrators.map((slug) => ({
      kind: OwnerKind.Team,
      owner: slug,
      rung: OwnershipRung.TeamsApiAdmin,
      detail: sole ? "sole team holding admin" : `one of ${administrators.length} teams holding admin`
    }));
  }

  if (claims.size > 0) {
    const slug = mostSpecificClaim(claims, evidence.teamSizes);
    return [
      {
        kind: OwnerKind.Team,
        owner: slug,
        rung: OwnershipRung.TeamsApiWrite,
        detail: `holds ${claims.get(slug)} among ${claims.size} claiming teams, and holds ${evidence.teamSizes.get(slug) ?? 0} repositories`
      }
    ];
  }

  // Above the CODEOWNERS rungs from 2026-09-14, which reverses the old order. `OwnershipRung` argues it: a
  // grant of `admin` to a login is current and per-person, a committed file is neither, and the team-before-
  // person rule the old order encoded is preserved by every rung above this one naming a team.
  const admins = detailFacts.directAdmins.get(repository) ?? [];
  if (admins.length > 0) {
    return admins.map((login) => ({
      kind: OwnerKind.Person,
      owner: canonical(login),
      rung: OwnershipRung.DirectCollaborator,
      detail: "direct collaborator holding admin"
    }));
  }

  if (owners.length === 1) {
    return [
      {
        kind: OwnerKind.Team,
        owner: owners[0] as string,
        rung: OwnershipRung.CodeownersSole,
        detail: `sole team in CODEOWNERS (${paths})`
      }
    ];
  }

  if (owners.length > 0) {
    const slug = mostSpecificOwner(owners, evidence.codeownerSizes);
    return [
      {
        kind: OwnerKind.Team,
        owner: slug,
        rung: OwnershipRung.CodeownersFirst,
        detail: `one of ${owners.length} teams in CODEOWNERS (${paths}), named in ${evidence.codeownerSizes.get(slug) ?? 0} repositories`
      }
    ];
  }

  // The last collected rung: a bare `@login` in a file, once no team the same file names has answered.
  const people = evidence.codeownerPeople.get(repository) ?? [];
  if (people.length > 0) {
    return people.map((login) => ({
      kind: OwnerKind.Person,
      owner: login,
      rung: OwnershipRung.CodeownersPerson,
      detail: `named in CODEOWNERS (${paths})`
    }));
  }

  return undefined;
}

/**
 * List a repository name's candidate family prefixes, LONGEST FIRST.
 *
 * Longest first because the narrower family is the more informative one: `api-cp-crime` should be read as an
 * `api-cp` repository before it is read as an `api` one.
 */
export function prefixesOf(repository: string): string[] {
  const segments = repository.split("-");
  const limit = Math.min(segments.length, MaximumPrefixSegments);
  const candidates: string[] = [];
  for (let count = limit; count > 0; count -= 1) {
    candidates.push(segments.slice(0, count).join("-"));
  }
  return candidates.filter((prefix) => prefix.length >= MinimumPrefixLength);
}

/**
 * Count which teams each name prefix was attributed to, over EVIDENCED TEAM decisions only.
 *
 * ONE VOTE PER REPOSITORY, cast by its `primary` owner. A repository with two admin teams is still one
 * repository, and letting it vote twice would inflate the `total` a dominance threshold is measured against.
 * Person owners cast no vote at all: a name family is a claim about teams.
 *
 * The rung filter is belt-and-braces — `attributeOwnership` passes evidenced decisions only — because it is
 * the invariant that stops inference feeding itself, and the cost of getting it wrong is a whole name family
 * attributed to a guess.
 *
 * A team the organisation did not list is kept OUT of the index when there is a list to check against. Such a
 * team came from a CODEOWNERS file naming a handle since renamed, deleted or mistyped, and while grouping the
 * repository that names it is still faithful to what that file says, spreading a label across a whole name
 * family on the strength of it is not: attributing three more repositories to a team that may not exist is
 * worse than `unowned`. An empty `knownTeams` is NO LIST rather than an organisation with no teams — a token
 * that could not list them must not be read as denying all of them — so the check is skipped.
 */
export function prefixIndex(decisions: Iterable<ResolvedOwnership>, knownTeams: ReadonlySet<string>): Map<string, Map<string, number>> {
  const index = new Map<string, Map<string, number>>();
  for (const decision of decisions) {
    const owner = decision.primary;
    if (owner.kind !== OwnerKind.Team || !EvidenceRungs.includes(owner.rung)) {
      continue;
    }
    if (knownTeams.size > 0 && !knownTeams.has(owner.owner)) {
      continue;
    }
    for (const prefix of prefixesOf(decision.repository)) {
      let counts = index.get(prefix);
      if (counts === undefined) {
        counts = new Map();
        index.set(prefix, counts);
      }
      counts.set(owner.owner, (counts.get(owner.owner) ?? 0) + 1);
    }
  }
  return index;
}

/**
 * The team a prefix's attributed repositories agree on, by highest count and then alphabetically.
 *
 * Python's `Counter.most_common` breaks a tie by INSERTION ORDER, which depends on the order repositories
 * happened to be listed in and so is not reproducible in a port. A stated order is used instead: most
 * repositories, then the earlier slug.
 */
function dominantTeam(counts: ReadonlyMap<string, number>): [string, number] | undefined {
  // `undefined` for an empty index rather than a throw, because unlike the two choosers above this one has a
  // legitimate empty case: a prefix nothing was attributed to has no entry, and `inferFromName` walks prefixes
  // it does not know will answer.
  const [first, ...rest] = [...counts];
  if (first === undefined) {
    return undefined;
  }
  return rest.reduce((best, entry) => {
    if (entry[1] !== best[1]) {
      return entry[1] > best[1] ? entry : best;
    }
    return byCodePoint(entry[0], best[0]) < 0 ? entry : best;
  }, first);
}

/**
 * Attribute a repository by name family, taking the longest prefix that agrees well enough.
 *
 * A prefix that fails either threshold does not end the walk: the shorter prefix is still tried, because
 * `sscs-` may speak for a repository `sscs-tya-` has too few siblings to speak for.
 */
export function inferFromName(
  repository: string,
  index: ReadonlyMap<string, ReadonlyMap<string, number>>,
  options: OwnershipOptions
): NameInference | undefined {
  for (const prefix of prefixesOf(repository)) {
    const counts = index.get(prefix);
    if (counts === undefined) {
      continue;
    }
    const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
    // One guard, not two: an empty count map and a prefix nobody agreed on are the same "this prefix cannot
    // speak", and `dominantTeam` is where that is decided.
    const dominant = dominantTeam(counts);
    if (dominant === undefined) {
      continue;
    }
    const [team, agreeing] = dominant;
    if (total >= options.prefixSupport && agreeing / total >= options.prefixDominance) {
      return { team, prefix, agreeing, total };
    }
  }
  return undefined;
}

/**
 * One repository's owners in reporting order, with the leader named.
 *
 * Ordered by rung and then alphabetically so that two runs over the same facts produce byte-identical output:
 * this is written to a database and diffed between collections, and an unstable order would show every
 * repository as changed.
 */
function ownershipOf(repository: string, owners: readonly ResolvedOwner[]): ResolvedOwnership {
  const ordered = [...owners].sort((left, right) => RungOrder.indexOf(left.rung) - RungOrder.indexOf(right.rung) || byCodePoint(left.owner, right.owner));
  return { repository, owners: ordered, primary: ordered[0] as ResolvedOwner };
}

/**
 * Attribute every repository in the population: evidence first, then name families.
 *
 * THE TWO PASSES ARE ORDERED AND NOT INTERLEAVED, so inference reads an index built entirely from evidence.
 * Were an inferred repository allowed into the index, one wrong guess could reach the support threshold on its
 * own and then attribute a whole family to the team it was wrong about.
 *
 * Every repository in the population appears EXACTLY ONCE with a non-empty `owners`, archived repositories
 * appear not at all, and the result is sorted by name.
 */
export function attributeOwnership(facts: OrgFacts, options: OwnershipOptions): ResolvedOwnership[] {
  const evidence = ownershipEvidence(facts, options);
  const population = [...new Set(facts.repositories.filter((repository) => !repository.archived).map((repository) => repository.name))].sort(byCodePoint);

  const decided = new Map<string, ResolvedOwnership>();
  for (const repository of population) {
    const owners = decideFromEvidence(repository, evidence, options, facts);
    if (owners !== undefined && owners.length > 0) {
      decided.set(repository, ownershipOf(repository, owners));
    }
  }

  const index = prefixIndex(decided.values(), facts.knownTeams);
  const walked = [...EvidenceRungs, OwnershipRung.NamePrefix].join(", ");
  return population.map((repository) => {
    const evidenced = decided.get(repository);
    if (evidenced !== undefined) {
      return evidenced;
    }
    const inferred = inferFromName(repository, index, options);
    if (inferred !== undefined) {
      return ownershipOf(repository, [
        {
          kind: OwnerKind.Team,
          owner: inferred.team,
          rung: OwnershipRung.NamePrefix,
          detail: `name family "${inferred.prefix}": ${inferred.agreeing} of ${inferred.total} attributed repositories agree`
        }
      ]);
    }
    // A remembered negative: the rungs that were walked are named, so "nothing owns it" stays
    // distinguishable from "we never looked".
    return ownershipOf(repository, [
      {
        kind: OwnerKind.None,
        owner: "",
        rung: OwnershipRung.Unowned,
        detail: `no rung answered; walked ${walked}`
      }
    ]);
  });
}

/**
 * How many repositories each rung attributed, counted by `primary` and read in precedence order.
 *
 * THIS IS THE FIGURE THE LADDER IS JUDGED BY, and the one to read after changing any rung's precedence. It
 * was once checked against the Python script's committed counts; those are no longer the target — see this
 * module's header — and what it is read for now is whether a change moved the estate where it was meant to.
 * Measured on AAT before and after the 2026-09-14 change: `teams-api-admin` 1,346 → 923, `authoring-team`
 * 0 → 457, `codeowners-*` 70 → 39, `unowned` 141 either way.
 *
 * Rungs that attributed nothing are omitted rather than reported as zero, as the original's report did: a
 * rung with no rows says nothing about this organisation, and a column of zeroes reads as a failure.
 */
export function rungCounts(resolved: Iterable<ResolvedOwnership>): Map<OwnershipRung, number> {
  const tally = new Map<OwnershipRung, number>();
  for (const ownership of resolved) {
    tally.set(ownership.primary.rung, (tally.get(ownership.primary.rung) ?? 0) + 1);
  }
  const counts = new Map<OwnershipRung, number>();
  for (const rung of RungOrder) {
    const count = tally.get(rung);
    if (count !== undefined) {
      counts.set(rung, count);
    }
  }
  return counts;
}

/**
 * The repositories no free rung answered, so the caller can scope the expensive fetches to the residue.
 *
 * THIS IS THE COST-CONTROL MECHANISM, and it has to agree with the ladder's precedence or it silently changes
 * the answer. The rule is mechanical: every rung that decides from data ALREADY IN HAND is free, and the
 * residue is what none of them answered. Free rungs are `configured`, `authoring-team`, `teams-api-admin` and
 * `teams-api-write` — an override is in the file, and the other three read the team walk and the fact cache,
 * both of which are complete before this is called. What is paid for is CODEOWNERS (up to three content
 * requests) and the direct-collaborator listing (one more).
 *
 * THE RESIDUE SHRANK WITH THE CODEOWNERS DEMOTION, which is worth stating because it reads the other way at
 * first glance. It once had to include any repository with a `push` claim but no `admin` team — 270 of them —
 * because `codeowners-sole` outranked `teams-api-write` and their files therefore had to be read to decide
 * them. Now no CODEOWNERS rung can outrank an access claim, so a repository with any owning claim is settled
 * for free and its file is never fetched. Measured on AAT, the residue falls from roughly 530 repositories to
 * roughly 260, so the demotion makes the walk CHEAPER as well as more current.
 *
 * `configured` is a parameter rather than read from `OwnershipOptions` so that a caller holding only facts can
 * still ask; left out, a repository with a reviewed override is fetched needlessly rather than skipped, which
 * costs a request and is never wrong.
 */
export function unresolvedRepositories(facts: OrgFacts, evidence: Evidence, configured: ReadonlyMap<string, string[]> = new Map()): string[] {
  return facts.repositories
    .filter((repository) => !repository.archived)
    .map((repository) => repository.name)
    .filter((name) => (configured.get(name) ?? []).length === 0 && (evidence.claims.get(name)?.size ?? 0) === 0)
    .sort(byCodePoint);
}
