import { ALERT_FAMILIES, AlertFamily, AlertScanState, alertScanState, type SecurityAlertDetail } from "../domain/alert-detail.ts";
import type { OpenAlertCount, SecurityAlertEvidence } from "../domain/security-alerts.ts";
import type { GitHubClient } from "../github/client.ts";
import { readCodeScanningAlert, readDependabotAlert, readSecretScanningAlert } from "./records.ts";

/**
 * Collecting the individual alerts, from the organisation-wide endpoint of each family.
 *
 * ONE PAGINATED WALK PER FAMILY FOR THE WHOLE ESTATE, AND NOT THREE CALLS PER REPOSITORY. Measured against live
 * GitHub with the collector App's installation token on 2026-09-22:
 *
 *     secret scanning, every state      146 alerts,   2 pages,  92 repositories,   2s
 *     code scanning, every state      1,852 alerts,  19 pages,  61 repositories,   9s
 *     Dependabot, open only          29,514 alerts, 296 pages, 452 repositories, 269s
 *
 * 317 requests and about five minutes, against the 5,670-plus that one call per repository per family would cost.
 * Against an installation budget of 15,000 core requests an hour that is a fiftieth of one hour's quota, which is
 * what makes this affordable daily rather than weekly.
 *
 * WHY THE STATE FILTERS DIFFER BETWEEN FAMILIES, which is a measurement and not an inconsistency. A resolved alert
 * is worth storing — it is the only place GitHub's own `resolution` exists, and for secret scanning 128 of the 146
 * alerts are resolved, so an open-only walk would store none of the credentials anybody has already revoked. It is
 * worth storing where it is cheap: all 146 secret-scanning alerts arrive in 2 pages and all 1,852 code-scanning
 * alerts in 19, against 5 for the open ones alone.
 *
 * Dependabot is the family where it is not cheap. Measured the same day, open-only is 29,514 alerts over 296 pages
 * in 269s and every state is 50,282 over 503 pages in 439s — 70% more requests and 20,768 more rows, every one of
 * them an alert whose whole content is that a dependency was bumped at some point. So Dependabot is walked
 * open-only, and the cost of that is stated where it lands: a stored Dependabot alert is always an open one, so its
 * `resolution` and `resolved_at` are always absent. Widening it is one word in `ENDPOINTS` below if a report ever
 * wants the closed history.
 */

/** How one family's organisation-wide alerts are asked for. */
interface FamilyEndpoint {
  path: (organization: string) => string;
  /** The query, which is where the open-only decision for Dependabot lives. */
  query: Record<string, string | number>;
  read: (record: unknown) => SecurityAlertDetail | undefined;
}

const ENDPOINTS: Readonly<Record<AlertFamily, FamilyEndpoint>> = {
  [AlertFamily.SecretScanning]: {
    path: (organization) => `/orgs/${organization}/secret-scanning/alerts`,
    query: { per_page: 100 },
    read: readSecretScanningAlert
  },
  [AlertFamily.Dependabot]: {
    path: (organization) => `/orgs/${organization}/dependabot/alerts`,
    // `state: open` for the reason the header measures: every state is 503 pages against 296 for 20,768 more rows
    // reporting that a dependency was bumped. The consequence is stated rather than hidden — a stored Dependabot
    // alert is an OPEN one, so its `resolution` and `resolved_at` are always absent.
    query: { state: "open", per_page: 100 },
    read: readDependabotAlert
  },
  [AlertFamily.CodeScanning]: {
    path: (organization) => `/orgs/${organization}/code-scanning/alerts`,
    query: { per_page: 100 },
    read: readCodeScanningAlert
  }
};

/** What one family's organisation-wide walk produced. */
export interface AlertWalk {
  family: AlertFamily;
  /**
   * The alerts it found, keyed by the CASEFOLDED repository name. `undefined` WHERE THE WALK ITSELF WAS REFUSED.
   *
   * Folded because the key has to survive GitHub spelling a name two ways: the walk's key comes out of the alert
   * record and the cohort's comes out of the repository listing, and GitHub owner and repository names are
   * case-insensitive. A miss here does not fail loudly — it reports a repository with alerts as clean, which is
   * exactly the class of wrong answer that reads like good news. `inventory/production.ts` folds the name it looks
   * up for the same reason.
   *
   * An empty map and `undefined` are different answers and the difference is the whole feature: an empty map means
   * the estate has no alerts of this family, and `undefined` means nobody could look. A refused walk that returned
   * an empty map would report the whole organisation clean, which is the one wrong answer that reads like good news.
   */
  byRepository?: Map<string, SecurityAlertDetail[]>;
  /** Records the walk could not attribute to a repository, counted rather than silently dropped. */
  unattributable: number;
  /** Why the walk produced nothing, where it failed. */
  detail?: string;
}

/**
 * Every alert of one family in the organisation, keyed by repository.
 *
 * FOLDED AS THE PAGES ARRIVE. Each record is projected to the dozen fields a reader needs before the next page is
 * asked for, which for Dependabot takes 29,514 records carrying a 60-field repository block each down to what is
 * stored. `cve/collect.ts` folds a Cosmos stream for the same reason and records what buffering it cost.
 *
 * The failure is NOT rethrown: a refused family must leave the other two collectable, exactly as
 * `collectSecurityAlerts` states for the per-repository reads. It is reported on the walk instead, and the caller
 * turns that into one failure for the run rather than one per repository.
 */
export async function collectOrganisationAlerts(client: GitHubClient, organization: string, family: AlertFamily): Promise<AlertWalk> {
  const endpoint = ENDPOINTS[family];
  const byRepository = new Map<string, SecurityAlertDetail[]>();
  let unattributable = 0;
  try {
    for await (const page of client.paginate<unknown>(endpoint.path(organization), endpoint.query)) {
      for (const record of page) {
        const alert = endpoint.read(record);
        if (alert === undefined) {
          unattributable += 1;
          continue;
        }
        const key = alert.repository.toLowerCase();
        const existing = byRepository.get(key);
        if (existing === undefined) {
          byRepository.set(key, [alert]);
        } else {
          existing.push(alert);
        }
      }
    }
  } catch (error) {
    return { family, unattributable, detail: `${family} could not be read for the organisation: ${error instanceof Error ? error.message : String(error)}` };
  }
  return { family, byRepository, unattributable };
}

/** One repository's position on one family: whether anybody looked, and what they saw. */
export interface AlertScan {
  repository: string;
  family: AlertFamily;
  state: AlertScanState;
  /** Why there are no alerts, for the two states that have none for a reason. */
  detail?: string;
  /** The alerts, which are meaningful ONLY beside a `Read` state. */
  alerts: readonly SecurityAlertDetail[];
}

/**
 * The stored count block per repository, as `repository_state.payload.securityAlerts` holds it.
 *
 * KEYED CASEFOLDED, as the walk is and for the same reason: a name spelled two ways would make the three-state
 * fallback below read "not collected" for a repository whose counts are stored under the other spelling.
 */
export type StoredCounts = ReadonlyMap<string, SecurityAlertEvidence | undefined>;

/** Which member of the count block answers for a family. */
const COUNT_FIELD: Readonly<Record<AlertFamily, keyof SecurityAlertEvidence>> = {
  [AlertFamily.SecretScanning]: "secretScanning",
  [AlertFamily.Dependabot]: "dependabot",
  [AlertFamily.CodeScanning]: "codeScanning"
};

/**
 * One repository's scan for one family, from the walk and from what `collect` already established.
 *
 * FOUR OUTCOMES, and the order they are decided in is the correctness of this whole feature:
 *
 *   1. The walk was REFUSED. Unmeasured, whatever the count block says — nothing this run did can speak for any
 *      repository, and a stored count from yesterday is not evidence about today's walk.
 *   2. The walk NAMED this repository. Read, whatever the count block says: something found those alerts, so
 *      something scanned. `organisationAnswer` decides the counts the same way and for the same reason.
 *   3. The walk did not name it, and the COUNT BLOCK SAYS THE FAMILY WAS READ. Genuinely clean — `Read` with no
 *      alerts, which is the measured zero this table exists to be able to say. The organisation-wide response
 *      covers every repository the feature is on for, so an absence from it IS an answer once something else
 *      confirms the feature is on.
 *   4. The walk did not name it and nothing confirms the feature is on. `alertScanState` splits that into "not
 *      enabled" and "unmeasured" off the block's own `detail`, and the absence is carried with the block's words so
 *      a reader gets the same sentence the count gave them.
 */
export function resolveAlertScan(repository: string, walk: AlertWalk, counts: StoredCounts): AlertScan {
  const family = walk.family;
  if (walk.byRepository === undefined) {
    return { repository, family, state: AlertScanState.Unmeasured, detail: walk.detail, alerts: [] };
  }
  // Folded for the lookup, stored as the cohort spelled it: the row has to join to `repository_state` and
  // `org_repository`, which are keyed by GitHub's own casing.
  const folded = repository.toLowerCase();
  const alerts = walk.byRepository.get(folded);
  if (alerts !== undefined) {
    return { repository, family, state: AlertScanState.Read, alerts };
  }
  const count: OpenAlertCount | undefined = counts.get(folded)?.[COUNT_FIELD[family]];
  const state = alertScanState(count);
  return {
    repository,
    family,
    state,
    ...(state === AlertScanState.Read ? {} : { detail: count?.detail ?? `${family} has not been collected for this repository` }),
    alerts: []
  };
}

/**
 * Every scan this run has an answer for: one per cohort repository per family.
 *
 * THE COHORT IS THE UNIVERSE AND NOT THE WALK'S KEY SET, which is what makes a refusal visible at all. Keying off
 * the response would write rows only for repositories that have alerts, so the 1,400-odd repositories with none and
 * the ones nobody may read would both be no row — and "no row" would then mean two opposite things.
 *
 * A REPOSITORY THE WALK NAMED BUT THE COHORT DOES NOT INCLUDE IS DROPPED. The cohort is what the policy selects and
 * what every other table is keyed by, so an alert against an archived or excluded repository has no row to hang off
 * and no page to appear on.
 */
export function resolveAlertScans(repositories: readonly string[], walks: readonly AlertWalk[], counts: StoredCounts): AlertScan[] {
  const byFamily = new Map(walks.map((walk) => [walk.family, walk]));
  const scans: AlertScan[] = [];
  for (const repository of repositories) {
    for (const family of ALERT_FAMILIES) {
      const walk = byFamily.get(family);
      if (walk !== undefined) {
        scans.push(resolveAlertScan(repository, walk, counts));
      }
    }
  }
  return scans;
}

/** What one family's scans amount to, for the line a run reports its coverage on. */
export interface FamilyCoverage {
  family: AlertFamily;
  /** Repositories whose family was read AND had at least one alert. */
  withAlerts: number;
  /** Repositories read and found clean, which is a measurement and not an absence. */
  clean: number;
  notEnabled: number;
  /** Repositories nobody could look at. NEVER to be reported as clean. */
  unmeasured: number;
  alerts: number;
}

/**
 * The coverage of one family, counted from the scans rather than from the walk.
 *
 * COUNTED FROM THE SCANS BECAUSE THAT IS WHAT WAS STORED. A figure taken off the walk would report the estate
 * GitHub answered for; this reports the estate the table now describes, which is the number a reader of the
 * dashboard is actually served — and the difference between them is exactly the repositories the cohort excludes.
 */
export function familyCoverage(family: AlertFamily, scans: readonly AlertScan[]): FamilyCoverage {
  const coverage: FamilyCoverage = { family, withAlerts: 0, clean: 0, notEnabled: 0, unmeasured: 0, alerts: 0 };
  for (const scan of scans) {
    if (scan.family !== family) {
      continue;
    }
    coverage.alerts += scan.alerts.length;
    if (scan.state === AlertScanState.NotEnabled) {
      coverage.notEnabled += 1;
    } else if (scan.state === AlertScanState.Unmeasured) {
      coverage.unmeasured += 1;
    } else if (scan.alerts.length > 0) {
      coverage.withAlerts += 1;
    } else {
      coverage.clean += 1;
    }
  }
  return coverage;
}
