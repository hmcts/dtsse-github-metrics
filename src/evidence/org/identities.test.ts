import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGitHubClient } from "../github/client.ts";
import { personalAccessToken } from "../github/credentials.ts";
import type { PersonFact } from "./graph.ts";
import { collectSsoIdentities, namedPeople, scimDisplayName, upnDisplayName } from "./identities.ts";
import { ScimPageSize, samlIdentitiesQuery } from "./queries.ts";

// Every case drives a stubbed `fetch`, so nothing here reaches GitHub, and the injected clock and pause mean
// nothing sleeps. Same helpers as `collect.test.ts`, because this walk issues one GraphQL document and one REST
// endpoint and both have to be recorded.
//
// THE LIVE SAML AND SCIM CALLS ARE NOT EXERCISED ANYWHERE and cannot be: they need the App's private key. The
// payloads below are shaped from real responses — a UPN `nameId`, an RFC 7644 `Resources` list response, a SCIM
// record with no login on it — and the join, the ladder and every degrade are covered against those.

interface Reply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

function replying(...replies: Reply[]): { fetch: typeof globalThis.fetch; sent: { url: string; query: string }[] } {
  const queue = [...replies];
  const sent: { url: string; query: string }[] = [];
  const fetch = vi.fn((url: string | URL, init?: RequestInit) => {
    const parsed = init?.body === undefined ? { query: "" } : (JSON.parse(String(init.body)) as { query: string });
    sent.push({ url: String(url), query: parsed.query });
    const next = queue.shift() ?? { status: 200, body: {} };
    const body = typeof next.body === "string" ? next.body : JSON.stringify(next.body ?? {});
    return Promise.resolve(new Response(body, { status: next.status ?? 200, headers: { "content-type": "application/json", ...next.headers } }));
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, sent };
}

function graphql(data: unknown): Reply {
  return { status: 200, body: { data } };
}

/** GitHub's answer to a credential that may not look: a refusal, not a rate limit, so it is not retried. */
const REFUSED: Reply = { status: 403, body: { message: "Forbidden" } };

function client(fetch: typeof globalThis.fetch) {
  return createGitHubClient({ credentials: personalAccessToken("ghp_test"), fetch, pause: () => Promise.resolve(), clock: () => 1000 });
}

const PAGE_END = { hasNextPage: false, endCursor: null };
const PAGE_MORE = { hasNextPage: true, endCursor: "MORE" };

/** One page of the SSO mapping, as `samlIdentityProvider.externalIdentities`. */
function identities(nodes: unknown[], pageInfo: unknown = PAGE_END) {
  return { organization: { samlIdentityProvider: { externalIdentities: { totalCount: nodes.length, pageInfo, nodes } } } };
}

function identity(login: string | null, nameId: string | null) {
  return { samlIdentity: nameId === null ? null : { nameId }, user: login === null ? null : { login } };
}

/** One page of the SCIM directory, as the RFC 7644 list response. */
function directory(records: unknown[], overrides: Record<string, unknown> = {}) {
  return { schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"], Resources: records, itemsPerPage: records.length, startIndex: 1, ...overrides };
}

/** One SCIM record, with the keys the live directory actually carries. No login is among them. */
function record(userName: string, givenName: string | null, familyName: string | null, emails: string[] = []) {
  return {
    id: "abc123",
    externalId: "def456",
    userName,
    name: { givenName, familyName },
    emails: emails.map((value) => ({ value, primary: true, type: "work" })),
    roles: [],
    active: true,
    meta: { resourceType: "User" }
  };
}

function person(login: string, overrides: Partial<PersonFact> = {}): PersonFact {
  return { login, role: "MEMBER", ...overrides };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

describe("samlIdentitiesQuery", () => {
  it("should report what the document cost", () => {
    expect(samlIdentitiesQuery()).toContain("rateLimit { cost limit remaining resetAt }");
  });

  it("should read the UPN and the linked login and nothing else about the person", () => {
    // The UPN is a work email address for ~800 named people. It is the join key and it is not stored, so the
    // document asks for no other identifying field either.
    const document = samlIdentitiesQuery();

    expect(document).toContain("nodes { samlIdentity { nameId } user { login } }");
    expect(document).not.toContain("scimIdentity");
    expect(document).not.toContain("organizationInvitation");
  });
});

describe("scimDisplayName", () => {
  it("should join the structured parts when a record carries both", () => {
    expect(scimDisplayName({ givenName: "Joe", familyName: "Dutton" })).toBe("Joe Dutton");
  });

  it("should name somebody from whichever single part a record carries", () => {
    expect(scimDisplayName({ givenName: "Lucy", familyName: null })).toBe("Lucy");
    expect(scimDisplayName({ givenName: null, familyName: "Geddis" })).toBe("Geddis");
  });

  it("should trim the parts, so a padded field does not become a double space", () => {
    expect(scimDisplayName({ givenName: "  Toqir  ", familyName: " Khalid " })).toBe("Toqir Khalid");
  });

  it("should return nothing at all when a record names neither part", () => {
    // Nothing rather than the empty string, which would render as a blank line where a person should be.
    expect(scimDisplayName({ givenName: "", familyName: "   " })).toBeUndefined();
    expect(scimDisplayName(null)).toBeUndefined();
    expect(scimDisplayName(undefined)).toBeUndefined();
  });
});

describe("upnDisplayName", () => {
  it("should title-case the separated parts of the local part", () => {
    expect(upnDisplayName("Harpreet.Jhita@justice.gov.uk")).toBe("Harpreet Jhita");
  });

  it("should strip a trailing disambiguating digit, which is not part of anybody's name", () => {
    // A real pair from the live estate: the directory carries two Jack Maloneys and numbers the second.
    expect(upnDisplayName("Jack.Maloney1@HMCTS.NET")).toBe("Jack Maloney");
    expect(upnDisplayName("Jack.Maloney12@HMCTS.NET")).toBe("Jack Maloney");
  });

  it("should title-case a part the directory holds in another case", () => {
    expect(upnDisplayName("HARPREET.JHITA@HMCTS.NET")).toBe("Harpreet Jhita");
    expect(upnDisplayName("harpreet.jhita@hmcts.net")).toBe("Harpreet Jhita");
  });

  it("should separate on an underscore as well as a dot", () => {
    expect(upnDisplayName("harpreet_jhita@hmcts.net")).toBe("Harpreet Jhita");
  });

  it("should derive from a bare local part with no domain on it", () => {
    expect(upnDisplayName("Harpreet.Jhita")).toBe("Harpreet Jhita");
  });

  it("should name somebody from a local part carrying no separator", () => {
    expect(upnDisplayName("jhita@hmcts.net")).toBe("Jhita");
  });

  it("should drop an empty part rather than emitting a double space", () => {
    expect(upnDisplayName("harpreet..jhita@hmcts.net")).toBe("Harpreet Jhita");
    expect(upnDisplayName(".harpreet.@hmcts.net")).toBe("Harpreet");
  });

  it("should return nothing when the local part carries no letters to name anybody by", () => {
    // Falls through to the login, which is the honest answer: a name made of punctuation is worse than a handle.
    expect(upnDisplayName("12345@hmcts.net")).toBeUndefined();
    expect(upnDisplayName("@hmcts.net")).toBeUndefined();
    expect(upnDisplayName("")).toBeUndefined();
  });
});

describe("collectSsoIdentities", () => {
  it("should give a member their structured SCIM name, joined through the UPN", async () => {
    const { fetch } = replying(graphql(identities([identity("joedutton", "Joe.Dutton@justice.gov.uk")])), {
      status: 200,
      body: directory([record("Joe.Dutton@justice.gov.uk", "Joe", "Dutton")])
    });

    const walk = await collectSsoIdentities(client(fetch), "hmcts");

    expect(walk.measured).toBe(true);
    expect(walk.names).toEqual(new Map([["joedutton", "Joe Dutton"]]));
  });

  it("should join the two systems case-insensitively, because they spell one address differently", async () => {
    // `Jack.Maloney1@HMCTS.NET` on one side and the folded address on the other. Left unfolded this reads exactly
    // like a person with no SCIM record, and they would silently drop to the derived name.
    const { fetch } = replying(graphql(identities([identity("jmaloney", "Jack.Maloney1@HMCTS.NET")])), {
      status: 200,
      body: directory([record("jack.maloney1@hmcts.net", "Jack", "Maloney")])
    });

    expect((await collectSsoIdentities(client(fetch), "hmcts")).names).toEqual(new Map([["jmaloney", "Jack Maloney"]]));
  });

  it("should reach a SCIM record through an email alias where the userName does not match", async () => {
    const { fetch } = replying(graphql(identities([identity("lgeddis", "Lucy.Geddis@justice.gov.uk")])), {
      status: 200,
      body: directory([record("lucy.geddis@hmcts.net", "Lucy", "Geddis", ["Lucy.Geddis@justice.gov.uk"])])
    });

    expect((await collectSsoIdentities(client(fetch), "hmcts")).names).toEqual(new Map([["lgeddis", "Lucy Geddis"]]));
  });

  it("should keep the first record to claim an address, rather than letting a second displace it", async () => {
    // The address is one record's own `userName` and another's alias. Choosing between them is not a decision the
    // join gets to invent, so the record that named it first keeps it.
    const { fetch } = replying(graphql(identities([identity("lgeddis", "lucy.geddis@hmcts.net")])), {
      status: 200,
      body: directory([record("lucy.geddis@hmcts.net", "Lucy", "Geddis"), record("someone.else@hmcts.net", "Someone", "Else", ["lucy.geddis@hmcts.net"])])
    });

    expect((await collectSsoIdentities(client(fetch), "hmcts")).names).toEqual(new Map([["lgeddis", "Lucy Geddis"]]));
  });

  it("should derive a name from the UPN for a member with no SCIM record", async () => {
    // 688 of the estate's 843 linked identities have a SCIM record; this rung is what takes coverage to all 778
    // live members.
    const { fetch } = replying(graphql(identities([identity("jmaloney", "Jack.Maloney1@HMCTS.NET")])), { status: 200, body: directory([]) });

    const walk = await collectSsoIdentities(client(fetch), "hmcts");

    expect(walk.measured).toBe(true);
    expect(walk.names).toEqual(new Map([["jmaloney", "Jack Maloney"]]));
  });

  it("should hold no entry for an identity whose UPN names nobody", async () => {
    const { fetch } = replying(graphql(identities([identity("service-account", "12345@hmcts.net")])), { status: 200, body: directory([]) });

    expect((await collectSsoIdentities(client(fetch), "hmcts")).names).toEqual(new Map());
  });

  it("should fold the login it keys on, because the report joins it against differently spelled logins", async () => {
    const { fetch } = replying(graphql(identities([identity("ParisFreire", "Paris.Freire@justice.gov.uk")])), { status: 200, body: directory([]) });

    const names = (await collectSsoIdentities(client(fetch), "hmcts")).names;

    expect(names.get("parisfreire")).toBe("Paris Freire");
    expect(names.has("ParisFreire")).toBe(false);
  });

  it("should ignore an identity with no linked GitHub account and one with no UPN", async () => {
    // Both are ordinary: somebody who has an Entra account and has not linked a GitHub one, and an identity the
    // provider named nothing on. Neither is a fault and neither can be recorded.
    const { fetch } = replying(graphql(identities([identity(null, "Nobody.Here@justice.gov.uk"), identity("nameless", null), null])), {
      status: 200,
      body: directory([])
    });

    expect((await collectSsoIdentities(client(fetch), "hmcts")).names).toEqual(new Map());
  });

  it("should page the whole SSO mapping", async () => {
    const { fetch, sent } = replying(
      graphql(identities([identity("joedutton", "Joe.Dutton@justice.gov.uk")], PAGE_MORE)),
      graphql(identities([identity("lgeddis", "Lucy.Geddis@justice.gov.uk")])),
      { status: 200, body: directory([]) }
    );

    const walk = await collectSsoIdentities(client(fetch), "hmcts");

    expect(walk.names).toEqual(
      new Map([
        ["joedutton", "Joe Dutton"],
        ["lgeddis", "Lucy Geddis"]
      ])
    );
    expect(sent.filter((call) => call.query.includes("OrganizationSamlIdentities"))).toHaveLength(2);
  });

  it("should page the whole SCIM directory, stopping on the first short page", async () => {
    const full = Array.from({ length: ScimPageSize }, (_unused, at) => record(`p${at}@hmcts.net`, "Given", `Family${at}`));
    const { fetch, sent } = replying(
      graphql(identities([identity("joedutton", "p7@hmcts.net"), identity("lgeddis", "last@hmcts.net")])),
      // No `totalResults`, so the walk has nothing but the page length to go on and keeps asking.
      { status: 200, body: { Resources: full } },
      { status: 200, body: directory([record("last@hmcts.net", "Lucy", "Geddis")]) }
    );

    const walk = await collectSsoIdentities(client(fetch), "hmcts");

    expect(walk.names).toEqual(
      new Map([
        ["joedutton", "Given Family7"],
        ["lgeddis", "Lucy Geddis"]
      ])
    );
    expect(sent.filter((call) => call.url.includes("/scim/v2/"))).toHaveLength(2);
  });

  it("should stop asking for SCIM pages once totalResults has been read, even on a full page", async () => {
    // A `startIndex` walk has no `hasNextPage`, so a directory whose last page happens to be exactly full must
    // still terminate rather than spinning on it.
    const full = Array.from({ length: ScimPageSize }, (_unused, at) => record(`p${at}@hmcts.net`, "Given", `Family${at}`));
    const { fetch, sent } = replying(graphql(identities([identity("joedutton", "p0@hmcts.net")])), {
      status: 200,
      body: directory(full, { totalResults: ScimPageSize })
    });

    const walk = await collectSsoIdentities(client(fetch), "hmcts");

    expect(walk.names).toEqual(new Map([["joedutton", "Given Family0"]]));
    expect(sent.filter((call) => call.url.includes("/scim/v2/"))).toHaveLength(1);
  });

  it("should ask the SCIM endpoint for whole pages by start index", async () => {
    const { fetch, sent } = replying(graphql(identities([])), { status: 200, body: directory([]) });

    await collectSsoIdentities(client(fetch), "hmcts");

    const scim = sent.find((call) => call.url.includes("/scim/v2/"))?.url;
    expect(scim).toContain("/scim/v2/organizations/hmcts/Users");
    expect(scim).toContain(`count=${ScimPageSize}`);
    expect(scim).toContain("startIndex=1");
  });

  it("should ignore a SCIM record that names nobody, and one GitHub named nothing for", async () => {
    const { fetch } = replying(graphql(identities([identity("nameless", "nameless@hmcts.net")])), {
      status: 200,
      body: directory([null, record("nameless@hmcts.net", null, null), record("", "Given", "Family")])
    });

    // The record exists and carries no name, so the derived rung answers rather than the structured one.
    expect((await collectSsoIdentities(client(fetch), "hmcts")).names).toEqual(new Map([["nameless", "Nameless"]]));
  });

  it("should join on the userName alone for a record carrying no emails", async () => {
    const { fetch } = replying(graphql(identities([identity("joedutton", "joe.dutton@hmcts.net")])), {
      status: 200,
      body: directory([{ userName: "joe.dutton@hmcts.net", name: { givenName: "Joe", familyName: "Dutton" } }])
    });

    expect((await collectSsoIdentities(client(fetch), "hmcts")).names).toEqual(new Map([["joedutton", "Joe Dutton"]]));
  });

  it("should ignore an email entry carrying no address", async () => {
    const { fetch } = replying(graphql(identities([identity("joedutton", "joe.dutton@hmcts.net")])), {
      status: 200,
      body: directory([{ userName: "joe.dutton@hmcts.net", name: { givenName: "Joe", familyName: "Dutton" }, emails: [{ value: null }, null] }])
    });

    expect((await collectSsoIdentities(client(fetch), "hmcts")).names).toEqual(new Map([["joedutton", "Joe Dutton"]]));
  });

  it("should read a null SAML provider as unmeasured rather than as an organisation with no names", async () => {
    // What a PAT gets: HTTP 200 and `samlIdentityProvider: null`. Read as an empty mapping it would end the
    // interval of every named person in the graph, which re-running cannot undo.
    const { fetch } = replying(graphql({ organization: { samlIdentityProvider: null } }));

    const walk = await collectSsoIdentities(client(fetch), "hmcts");

    expect(walk.measured).toBe(false);
    expect(walk.names).toEqual(new Map());
  });

  it("should not pay for the SCIM directory when nothing can be joined to it", async () => {
    const { fetch, sent } = replying(graphql({ organization: null }));

    await collectSsoIdentities(client(fetch), "hmcts");

    expect(sent.filter((call) => call.url.includes("/scim/v2/"))).toHaveLength(0);
  });

  it("should read a refused SSO mapping as unmeasured", async () => {
    const { fetch } = replying(REFUSED);

    expect(await collectSsoIdentities(client(fetch), "hmcts")).toEqual({ measured: false, names: new Map() });
  });

  it("should read a mapping that failed part way through its pages as unmeasured", async () => {
    // A prefix of the mapping is not a smaller answer, it is a wrong one: the members on the pages nobody reached
    // would have their names ended as though they had none.
    const { fetch } = replying(graphql(identities([identity("joedutton", "Joe.Dutton@justice.gov.uk")], PAGE_MORE)), REFUSED);

    expect(await collectSsoIdentities(client(fetch), "hmcts")).toEqual({ measured: false, names: new Map() });
  });

  it("should read a refused SCIM directory as unmeasured, rather than falling back to derived names", async () => {
    // Deriving all 778 names would replace 688 correctly spelled ones with worse ones, and the next run would put
    // them back — a supersession history of a fact nobody changed.
    const { fetch } = replying(graphql(identities([identity("joedutton", "Joe.Dutton@justice.gov.uk")])), REFUSED);

    expect(await collectSsoIdentities(client(fetch), "hmcts")).toEqual({ measured: false, names: new Map() });
  });

  it("should read a SCIM body carrying no Resources as unmeasured", async () => {
    const { fetch } = replying(graphql(identities([identity("joedutton", "Joe.Dutton@justice.gov.uk")])), { status: 200, body: { totalResults: 688 } });

    expect(await collectSsoIdentities(client(fetch), "hmcts")).toEqual({ measured: false, names: new Map() });
  });

  it("should read a SCIM directory that failed part way through its pages as unmeasured", async () => {
    const full = Array.from({ length: ScimPageSize }, (_unused, at) => record(`p${at}@hmcts.net`, "Given", `Family${at}`));
    const { fetch } = replying(graphql(identities([identity("joedutton", "p0@hmcts.net")])), { status: 200, body: { Resources: full } }, REFUSED);

    expect(await collectSsoIdentities(client(fetch), "hmcts")).toEqual({ measured: false, names: new Map() });
  });

  it("should measure an organisation whose mapping names nobody", async () => {
    // Distinct from unmeasured: the provider answered, and it linked no accounts.
    const { fetch } = replying(graphql(identities([])), { status: 200, body: directory([]) });

    expect(await collectSsoIdentities(client(fetch), "hmcts")).toEqual({ measured: true, names: new Map() });
  });
});

describe("namedPeople", () => {
  it("should attach the resolved name to the person it belongs to", () => {
    expect(namedPeople([person("joedutton")], new Map([["joedutton", "Joe Dutton"]]))).toEqual([
      { login: "joedutton", role: "MEMBER", displayName: "Joe Dutton" }
    ]);
  });

  it("should match a person whose login the mapping spelled differently", () => {
    expect(namedPeople([person("ParisFreire")], new Map([["parisfreire", "Paris Freire"]]))).toEqual([
      { login: "ParisFreire", role: "MEMBER", displayName: "Paris Freire" }
    ]);
  });

  it("should return the same fact for a person nothing named", () => {
    // The SAME object, not a copy carrying `displayName: undefined`: the digest the store computes has to be what
    // it was before this pass existed, or an unmeasured member supersedes their own row.
    const unnamed = person("nobody", { name: "Self Reported" });

    expect(namedPeople([unnamed], new Map())[0]).toBe(unnamed);
  });

  it("should leave the self-reported fields alone", () => {
    const facts = namedPeople([person("joedutton", { name: "joe", email: "joe@example.com", company: "HMCTS" })], new Map([["joedutton", "Joe Dutton"]]));

    expect(facts).toEqual([{ login: "joedutton", role: "MEMBER", name: "joe", email: "joe@example.com", company: "HMCTS", displayName: "Joe Dutton" }]);
  });
});
