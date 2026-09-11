import { describe, expect, it, vi } from "vitest";
import { parseConfiguration } from "../policy/load.ts";
import type { Configuration } from "../policy/schema.ts";
import type { LiveOrgRepository, LiveRepositoryOwnership } from "../store/org-graph.ts";
import {
  type CohortEntry,
  type CohortPolicy,
  CohortUncollectedError,
  cohortOwners,
  cohortPolicy,
  cohortRepositories,
  cohortTeams,
  pushedWithin,
  readCohort,
  selectCohort,
  servedCohort,
  UnownedIdentifier
} from "./cohort.ts";
import { OwnerKind } from "./graph.ts";

// `selectCohort`, `pushedWithin`, `cohortPolicy` and `cohortTeams` are pure, so they are called with literals
// and nothing is stubbed for them. Only the three readers touch Postgres, and the store module is the one thing
// mocked — the two `live*` functions are the whole of the impurity, so faking them leaves the selection under
// test entirely real.
const liveOrgRepositories = vi.hoisted(() => vi.fn<(organization: string) => Promise<LiveOrgRepository[]>>());
const liveRepositoryOwnership = vi.hoisted(() => vi.fn<(organization: string) => Promise<LiveRepositoryOwnership[]>>());

vi.mock("../store/org-graph.ts", () => ({ liveOrgRepositories, liveRepositoryOwnership }));

/**
 * One fixed instant every window test measures from.
 *
 * Never `new Date()`: a window fixture written against the clock passes today and fails in ninety days, which is
 * a suite that breaks with the passage of time rather than with a change to the code.
 */
const REFERENCE = new Date("2026-03-01T12:00:00Z");

function daysBefore(days: number): Date {
  return new Date(REFERENCE.getTime() - days * 24 * 60 * 60 * 1000);
}

/**
 * A live row with NO last push, which is how the reader represents a null column.
 *
 * The base builder rather than a variant of it, because absence is the interesting case and building it by
 * spreading `pushedAt: undefined` over a row that has one would leave the key present.
 */
function neverPushed(name: string, overrides: Partial<LiveOrgRepository> = {}): LiveOrgRepository {
  return { repository: name, archived: false, visibility: "public", payload: {}, observedAt: REFERENCE, lastObservedAt: REFERENCE, ...overrides };
}

/** A live row pushed to yesterday, so anything a test does not state about it is inside every window it sets. */
function repository(name: string, overrides: Partial<LiveOrgRepository> = {}): LiveOrgRepository {
  return neverPushed(name, { pushedAt: daysBefore(1), ...overrides });
}

function ownedBy(name: string, owner: string, ownerKind: OwnerKind = OwnerKind.Team): LiveRepositoryOwnership {
  return { repository: name, ownerKind, owner, rung: "teams-api-admin", payload: {}, observedAt: REFERENCE, lastObservedAt: REFERENCE };
}

/** The ladder's remembered negative: a row saying nothing owns this, which is not the same as no row. */
function ownedByNobody(name: string): LiveRepositoryOwnership {
  return { ...ownedBy(name, "", OwnerKind.None), rung: "unowned" };
}

/**
 * A policy admitting public repositories pushed to within ninety days.
 *
 * Every filter is stated rather than defaulted, so a test that is about one of them changes that one and the
 * others cannot quietly decide the case.
 */
function policyOf(overrides: Partial<CohortPolicy> = {}): CohortPolicy {
  return { visibilities: new Set(["public"]), includeArchived: false, activeWithinDays: 90, excluded: new Set(), ...overrides };
}

/**
 * A cohort entry owned by a team, since that is the case every ordering fixture is about.
 *
 * The kind is a parameter rather than always `team` because it is what decides whether an entry gets a card at
 * all, and a builder that could only make teams would leave the whole exclusion untestable.
 */
function entryOf(name: string, owners: string[], ownerKind: OwnerKind = OwnerKind.Team): CohortEntry {
  return { repository: name, owners, ownerKind, archived: false, visibility: "public" };
}

/** A real parsed configuration, so what the reading tests exercise is the policy the schema actually produces. */
function configurationOf(...lines: string[]): Configuration {
  return parseConfiguration(["version: 1", "organization: hmcts", ...lines].join("\n"));
}

function graphHolding(repositories: LiveOrgRepository[], ownership: LiveRepositoryOwnership[] = []): void {
  liveOrgRepositories.mockResolvedValue(repositories);
  liveRepositoryOwnership.mockResolvedValue(ownership);
}

/** The error `readCohort` refused with, so a test can compare two refusals rather than only match one. */
async function refusalOf(configuration: Configuration): Promise<Error> {
  try {
    await readCohort(configuration, REFERENCE);
  } catch (error) {
    return error as Error;
  }
  throw new Error("readCohort resolved where it was expected to refuse");
}

describe("selectCohort", () => {
  it("should keep a repository whose visibility the policy counts and drop one whose it does not", () => {
    const repositories = [repository("open-service"), repository("closed-service", { visibility: "private" })];

    expect(selectCohort(repositories, [], policyOf(), REFERENCE).map((entry) => entry.repository)).toEqual(["open-service"]);
  });

  it("should match visibility case-insensitively, since the graph stores whatever GitHub sent", () => {
    // GitHub's REST and GraphQL surfaces disagree on the case of this field, so the column carries both. A
    // case-sensitive comparison would silently empty the cohort of every repository collected through one of them.
    const repositories = [repository("shouty", { visibility: "PUBLIC" })];

    expect(selectCohort(repositories, [], policyOf(), REFERENCE).map((entry) => entry.repository)).toEqual(["shouty"]);
  });

  it("should exclude an archived repository by default and keep it once the policy asks for archived ones", () => {
    const repositories = [repository("retired", { archived: true })];

    expect(selectCohort(repositories, [], policyOf(), REFERENCE)).toEqual([]);
    expect(selectCohort(repositories, [], policyOf({ includeArchived: true }), REFERENCE).map((entry) => entry.repository)).toEqual(["retired"]);
  });

  it("should drop an excluded repository even where every other rule admits it", () => {
    // `excluded_repositories` is a decision somebody took, and the graph cannot hold decisions — so it has to
    // outrank everything the graph says, not merely join it.
    const repositories = [repository("reported"), repository("suppressed")];

    const entries = selectCohort(repositories, [], policyOf({ excluded: new Set(["suppressed"]) }), REFERENCE);

    expect(entries.map((entry) => entry.repository)).toEqual(["reported"]);
  });

  it("should keep a repository pushed to inside the window and drop one pushed to before it", () => {
    const repositories = [repository("busy", { pushedAt: daysBefore(10) }), repository("dormant", { pushedAt: daysBefore(400) })];

    expect(selectCohort(repositories, [], policyOf({ activeWithinDays: 90 }), REFERENCE).map((entry) => entry.repository)).toEqual(["busy"]);
  });

  it("should keep a very old push once the window is off, which is what turning it off is for", () => {
    const repositories = [repository("ancient", { pushedAt: new Date("2014-01-01T00:00:00Z") })];

    expect(selectCohort(repositories, [], policyOf({ activeWithinDays: undefined }), REFERENCE).map((entry) => entry.repository)).toEqual(["ancient"]);
  });

  it("should not read an absent push as activity while a window is set", () => {
    // THE CASE THAT WOULD HAVE SELECTED THE WHOLE ORGANISATION. `pushed_at` is null on every row collected
    // before the column existed, so had absence counted as active, the first run after the migration would have
    // admitted all 3,277 repositories. An empty cohort is a visible failure; that one is an invisible bill.
    const repositories = [neverPushed("never-pushed"), repository("pushed")];

    expect(selectCohort(repositories, [], policyOf({ activeWithinDays: 90 }), REFERENCE).map((entry) => entry.repository)).toEqual(["pushed"]);
  });

  it("should keep a repository with no recorded push once the window is off", () => {
    // With no window there is nothing to compare against, so the absence stops being disqualifying — an empty
    // repository somebody created on Tuesday is still part of the estate.
    const repositories = [neverPushed("never-pushed")];

    expect(selectCohort(repositories, [], policyOf({ activeWithinDays: undefined }), REFERENCE).map((entry) => entry.repository)).toEqual(["never-pushed"]);
  });

  it("should report a repository under the team its ownership row names", () => {
    const entries = selectCohort([repository("civil-service")], [ownedBy("civil-service", "civil")], policyOf(), REFERENCE);

    expect(entries).toEqual([
      { repository: "civil-service", owners: ["civil"], ownerKind: OwnerKind.Team, archived: false, visibility: "public", pushedAt: daysBefore(1) }
    ]);
  });

  it("should carry every owner of a repository several teams hold", () => {
    const ownership = [ownedBy("shared", "zebra"), ownedBy("shared", "alpha")];

    expect(selectCohort([repository("shared")], ownership, policyOf(), REFERENCE)[0]?.owners).toEqual(["alpha", "zebra"]);
  });

  it("should report a repository whose only ownership row says nobody under the unowned bucket", () => {
    const entries = selectCohort([repository("orphan")], [ownedByNobody("orphan")], policyOf(), REFERENCE);

    expect(entries[0]?.owners).toEqual([UnownedIdentifier]);
  });

  it("should still report a selected repository that has no ownership row at all", () => {
    // The two tables disagreeing is the normal state of a repository collected after the last attribution ran.
    // Dropping it would shrink the estate by exactly the repositories nobody has looked at yet, which is the
    // direction of error nobody checks.
    const entries = selectCohort([repository("collected-since")], [ownedBy("something-else", "civil")], policyOf(), REFERENCE);

    expect(entries).toEqual([
      { repository: "collected-since", owners: [UnownedIdentifier], ownerKind: OwnerKind.None, archived: false, visibility: "public", pushedAt: daysBefore(1) }
    ]);
  });

  it("should carry the kind of owner a row names, which the name itself cannot say", () => {
    // A slug and a login are the same shape. Without the kind, `a1i-hussain` and `civil-admins` are two
    // strings a report has no way to tell apart, which is how 126 people came to have team cards.
    const repositories = [repository("team-owned"), repository("person-owned")];
    const ownership = [ownedBy("team-owned", "civil-admins"), ownedBy("person-owned", "a1i-hussain", OwnerKind.Person)];

    const kinds = new Map(selectCohort(repositories, ownership, policyOf(), REFERENCE).map((entry) => [entry.repository, entry.ownerKind]));

    expect(kinds.get("team-owned")).toBe(OwnerKind.Team);
    expect(kinds.get("person-owned")).toBe(OwnerKind.Person);
  });

  it("should read an ownership row whose kind this build does not know as unowned", () => {
    // The column is `text`, so a kind written by a newer collector can reach an older reader. Reported as a
    // team it would put whatever the string was on the teams page, which is the failure the kind exists to fix.
    const ownership = [{ ...ownedBy("odd", "something"), ownerKind: "consortium" as OwnerKind }];

    expect(selectCohort([repository("odd")], ownership, policyOf(), REFERENCE)[0]?.ownerKind).toBe(OwnerKind.None);
  });

  it("should report a repository with a team row and a person row under the team alone", () => {
    // The ladder reaches a person only once no team rung answered, so rows of both kinds are two collections'
    // answers overlapping rather than co-owners. Kept together, the login would be listed as a second owning
    // team — the exact thing the kind is carried to prevent.
    const ownership = [ownedBy("both", "a1i-hussain", OwnerKind.Person), ownedBy("both", "civil-admins")];

    const entry = selectCohort([repository("both")], ownership, policyOf(), REFERENCE)[0];

    expect(entry?.owners).toEqual(["civil-admins"]);
    expect(entry?.ownerKind).toBe(OwnerKind.Team);
  });

  it("should keep every person where several people own one repository", () => {
    // `direct-collaborator-admin` yields one owner per admin collaborator, so several people is a real answer
    // and not a kind collision — the precedence reduces ACROSS kinds and must not reduce within one.
    const ownership = [ownedBy("shared", "zoe", OwnerKind.Person), ownedBy("shared", "amir", OwnerKind.Person)];

    expect(selectCohort([repository("shared")], ownership, policyOf(), REFERENCE)[0]?.owners).toEqual(["amir", "zoe"]);
  });

  it("should collapse two ownership rows naming the same owner into one", () => {
    // One live row per (repository, owner-kind, owner) is an index guarantee, but the same owner can arrive
    // twice across kinds — and a team reported twice would double it in every count derived from this list.
    const ownership = [ownedBy("civil-service", "civil"), { ...ownedBy("civil-service", "civil"), rung: "codeowners-sole" }];

    expect(selectCohort([repository("civil-service")], ownership, policyOf(), REFERENCE)[0]?.owners).toEqual(["civil"]);
  });
});

describe("the reporting order", () => {
  /**
   * A fixture whose (owner, repository) order is NOT its repository order.
   *
   * `alpha-service` sorts first by name and last by owner, which is the only kind of fixture that can tell the
   * two orders apart — one sorted by repository alone would pass under either rule.
   */
  function crossedOrders(): { repositories: LiveOrgRepository[]; ownership: LiveRepositoryOwnership[] } {
    return {
      repositories: [repository("alpha-service"), repository("zebra-service"), repository("middle-service")],
      ownership: [ownedBy("alpha-service", "zebra-team"), ownedBy("zebra-service", "alpha-team"), ownedBy("middle-service", "alpha-team")]
    };
  }

  it("should order by owner and then by repository, not by repository alone", () => {
    const { repositories, ownership } = crossedOrders();

    const entries = selectCohort(repositories, ownership, policyOf(), REFERENCE);

    expect(entries.map((entry) => [entry.owners[0], entry.repository])).toEqual([
      ["alpha-team", "middle-service"],
      ["alpha-team", "zebra-service"],
      ["zebra-team", "alpha-service"]
    ]);
  });

  it("should produce identical output from identical input, so two runs are diffable", () => {
    const { repositories, ownership } = crossedOrders();

    expect(selectCohort(repositories, ownership, policyOf(), REFERENCE)).toEqual(selectCohort(repositories, ownership, policyOf(), REFERENCE));
  });
});

describe("pushedWithin", () => {
  it("should count a push exactly on the boundary as inside, the window being a maximum age", () => {
    expect(pushedWithin(daysBefore(90), 90, REFERENCE)).toBe(true);
    expect(pushedWithin(daysBefore(91), 90, REFERENCE)).toBe(false);
  });

  it("should not count an absent push as activity", () => {
    expect(pushedWithin(undefined, 90, REFERENCE)).toBe(false);
  });
});

describe("cohortPolicy", () => {
  it("should read the visibilities, the archive rule and the window out of the file", () => {
    const policy = cohortPolicy(configurationOf("cohort:", "  visibilities: [public, internal]", "  include_archived: true", "  active_within_days: 30"));

    expect(policy.visibilities).toEqual(new Set(["public", "internal"]));
    expect(policy.includeArchived).toBe(true);
    expect(policy.activeWithinDays).toBe(30);
  });

  it("should lower-case the visibilities, so the policy compares against what the graph stores", () => {
    // The schema's enum is already lower-case, so a parsed file cannot reach this fold and a cast is the only
    // way to state the case at all. It is worth stating because the set it builds is compared against a column
    // carrying GitHub's own casing, and a configuration built any other way than by the schema would break that.
    const parsed = configurationOf();
    const visibilities = ["PUBLIC", "Internal"] as unknown as Configuration["cohort"]["visibilities"];

    expect(cohortPolicy({ ...parsed, cohort: { ...parsed.cohort, visibilities } }).visibilities).toEqual(new Set(["public", "internal"]));
  });

  it("should turn a null window into an absent one rather than into a window of zero days", () => {
    const policy = cohortPolicy(configurationOf("cohort:", "  active_within_days: null"));

    expect(policy.activeWithinDays).toBeUndefined();
    // Absent and not merely undefined: `selectCohort` reads the field's presence as the switch, and a key set to
    // undefined would survive a round trip through anything that copies own properties.
    expect(Object.hasOwn(policy, "activeWithinDays")).toBe(false);
  });

  it("should carry the excluded repositories through from the top level of the file", () => {
    const policy = cohortPolicy(configurationOf("excluded_repositories:", "  - retired-service"));

    expect(policy.excluded).toEqual(new Set(["retired-service"]));
  });
});

describe("readCohort", () => {
  it("should select from the graph the policy the configuration states", async () => {
    graphHolding([repository("open-service"), repository("closed-service", { visibility: "private" })], [ownedBy("open-service", "civil")]);

    const entries = await readCohort(configurationOf("cohort:", "  visibilities: [public]"), REFERENCE);

    expect(entries.map((entry) => entry.repository)).toEqual(["open-service"]);
    expect(liveOrgRepositories).toHaveBeenCalledWith("hmcts");
    expect(liveRepositoryOwnership).toHaveBeenCalledWith("hmcts");
  });

  it("should refuse an empty graph by saying no graph has been collected", async () => {
    // A fresh database is not an organisation that owns nothing. Reported as an estate of zero it reads as a
    // successful run, which is the failure that would sit unnoticed for a week; reported as uncollected it names
    // the command somebody forgot to run.
    graphHolding([], []);

    const refusal = await refusalOf(configurationOf());

    expect(refusal).toBeInstanceOf(CohortUncollectedError);
    expect(refusal.message).toContain("no organisation graph has been collected for hmcts");
    expect(refusal.message).toContain("collect-org");
  });

  it("should refuse a collected graph the policy empties by naming the keys to widen", async () => {
    graphHolding([repository("closed-service", { visibility: "private", pushedAt: daysBefore(400) })], []);

    const refusal = await refusalOf(configurationOf("cohort:", "  visibilities: [public]"));

    expect(refusal).toBeInstanceOf(CohortUncollectedError);
    expect(refusal.message).toContain("the graph holds 1 repositories for hmcts");
    expect(refusal.message).toContain("cohort.visibilities");
    expect(refusal.message).toContain("cohort.active_within_days");
    expect(refusal.message).toContain("cohort.include_archived");
  });

  it("should not describe an emptied policy in the words it describes an uncollected graph, these being different mistakes", async () => {
    // Same exception type, deliberately different text: one is fixed by running `collect-org`, the other by
    // editing the file. A shared message would send every reader to the wrong one of the two.
    graphHolding([], []);
    const uncollected = await refusalOf(configurationOf());

    graphHolding([repository("closed-service", { visibility: "private" })], []);
    const emptied = await refusalOf(configurationOf("cohort:", "  visibilities: [public]"));

    expect(emptied.message).not.toBe(uncollected.message);
    expect(uncollected.message).not.toContain("cohort.visibilities");
    expect(emptied.message).not.toContain("no organisation graph has been collected");
  });
});

describe("cohortRepositories", () => {
  it("should name every cohort repository in the order readCohort put them in", async () => {
    graphHolding([repository("alpha-service"), repository("zebra-service")], [ownedBy("alpha-service", "zebra-team"), ownedBy("zebra-service", "alpha-team")]);

    const names = await cohortRepositories(configurationOf(), REFERENCE);

    expect(names).toEqual((await readCohort(configurationOf(), REFERENCE)).map((entry) => entry.repository));
    // Pinned concretely as well, so a change that reordered BOTH functions together could not pass.
    expect(names).toEqual(["zebra-service", "alpha-service"]);
  });
});

describe("cohortOwners", () => {
  it("should map each cohort repository to the owners it is reported under", async () => {
    graphHolding(
      [repository("civil-service"), repository("orphan")],
      [ownedBy("civil-service", "zebra"), ownedBy("civil-service", "alpha"), ownedByNobody("orphan")]
    );

    expect(await cohortOwners(configurationOf(), REFERENCE)).toEqual(
      new Map([
        ["civil-service", ["alpha", "zebra"]],
        ["orphan", [UnownedIdentifier]]
      ])
    );
  });
});

describe("cohortTeams", () => {
  it("should list the teams with the largest holding first, and the unowned bucket last", () => {
    // THE FIXTURE HAS TO CROSS THE TWO ORDERS. `zebra` sorts last alphabetically and holds most, so an
    // alphabetical list and a list by holding disagree about it — one where the largest team was named `alpha`
    // would pass under either rule and prove nothing.
    //
    // `unowned` sorts last whatever it holds, and here it holds more than either team, which is what separates
    // "a bucket last" from "the smallest last".
    const entries = [
      entryOf("one", ["alpha"]),
      entryOf("two", [UnownedIdentifier], OwnerKind.None),
      entryOf("three", [UnownedIdentifier], OwnerKind.None),
      entryOf("four", [UnownedIdentifier], OwnerKind.None),
      entryOf("five", ["zebra"]),
      entryOf("six", ["zebra"])
    ];

    expect(cohortTeams(entries)).toEqual(["zebra", "alpha", UnownedIdentifier]);
  });

  it("should break a tie on holding alphabetically, so two runs over one cohort are diffable", () => {
    const entries = [entryOf("one", ["zebra"]), entryOf("two", ["alpha"])];

    expect(cohortTeams(entries)).toEqual(["alpha", "zebra"]);
  });

  it("should count a shared repository for both its teams, as the cards do", () => {
    // A card's figure comes from `teamRows` and its position from here, and both fold one repository to every
    // owner it names. Counted for the primary alone, `zebra` would hold one and sit below `alpha`.
    const entries = [entryOf("one", ["alpha", "zebra"]), entryOf("two", ["zebra"])];

    expect(cohortTeams(entries)).toEqual(["zebra", "alpha"]);
  });

  it("should name each team once however many repositories it owns", () => {
    const entries = [entryOf("one", ["civil"]), entryOf("two", ["civil"])];

    expect(cohortTeams(entries)).toEqual(["civil"]);
  });

  it("should list no card for a repository one person owns", () => {
    // THE 126 CARDS THAT WERE PEOPLE. `a1i-hussain` is one person holding admin on one repository as a direct
    // collaborator, and it had a card headed `team` and a page of its own.
    const entries = [entryOf("theirs", ["a1i-hussain"], OwnerKind.Person), entryOf("ours", ["civil-admins"])];

    expect(cohortTeams(entries)).toEqual(["civil-admins"]);
  });

  it("should still list the unowned bucket, which is a destination and not a person", () => {
    // 141 repositories are reported under it, so dropping it with the individuals would silently shrink what
    // the cards account for. "Nobody owns this" and "one person owns this" are different findings.
    const entries = [entryOf("orphan", [UnownedIdentifier], OwnerKind.None), entryOf("theirs", ["someone"], OwnerKind.Person)];

    expect(cohortTeams(entries)).toEqual([UnownedIdentifier]);
  });

  it("should count none of a person's repositories for a team whose slug that login happens to equal", () => {
    // A login can equal a team slug — nothing in GitHub stops it — so a person-owned repository has to be
    // excluded by KIND rather than by the identifier failing to match any team's name.
    const entries = [entryOf("ours", ["zzz-ambiguous"]), entryOf("theirs", ["zzz-ambiguous"], OwnerKind.Person), entryOf("mine", ["civil-admins"])];

    // ONE REPOSITORY EACH IS THE ASSERTION. Both teams tie on holding, so the alphabetical break decides and
    // `civil-admins` leads. Counted, the person's repository would give `zzz-ambiguous` two and put it first.
    expect(cohortTeams(entries)).toEqual(["civil-admins", "zzz-ambiguous"]);
  });
});

describe("servedCohort", () => {
  it("should serve an empty estate rather than throw when no graph has been collected", async () => {
    // A preview deploys with `orgJob.enabled: false` and an empty database, and `@smoke` asserts that pages
    // render on exactly that. `collect` refusing is right — it is about to decide what to fetch — but a page has
    // no such stake and should render nothing with the collection notice saying why.
    liveOrgRepositories.mockResolvedValue([]);
    liveRepositoryOwnership.mockResolvedValue([]);

    await expect(servedCohort(configurationOf(), REFERENCE)).resolves.toEqual([]);
  });

  it("should serve an empty estate when the policy selects none of a collected graph", async () => {
    liveOrgRepositories.mockResolvedValue([repository("only-private", { visibility: "PRIVATE" })]);
    liveRepositoryOwnership.mockResolvedValue([]);

    await expect(servedCohort(configurationOf("cohort:", "  visibilities:", "    - public"), REFERENCE)).resolves.toEqual([]);
  });

  it("should still serve the cohort when there is one", async () => {
    liveOrgRepositories.mockResolvedValue([repository("civil-service")]);
    liveRepositoryOwnership.mockResolvedValue([ownedBy("civil-service", "civil-admins")]);

    expect((await servedCohort(configurationOf(), REFERENCE)).map((entry) => entry.repository)).toEqual(["civil-service"]);
  });
});
