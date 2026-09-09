import { z } from "zod";
import { parseResponse } from "../behaviour/responses.ts";
import type { AccessLevel } from "./graph.ts";
import { CodeownersPaths } from "./graph.ts";

/**
 * Zod schemas for the bodies organisation-graph collection reads. Same idiom as `behaviour/responses.ts`, and
 * `parseResponse` is IMPORTED from there rather than written again: a response this build cannot read and one
 * it cannot parse are the same failure to every caller, and two spellings of that rule would eventually grade
 * the same broken body two different ways.
 *
 * PERMISSIVE, deliberately, for the reason that file gives: GitHub adds fields to its own payloads, and a
 * strict schema would reject a response for carrying more than was asked for. What is strict is the shape of
 * what gets READ — a team edge with no `permission` is a body this build cannot interpret, not a team holding
 * some unnamed access.
 */

const pageInfo = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullish() });

// Instants are parsed here rather than imported, because `behaviour/responses.ts` keeps its helper private;
// the rule is the same one — an unreadable timestamp is a body this build cannot read, not a repository with
// no last push.
const instant = z.string().transform((value, ctx) => {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `unreadable instant: ${value}` });
    return z.NEVER;
  }
  return parsed;
});

const memberEdge = z.object({ role: z.string().nullish(), node: z.object({ login: z.string() }).nullish() });

const memberConnection = z.object({ totalCount: z.number().nullish(), pageInfo, edges: z.array(memberEdge.nullish()) });

const teamRepositoryEdge = z.object({
  permission: z.string().nullish(),
  node: z.object({ name: z.string(), isArchived: z.boolean().nullish() }).nullish()
});

const teamRepositoryConnection = z.object({ totalCount: z.number().nullish(), pageInfo, edges: z.array(teamRepositoryEdge.nullish()) });

const teamNode = z.object({
  slug: z.string(),
  name: z.string().nullish(),
  description: z.string().nullish(),
  privacy: z.string().nullish(),
  parentTeam: z.object({ slug: z.string() }).nullish(),
  members: memberConnection,
  repositories: teamRepositoryConnection
});

export const orgTeamsSchema = z.object({
  organization: z.object({ teams: z.object({ totalCount: z.number().nullish(), pageInfo, nodes: z.array(teamNode.nullish()) }).nullish() }).nullish()
});

export const teamMembersSchema = z.object({
  organization: z.object({ team: z.object({ members: memberConnection }).nullish() }).nullish()
});

export const teamRepositoriesSchema = z.object({
  organization: z.object({ team: z.object({ repositories: teamRepositoryConnection }).nullish() }).nullish()
});

const repositoryNode = z.object({
  name: z.string(),
  isArchived: z.boolean().nullish(),
  isFork: z.boolean().nullish(),
  visibility: z.string().nullish(),
  pushedAt: instant.nullish(),
  defaultBranchRef: z.object({ name: z.string().nullish() }).nullish()
});

export const orgRepositoriesSchema = z.object({
  organization: z
    .object({ repositories: z.object({ totalCount: z.number().nullish(), pageInfo, nodes: z.array(repositoryNode.nullish()) }).nullish() })
    .nullish()
});

const personEdge = z.object({
  role: z.string().nullish(),
  node: z.object({ login: z.string(), name: z.string().nullish(), email: z.string().nullish(), company: z.string().nullish() }).nullish()
});

export const orgPeopleSchema = z.object({
  organization: z
    .object({ membersWithRole: z.object({ totalCount: z.number().nullish(), pageInfo, edges: z.array(personEdge.nullish()) }).nullish() })
    .nullish()
});

/**
 * The ownership document, read as the aliased map it is.
 *
 * The top level cannot be a fixed shape: its keys are `f0`…`fN` for whatever `N` the batch had, beside
 * `rateLimit`. So the body is accepted as a mapping and each ENTRY is parsed on its own — which is also what
 * keeps one unreadable repository from rejecting a batch of 25.
 */
export const ownershipFilesSchema = z.record(z.string(), z.unknown());

const ownershipBlobSchema = z
  .object({
    text: z.string().nullish(),
    byteSize: z.number().nullish(),
    // Absent for anything that is not a Blob — a path resolving to a directory, most obviously. Read as "not
    // truncated", because there was no file to truncate.
    isTruncated: z.boolean().nullish()
  })
  .nullish();

export type OwnershipBlob = NonNullable<z.infer<typeof ownershipBlobSchema>>;

/** One repository's ownership answer: the name GitHub echoed, and one blob slot per `CodeownersPaths` entry. */
export interface OwnershipEntry {
  /** GitHub's own spelling, for the assertion that an alias belongs to the repository it was asked for. */
  name?: string;
  files: (OwnershipBlob | undefined)[];
}

/**
 * Reads one `f<n>` entry into a POSITIONAL list of blobs, in `CodeownersPaths` order.
 *
 * Positional rather than keyed, because the aliases carry position and nothing else: the caller knows which
 * path each slot came from, and a `p2` in a body is meaningless without this file's ordering anyway.
 */
export function ownershipEntry(value: unknown): OwnershipEntry {
  const entry = parseResponse(z.record(z.string(), z.unknown()), value, "CODEOWNERS repository data");
  const name = typeof entry.name === "string" ? entry.name : undefined;
  const files = CodeownersPaths.map((_path, at) => parseResponse(ownershipBlobSchema, entry[`p${at}`] ?? null, "CODEOWNERS blob data") ?? undefined);
  return { ...(name === undefined ? {} : { name }), files };
}

/** One direct collaborator, as REST reports them. */
export const collaboratorsSchema = z.array(z.object({ login: z.string(), type: z.string().nullish() }).nullish());

/**
 * GitHub's SCREAMING team permission, as the lower-case `AccessLevel` this codebase indexes ladders by.
 *
 * `WRITE` MAPS TO `push`, and that one row is the whole reason this function exists rather than a
 * `toLowerCase()` call. GraphQL words the level `WRITE`; the REST API, the Python original and `AccessLevels`
 * in `graph.ts` all word it `push`. Lower-casing alone yields `write`, which is not in the union, so
 * `isOwningAccess` rejects it and every team holding ordinary write access silently stops being an owner —
 * emptying the `teams-api-write` rung, which is the rung most service teams are attributed by.
 *
 * `READ` maps to `pull` for the same reason. Both spellings of each level are accepted, so an edge quoting the
 * REST words is read the same way: this maps a VOCABULARY onto the ladder, not one API's enum.
 *
 * An unrecognised permission returns `undefined` — a level this build cannot place is not silently demoted to
 * `pull`, which would turn a new stronger permission into "may look".
 */
const TeamPermissions: Record<string, AccessLevel> = {
  ADMIN: "admin",
  MAINTAIN: "maintain",
  WRITE: "push",
  PUSH: "push",
  TRIAGE: "triage",
  READ: "pull",
  PULL: "pull"
};

export function teamAccess(permission: string | null | undefined): AccessLevel | undefined {
  return permission == null ? undefined : TeamPermissions[permission.toUpperCase()];
}

export type TeamNode = z.infer<typeof teamNode>;
export type MemberConnection = z.infer<typeof memberConnection>;
export type MemberEdge = z.infer<typeof memberEdge>;
export type TeamRepositoryConnection = z.infer<typeof teamRepositoryConnection>;
export type TeamRepositoryEdge = z.infer<typeof teamRepositoryEdge>;
export type RepositoryNode = z.infer<typeof repositoryNode>;
export type PersonEdge = z.infer<typeof personEdge>;

// The INPUT types, for a test describing what GitHub actually sends — instants as ISO strings rather than as
// the `Date`s parsing turns them into.
export type RepositoryNodeInput = z.input<typeof repositoryNode>;
export type TeamNodeInput = z.input<typeof teamNode>;
