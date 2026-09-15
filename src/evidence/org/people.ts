import { liveOrgPeople } from "../store/org-graph.ts";

/**
 * What the organisation graph knows a person is CALLED, as opposed to what they log in as.
 *
 * `collect-org` already stores it. The people walk asks GitHub for `name`, `email` and `company` on every
 * organisation member and keeps whichever of the three came back, so a real name has been in `org_people.payload`
 * since the walk landed and nothing has ever read it — the dashboard has shown the login everywhere.
 *
 * NO NEW GITHUB CALL IS NEEDED FOR THIS and no second source exists either. Measured on the live estate, 325 of
 * 778 members have a name set, so this map answers for 41.8% of the organisation and the other 58% fall back to
 * their login at every point of use. The stored merge facts carry no author email and no git author name, so
 * there is nothing to derive the rest from — see `Contributor` in `src/lib/types.ts`.
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
    const name = profileName(person.payload);
    if (name !== undefined) {
      names.set(person.login.toLowerCase(), name);
    }
  }
  return names;
}

/**
 * One person's name out of their stored payload, or nothing at all.
 *
 * THREE WAYS TO HAVE NO NAME AND ONE ANSWER FOR ALL OF THEM: the key is absent, GitHub returned `null`, or it
 * returned whitespace. The collector already drops an empty string, but a payload is `jsonb` a year old by the
 * time a reader sees it, so the guard is here rather than assumed upstream — and a name trimmed to nothing must
 * read as absent, never as a person whose name is the empty string. That is the shape that put " contributors"
 * on every team card, and a blank line under a login is the same fault one column over.
 */
function profileName(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }
  const name = (payload as { name?: unknown }).name;
  if (typeof name !== "string") {
    return undefined;
  }
  const trimmed = name.trim();
  return trimmed === "" ? undefined : trimmed;
}
