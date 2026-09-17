import type { StoredSonarMapping } from "../domain/sonar.ts";

/**
 * The stored project map, indexed both ways for one walk of the estate. Ported from `metrics.storage`'s two
 * map queries.
 *
 * READ ONCE PER RUN AND INDEXED IN MEMORY, rather than queried per repository. The whole map is one small table
 * — 315 projects for `hmcts` — and `collect` asks about it for every repository in the estate, so a query each
 * would be 1,889 round trips for a table that fits in a single read. It is also the shape `./resolve.ts` asks
 * for: two lookup functions, one by project key and one by repository.
 */

/** The project a repository is claimed by, and how many projects claimed it. */
export interface RepositoryClaim {
  mapping: StoredSonarMapping;
  candidates: number;
}

export interface SonarProjectMap {
  /** What the map knows about one project, INCLUDING a remembered negative — a row with a reason and no repository. */
  byProject(projectKey: string): StoredSonarMapping | undefined;
  /** The project the map attributes to one repository, with how many claimed it. */
  byRepository(repository: string): RepositoryClaim | undefined;
  /** How many projects the map holds an answer for, resolved or not. Zero means the mapping has never been run. */
  answered: number;
  /** How many of those answers name a repository. */
  attributed: number;
}

/**
 * Whether one candidate mapping supersedes another as the project to report for a repository.
 *
 * MANY-TO-ONE IS ORDINARY, not a fault: SonarCloud has no rename, so a re-created project leaves its abandoned
 * twin behind claiming the same repository, and the most recently analysed one is the live one. AN UNDATED
 * CANDIDATE LOSES TO EVERY DATED ONE and never wins a tie, and the project key breaks a remaining tie, so the
 * order is total and a repeated read answers the same way.
 */
function supersedes(candidate: StoredSonarMapping, incumbent: StoredSonarMapping): boolean {
  const candidateAt = candidate.analysisAt?.getTime();
  const incumbentAt = incumbent.analysisAt?.getTime();
  if (candidateAt !== incumbentAt) {
    if (candidateAt === undefined) {
      return false;
    }
    if (incumbentAt === undefined) {
      return true;
    }
    return candidateAt > incumbentAt;
  }
  return candidate.projectKey < incumbent.projectKey;
}

/**
 * Indexes the stored rows of one SonarCloud organisation's map.
 *
 * The repository index folds case, because one side of the comparison is a name GitHub returned and the other
 * is a name a human typed into the configuration file — or a repository name collected from the graph, which
 * GitHub itself compares case-insensitively.
 */
export function sonarProjectMap(rows: readonly StoredSonarMapping[]): SonarProjectMap {
  const byProject = new Map<string, StoredSonarMapping>();
  const claims = new Map<string, RepositoryClaim>();

  for (const row of rows) {
    byProject.set(row.projectKey, row);
    if (row.repository === undefined) {
      continue;
    }
    const key = row.repository.toLowerCase();
    const claimed = claims.get(key);
    if (claimed === undefined) {
      claims.set(key, { mapping: row, candidates: 1 });
      continue;
    }
    claims.set(key, {
      mapping: supersedes(row, claimed.mapping) ? row : claimed.mapping,
      candidates: claimed.candidates + 1
    });
  }

  return {
    byProject: (projectKey: string) => byProject.get(projectKey),
    byRepository: (repository: string) => claims.get(repository.toLowerCase()),
    answered: byProject.size,
    attributed: claims.size
  };
}
