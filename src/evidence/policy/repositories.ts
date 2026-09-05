import type { Configuration } from "./schema.ts";

/**
 * Reading the cohort out of a configuration, ported from `metrics.config`'s module functions.
 *
 * This is ordering, not aggregation: nothing here groups repositories or reduces a team's repositories
 * to one anything.
 */

/**
 * Every configured repository beside the team that owns it, in the reporting order.
 *
 * Sorted by team identifier and then repository name rather than left in whatever order the
 * configuration file happens to list them. At one repository the difference was invisible; at fourteen,
 * moving a `teams:` block reorders an entire report and makes two runs undiffable, which hides the
 * change a reader was looking for. Ownership is unique — the schema enforces it — so the pair is a
 * total order and no repository can appear twice.
 */
export function ownedRepositories(configuration: Configuration): [string, string][] {
  const pairs: [string, string][] = configuration.teams.flatMap((team) =>
    team.repositories.map((repository) => [team.identifier, repository] as [string, string])
  );
  return pairs.sort((left, right) => left[0].localeCompare(right[0]) || left[1].localeCompare(right[1]));
}

/** Every configured repository name in the reporting order. */
export function configuredRepositories(configuration: Configuration): string[] {
  return ownedRepositories(configuration).map(([, repository]) => repository);
}

/**
 * Every configured repository, in the reporting order, mapped to its enablement instant or `undefined`.
 *
 * Every configured repository appears, including the ones without a date: a repository missing an
 * anchor is reported with that reason and no series, never silently dropped and never defaulted to an
 * instant nobody chose.
 */
export function enablementInstants(configuration: Configuration): Map<string, Date | undefined> {
  return new Map(configuredRepositories(configuration).map((repository) => [repository, configuration.enablement[repository]]));
}

/** Each configured repository mapped to the identifier of the team that owns it. */
export function repositoryOwners(configuration: Configuration): Map<string, string> {
  return new Map(ownedRepositories(configuration).map(([identifier, repository]) => [repository, identifier]));
}

/** Each team identifier mapped to its display name. */
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
