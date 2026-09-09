import type { Configuration } from "./schema.ts";

/**
 * What the configuration still decides about repositories, now that it no longer decides the cohort.
 *
 * `configuredRepositories`, `repositoryOwners` and `ownedRepositories` used to live here and read `teams:`. The
 * cohort moved to the collected graph — see `org/cohort.ts` — because a hand-maintained list of 1,872 names is
 * stale the day it lands. What is left here is the part a graph cannot answer: which owners a human has
 * OVERRIDDEN, and what a team is called.
 *
 * This is still ordering and lookup, not aggregation: nothing here groups repositories or reduces a team's
 * repositories to one anything.
 */

/**
 * Each repository a human has assigned an owner to, mapped to the teams they assigned.
 *
 * This is the ladder's `configured` rung and the whole of what `teams:` now does. It short-circuits every
 * collected rung, on the precedent `sonar_projects` sets: an override is the answer, not a hint.
 *
 * Sorted by team then repository so two runs propose the same order, which is the ordering rule the file era
 * established and `org/cohort.ts` continues for the cohort itself. A repository may appear under several teams —
 * shared ownership is real — and each is kept.
 */
export function configuredOwners(configuration: Configuration): Map<string, string[]> {
  const pairs: [string, string][] = configuration.teams.flatMap((team) =>
    team.repositories.map((repository) => [team.identifier, repository] as [string, string])
  );
  pairs.sort((left, right) => left[0].localeCompare(right[0]) || left[1].localeCompare(right[1]));

  const owners = new Map<string, string[]>();
  for (const [identifier, repository] of pairs) {
    const existing = owners.get(repository);
    if (existing === undefined) {
      owners.set(repository, [identifier]);
    } else if (!existing.includes(identifier)) {
      existing.push(identifier);
    }
  }
  return owners;
}

/**
 * Each repository mapped to its enablement instant, over the repositories given.
 *
 * Takes the cohort rather than reading it, so this stays a pure lookup and the caller decides what the estate
 * is. Every repository given appears, including the ones without a date: a repository missing an anchor is
 * reported with that reason and no series, never silently dropped and never defaulted to an instant nobody
 * chose.
 */
export function enablementInstants(configuration: Configuration, repositories: readonly string[]): Map<string, Date | undefined> {
  return new Map(repositories.map((repository) => [repository, configuration.enablement[repository]]));
}

/**
 * Each team identifier mapped to the display name the file gives it.
 *
 * A LOOKUP WITH A FALLBACK NOW, not a complete map. The graph knows teams by slug and the file names only the
 * ones somebody has overridden, so most cohort teams are absent from this and callers fall back to the slug.
 * That is why it returns a map rather than resolving names itself: the caller knows what to do with a miss.
 */
export function teamDisplayNames(configuration: Configuration): Map<string, string> {
  return new Map(configuration.teams.map((team) => [team.identifier, team.display_name]));
}

/**
 * The SonarCloud organisation to read, falling back to the GitHub organisation.
 *
 * `sonar_organization` is left absent rather than defaulted to the same text, so the common case is
 * not restated in every configuration file.
 */
export function sonarOrganizationName(configuration: Configuration): string {
  return configuration.sonar_organization?.trim() || configuration.organization;
}
