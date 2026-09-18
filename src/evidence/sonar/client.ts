import { z } from "zod";
import { AvailabilityReason } from "../domain/availability.ts";
import type { SonarMeasures } from "../domain/sonar.ts";
import { parseMeasures, SONAR_METRIC_KEYS } from "./measures.ts";

/**
 * Reading one SonarCloud organisation's projects, analyses and measures. Ported from `metrics.sonar`.
 *
 * EVERY READ HERE WORKS ANONYMOUSLY, which is what this deployment does: there is no SonarCloud token in the
 * `dtsse-aat` vault. Measured against `sonarcloud.io` on 2026-09-17 with no credential — the project listing,
 * `/api/project_analyses/search` and `/api/measures/component` all answer 200, and the listing reports 315
 * projects for `hmcts`, of which a sampled 22 in 27 then resolved to a repository (see `./attribute.ts`). A
 * token widens the answers to an organisation's PRIVATE projects and changes nothing else, so the token path is
 * kept and nothing depends on it.
 */

const SONAR_URL = "https://sonarcloud.io";
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * SonarCloud's maximum page size, and what the project listing asks for: 315 projects is then one call.
 */
const MAXIMUM_PAGE_SIZE = 500;

/**
 * The environment variables a SonarCloud token is read from, in the order SonarCloud's own scanner documents.
 *
 * Read here rather than in `cli/index.ts` because it is this client's credential, and it is a list rather than
 * one name so that a deployment already setting either variable for a scanner needs no second copy of it.
 */
const TOKEN_VARIABLES = ["SONAR_TOKEN", "SONARCLOUD_TOKEN"];

/** The first SonarCloud token the environment sets, or `undefined` for the anonymous read. */
export function sonarToken(environment: Record<string, string | undefined>): string | undefined {
  for (const name of TOKEN_VARIABLES) {
    const token = environment[name];
    if (token !== undefined && token.trim() !== "") {
      return token;
    }
  }
  return undefined;
}

/** Reports a SonarCloud read that could not be completed, carrying why. */
export class SonarError extends Error {
  readonly reason: AvailabilityReason;

  constructor(message: string, reason: AvailabilityReason, options?: ErrorOptions) {
    super(message, options);
    this.name = "SonarError";
    this.reason = reason;
  }
}

const projectsSchema = z.object({
  paging: z.object({ pageIndex: z.number(), pageSize: z.number(), total: z.number() }).nullish(),
  components: z.array(z.object({ key: z.string(), name: z.string().nullish(), analysisDate: z.string().nullish() })).default([])
});

const analysesSchema = z.object({
  analyses: z.array(z.object({ key: z.string().nullish(), date: z.string().nullish(), revision: z.string().nullish() })).default([])
});

const measuresSchema = z.object({
  component: z.object({ key: z.string().nullish(), measures: z.array(z.object({ metric: z.string(), value: z.string().nullish() })).default([]) })
});

export interface SonarClientOptions {
  organization: string;
  token?: string;
  fetch?: typeof globalThis.fetch;
  baseUrl?: string;
}

export function createSonarClient(options: SonarClientOptions) {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const baseUrl = options.baseUrl ?? SONAR_URL;

  /**
   * One SonarCloud read.
   *
   * The token is optional and widens what can be read to private projects; an anonymous client reads the
   * public ones, which is most of an open organisation. A 404 is carried as `NotFoundOrInaccessible` because
   * the caller reads it as a REFUTATION — a project that does not exist — rather than as a failure.
   */
  async function read<Schema extends z.ZodTypeAny>(schema: Schema, path: string, parameters: Record<string, string>, what: string): Promise<z.infer<Schema>> {
    const url = new URL(`${baseUrl}${path}`);
    for (const [name, value] of Object.entries(parameters)) {
      url.searchParams.set(name, value);
    }
    const headers: Record<string, string> = { Accept: "application/json" };
    if (options.token) {
      // SonarCloud takes the token as the basic-auth username with an empty password.
      headers.Authorization = `Basic ${Buffer.from(`${options.token}:`).toString("base64")}`;
    }

    let response: Response;
    try {
      response = await fetchImpl(url.toString(), { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (error) {
      throw new SonarError(`SonarCloud could not be reached for ${what}`, AvailabilityReason.CollectionFailed, { cause: error });
    }

    if (response.status === 401) {
      throw new SonarError(`SonarCloud refused the ${what} read: unauthenticated`, AvailabilityReason.AuthenticationFailed);
    }
    if (response.status === 403) {
      throw new SonarError(`SonarCloud refused the ${what} read`, AvailabilityReason.PermissionDenied);
    }
    if (response.status === 404) {
      throw new SonarError(`SonarCloud has no ${what}`, AvailabilityReason.NotFoundOrInaccessible);
    }
    if (response.status === 429) {
      throw new SonarError(`SonarCloud rate limited the ${what} read`, AvailabilityReason.RateLimited);
    }
    if (!response.ok) {
      throw new SonarError(`SonarCloud returned HTTP ${response.status} for ${what}`, AvailabilityReason.CollectionFailed);
    }

    const body = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (error) {
      throw new SonarError(`SonarCloud returned an unreadable ${what} body`, AvailabilityReason.CollectionFailed, { cause: error });
    }
    const result = schema.safeParse(parsed);
    if (!result.success) {
      throw new SonarError(`SonarCloud returned ${what} this build cannot accept`, AvailabilityReason.CollectionFailed, { cause: result.error });
    }
    return result.data;
  }

  return {
    /**
     * Every project the organisation lists, with the instant each was last analysed, paged to the end.
     *
     * `/api/components/search_projects` AND NOT `/api/projects/search`, which is an administrative endpoint:
     * measured on 2026-09-17, the latter answers 401 to an anonymous caller for `hmcts` while this one answers
     * 200 with all 315 public projects. This is the endpoint SonarCloud's own project explorer reads.
     *
     * `analysisDate` is asked for by name — `f=analysisDate` — because it is what `map-sonar`'s skip watermark
     * compares against. Without it every project would look never-analysed, and a run would re-pay the whole
     * organisation's commit-search quota every time.
     */
    async projects(): Promise<{ key: string; name?: string; analysisAt?: Date }[]> {
      const found: { key: string; name?: string; analysisAt?: Date }[] = [];
      for (let page = 1; ; page += 1) {
        const parsed = await read(
          projectsSchema,
          "/api/components/search_projects",
          { organization: options.organization, p: String(page), ps: String(MAXIMUM_PAGE_SIZE), f: "analysisDate" },
          "projects"
        );
        found.push(
          ...parsed.components.map((component) => ({
            key: component.key,
            ...(component.name ? { name: component.name } : {}),
            ...(component.analysisDate ? { analysisAt: new Date(component.analysisDate) } : {})
          }))
        );
        const paging = parsed.paging;
        if (paging == null || found.length >= paging.total || parsed.components.length === 0) {
          break;
        }
      }
      return found;
    },

    /** The most recent analyses of one project, newest first. */
    async projectAnalyses(project: string, limit: number): Promise<{ revision?: string; analysisAt?: Date }[]> {
      const parsed = await read(analysesSchema, "/api/project_analyses/search", { project, ps: String(limit) }, `project ${project}`);
      return parsed.analyses.map((analysis) => ({
        ...(analysis.revision ? { revision: analysis.revision } : {}),
        ...(analysis.date ? { analysisAt: new Date(analysis.date) } : {})
      }));
    },

    /** One project's measures, with every absence kept an absence. */
    async measures(project: string, analysisAt: Date | undefined): Promise<SonarMeasures> {
      const parsed = await read(
        measuresSchema,
        "/api/measures/component",
        { component: project, metricKeys: SONAR_METRIC_KEYS.join(",") },
        `measures for ${project}`
      );
      return parseMeasures(
        project,
        parsed.component.measures.map((measure) => ({ metric: measure.metric, ...(measure.value == null ? {} : { value: measure.value }) })),
        analysisAt
      );
    }
  };
}

export type SonarClient = ReturnType<typeof createSonarClient>;

/**
 * What a revision must look like to be worth asking GitHub about, and safe to ask with.
 *
 * WORTH: nothing but a hexadecimal object name can match a commit, so anything else is a wasted call against
 * the scarcest quota this project spends. SAFE: the revision reaches GitHub both as a `hash:` search qualifier
 * and as a path segment of `/repos/{org}/{repo}/commits/{sha}`, so an unconstrained value SonarCloud returned
 * could address a different endpoint entirely and have its `200` read as a confirmation.
 */
const COMMIT_SHA = /^[0-9a-fA-F]{7,64}$/;

/**
 * The distinct revisions worth searching for, newest first, each with the analysis that named it.
 *
 * DISTINCT, because a project re-analysed on an unchanged main branch reports the same SHA for several
 * analyses running, and paying the scarcest quota there is twice for one identical question buys nothing.
 * Revision-less analyses drop out — SonarCloud does not record a commit for every analysis — and so does
 * anything that is not an object name, per `COMMIT_SHA`.
 */
export function searchableRevisions(analyses: readonly { revision?: string; analysisAt?: Date }[]): { revision: string; analysisAt?: Date }[] {
  const seen = new Set<string>();
  const searchable: { revision: string; analysisAt?: Date }[] = [];
  for (const analysis of analyses) {
    const revision = analysis.revision;
    if (revision === undefined || seen.has(revision) || !COMMIT_SHA.test(revision)) {
      continue;
    }
    seen.add(revision);
    searchable.push({ revision, ...(analysis.analysisAt === undefined ? {} : { analysisAt: analysis.analysisAt }) });
  }
  return searchable;
}
