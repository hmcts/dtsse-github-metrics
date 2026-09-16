import { parseResponse } from "../behaviour/responses.ts";
import type { GitHubClient } from "../github/client.ts";
import { canonical, type PersonFact } from "./graph.ts";
import { ScimPageSize, samlIdentitiesQuery, scimUsersPath } from "./queries.ts";
import { type ScimUser, samlIdentitiesSchema, scimUsersSchema } from "./responses.ts";

/**
 * Resolving what a contributor is CALLED from the GitHub↔Entra SSO identity mapping.
 *
 * COLLECTED HERE AND PERSISTED, NEVER FETCHED BY A READER, and that is an architectural constraint rather than a
 * preference. `charts/dtsse-github-metrics/values.yaml` gives `GH_APP_*` to the `job` and `orgJob` CronJobs and to
 * nothing else: the web pod holds no GitHub credential and must not, so the serving path cannot ask GitHub who
 * anybody is. Both calls below therefore belong to `collect-org`, and the report layer reads the answer out of
 * `org_people` — see `contributorNames` in `people.ts`.
 *
 * TWO SOURCES, BECAUSE NEITHER ANSWERS ALONE:
 *
 *   - `samlIdentityProvider.externalIdentities` is the only join there is between a GitHub login and a person.
 *     843 identities carry a login, covering all 778 live members, and each one's `nameId` is that person's UPN.
 *   - The SCIM directory holds the STRUCTURED name — 688 records, every one with both `givenName` and
 *     `familyName`, correctly spelled and correctly accented. It carries no login at all, so it can only be
 *     reached through the UPN.
 *
 * So the ladder is SCIM first and the UPN second, and the calibration says why round that way: a UPN-derived name
 * agrees with the profile name in 80.6% of the 325 cases where both exist, and the disagreements are middle names
 * and diacritics — exactly what a structured record gets right and string surgery on an email address cannot.
 *
 * THE WHOLE PASS IS ALL-OR-NOTHING, which is the opposite rule to every other walk in `collect.ts`. Those degrade
 * per team or per repository because a short list omits a claim; this one REPLACES a value, so a short read does
 * not omit a name, it rewrites 688 good names as worse ones and then rewrites them back on the next run — a
 * supersession history of a fact nobody changed. Either both sources were read in full or nothing is measured.
 *
 * ~16 requests: 9 GraphQL pages and 7 SCIM pages, once per `collect-org`. Negligible against the installation's
 * hourly budget, and the reason this is a walk rather than a per-member call.
 */

/** One failure's message, worded as `collect.ts` words its own. */
function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What the SSO pass answers. */
export interface SsoIdentityWalk {
  /** Folded login → the person's real name. Empty when nothing was measured. */
  names: Map<string, string>;
  /**
   * Whether BOTH sources were read in full.
   *
   * `false` MEANS UNMEASURED AND NOT "NOBODY HAS A NAME". A PAT authenticates perfectly well and gets
   * `samlIdentityProvider: null`, so a run that read the mapping with the wrong credential must leave the stored
   * names exactly as they were. Read the other way round, one such run blanks the name of every person in the
   * organisation, and since the graph is change-versioned that is not a value to restore but an interval to
   * reopen.
   */
  measured: boolean;
}

/**
 * One person's name out of a SCIM record's structured parts.
 *
 * JOINED WITH A SPACE RATHER THAN READ FROM `formatted`, which GitHub does also send: two fields this build has
 * measured at 100% coverage beat one it has not looked at. Whichever parts are present are used, so a record
 * carrying only a family name still names somebody rather than nobody — and a record carrying neither returns
 * nothing at all instead of the empty string, which would render as a blank line under a login.
 */
export function scimDisplayName(name: ScimUser["name"]): string | undefined {
  const parts = [name?.givenName, name?.familyName].map((part) => part?.trim() ?? "").filter((part) => part !== "");
  return parts.length === 0 ? undefined : parts.join(" ");
}

/**
 * One person's name derived from their UPN, for the ~90 members with no SCIM record.
 *
 * TAKES COVERAGE TO 778 OF 778 AND IS SECOND FOR A REASON. Two fixes are measured on the live estate and are
 * both here: `Jack.Maloney1@HMCTS.NET` carries a DISAMBIGUATING DIGIT that is not part of anybody's name, and the
 * separated parts arrive in whatever case the directory holds — `Jack.Maloney1` beside `HARPREET.JHITA` — so each
 * is title-cased rather than passed through.
 *
 * IT IS STRING SURGERY ON AN EMAIL ADDRESS AND IT GETS SOME NAMES WRONG. `McKenzie` comes back as `Mckenzie`,
 * `O'Brien` as `O'brien`, `Anne-Marie` as `Anne-marie`, and a middle name in the UPN becomes part of the name.
 * That is the 19.4% the calibration measured, and it is why SCIM is rung 1 rather than a refinement of this. A
 * local part that is all digits, or empty, resolves to nothing rather than to a name made of punctuation.
 *
 * The address itself is used and DISCARDED. Nothing returns from here but the name.
 */
export function upnDisplayName(nameId: string): string | undefined {
  // The local part, and the whole string when there is no `@` — a directory that spells a bare `Jack.Maloney` is
  // still naming somebody.
  const local = (nameId.split("@")[0] ?? "").trim().replace(/\d+$/, "");
  const parts = local
    .split(/[._]/)
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1).toLowerCase()}`);
  return parts.length === 0 ? undefined : parts.join(" ");
}

/**
 * Every SSO identity the provider has linked to a GitHub account, or `undefined` where nobody could look.
 *
 * `undefined` RATHER THAN AN EMPTY LIST FOR A NULL PROVIDER, and the distinction is the whole safety of this
 * module. GitHub answers a token without `organization_administration: read` with HTTP 200 and
 * `samlIdentityProvider: null` — a perfectly successful request that says nothing — so an empty list here would
 * be read downstream as "no member of this organisation has an SSO identity" and would end every stored name.
 *
 * A page that fails part way through returns `undefined` too, for the reason the module header gives: a prefix of
 * the mapping is not a smaller answer, it is a wrong one.
 */
async function collectSamlIdentities(client: GitHubClient, organization: string): Promise<{ login: string; nameId: string }[] | undefined> {
  const identities: { login: string; nameId: string }[] = [];
  let cursor: string | null = null;

  for (;;) {
    let connection: ReturnType<typeof parseSamlIdentities>;
    try {
      const data: unknown = await client.graphql(samlIdentitiesQuery(), { organization, cursor });
      connection = parseSamlIdentities(data);
    } catch (error) {
      console.warn(
        `Could not read the SSO identities of ${organization} after ${identities.length}; contributor names will be left as they stand: ${reason(error)}`
      );
      return undefined;
    }
    if (connection == null) {
      console.warn(
        `GitHub named no SAML identity provider for ${organization}, which is what a credential without organization_administration:read is answered with; contributor names will be left as they stand`
      );
      return undefined;
    }

    for (const node of connection.nodes) {
      const login = node?.user?.login;
      const nameId = node?.samlIdentity?.nameId;
      if (login == null || nameId == null) {
        // An identity with no linked GitHub account, or none with a UPN to name them by. Ordinary, not a fault.
        continue;
      }
      identities.push({ login, nameId });
    }

    if (!connection.pageInfo.hasNextPage) {
      return identities;
    }
    cursor = connection.pageInfo.endCursor ?? null;
  }
}

/** Named so the loop above can annotate the connection without restating the schema's inferred shape. */
function parseSamlIdentities(data: unknown) {
  return parseResponse(samlIdentitiesSchema, data, "SAML identity data").organization?.samlIdentityProvider?.externalIdentities;
}

/**
 * The structured names in the SCIM directory, keyed on every address a record can be joined on.
 *
 * KEYED ON THE ADDRESS BECAUSE A SCIM RECORD HOLDS NO GITHUB LOGIN. `userName` is the record's own identifier and
 * each `emails[].value` is an alias for it, so both are indexed and the SAML `nameId` is looked up against them.
 * All keys are FOLDED, on the rule the login join already follows: the directory and the identity provider are
 * different systems spelling the same person, and `Jack.Maloney1@HMCTS.NET` beside `jack.maloney1@hmcts.net` is
 * the failure this avoids — it would look exactly like a person with no SCIM record.
 *
 * The FIRST record to claim an address keeps it, so a second record naming somebody else's alias cannot displace
 * the name reached through their own `userName`. Choosing between two records for one address is not a decision
 * this join gets to invent.
 *
 * `undefined` where the directory could not be read in full — a 403 for a credential without
 * `organization_administration: read`, or a page that failed part way. The map is a lookup table that is thrown
 * away; nothing built here is stored.
 */
async function collectScimNames(client: GitHubClient, organization: string): Promise<Map<string, string> | undefined> {
  const names = new Map<string, string>();

  for (let startIndex = 1; ; startIndex += ScimPageSize) {
    let page: ReturnType<typeof parseScimUsers>;
    try {
      const data: unknown = await client.get(scimUsersPath(organization), { count: ScimPageSize, startIndex });
      page = parseScimUsers(data);
    } catch (error) {
      console.warn(
        `Could not read the SCIM directory of ${organization} after ${names.size} addresses; contributor names will be left as they stand: ${reason(error)}`
      );
      return undefined;
    }
    const records = page.Resources;
    if (records == null) {
      console.warn(`GitHub named no SCIM Resources for ${organization}; contributor names will be left as they stand`);
      return undefined;
    }

    for (const record of records) {
      const name = record == null ? undefined : scimDisplayName(record.name);
      if (record == null || name === undefined) {
        continue;
      }
      for (const address of scimAddresses(record)) {
        if (!names.has(address)) {
          names.set(address, name);
        }
      }
    }

    // A `startIndex` walk carries no `hasNextPage`, so it stops on the first short page — and on `totalResults`
    // as well, so a directory that keeps answering with a full page cannot spin here for ever.
    const read = startIndex + records.length - 1;
    if (records.length < ScimPageSize || (page.totalResults != null && read >= page.totalResults)) {
      return names;
    }
  }
}

function parseScimUsers(data: unknown) {
  return parseResponse(scimUsersSchema, data, "SCIM user data");
}

/** Every folded address one SCIM record may be joined on, its own identifier first. */
function scimAddresses(record: ScimUser): string[] {
  const addresses = [record.userName, ...(record.emails ?? []).map((email) => email?.value)];
  return addresses.map((address) => address?.trim().toLowerCase() ?? "").filter((address) => address !== "");
}

/**
 * What every organisation member is called, resolved from SSO.
 *
 * The mapping is read FIRST so that a credential which cannot see it costs nothing: a null provider skips the
 * seven SCIM pages entirely rather than paying for a directory nothing can be joined to.
 */
export async function collectSsoIdentities(client: GitHubClient, organization: string): Promise<SsoIdentityWalk> {
  const unmeasured: SsoIdentityWalk = { names: new Map(), measured: false };

  const identities = await collectSamlIdentities(client, organization);
  if (identities === undefined) {
    return unmeasured;
  }
  const structured = await collectScimNames(client, organization);
  if (structured === undefined) {
    return unmeasured;
  }

  const names = new Map<string, string>();
  for (const identity of identities) {
    const name = structured.get(identity.nameId.trim().toLowerCase()) ?? upnDisplayName(identity.nameId);
    if (name !== undefined) {
      names.set(canonical(identity.login), name);
    }
  }
  return { names, measured: true };
}

/**
 * Attaches the resolved name to each person, leaving the fact untouched where nothing resolved.
 *
 * The absent case returns THE SAME OBJECT rather than one carrying `displayName: undefined`, so the digest the
 * store computes over a person nothing named is byte-for-byte what it was before this pass existed — an
 * unmeasured member must move `lastObservedAt` and write no row.
 */
export function namedPeople(facts: readonly PersonFact[], names: ReadonlyMap<string, string>): PersonFact[] {
  return facts.map((fact) => {
    const displayName = names.get(canonical(fact.login));
    return displayName === undefined ? fact : { ...fact, displayName };
  });
}
