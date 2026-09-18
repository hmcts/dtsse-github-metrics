import { AvailabilityReason, GitHubError } from "../domain/availability.ts";
import { SonarMappingOutcome, type SonarResolutionAttempt, SonarResolutionMethod, type StoredSonarMapping } from "../domain/sonar.ts";
import type { GitHubClient } from "../github/client.ts";
import { type SonarClient, SonarError, searchableRevisions } from "./client.ts";
import { type CallPacer, createCallPacer } from "./pacer.ts";

/**
 * Naming the GitHub repository one SonarCloud project analyses. Ported from `metrics.sonar.sonar_to_github`.
 *
 * THE PROJECT DIRECTION, and the expensive one. `./resolve.ts` asks which project analyses a repository and
 * answers most of the estate from the map for nothing; this is what BUILDS that map, and it is the only thing
 * here that spends GitHub's commit search — 30 documented calls a minute, 10 observed, against quotas counted
 * in thousands an hour everywhere else. That is why `map-sonar` is a command of its own rather than a step of
 * `collect`, and why every answer it reaches is stored, including the ones that say there is no repository.
 *
 * NEITHER SIDE RECORDS THE PAIRING, so the commit SHA is the identifier the two systems share: read the
 * project's most recent analyses and search the organisation for each revision until a commit resolves.
 *
 * MEASURED ANONYMOUSLY on 2026-09-17, over every twelfth project of the 315 SonarCloud lists for `hmcts`: 22 of
 * 27 resolved to a repository, 4 named a commit no repository in the organisation holds, and 1 had no analysis
 * carrying a revision. No SonarCloud read and no commit search was refused without a credential. Three of the 22
 * are also the argument against name matching, because no name rule reaches them: `Probate` is
 * `probate-frontend`, `SSCSCL` is `sscs-case-loader`, and `hmcts_apim-public-frontend` is `web-api-marketplace`.
 */

/**
 * GitHub's DOCUMENTED commit-search allowance for an authenticated caller, in calls a minute.
 *
 * A BOOTSTRAP VALUE AND NOT THE PACING RULE. Measured over a full upstream `map-sonar` run on 2026-08-27 the
 * token in use was issued TEN a minute: the run took a 403 after every tenth search, 37 times, and paid a
 * 60-second backoff for each. `./pacer.ts` therefore paces off the `x-ratelimit-*` headers GitHub actually
 * returns and falls back to this interval only until the first response reports a budget.
 */
export const SEARCH_CALLS_PER_MINUTE = 30;
const SEARCH_INTERVAL_SECONDS = 60 / SEARCH_CALLS_PER_MINUTE;

/**
 * The resource name the commit search is ISSUED under, which is deliberately not the one it is PACED by.
 *
 * `github/client.ts` holds back an absolute reserve of calls tuned to the 5,000-an-hour core quota, and a
 * reserve of 100 out of a limit of 30 would stop the run before its second search. Pacing for this quota is
 * done here, by interval; the name only keeps the client's logs honest about which call is waiting.
 */
const COMMIT_SEARCH_RESOURCE = "commit-search";

/** What GitHub's own headers call the quota the commit search spends, and so the key its budget is under. */
const SEARCH_BUDGET_RESOURCE = "search";

/**
 * How many of a project's analyses may be searched before it is given up on.
 *
 * More than one, because a pull-request analysis can name a commit on a branch since force-pushed or deleted,
 * which is then in no repository at all — while the analysis under it, on the default branch, is permanent.
 * Bounded, because every attempt spends the scarcest quota there is.
 */
export const MAXIMUM_ANALYSES_TRIED = 5;

/** The commit-search pacer, wired to the search budget this client has last been told about. */
export function searchPacer(client: GitHubClient, interval: number = SEARCH_INTERVAL_SECONDS): CallPacer {
  return createCallPacer({ interval, budget: () => client.budget(SEARCH_BUDGET_RESOURCE) });
}

interface CommitSearchPage {
  items?: { repository?: { full_name?: string } }[];
}

/**
 * Asks GitHub which repository in one organisation holds one commit.
 *
 * One paced call. The `org:` qualifier is what makes the answer usable: an unqualified `hash:` search reaches
 * every public repository on GitHub, and a commit found in a fork elsewhere says nothing about who owns the
 * project. Only the FIRST result is read — a SHA present twice in one organisation is a fork, and GitHub's best
 * match is the answer either way.
 */
export async function searchCommit(client: GitHubClient, organization: string, revision: string, pacer: CallPacer): Promise<string | undefined> {
  await pacer.wait();
  const page = await client.get<CommitSearchPage>("/search/commits", { q: `org:${organization} hash:${revision}`, per_page: 1 }, COMMIT_SEARCH_RESOURCE);
  return page.items?.[0]?.repository?.full_name ?? undefined;
}

/**
 * The repository name in an `owner/name` pair, or `undefined` where the owner is somebody else.
 *
 * Compared without regard to case, as GitHub compares owners. AN OWNER THAT IS NOT THE CONFIGURED ORGANISATION
 * IS NOT A NEAR MISS TO BE TRIMMED OFF: the project analyses somebody else's code, and attributing it here
 * would put another organisation's quality gate on this one's report.
 */
export function attributedRepository(organization: string, fullName: string): string | undefined {
  const [owner, repository] = fullName.split("/", 2);
  if (owner === undefined || repository === undefined || repository === "") {
    return undefined;
  }
  return owner.toLowerCase() === organization.toLowerCase() ? repository : undefined;
}

/**
 * Searches one analysed revision, returning the attempt it settles or `undefined` to walk on to the next.
 *
 * `undefined` means only "this commit answered nothing", which is the one outcome worth another analysis: a
 * force-pushed pull-request branch takes its commits with it, and the analysis under it may still name one that
 * exists. Every other outcome — found, found elsewhere, refused — is final, because an older analysis cannot
 * contradict it.
 */
export async function resolveRevision(
  client: GitHubClient,
  organization: string,
  project: string,
  revision: string,
  analysisAt: Date | undefined,
  now: Date,
  pacer: CallPacer
): Promise<SonarResolutionAttempt | undefined> {
  let fullName: string | undefined;
  try {
    fullName = await searchCommit(client, organization, revision, pacer);
  } catch (error) {
    if (!(error instanceof GitHubError)) {
      throw error;
    }
    // RE-RAISED RATHER THAN CLASSIFIED: an exhausted search quota applies to every project still to come
    // exactly as it applied to this one, so recording it would write this run's exhaustion into the map as each
    // remaining project's own dead end.
    if (error.reason === AvailabilityReason.RateLimited) {
      throw error;
    }
    return { projectKey: project, outcome: SonarMappingOutcome.Failed, analysesTried: 0, detail: error.message };
  }
  if (fullName === undefined) {
    return undefined;
  }
  const repository = attributedRepository(organization, fullName);
  if (repository === undefined) {
    return {
      projectKey: project,
      outcome: SonarMappingOutcome.OutsideOrganization,
      analysesTried: 0,
      detail: `commit ${revision} belongs to ${fullName}, which is outside ${organization}`
    };
  }
  const mapping: StoredSonarMapping = {
    projectKey: project,
    repository,
    method: SonarResolutionMethod.AnalysisRevision,
    ...(analysisAt === undefined ? {} : { analysisAt }),
    revision,
    resolvedAt: now
  };
  return { projectKey: project, outcome: SonarMappingOutcome.Resolved, analysesTried: 0, mapping };
}

/**
 * Names the repository one SonarCloud project analyses, through its analysed commits.
 *
 * Every outcome but `Failed` is an ANSWER ABOUT THE PROJECT and is meant to be stored as one — a project
 * SonarCloud has never analysed and one whose analyses name no findable commit are both settled until the next
 * analysis exists. A rate limit that survived the client's own retries is the exception, and it is raised.
 */
export async function attributeProject(options: {
  sonarClient: SonarClient;
  githubClient: GitHubClient;
  organization: string;
  projectKey: string;
  pacer: CallPacer;
  now: Date;
  attempts?: number;
}): Promise<SonarResolutionAttempt> {
  const { sonarClient, githubClient, organization, projectKey, pacer, now } = options;
  const attempts = options.attempts ?? MAXIMUM_ANALYSES_TRIED;

  let analyses: { revision?: string; analysisAt?: Date }[];
  try {
    analyses = await sonarClient.projectAnalyses(projectKey, attempts);
  } catch (error) {
    if (!(error instanceof SonarError)) {
      throw error;
    }
    return { projectKey, outcome: SonarMappingOutcome.Failed, analysesTried: 0, detail: error.message };
  }
  if (analyses.length === 0) {
    return {
      projectKey,
      outcome: SonarMappingOutcome.NoAnalysis,
      analysesTried: 0,
      detail: "SonarCloud records no analysis of this project, so there is no commit to resolve it by"
    };
  }
  const revisions = searchableRevisions(analyses);
  if (revisions.length === 0) {
    return {
      projectKey,
      outcome: SonarMappingOutcome.NoRevision,
      analysesTried: 0,
      detail: `none of the ${analyses.length} most recent analyses names the commit it ran against`
    };
  }

  let tried = 0;
  for (const { revision, analysisAt } of revisions) {
    tried += 1;
    const settled = await resolveRevision(githubClient, organization, projectKey, revision, analysisAt, now, pacer);
    if (settled !== undefined) {
      // The cost is attached here rather than inside the search, so the one place counting searches is the one
      // place issuing them.
      return { ...settled, analysesTried: tried };
    }
  }
  return {
    projectKey,
    outcome: SonarMappingOutcome.UnknownCommit,
    analysesTried: tried,
    detail: `no commit in ${organization} matches any of the ${tried} most recently analysed revisions`
  };
}

/**
 * Whether the stored map already answers for this project, so that no call need be spent on it.
 *
 * THE WATERMARK IS WHEN THE ROW WAS WRITTEN, NOT WHICH ANALYSIS ANSWERED. A row is skipped when NOTHING HAS
 * BEEN ANALYSED SINCE it was stored: whatever the last run learned — a repository, or the reason there is none
 * — is a property of the analyses that existed then, and asking again before a newer one exists spends the
 * scarcest quota there is on a question already answered. It falls through the moment a newer analysis exists,
 * which is the only thing that can change the answer.
 *
 * Comparing against the RESOLVING analysis instead would never converge for the projects `attributeProject`
 * walks back for: it records the instant of whichever analysis resolved, which is older than the listed one
 * whenever the newest commit is not findable — so the row would be re-resolved every run.
 */
export function alreadyAnswered(listedAnalysisAt: Date | undefined, stored: StoredSonarMapping): boolean {
  return listedAnalysisAt === undefined || listedAnalysisAt.getTime() <= stored.resolvedAt.getTime();
}
