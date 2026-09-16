import { describe, expect, it, vi } from "vitest";
import type { LiveOrgPerson, LiveOrgTeamMembership } from "../store/org-graph.ts";
import { contributorNames, storedDisplayNames, teamMembers } from "./people.ts";

// The store read is the whole of the impurity here, so it is the one thing mocked: `payloadOf` in the store writes
// whatever GitHub returned, and what is under test is how a reader gets a usable name back out of it.
const liveOrgPeople = vi.hoisted(() => vi.fn<(organization: string) => Promise<LiveOrgPerson[]>>());
const liveOrgTeamMemberships = vi.hoisted(() => vi.fn<(organization: string) => Promise<LiveOrgTeamMembership[]>>());

vi.mock("../store/org-graph.ts", () => ({ liveOrgPeople, liveOrgTeamMemberships }));

const OBSERVED = new Date("2026-09-01T14:00:00Z");

function person(login: string, payload: unknown, role = "MEMBER"): LiveOrgPerson {
  return { login, role, payload, observedAt: OBSERVED, lastObservedAt: OBSERVED };
}

function stub(people: LiveOrgPerson[]): void {
  liveOrgPeople.mockResolvedValue(people);
}

function membership(teamSlug: string, login: string, role = "MEMBER"): LiveOrgTeamMembership {
  return { teamSlug, login, role, observedAt: OBSERVED, lastObservedAt: OBSERVED };
}

function stubMemberships(memberships: LiveOrgTeamMembership[]): void {
  liveOrgTeamMemberships.mockResolvedValue(memberships);
}

describe("contributorNames", () => {
  it("should return the name resolved from the SSO identity mapping", async () => {
    // The rung that answers: `collect-org` resolves it for all 778 live members and stores it on the person's row.
    stub([person("joedutton", { displayName: "Joe Dutton" })]);

    expect(await contributorNames("hmcts")).toEqual(new Map([["joedutton", "Joe Dutton"]]));
  });

  it("should prefer the resolved name over the self-reported profile name", async () => {
    // Both exist for 325 members and they disagree for a fifth of them — middle names and diacritics. The
    // structured directory record is the better answer.
    stub([person("jdutton", { displayName: "Joe Dutton", name: "joe" })]);

    expect(await contributorNames("hmcts")).toEqual(new Map([["jdutton", "Joe Dutton"]]));
  });

  it("should fall back to the profile name for a row no collection has resolved yet", async () => {
    // TRANSITIONAL. Every row in the database predates this field, and blanking them all in the window before the
    // first `collect-org` runs would take the dashboard backwards. Dead after one collection.
    stub([person("parisfreire", { name: "Paris Freire" })]);

    expect(await contributorNames("hmcts")).toEqual(new Map([["parisfreire", "Paris Freire"]]));
  });

  it("should fall back to the profile name where the resolved one is blank", async () => {
    stub([person("parisfreire", { displayName: "   ", name: "Paris Freire" })]);

    expect(await contributorNames("hmcts")).toEqual(new Map([["parisfreire", "Paris Freire"]]));
  });

  it("should hold no entry at all for a member neither source names", async () => {
    // Which is what makes every caller render the login. Never the empty string and never "undefined".
    stub([person("ef32", { company: "HMCTS" })]);

    const names = await contributorNames("hmcts");

    expect(names.has("ef32")).toBe(false);
    expect(names.get("ef32")).toBeUndefined();
  });

  it("should return the profile name GitHub holds for each member", async () => {
    // Both are real pairs from the live estate, and the second is why nothing may be derived from a login.
    stub([person("parisfreire", { name: "Paris Freire" }), person("ef32", { name: "Tam Arah" })]);

    expect(await contributorNames("hmcts")).toEqual(
      new Map([
        ["parisfreire", "Paris Freire"],
        ["ef32", "Tam Arah"]
      ])
    );
  });

  it("should read the graph for the organisation it was asked about", async () => {
    stub([]);

    await contributorNames("hmcts");

    expect(liveOrgPeople).toHaveBeenCalledWith("hmcts");
  });

  it("should hold no entry at all for a member who has set no name", async () => {
    // 453 of the estate's 778 members. Absent rather than empty, so every reader falls back to the login instead
    // of rendering a blank where a person should be.
    stub([person("nameless", { company: "HMCTS" })]);

    const names = await contributorNames("hmcts");

    expect(names.has("nameless")).toBe(false);
    expect(names.get("nameless")).toBeUndefined();
  });

  it("should hold no entry for a name that is null, empty or whitespace", async () => {
    // The collector drops an empty string today, but a payload is `jsonb` a year old by the time a reader sees it —
    // and a name trimmed to nothing must read as absent rather than as somebody called "".
    stub([person("nulled", { name: null }), person("blank", { name: "" }), person("spaces", { name: "   " })]);

    expect(await contributorNames("hmcts")).toEqual(new Map());
  });

  it("should trim a name GitHub returned with whitespace around it", async () => {
    stub([person("padded", { name: "  Paris Freire  " })]);

    expect(await contributorNames("hmcts")).toEqual(new Map([["padded", "Paris Freire"]]));
  });

  it("should ignore a name that is not a string", async () => {
    // A payload nothing validates on the way out. Dropping it beats putting `[object Object]` beside a login.
    stub([person("odd", { name: 42 }), person("nested", { name: { first: "Paris" } })]);

    expect(await contributorNames("hmcts")).toEqual(new Map());
  });

  it("should survive a payload that is not an object", async () => {
    stub([person("nulled", null), person("stringly", "Paris Freire"), person("listed", [])]);

    expect(await contributorNames("hmcts")).toEqual(new Map());
  });

  it("should fold the login it keys on, because the two sides of the join are spelled by different walks", async () => {
    // The people walk stores what the member list said and a merge fact carries what the pull request said. A case
    // difference between them would read exactly like an unset profile name.
    stub([person("ParisFreire", { name: "Paris Freire" })]);

    const names = await contributorNames("hmcts");

    expect(names.get("parisfreire")).toBe("Paris Freire");
    expect(names.has("ParisFreire")).toBe(false);
  });

  it("should return an empty map for an organisation with no people collected", async () => {
    stub([]);

    expect(await contributorNames("hmcts")).toEqual(new Map());
  });
});

describe("storedDisplayNames", () => {
  it("should return the resolved names an earlier collection stored", async () => {
    stub([person("joedutton", { displayName: "Joe Dutton" }), person("lgeddis", { displayName: "Lucy Geddis" })]);

    expect(await storedDisplayNames("hmcts")).toEqual(
      new Map([
        ["joedutton", "Joe Dutton"],
        ["lgeddis", "Lucy Geddis"]
      ])
    );
  });

  it("should not promote a self-reported profile name into the resolved field", async () => {
    // An unmeasured run hands this straight back to the writer. Reading the profile name here would copy it into
    // `displayName` and keep it there for ever, so the two would stop being distinguishable.
    stub([person("parisfreire", { name: "Paris Freire" })]);

    expect(await storedDisplayNames("hmcts")).toEqual(new Map());
  });

  it("should ignore a resolved name that is blank or is not a string", async () => {
    stub([person("blank", { displayName: "  " }), person("odd", { displayName: 42 }), person("nulled", null)]);

    expect(await storedDisplayNames("hmcts")).toEqual(new Map());
  });

  it("should fold the login it keys on, so the writer's own fold finds it", async () => {
    stub([person("ParisFreire", { displayName: "Paris Freire" })]);

    expect(await storedDisplayNames("hmcts")).toEqual(new Map([["parisfreire", "Paris Freire"]]));
  });

  it("should read the graph for the organisation it was asked about", async () => {
    stub([]);

    await storedDisplayNames("hmcts");

    expect(liveOrgPeople).toHaveBeenCalledWith("hmcts");
  });
});

/**
 * Who GitHub says is in each team, which the report layer needs kept apart from who contributed to its
 * repositories.
 *
 * The distinction is the whole reason this exists: a team page's contributor list is folded from the merges in the
 * repositories attributed to that team, so `platform-operations` — the sole `admin` team on 217 repositories —
 * shows most of the organisation as a contributor and 56 people as members. Neither list is the other's subset.
 */
describe("teamMembers", () => {
  it("should group each team's members under its own slug", async () => {
    stubMemberships([membership("civil", "ada"), membership("civil", "grace"), membership("probate", "alan")]);

    const members = await teamMembers("hmcts");

    expect(members.get("civil")).toEqual([
      { login: "ada", role: "MEMBER" },
      { login: "grace", role: "MEMBER" }
    ]);
    expect(members.get("probate")).toEqual([{ login: "alan", role: "MEMBER" }]);
  });

  it("should keep the role GitHub words the membership with", async () => {
    stubMemberships([membership("civil", "ada", "MAINTAINER"), membership("civil", "grace", "MEMBER")]);

    expect(await teamMembers("hmcts")).toEqual(
      new Map([
        [
          "civil",
          [
            { login: "ada", role: "MAINTAINER" },
            { login: "grace", role: "MEMBER" }
          ]
        ]
      ])
    );
  });

  it("should hold no entry at all for a team no membership was read for", async () => {
    // ABSENT AND NOT EMPTY, which is the answer the whole section rests on: nothing stores which teams a run read
    // in full, and 15 teams on this estate have no membership row — so a team with no rows is indistinguishable
    // from a team nobody walked, and an empty list would state that GitHub puts nobody in it.
    stubMemberships([membership("civil", "ada")]);

    const members = await teamMembers("hmcts");

    expect(members.has("platform-operations")).toBe(false);
    expect(members.get("platform-operations")).toBeUndefined();
  });

  it("should keep the login's own spelling, which is what a reader is shown", async () => {
    stubMemberships([membership("civil", "ParisFreire")]);

    expect(await teamMembers("hmcts")).toEqual(new Map([["civil", [{ login: "ParisFreire", role: "MEMBER" }]]]));
  });

  it("should fold the team slug it keys on, so an overridden team's membership is still found", async () => {
    // A `configured` owner is a name somebody typed into `metrics.yaml` while every other rung's is the slug
    // GitHub served. A case difference between them would report that team's membership as unread.
    stubMemberships([membership("Civil", "ada")]);

    const members = await teamMembers("hmcts");

    expect(members.get("civil")).toEqual([{ login: "ada", role: "MEMBER" }]);
    expect(members.has("Civil")).toBe(false);
  });

  it("should read the graph for the organisation it was asked about", async () => {
    stubMemberships([]);

    await teamMembers("hmcts");

    expect(liveOrgTeamMemberships).toHaveBeenCalledWith("hmcts");
  });

  it("should return an empty map where no membership has been collected at all", async () => {
    stubMemberships([]);

    expect(await teamMembers("hmcts")).toEqual(new Map());
  });
});
