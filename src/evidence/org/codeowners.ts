import { byCodePoint, canonical, PlaceholderLogins } from "./graph.ts";

/**
 * Reading a CODEOWNERS file. Ported from `build_team_configuration.py`'s `parse_codeowners`.
 *
 * PURE, and deliberately so: no `fetch`, no client, no organisation lookup. Everything about who a file names
 * is decided from the text and the surveyed organisation's name, which is what lets the cases below be tested
 * on strings alone — the same separation `parseProductionRepositories` gets its coverage from, and the reason
 * the awkward cases (a handle inside a comment, a foreign organisation, one team written two ways) are cheap
 * to state as tests rather than argued about in review.
 *
 * WHAT THIS FILE MEANS IS "WHO IS EXPECTED TO REVIEW", NOT "WHO OWNS". CODEOWNERS is a review-request rule,
 * and the ladder in `graph.ts` weighs it as such: it is treated as a claim, and only a file naming exactly one
 * team is treated as an unambiguous one.
 */

/** What one CODEOWNERS file named, teams and people kept apart because the ladder treats them differently. */
export interface CodeownersOwners {
  teams: string[];
  people: string[];
}

/**
 * A team handle, anchored to a whole whitespace-separated token.
 *
 * ANCHORED RATHER THAN SCANNED, because a bare `@` appears in CODEOWNERS in two places that are not handles:
 * an owner given as an email address (`someone@example.com`, which GitHub accepts and this estate uses), and
 * the path column of a pattern. Scanning `@([A-Za-z0-9-]+)` across the line would read `@example` out of the
 * first as a person. GitHub's own format is whitespace-separated tokens, so testing tokens is both simpler and
 * closer to what GitHub does.
 */
const TEAM_HANDLE = /^@([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/;

/** A bare `@login`. Not followed by a `/`, because that is a team, and the two are different kinds of owner. */
const PERSON_HANDLE = /^@([A-Za-z0-9-]+)$/;

const placeholders = new Set(PlaceholderLogins.map((login) => canonical(login)));

/**
 * Every team and person one CODEOWNERS file names, folded and sorted.
 *
 * THE WHOLE FILE IS READ, not just the `*` line. HMCTS repositories routinely name a default owner for
 * everything and then name the same team again per directory, and reading only the default line would drop
 * every per-directory owner; a repository with no `*` line at all still has owners worth reporting, and under
 * a `*`-only rule it would read as owning nobody. Line ORDER is not preserved on purpose — GitHub resolves the
 * LAST matching pattern per path, which cannot be answered without knowing the path, so this reports the set of
 * owners a file names and leaves precedence to the rungs that have a repository in hand.
 *
 * COMMENTS ARE CUT FIRST. A handle someone left in a note — `# ask @hmcts/platform-operations before editing`
 * — is not an owner, and reading it as one attributes a repository to whoever was mentioned in passing.
 *
 * The surveyed organisation's own prefix is dropped case-insensitively, so `@hmcts/appreg` becomes `appreg`,
 * which is the slug the teams API returns and therefore the key `knownTeams` can be checked against. A FOREIGN
 * organisation's prefix is KEPT as `owner/team`, because there the prefix is the part that matters: a team in
 * another organisation is not this organisation's team of the same name, and flattening it would merge the two.
 *
 * Everything is emitted folded, and DEDUPLICATION HAPPENS AFTER FOLDING via `canonical`. A file naming both
 * `@hmcts/AppReg` and `@hmcts/appreg` names ONE team twice; left as two, the file would look contested and the
 * `codeowners-sole` rung — which fires only on exactly one team — would not fire for a repository that plainly
 * has a single owner.
 */
export function parseCodeowners(document: string, organization: string): CodeownersOwners {
  const prefix = canonical(organization);
  const teams = new Set<string>();
  const people = new Set<string>();

  for (const raw of document.split(/\r?\n/)) {
    const line = raw.split("#", 1)[0] ?? "";
    for (const token of line.split(/\s+/)) {
      if (!token.startsWith("@")) {
        continue;
      }
      const team = TEAM_HANDLE.exec(token);
      if (team !== null) {
        const owner = canonical(team[1] as string);
        const name = canonical(team[2] as string);
        teams.add(owner === prefix ? name : `${owner}/${name}`);
        continue;
      }
      const person = PERSON_HANDLE.exec(token);
      if (person !== null) {
        const login = canonical(person[1] as string);
        // `@global-owner1` and `@global-owner2` are GitHub's documentation examples, copied verbatim into 18
        // places across 97 files in this estate — the most common individual "owner" in it, and neither is a
        // person. See `PlaceholderLogins`: kept out here so the `codeowners-person` rung cannot attribute a
        // repository to an example.
        if (placeholders.has(login)) {
          continue;
        }
        people.add(login);
      }
    }
  }

  // Sorted so two runs over one unchanged file produce byte-identical facts, which is what makes the digest
  // comparison downstream able to say "nothing changed" rather than "the order changed".
  return { teams: [...teams].sort(byCodePoint), people: [...people].sort(byCodePoint) };
}

/** Merges the owners of the several CODEOWNERS paths one repository may carry, keeping the output stable. */
export function mergeCodeowners(files: CodeownersOwners[]): CodeownersOwners {
  const teams = new Set<string>();
  const people = new Set<string>();
  for (const file of files) {
    for (const team of file.teams) {
      teams.add(team);
    }
    for (const person of file.people) {
      people.add(person);
    }
  }
  return { teams: [...teams].sort(byCodePoint), people: [...people].sort(byCodePoint) };
}
