import type * as contract from "../../../lib/types.ts";
import type { TeamMember } from "../../org/people.ts";
import { stripAbsent } from "../absent.ts";

/**
 * Each team's members as the team page lists them, named through the SAME map the contributor rows are.
 *
 * ONE NAMING SEAM AND NOT TWO. `contributorNames` resolves every live member of the organisation from the SSO
 * identity mapping, so a member who merged nothing in the window is named exactly as well as one who merged
 * fifty — and a member and a contributor who are the same person cannot be shown under two different names. A
 * second lookup for this section would be a second thing to keep true.
 *
 * ABSENT AND EMPTY ARE DIFFERENT ANSWERS, which this preserves rather than decides: a team missing from
 * `memberships` is missing from what this returns, so the page states that no membership was read instead of
 * printing an empty table under a heading that would read as "GitHub says this team has nobody in it".
 *
 * `stripAbsent` per team rather than over the map, because it walks objects and arrays and a `Map` is neither —
 * handed one it would return an empty object and take the whole section with it.
 */
export function builtTeamMemberRows(
  memberships: ReadonlyMap<string, readonly TeamMember[]>,
  names: ReadonlyMap<string, string>
): ReadonlyMap<string, contract.TeamMemberRow[]> {
  const members = new Map<string, contract.TeamMemberRow[]>();
  for (const [team, people] of memberships) {
    members.set(
      team,
      stripAbsent(
        people
          .map(
            (person): contract.TeamMemberRow => ({
              login: person.login,
              // Folded on the way in, for `contributorNames`' reason: the team walk and the people walk spell a
              // login however GitHub answered each of them, and a case difference would read as a member with no
              // name.
              name: names.get(person.login.toLowerCase()),
              role: person.role
            })
          )
          // Alphabetical by login, case-insensitively — the rule `builtActorRows` and `teamActors` order by, so
          // the two lists on a team's page are alphabetised the same way and neither is ordered by a database
          // collation the other is not.
          .sort((left, right) => left.login.toLowerCase().localeCompare(right.login.toLowerCase()))
      )
    );
  }
  return members;
}
