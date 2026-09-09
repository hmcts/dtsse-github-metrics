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
 * change a reader was looking for.
 *
 * THE PAIR IS A TOTAL ORDER; THE REPOSITORY IS NOT. Ownership was once unique and this comment used to
 * claim no repository could appear twice. Since shared ownership became representable it can: a
 * repository owned by two teams appears once per owner, which is the point. Callers wanting each
 * repository once want `configuredRepositories`, which dedupes for exactly that reason.
 */
export function ownedRepositories(configuration: Configuration): [string, string][] {
  const pairs: [string, string][] = configuration.teams.flatMap((team) =>
    team.repositories.map((repository) => [team.identifier, repository] as [string, string])
  );
  return pairs.sort((left, right) => left[0].localeCompare(right[0]) || left[1].localeCompare(right[1]));
}

/**
 * Every configured repository name ONCE, in the reporting order.
 *
 * Deduplicated first-occurrence-wins in pair order, and that is load-bearing rather than tidy now that a
 * repository may have several owners. Two callers depend on it: `runCollect` walks this to decide what to
 * fetch, so a duplicate would collect the same repository twice and report the estate as larger than it is;
 * and `repositoryRows` builds one row per name, so a duplicate would emit two rows for one repository and
 * double it in every overview total.
 */
export function configuredRepositories(configuration: Configuration): string[] {
  return [...new Set(ownedRepositories(configuration).map(([, repository]) => repository))];
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

/**
 * Each configured repository mapped to the identifiers of the teams that own it.
 *
 * A LIST, not a scalar, because a repository may be shared. The signature was changed outright rather than
 * kept beside a lossy single-owner variant: there are two callers, and a shim that silently returned the
 * first of several owners would be the kind of truncation nobody notices until a team's figures are wrong.
 *
 * Owners are in the reporting order, so `[0]` is a stable primary for callers that can only render one.
 *
 * These are `identifier`s, which are what a REPORT groups by. Anything writing an owner into the graph wants
 * `configuredTeamSlugs` instead — see there for why the two must not be confused.
 */
export function repositoryOwners(configuration: Configuration): Map<string, string[]> {
  const owners = new Map<string, string[]>();
  for (const [identifier, repository] of ownedRepositories(configuration)) {
    const existing = owners.get(repository);
    if (existing === undefined) {
      owners.set(repository, [identifier]);
    } else {
      existing.push(identifier);
    }
  }
  return owners;
}

/**
 * Each configured repository mapped to the GITHUB TEAM SLUGS that own it, for the ladder's `configured` rung.
 *
 * TWO NAMESPACES WERE BEING MIXED, and this separates them. `repository_ownership.owner` is documented as "a team
 * slug, a login, or ''", and every collected rung writes a real slug from `org_teams`. The configured rung was
 * writing `identifier` — a name whose only job is to group a report — so for any team whose identifier differs
 * from its slug the row could not be joined to `org_teams`, and `prefixIndex` silently dropped the decision from
 * the name-prefix index because the identifier is not in `knownTeams`. It looked harmless only because the one
 * configured team happened to use the same word for both.
 *
 * This is also the first reader `github_team_slugs` has ever had. A team declaring several slugs contributes each
 * of them, because each is genuinely an owner. A team declaring NONE falls back to its identifier — the best
 * guess available, and the same string as before, so nothing gets worse for the case that used to work.
 */
export function configuredTeamSlugs(configuration: Configuration): Map<string, string[]> {
  const slugsByIdentifier = new Map(
    configuration.teams.map((team) => [team.identifier, team.github_team_slugs.length > 0 ? team.github_team_slugs : [team.identifier]])
  );
  const owners = new Map<string, string[]>();
  for (const [identifier, repository] of ownedRepositories(configuration)) {
    const held = owners.get(repository) ?? [];
    for (const slug of slugsByIdentifier.get(identifier) ?? [identifier]) {
      if (!held.includes(slug)) {
        held.push(slug);
      }
    }
    owners.set(repository, held);
  }
  return owners;
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
