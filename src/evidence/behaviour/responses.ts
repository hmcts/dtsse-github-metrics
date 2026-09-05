import { z } from "zod";
import { AvailabilityReason, GitHubError } from "../domain/availability.ts";

/**
 * Zod schemas for the GraphQL bodies behaviour collection reads. Ported from `metrics.behaviour`'s
 * `GitHubModel` family.
 *
 * PERMISSIVE, deliberately: upstream set `extra="ignore"` and these do the same by default, because GitHub
 * adds fields to its own payloads and a strict schema would reject a response for carrying more than was
 * asked for. What IS strict is the shape of what gets read — a missing `mergedAt` on a merged pull request
 * is a collection failure, not a fact with a hole in it.
 */

const actor = z.object({ login: z.string(), __typename: z.string() }).nullish();

const pageInfo = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullish() });

const instant = z.string().transform((value, ctx) => {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `unreadable instant: ${value}` });
    return z.NEVER;
  }
  return parsed;
});

const reviewNode = z.object({
  databaseId: z.number(),
  submittedAt: instant,
  state: z.string(),
  author: actor,
  body: z.string().nullish(),
  comments: z.object({ totalCount: z.number() })
});

const reviewConnection = z.object({ pageInfo, nodes: z.array(reviewNode.nullish()) });

const checkContext = z.object({
  __typename: z.string(),
  name: z.string().nullish(),
  status: z.string().nullish(),
  conclusion: z.string().nullish(),
  completedAt: instant.nullish(),
  context: z.string().nullish(),
  state: z.string().nullish(),
  createdAt: instant.nullish()
});

const checkConnection = z.object({ pageInfo, nodes: z.array(checkContext.nullish()) });

const commitConnection = z.object({
  nodes: z.array(z.object({ commit: z.object({ statusCheckRollup: z.object({ contexts: checkConnection }).nullish() }) }).nullish())
});

const pullRequestNode = z.object({
  databaseId: z.number(),
  number: z.number(),
  title: z.string().nullish(),
  body: z.string().nullish(),
  createdAt: instant,
  mergedAt: instant,
  isDraft: z.boolean(),
  additions: z.number().nullish(),
  deletions: z.number().nullish(),
  changedFiles: z.number().nullish(),
  timelineItems: z.object({ nodes: z.array(z.object({ createdAt: instant.nullish() }).nullish()) }),
  author: actor,
  reviews: reviewConnection,
  commits: commitConnection
});

export const searchSchema = z.object({
  search: z.object({ issueCount: z.number(), pageInfo, nodes: z.array(pullRequestNode.nullish()) })
});

export const reviewPageSchema = z.object({
  repository: z.object({ pullRequest: z.object({ reviews: reviewConnection }).nullish() }).nullish()
});

export const checkPageSchema = z.object({
  repository: z.object({ pullRequest: z.object({ commits: commitConnection }).nullish() }).nullish()
});

const commitNode = z.object({
  oid: z.string(),
  committedDate: instant,
  additions: z.number().nullish(),
  deletions: z.number().nullish(),
  changedFilesIfAvailable: z.number().nullish(),
  author: z.object({ user: actor, name: z.string().nullish() }).nullish(),
  associatedPullRequests: z.object({ nodes: z.array(z.object({ number: z.number() }).nullish()) }),
  statusCheckRollup: z.object({ state: z.string().nullish() }).nullish()
});

export const commitHistorySchema = z.object({
  repository: z
    .object({
      defaultBranchRef: z.object({ target: z.object({ history: z.object({ pageInfo, nodes: z.array(commitNode.nullish()) }).nullish() }).nullish() }).nullish()
    })
    .nullish()
});

export const openPullRequestSchema = z.object({
  openedInWindow: z.object({ issueCount: z.number() }),
  closedWithoutMerge: z.object({ issueCount: z.number() }),
  currentlyOpen: z.object({ issueCount: z.number() }),
  staleOpen: z.object({ issueCount: z.number() })
});

/**
 * Parses one GraphQL body, reporting a rejected shape as a collection failure.
 *
 * A response this build cannot READ and one it cannot PARSE are the same failure to every caller: each
 * degrades to "this evidence is unavailable" for the repository, and neither is allowed to escape as an
 * unclassified crash that would end the whole collection.
 */
export function parseResponse<Schema extends z.ZodTypeAny>(schema: Schema, data: unknown, what: string): z.infer<Schema> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new GitHubError(`GitHub returned invalid ${what}`, AvailabilityReason.CollectionFailed, undefined, { cause: result.error });
  }
  return result.data;
}

// The OUTPUT types, which is what collection works with: `instant` transforms a string into a `Date`, so
// these carry `Date` where the wire carries text.
export type SearchResponse = z.infer<typeof searchSchema>;
export type PullRequestNode = z.infer<typeof pullRequestNode>;
export type ReviewNode = z.infer<typeof reviewNode>;
export type ReviewConnection = z.infer<typeof reviewConnection>;
export type CheckContext = z.infer<typeof checkContext>;
export type CheckConnection = z.infer<typeof checkConnection>;
export type CommitConnection = z.infer<typeof commitConnection>;
export type CommitNode = z.infer<typeof commitNode>;
export type OpenPullRequestResponse = z.infer<typeof openPullRequestSchema>;

// The INPUT types, for a test or a fixture describing what GitHub actually sends — instants as ISO strings
// rather than as the `Date`s parsing turns them into.
export type CheckContextInput = z.input<typeof checkContext>;
export type CommitNodeInput = z.input<typeof commitNode>;
export type PullRequestNodeInput = z.input<typeof pullRequestNode>;
