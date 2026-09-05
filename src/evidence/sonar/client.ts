import { z } from "zod";
import { AvailabilityReason } from "../domain/availability.ts";
import type { SonarMeasures } from "../domain/sonar.ts";
import { parseMeasures, SONAR_METRIC_KEYS } from "./measures.ts";

/**
 * Reading one SonarCloud organisation's projects, analyses and measures. Ported from `metrics.sonar`.
 */

const SONAR_URL = "https://sonarcloud.io";
const REQUEST_TIMEOUT_MS = 30_000;

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
  components: z.array(z.object({ key: z.string(), name: z.string().nullish() })).default([])
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
    /** Every project the organisation lists, following its paging to the end. */
    async projects(): Promise<{ key: string; name?: string }[]> {
      const found: { key: string; name?: string }[] = [];
      for (let page = 1; ; page += 1) {
        const parsed = await read(projectsSchema, "/api/projects/search", { organization: options.organization, p: String(page), ps: "500" }, "projects");
        found.push(...parsed.components.map((component) => ({ key: component.key, ...(component.name ? { name: component.name } : {}) })));
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

/** The analyses that carry a revision a commit search could look for. */
export function searchableRevisions(analyses: readonly { revision?: string; analysisAt?: Date }[]): { revision: string; analysisAt?: Date }[] {
  return analyses
    .filter((analysis): analysis is { revision: string; analysisAt?: Date } => analysis.revision !== undefined && analysis.revision !== "")
    .map((analysis) => ({ revision: analysis.revision, ...(analysis.analysisAt === undefined ? {} : { analysisAt: analysis.analysisAt }) }));
}
