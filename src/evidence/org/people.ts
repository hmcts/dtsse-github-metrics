import { liveOrgPeople } from "../store/org-graph.ts";

/**
 * What the organisation graph knows a person is CALLED, as opposed to what they log in as.
 *
 * READ FROM THE DATABASE AND NEVER FROM GITHUB, which is a constraint rather than a convenience: the web pod
 * holds no GitHub credential — `charts/dtsse-github-metrics/values.yaml` gives `GH_APP_*` to the `job` and
 * `orgJob` CronJobs alone — so everything this answers has to have been collected already. `collect-org` resolves
 * the names and stores them on the person's row; see `identities.ts`.
 *
 * A THREE-RUNG LADDER, and the middle rung is the one that answers:
 *
 *   1. `displayName`, resolved from the Entra SSO identity mapping — the SCIM directory's structured name where
 *      there is one, otherwise a name derived from the SAML UPN. Measured at 778 of 778 live members.
 *   2. `name`, the self-reported GitHub profile name, which 325 of 778 members have set. TRANSITIONAL: it is here
 *      so that the rows already in the database are not blanked in the window between this landing and the first
 *      `collect-org` that resolves a name. After one collection nothing reaches it and it can be deleted.
 *   3. No entry at all, which is what makes a caller fall back to the login. Not the empty string, and not the
 *      word "undefined" — see the note on the absent name below.
 *
 * FOLDED ON THE WAY IN, because a login is unique case-insensitively and the two sides of this join are spelled
 * by different walks: the people walk stores whatever GitHub's member list says, and a merge fact carries
 * whatever the pull request's author field said. `parisFreire` looking up nothing because the graph holds
 * `parisfreire` is the failure this avoids, and it would have looked exactly like an unset profile name.
 */
export async function contributorNames(organization: string): Promise<Map<string, string>> {
  const people = await liveOrgPeople(organization);
  const names = new Map<string, string>();
  for (const person of people) {
    const name = payloadName(person.payload, "displayName") ?? payloadName(person.payload, "name");
    if (name !== undefined) {
      names.set(person.login.toLowerCase(), name);
    }
  }
  return names;
}

/**
 * Only the names resolved from SSO, with no fallback to the profile name.
 *
 * WHAT AN UNMEASURED `collect-org` CARRIES FORWARD. A run whose credential cannot read the SSO mapping must write
 * the names it already had rather than recompute them as absent: the graph is change-versioned, so a person
 * arriving with no `displayName` does not leave the stored one alone — it ends that row's interval and opens a
 * new one without it, which GitHub cannot be asked to undo. Reading them back and handing them to the writer
 * makes such a run move `lastObservedAt` and write nothing, which is what "unmeasured" has to mean.
 *
 * Deliberately not `contributorNames`, whose profile-name rung would promote a self-reported name into the
 * resolved field and then keep it there for ever.
 */
export async function storedDisplayNames(organization: string): Promise<Map<string, string>> {
  const people = await liveOrgPeople(organization);
  const names = new Map<string, string>();
  for (const person of people) {
    const name = payloadName(person.payload, "displayName");
    if (name !== undefined) {
      names.set(person.login.toLowerCase(), name);
    }
  }
  return names;
}

/**
 * One name field out of a stored payload, or nothing at all.
 *
 * THREE WAYS TO HAVE NO NAME AND ONE ANSWER FOR ALL OF THEM: the key is absent, GitHub returned `null`, or it
 * returned whitespace. The collector already drops an empty string, but a payload is `jsonb` a year old by the
 * time a reader sees it, so the guard is here rather than assumed upstream — and a name trimmed to nothing must
 * read as absent, never as a person whose name is the empty string. That is the shape that put " contributors"
 * on every team card, and a blank line under a login is the same fault one column over.
 */
function payloadName(payload: unknown, field: "displayName" | "name"): string | undefined {
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }
  const name = (payload as Record<string, unknown>)[field];
  if (typeof name !== "string") {
    return undefined;
  }
  const trimmed = name.trim();
  return trimmed === "" ? undefined : trimmed;
}
