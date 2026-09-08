import { describe, expect, it } from "vitest";
import {
  type AccessLevel,
  type CodeownersFact,
  DefaultExcludedTeams,
  DefaultMaximumTeamMembers,
  DefaultMaximumTeamShare,
  DefaultPrefixDominance,
  DefaultPrefixSupport,
  type OrgFacts,
  OwnerKind,
  type OwnershipOptions,
  OwnershipRung,
  type RepositoryFact,
  type ResolvedOwnership,
  type TeamRepositoryFact
} from "./graph.ts";
import {
  attributeOwnership,
  decideFromEvidence,
  inferFromName,
  mostSpecificClaim,
  mostSpecificOwner,
  ownershipEvidence,
  prefixesOf,
  prefixIndex,
  rungCounts,
  soleAdmin,
  unresolvedRepositories
} from "./ownership.ts";

// Ported alongside scripts/build_team_configuration.py. Everything under test is a pure function of the
// facts, so there is no fetch to stub and no fixture to load: each case states the whole organisation it
// needs, which is also what makes the precedence order readable in a diff.

function repositories(...names: string[]): RepositoryFact[] {
  return names.map((name) => ({ name, archived: false, visibility: "private", isFork: false }));
}

function archived(name: string): RepositoryFact {
  return { name, archived: true, visibility: "private", isFork: false };
}

function owns(teamSlug: string, repository: string, access: AccessLevel = "push"): TeamRepositoryFact {
  return { teamSlug, repository, access };
}

function codeownersFor(entries: { repository: string; teams?: string[]; people?: string[]; paths?: string[] }[]): Map<string, CodeownersFact> {
  return new Map(
    entries.map((entry) => [
      entry.repository,
      { repository: entry.repository, teams: entry.teams ?? [], people: entry.people ?? [], paths: entry.paths ?? [".github/CODEOWNERS"] }
    ])
  );
}

function orgFacts(overrides: Partial<OrgFacts> = {}): OrgFacts {
  return {
    organization: "hmcts",
    teamsRead: true,
    knownTeams: new Set(),
    teams: [],
    memberships: [],
    teamRepositories: [],
    repositories: [],
    people: [],
    codeowners: new Map(),
    directAdmins: new Map(),
    ...overrides
  };
}

/**
 * Options with both ceilings disabled by default.
 *
 * These populations are a handful of repositories, and a 25% ceiling over four of them suppresses any team
 * holding two — so left at its default it would silently take over every test that is about something else.
 * `maximumTeamMembers` is `Infinity` for the same reason, from the other direction: these fixtures name one or
 * two members per team, so a real ceiling would never fire and a test that forgot to set it would pass
 * vacuously. The tests that are about either ceiling set it themselves.
 */
function ownershipOptions(overrides: Partial<OwnershipOptions> = {}): OwnershipOptions {
  return {
    prefixSupport: DefaultPrefixSupport,
    prefixDominance: DefaultPrefixDominance,
    maximumTeamShare: 1,
    maximumTeamMembers: Number.POSITIVE_INFINITY,
    excludedTeams: new Set(DefaultExcludedTeams),
    configured: new Map(),
    ...overrides
  };
}

function primaryOf(resolved: ResolvedOwnership[], repository: string): ResolvedOwnership["primary"] {
  const found = resolved.find((ownership) => ownership.repository === repository);
  if (found === undefined) {
    throw new Error(`${repository} was not attributed at all`);
  }
  return found.primary;
}

/** `count` distinct members of one team, for the tests that are about how large a team is. */
function membersOf(team: string, count: number): OrgFacts["memberships"] {
  return Array.from({ length: count }, (_unused, at) => ({ teamSlug: team, login: `person-${at}`, role: "MEMBER" }));
}

/** A family of repositories each held by one admin team, which is the cheapest way to make evidence. */
function family(pairs: [string, string][]): Pick<OrgFacts, "repositories" | "teamRepositories"> {
  return {
    repositories: repositories(...pairs.map(([repository]) => repository)),
    teamRepositories: pairs.map(([repository, team]) => owns(team, repository, "admin"))
  };
}

describe("ownershipEvidence", () => {
  it("should discard read access rather than read it as a claim to own", () => {
    // Discarded here and not only where it is fetched: a cache written by an older run must not be able to
    // turn permission to look at a repository into ownership of it.
    const facts = orgFacts({ repositories: repositories("civil"), teamRepositories: [owns("watchers", "civil", "pull"), owns("watchers", "civil", "triage")] });

    const evidence = ownershipEvidence(facts, ownershipOptions());

    expect(evidence.claims.size).toBe(0);
    expect(evidence.teamSizes.has("watchers")).toBe(false);
  });

  it("should fold one team arriving twice under different case to its most permissive access", () => {
    const facts = orgFacts({ repositories: repositories("civil"), teamRepositories: [owns("Civil", "civil", "push"), owns("civil", "civil", "admin")] });

    const evidence = ownershipEvidence(facts, ownershipOptions());

    expect(evidence.claims.get("civil")).toEqual(new Map([["civil", "admin"]]));
    expect(evidence.teamSizes.get("civil")).toBe(1);
  });

  it("should exclude archived repositories from the population and from every size count", () => {
    // A team's weight ought to be how much of the organisation it holds now, not how much it holds in
    // repositories nobody can merge to.
    const facts = orgFacts({
      repositories: [...repositories("live"), archived("retired")],
      teamRepositories: [owns("civil", "live", "admin"), owns("civil", "retired", "admin")],
      codeowners: codeownersFor([{ repository: "retired", teams: ["civil"] }])
    });

    const evidence = ownershipEvidence(facts, ownershipOptions());

    expect(evidence.teamSizes.get("civil")).toBe(1);
    expect([...evidence.claims.keys()]).toEqual(["live"]);
    expect(evidence.codeowners.has("retired")).toBe(false);
    expect(attributeOwnership(facts, ownershipOptions()).map((ownership) => ownership.repository)).toEqual(["live"]);
  });

  it("should count a team holding only archived repositories as a team of size zero", () => {
    const facts = orgFacts({ repositories: [...repositories("live"), archived("retired")], teamRepositories: [owns("legacy", "retired", "admin")] });

    expect(ownershipEvidence(facts, ownershipOptions()).teamSizes.get("legacy")).toBe(0);
  });

  it("should suppress the claims of a team holding more of the estate than the share allows", () => {
    const facts = orgFacts({
      repositories: repositories("one", "two", "three", "four"),
      teamRepositories: ["one", "two", "three", "four"].map((repository) => owns("platform", repository, "admin"))
    });

    const evidence = ownershipEvidence(facts, ownershipOptions({ maximumTeamShare: DefaultMaximumTeamShare }));

    expect([...evidence.broadTeams]).toEqual(["platform"]);
    expect(evidence.claims.size).toBe(0);
    // The size is kept even though the claims are gone: the tie-breaks index into it by slug, and a
    // suppressed team is still a team of that size.
    expect(evidence.teamSizes.get("platform")).toBe(4);
  });

  it("should not read a team with more members than the ceiling as an owner", () => {
    // The "all developers" case: a coherent handful of repositories held by a team that is really the whole
    // engineering department. Neither other filter catches it — it is not named, and it holds too little of
    // the estate to be broad — so size is the only thing that gives it away.
    const facts = orgFacts({
      repositories: repositories("one", "two"),
      teamRepositories: [owns("all-developers", "one", "admin"), owns("all-developers", "two", "admin")],
      memberships: membersOf("all-developers", 101)
    });

    const evidence = ownershipEvidence(facts, ownershipOptions({ maximumTeamMembers: DefaultMaximumTeamMembers }));

    expect([...evidence.populousTeams]).toEqual(["all-developers"]);
    expect(evidence.claims.size).toBe(0);
    expect(evidence.memberCounts.get("all-developers")).toBe(101);
  });

  it("should keep a team exactly at the member ceiling, since the ceiling is a maximum it may reach", () => {
    const facts = orgFacts({
      repositories: repositories("one"),
      teamRepositories: [owns("large-but-real", "one", "admin")],
      memberships: membersOf("large-but-real", DefaultMaximumTeamMembers)
    });

    const evidence = ownershipEvidence(facts, ownershipOptions({ maximumTeamMembers: DefaultMaximumTeamMembers }));

    expect([...evidence.populousTeams]).toEqual([]);
    expect(evidence.claims.get("one")).toEqual(new Map([["large-but-real", "admin"]]));
  });

  it("should not read a populous team named in CODEOWNERS as an owner either, unlike a broad one", () => {
    // The two filters part company here. Breadth is a fact about a blanket GRANT, so an explicit per-repository
    // mention still counts. Size is a fact about the TEAM: everyone is everyone wherever the handle is written.
    const facts = orgFacts({
      repositories: repositories("one"),
      memberships: membersOf("all-developers", 101),
      codeowners: codeownersFor([{ repository: "one", teams: ["all-developers"] }])
    });

    const resolved = attributeOwnership(facts, ownershipOptions({ maximumTeamMembers: DefaultMaximumTeamMembers }));

    expect(primaryOf(resolved, "one")).toMatchObject({ kind: OwnerKind.None, rung: OwnershipRung.Unowned });
  });

  it("should never exclude a team by size when its membership could not be listed", () => {
    // A team whose members were refused counts as zero, and being refused the membership is not evidence of
    // being large. Read the other way round, one 403 disowns every repository that team holds.
    const facts = orgFacts({
      repositories: repositories("one"),
      teamRepositories: [owns("unlistable", "one", "admin")],
      memberships: []
    });

    const evidence = ownershipEvidence(facts, ownershipOptions({ maximumTeamMembers: 1 }));

    expect([...evidence.populousTeams]).toEqual([]);
    expect(evidence.claims.get("one")).toEqual(new Map([["unlistable", "admin"]]));
  });

  it("should count a team's members case-insensitively, so one team is not two half-sized ones", () => {
    const facts = orgFacts({
      repositories: repositories("one"),
      teamRepositories: [owns("mixed", "one", "admin")],
      memberships: [...membersOf("Mixed", 2), ...membersOf("mixed", 1).map((m) => ({ ...m, login: "person-9" }))]
    });

    const evidence = ownershipEvidence(facts, ownershipOptions({ maximumTeamMembers: 2 }));

    expect(evidence.memberCounts.get("mixed")).toBe(3);
    expect([...evidence.populousTeams]).toEqual(["mixed"]);
  });

  it("should still count a broad team named in one repository's CODEOWNERS", () => {
    // The share filter is about proportion and deliberately spares CODEOWNERS, where naming a team in one
    // repository is a per-repository act rather than a blanket grant.
    const facts = orgFacts({
      repositories: repositories("one", "two", "three", "four"),
      teamRepositories: ["one", "two", "three", "four"].map((repository) => owns("platform", repository, "admin")),
      codeowners: codeownersFor([{ repository: "one", teams: ["platform"] }])
    });

    const resolved = attributeOwnership(facts, ownershipOptions({ maximumTeamShare: DefaultMaximumTeamShare }));

    expect(primaryOf(resolved, "one")).toMatchObject({ kind: OwnerKind.Team, owner: "platform", rung: OwnershipRung.CodeownersSole });
    expect(primaryOf(resolved, "two").rung).toBe(OwnershipRung.Unowned);
  });

  it("should reject an excluded handle in team access and in CODEOWNERS alike", () => {
    // `all-org-members` is the organisation wearing a team's clothes. A handle that is not a team is not a
    // team wherever it is written, so the exclusion applies to both sources.
    const facts = orgFacts({
      repositories: repositories("civil"),
      teamRepositories: [owns("all-org-members", "civil", "admin")],
      codeowners: codeownersFor([{ repository: "civil", teams: ["all-org-members"] }])
    });

    const evidence = ownershipEvidence(facts, ownershipOptions());

    expect(evidence.claims.size).toBe(0);
    expect(evidence.teamSizes.has("all-org-members")).toBe(false);
    expect(evidence.codeowners.get("civil")).toEqual([]);
    expect(primaryOf(attributeOwnership(facts, ownershipOptions()), "civil").rung).toBe(OwnershipRung.Unowned);
  });

  it("should collapse two spellings of one CODEOWNERS handle so the sole-owner rung fires", () => {
    // A file naming both `@hmcts/AppReg` and `@hmcts/appreg` names ONE team twice, and left as two the
    // sole-owner rung would not fire.
    const facts = orgFacts({ repositories: repositories("civil"), codeowners: codeownersFor([{ repository: "civil", teams: ["AppReg", "appreg"] }]) });

    const evidence = ownershipEvidence(facts, ownershipOptions());

    expect(evidence.codeowners.get("civil")).toEqual(["appreg"]);
    expect(primaryOf(attributeOwnership(facts, ownershipOptions()), "civil")).toMatchObject({ owner: "appreg", rung: OwnershipRung.CodeownersSole });
  });

  it("should keep an empty CODEOWNERS answer, which is read and naming nobody rather than unread", () => {
    const facts = orgFacts({ repositories: repositories("civil"), codeowners: codeownersFor([{ repository: "civil", teams: [] }]) });

    expect(ownershipEvidence(facts, ownershipOptions()).codeowners.get("civil")).toEqual([]);
  });

  it("should count how many repositories name each team in CODEOWNERS", () => {
    const facts = orgFacts({
      repositories: repositories("one", "two"),
      codeowners: codeownersFor([
        { repository: "one", teams: ["shared", "narrow"] },
        { repository: "two", teams: ["shared"] }
      ])
    });

    expect(ownershipEvidence(facts, ownershipOptions()).codeownerSizes).toEqual(
      new Map([
        ["shared", 2],
        ["narrow", 1]
      ])
    );
  });
});

describe("soleAdmin", () => {
  it("should name the one team holding admin", () => {
    expect(
      soleAdmin(
        new Map<string, AccessLevel>([
          ["civil", "admin"],
          ["platform", "push"]
        ])
      )
    ).toBe("civil");
  });

  it("should name nobody when none or several teams hold admin", () => {
    expect(soleAdmin(new Map<string, AccessLevel>([["civil", "push"]]))).toBeUndefined();
    expect(
      soleAdmin(
        new Map<string, AccessLevel>([
          ["civil", "admin"],
          ["platform", "admin"]
        ])
      )
    ).toBeUndefined();
  });
});

describe("mostSpecificClaim", () => {
  it("should prefer the most permissive access", () => {
    const claims = new Map<string, AccessLevel>([
      ["writer", "push"],
      ["maintainer", "maintain"]
    ]);

    expect(mostSpecificClaim(claims, new Map())).toBe("maintainer");
  });

  it("should break a tie on access towards the smallest team", () => {
    // Where an organisation-wide platform team and a service team both hold push on that service, the
    // specific claim is the informative one.
    const claims = new Map<string, AccessLevel>([
      ["platform", "push"],
      ["service", "push"]
    ]);

    expect(
      mostSpecificClaim(
        claims,
        new Map([
          ["platform", 400],
          ["service", 3]
        ])
      )
    ).toBe("service");
  });

  it("should break a tie on access and size alphabetically", () => {
    const claims = new Map<string, AccessLevel>([
      ["zebra", "push"],
      ["alpha", "push"]
    ]);

    expect(mostSpecificClaim(claims, new Map())).toBe("alpha");
  });
});

describe("choosing between nothing", () => {
  // The ladder only reaches these having found something to choose between, so an empty call is a caller bug.
  // Naming it beats `reduce of empty array with no initial value`, which says nothing about which rung was
  // wrong.
  it("should name itself when asked to choose between no claims", () => {
    expect(() => mostSpecificClaim(new Map(), new Map())).toThrow(/no claims to choose between/);
  });

  it("should name itself when asked to choose between no owners", () => {
    expect(() => mostSpecificOwner([], new Map())).toThrow(/no owners to choose between/);
  });

  it("should let a prefix nobody agreed on decline to speak rather than throwing", () => {
    // Unlike the two above, an empty count map is a legitimate state: `inferFromName` walks prefixes without
    // knowing which will answer.
    const index = new Map([["sscs", new Map<string, number>()]]);

    expect(inferFromName("sscs-api", index, ownershipOptions())).toBeUndefined();
  });
});

describe("mostSpecificOwner", () => {
  it("should prefer the team named in fewest repositories, then the earlier slug", () => {
    const sizes = new Map([
      ["shared", 40],
      ["narrow", 2],
      ["alpha", 2]
    ]);

    expect(mostSpecificOwner(["shared", "narrow", "alpha"], sizes)).toBe("alpha");
    expect(mostSpecificOwner(["shared", "narrow"], sizes)).toBe("narrow");
  });
});

describe("decideFromEvidence", () => {
  function evidenceOf(facts: OrgFacts, options: OwnershipOptions = ownershipOptions()) {
    return { evidence: ownershipEvidence(facts, options), options, facts };
  }

  it("should let a configured override short-circuit every collected rung", () => {
    const facts = orgFacts({ repositories: repositories("civil"), teamRepositories: [owns("collected", "civil", "admin")] });
    const options = ownershipOptions({ configured: new Map([["civil", ["Reviewed-Team"]]]) });
    const { evidence } = evidenceOf(facts, options);

    expect(decideFromEvidence("civil", evidence, options, facts)).toEqual([
      { kind: OwnerKind.Team, owner: "reviewed-team", rung: OwnershipRung.Configured, detail: "configured in metrics.yaml" }
    ]);
  });

  it("should attribute a sole admin team, and say that it was sole", () => {
    const facts = orgFacts({ repositories: repositories("civil"), teamRepositories: [owns("civil", "civil", "admin"), owns("platform", "civil", "push")] });
    const { evidence, options } = evidenceOf(facts);

    expect(decideFromEvidence("civil", evidence, options, facts)).toEqual([
      { kind: OwnerKind.Team, owner: "civil", rung: OwnershipRung.TeamsApiAdmin, detail: "sole team holding admin" }
    ]);
  });

  it("should return every admin team when several hold admin", () => {
    // The one deliberate extension over the Python script, which forced a single owner: a repository with
    // two admin teams has two owners, and collapsing that to one invents a tie-break nobody made.
    const facts = orgFacts({ repositories: repositories("civil"), teamRepositories: [owns("beta", "civil", "admin"), owns("alpha", "civil", "admin")] });
    const resolved = attributeOwnership(facts, ownershipOptions());

    expect(resolved[0]?.owners).toEqual([
      { kind: OwnerKind.Team, owner: "alpha", rung: OwnershipRung.TeamsApiAdmin, detail: "one of 2 teams holding admin" },
      { kind: OwnerKind.Team, owner: "beta", rung: OwnershipRung.TeamsApiAdmin, detail: "one of 2 teams holding admin" }
    ]);
    expect(resolved[0]?.primary.owner).toBe("alpha");
  });

  it("should let a sole admin team outrank a sole CODEOWNERS team", () => {
    const facts = orgFacts({
      repositories: repositories("civil"),
      teamRepositories: [owns("civil", "civil", "admin")],
      codeowners: codeownersFor([{ repository: "civil", teams: ["reviewers"] }])
    });

    expect(primaryOf(attributeOwnership(facts, ownershipOptions()), "civil")).toMatchObject({ owner: "civil", rung: OwnershipRung.TeamsApiAdmin });
  });

  it("should attribute a sole CODEOWNERS team, citing the path it was read from", () => {
    const facts = orgFacts({
      repositories: repositories("civil"),
      codeowners: codeownersFor([{ repository: "civil", teams: ["reviewers"], paths: ["CODEOWNERS"] }])
    });

    expect(primaryOf(attributeOwnership(facts, ownershipOptions()), "civil")).toEqual({
      kind: OwnerKind.Team,
      owner: "reviewers",
      rung: OwnershipRung.CodeownersSole,
      detail: "sole team in CODEOWNERS (CODEOWNERS)"
    });
  });

  it("should let a sole CODEOWNERS team outrank a contested API claim", () => {
    // Access says who CAN merge and CODEOWNERS says who is EXPECTED to review; where they disagree the less
    // ambiguous of the two is the better guess.
    const facts = orgFacts({
      repositories: repositories("civil"),
      teamRepositories: [owns("platform", "civil", "push"), owns("tooling", "civil", "push")],
      codeowners: codeownersFor([{ repository: "civil", teams: ["reviewers"] }])
    });

    expect(primaryOf(attributeOwnership(facts, ownershipOptions()), "civil")).toMatchObject({ owner: "reviewers", rung: OwnershipRung.CodeownersSole });
  });

  it("should attribute a contested write claim to the smallest of the claiming teams", () => {
    const facts = orgFacts({
      repositories: repositories("civil", "other", "third"),
      teamRepositories: [owns("platform", "civil"), owns("platform", "other"), owns("platform", "third"), owns("civil", "civil")]
    });

    expect(primaryOf(attributeOwnership(facts, ownershipOptions()), "civil")).toEqual({
      kind: OwnerKind.Team,
      owner: "civil",
      rung: OwnershipRung.TeamsApiWrite,
      detail: "holds push among 2 claiming teams, and holds 1 repositories"
    });
  });

  it("should let any API claim outrank several CODEOWNERS teams", () => {
    const facts = orgFacts({
      repositories: repositories("civil"),
      teamRepositories: [owns("platform", "civil"), owns("tooling", "civil")],
      codeowners: codeownersFor([{ repository: "civil", teams: ["one", "two"] }])
    });

    expect(primaryOf(attributeOwnership(facts, ownershipOptions()), "civil").rung).toBe(OwnershipRung.TeamsApiWrite);
  });

  it("should choose between several CODEOWNERS teams by how many repositories name them", () => {
    const facts = orgFacts({
      repositories: repositories("civil", "other"),
      codeowners: codeownersFor([
        { repository: "civil", teams: ["shared", "narrow"] },
        { repository: "other", teams: ["shared"] }
      ])
    });

    expect(primaryOf(attributeOwnership(facts, ownershipOptions()), "civil")).toEqual({
      kind: OwnerKind.Team,
      owner: "narrow",
      rung: OwnershipRung.CodeownersFirst,
      detail: "one of 2 teams in CODEOWNERS (.github/CODEOWNERS), named in 1 repositories"
    });
  });

  it("should attribute every person CODEOWNERS names once no team has answered", () => {
    const facts = orgFacts({ repositories: repositories("civil"), codeowners: codeownersFor([{ repository: "civil", people: ["Bob", "alice"] }]) });

    expect(attributeOwnership(facts, ownershipOptions())[0]?.owners).toEqual([
      { kind: OwnerKind.Person, owner: "alice", rung: OwnershipRung.CodeownersPerson, detail: "named in CODEOWNERS (.github/CODEOWNERS)" },
      { kind: OwnerKind.Person, owner: "bob", rung: OwnershipRung.CodeownersPerson, detail: "named in CODEOWNERS (.github/CODEOWNERS)" }
    ]);
  });

  it("should let a team CODEOWNERS names outrank a person it names alongside", () => {
    // An individual owner is the outlier the ladder falls back to, never a competitor to a team.
    const facts = orgFacts({
      repositories: repositories("civil"),
      codeowners: codeownersFor([{ repository: "civil", teams: ["reviewers"], people: ["alice"] }])
    });

    expect(primaryOf(attributeOwnership(facts, ownershipOptions()), "civil").rung).toBe(OwnershipRung.CodeownersSole);
  });

  it("should fall back to the direct collaborators holding admin", () => {
    const facts = orgFacts({ repositories: repositories("civil"), directAdmins: new Map([["civil", ["Carol"]]]) });

    expect(primaryOf(attributeOwnership(facts, ownershipOptions()), "civil")).toEqual({
      kind: OwnerKind.Person,
      owner: "carol",
      rung: OwnershipRung.DirectCollaborator,
      detail: "direct collaborator holding admin"
    });
  });

  it("should let a person CODEOWNERS names outrank a direct collaborator", () => {
    const facts = orgFacts({
      repositories: repositories("civil"),
      codeowners: codeownersFor([{ repository: "civil", people: ["alice"] }]),
      directAdmins: new Map([["civil", ["carol"]]])
    });

    expect(primaryOf(attributeOwnership(facts, ownershipOptions()), "civil").rung).toBe(OwnershipRung.CodeownersPerson);
  });

  it("should decide the CODEOWNERS rungs without the per-repository paths, which are only detail", () => {
    const facts = orgFacts({ repositories: repositories("civil"), codeowners: codeownersFor([{ repository: "civil", teams: ["reviewers"], paths: [] }]) });
    const { evidence, options } = evidenceOf(facts);

    expect(decideFromEvidence("civil", evidence, options)).toEqual([
      { kind: OwnerKind.Team, owner: "reviewers", rung: OwnershipRung.CodeownersSole, detail: "sole team in CODEOWNERS (no path recorded)" }
    ]);
  });

  it("should leave a repository nothing claimed for the name pass", () => {
    const facts = orgFacts({ repositories: repositories("civil") });
    const { evidence, options } = evidenceOf(facts);

    expect(decideFromEvidence("civil", evidence, options, facts)).toBeUndefined();
  });
});

describe("prefixesOf", () => {
  it("should list candidate family prefixes longest first, up to three segments", () => {
    expect(prefixesOf("api-cp-crime-portal")).toEqual(["api-cp-crime", "api-cp", "api"]);
  });

  it("should leave out a prefix too short to be a family rather than an accident of naming", () => {
    expect(prefixesOf("ab-cd")).toEqual(["ab-cd"]);
  });

  it("should offer a whole name with no separators as its only prefix", () => {
    expect(prefixesOf("cftlib")).toEqual(["cftlib"]);
  });
});

describe("prefixIndex", () => {
  function decision(repository: string, owner: string, rung: OwnershipRung, kind: OwnerKind = OwnerKind.Team): ResolvedOwnership {
    const primary = { kind, owner, rung, detail: "" };
    return { repository, owners: [primary], primary };
  }

  it("should count only evidenced team decisions, so inference can never widen a prefix", () => {
    // Were an inferred repository allowed into the index, one wrong guess could reach the support threshold
    // on its own and then attribute a whole family to the team it was wrong about.
    const index = prefixIndex(
      [
        decision("sscs-one", "sscs", OwnershipRung.TeamsApiAdmin),
        decision("sscs-two", "sscs", OwnershipRung.CodeownersSole),
        decision("sscs-three", "sscs", OwnershipRung.NamePrefix),
        decision("sscs-four", "", OwnershipRung.Unowned, OwnerKind.None)
      ],
      new Set()
    );

    expect(index.get("sscs")).toEqual(new Map([["sscs", 2]]));
  });

  it("should let no person vote on a name family", () => {
    const index = prefixIndex([decision("sscs-one", "alice", OwnershipRung.CodeownersPerson, OwnerKind.Person)], new Set());

    expect(index.has("sscs")).toBe(false);
  });

  it("should keep a team the organisation did not list out of the index", () => {
    const index = prefixIndex([decision("sscs-one", "ghost", OwnershipRung.CodeownersSole)], new Set(["real"]));

    expect(index.size).toBe(0);
  });

  it("should treat an empty team list as no list rather than as an organisation with no teams", () => {
    // A token that could not list teams must not be read as denying all of them.
    const index = prefixIndex([decision("sscs-one", "ghost", OwnershipRung.CodeownersSole)], new Set());

    expect(index.get("sscs")).toEqual(new Map([["ghost", 1]]));
  });
});

describe("inferFromName", () => {
  it("should break a tie between equally common teams on the earlier slug", () => {
    // Python's Counter.most_common is insertion-ordered on ties, which is not reproducible in a port, so a
    // stated order is used instead: most repositories, then the earlier slug.
    const index = new Map([
      [
        "sscs",
        new Map([
          ["zebra", 2],
          ["alpha", 2]
        ])
      ]
    ]);

    expect(inferFromName("sscs-new", index, ownershipOptions({ prefixSupport: 4, prefixDominance: 0.5 }))?.team).toBe("alpha");
  });

  it("should fall through a prefix that fails the thresholds to a shorter one", () => {
    const index = new Map([
      ["sscs-tya", new Map([["tya", 1]])],
      ["sscs", new Map([["sscs", 6]])]
    ]);

    expect(inferFromName("sscs-tya-new", index, ownershipOptions())).toMatchObject({ team: "sscs", prefix: "sscs", agreeing: 6, total: 6 });
  });

  it("should infer nothing from a name no prefix in the index reaches", () => {
    expect(inferFromName("unrelated-thing", new Map([["sscs", new Map([["sscs", 9]])]]), ownershipOptions())).toBeUndefined();
  });
});

describe("attributeOwnership", () => {
  it("should not attribute by name until a prefix reaches the support threshold", () => {
    const twoSiblings = orgFacts({
      ...family([
        ["sscs-one", "sscs"],
        ["sscs-two", "sscs"]
      ]),
      repositories: repositories("sscs-one", "sscs-two", "sscs-later")
    });

    expect(primaryOf(attributeOwnership(twoSiblings, ownershipOptions({ prefixSupport: 3 })), "sscs-later").rung).toBe(OwnershipRung.Unowned);
  });

  it("should attribute by name once a prefix reaches exactly the support threshold", () => {
    const threeSiblings = orgFacts({
      ...family([
        ["sscs-one", "sscs"],
        ["sscs-two", "sscs"],
        ["sscs-three", "sscs"]
      ]),
      repositories: repositories("sscs-one", "sscs-two", "sscs-three", "sscs-later")
    });

    expect(primaryOf(attributeOwnership(threeSiblings, ownershipOptions({ prefixSupport: 3 })), "sscs-later")).toEqual({
      kind: OwnerKind.Team,
      owner: "sscs",
      rung: OwnershipRung.NamePrefix,
      detail: 'name family "sscs": 3 of 3 attributed repositories agree'
    });
  });

  it("should not attribute by name from a prefix its members do not agree well enough on", () => {
    // Three of four is 0.75, just under the 0.8 default.
    const divided = orgFacts({
      ...family([
        ["sscs-one", "sscs"],
        ["sscs-two", "sscs"],
        ["sscs-three", "sscs"],
        ["sscs-odd", "other"]
      ]),
      repositories: repositories("sscs-one", "sscs-two", "sscs-three", "sscs-odd", "sscs-later")
    });

    expect(primaryOf(attributeOwnership(divided, ownershipOptions()), "sscs-later").rung).toBe(OwnershipRung.Unowned);
  });

  it("should attribute by name from a prefix that agrees to exactly the dominance threshold", () => {
    // Four of five is 0.8 exactly, and the comparison is inclusive.
    const mostlyAgreed = orgFacts({
      ...family([
        ["sscs-one", "sscs"],
        ["sscs-two", "sscs"],
        ["sscs-three", "sscs"],
        ["sscs-four", "sscs"],
        ["sscs-odd", "other"]
      ]),
      repositories: repositories("sscs-one", "sscs-two", "sscs-three", "sscs-four", "sscs-odd", "sscs-later")
    });

    expect(primaryOf(attributeOwnership(mostlyAgreed, ownershipOptions()), "sscs-later")).toMatchObject({
      owner: "sscs",
      rung: OwnershipRung.NamePrefix,
      detail: 'name family "sscs": 4 of 5 attributed repositories agree'
    });
  });

  it("should not let an inferred repository widen the prefix that inferred it", () => {
    // Two evidenced siblings and two unclaimed ones. Had either inference joined the index, the prefix would
    // have reached the support of three and the second unclaimed repository would have been attributed.
    const facts = orgFacts({
      ...family([
        ["sscs-one", "sscs"],
        ["sscs-two", "sscs"]
      ]),
      repositories: repositories("sscs-one", "sscs-two", "sscs-later", "sscs-latest")
    });

    const resolved = attributeOwnership(facts, ownershipOptions({ prefixSupport: 3 }));

    expect(primaryOf(resolved, "sscs-later").rung).toBe(OwnershipRung.Unowned);
    expect(primaryOf(resolved, "sscs-latest").rung).toBe(OwnershipRung.Unowned);
    expect(prefixIndex(resolved, facts.knownTeams).get("sscs")).toEqual(new Map([["sscs", 2]]));
  });

  it("should let a team the organisation did not list group its own repositories but attribute nothing by name", () => {
    // Grouping the repository that names the handle is faithful to what its CODEOWNERS says; spreading a
    // possibly-dead label across a whole name family on the strength of it is not.
    const facts = orgFacts({
      knownTeams: new Set(["real"]),
      repositories: repositories("ghost-one", "ghost-two", "ghost-three", "ghost-later"),
      codeowners: codeownersFor(["ghost-one", "ghost-two", "ghost-three"].map((repository) => ({ repository, teams: ["ghost"] })))
    });

    const resolved = attributeOwnership(facts, ownershipOptions());

    expect(primaryOf(resolved, "ghost-one")).toMatchObject({ owner: "ghost", rung: OwnershipRung.CodeownersSole });
    expect(primaryOf(resolved, "ghost-later").rung).toBe(OwnershipRung.Unowned);
  });

  it("should attribute by name once that same team is in the organisation's list", () => {
    const facts = orgFacts({
      knownTeams: new Set(["ghost", "real"]),
      repositories: repositories("ghost-one", "ghost-two", "ghost-three", "ghost-later"),
      codeowners: codeownersFor(["ghost-one", "ghost-two", "ghost-three"].map((repository) => ({ repository, teams: ["ghost"] })))
    });

    expect(primaryOf(attributeOwnership(facts, ownershipOptions()), "ghost-later")).toMatchObject({ owner: "ghost", rung: OwnershipRung.NamePrefix });
  });

  it("should carry the rungs that were walked on a repository nothing owns", () => {
    // A remembered negative: "nothing owns it" has to stay distinguishable from "we never looked".
    const resolved = attributeOwnership(orgFacts({ repositories: repositories("orphan") }), ownershipOptions());

    expect(resolved[0]?.owners).toHaveLength(1);
    expect(resolved[0]?.primary.kind).toBe(OwnerKind.None);
    expect(resolved[0]?.primary.owner).toBe("");
    expect(resolved[0]?.primary.detail).toBe(
      "no rung answered; walked configured, teams-api-admin, codeowners-sole, teams-api-write, codeowners-first, codeowners-person, direct-collaborator-admin, name-prefix"
    );
  });

  it("should return every repository exactly once, sorted, with a non-empty owners list", () => {
    const facts = orgFacts({
      repositories: [...repositories("zebra", "alpha", "middle"), archived("gone")],
      teamRepositories: [owns("alpha", "alpha", "admin")]
    });

    const resolved = attributeOwnership(facts, ownershipOptions());

    expect(resolved.map((ownership) => ownership.repository)).toEqual(["alpha", "middle", "zebra"]);
    expect(resolved.every((ownership) => ownership.owners.length > 0 && ownership.owners[0] === ownership.primary)).toBe(true);
  });

  it("should produce identical output from identical input, so two runs are diffable", () => {
    const facts = orgFacts({
      knownTeams: new Set(["sscs", "other"]),
      ...family([
        ["sscs-one", "sscs"],
        ["sscs-two", "sscs"],
        ["sscs-three", "sscs"]
      ]),
      repositories: repositories("sscs-one", "sscs-two", "sscs-three", "sscs-later", "orphan"),
      codeowners: codeownersFor([{ repository: "orphan", teams: ["other", "sscs"] }])
    });

    expect(attributeOwnership(facts, ownershipOptions())).toEqual(attributeOwnership(facts, ownershipOptions()));
  });
});

describe("rungCounts", () => {
  it("should count each repository by the rung its primary owner came from, in precedence order", () => {
    const facts = orgFacts({
      knownTeams: new Set(["sscs"]),
      ...family([
        ["sscs-one", "sscs"],
        ["sscs-two", "sscs"],
        ["sscs-three", "sscs"]
      ]),
      repositories: repositories("sscs-one", "sscs-two", "sscs-three", "sscs-later", "orphan")
    });

    const counts = rungCounts(attributeOwnership(facts, ownershipOptions()));

    expect([...counts]).toEqual([
      [OwnershipRung.TeamsApiAdmin, 3],
      [OwnershipRung.NamePrefix, 1],
      [OwnershipRung.Unowned, 1]
    ]);
  });

  it("should omit a rung that attributed nothing rather than report it as zero", () => {
    const counts = rungCounts(attributeOwnership(orgFacts({ repositories: repositories("orphan") }), ownershipOptions()));

    expect([...counts.keys()]).toEqual([OwnershipRung.Unowned]);
  });
});

describe("unresolvedRepositories", () => {
  it("should name only the repositories the free rungs left open", () => {
    // Team access and a configured override are already collected, so they cost nothing; CODEOWNERS and the
    // collaborator listing are per-repository requests and are only worth making for the residue.
    const facts = orgFacts({
      repositories: [...repositories("claimed", "reviewed", "named", "orphan"), archived("gone")],
      teamRepositories: [owns("civil", "claimed", "admin")],
      codeowners: codeownersFor([{ repository: "named", teams: ["reviewers"] }])
    });
    const configured = new Map([["reviewed", ["reviewed-team"]]]);
    const evidence = ownershipEvidence(facts, ownershipOptions({ configured }));

    expect(unresolvedRepositories(facts, evidence, configured)).toEqual(["named", "orphan"]);
  });

  it("should treat an unchecked override as unresolved rather than skip it, which costs a request and is never wrong", () => {
    const facts = orgFacts({ repositories: repositories("reviewed") });
    const evidence = ownershipEvidence(facts, ownershipOptions());

    expect(unresolvedRepositories(facts, evidence)).toEqual(["reviewed"]);
  });
});
