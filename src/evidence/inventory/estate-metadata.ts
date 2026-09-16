import { z } from "zod";
import type { GitHubClient } from "../github/client.ts";

/**
 * The estate's repository metadata, read as ONE PAGINATED ORG LISTING rather than one call per repository.
 *
 * `GET /orgs/{org}/repos` carries the same `security_and_analysis` block and the same `default_branch` that
 * `GET /repos/{org}/{repo}` does, so 1,889 per-repository reads become about 19 pages. Verified against live
 * GitHub with the collector App's own installation token before this was built, because the field is OPTIONAL
 * in GitHub's OpenAPI spec and a token that cannot see it would be answered with the block simply missing:
 *
 *     GET /orgs/hmcts/repos?per_page=100&type=all -> 200, Link present
 *       100 of 100 records carry `security_and_analysis`
 *       100 of 100 records carry `default_branch`
 *
 * That check mattered more than the saving. `hygieneFromMetadata` reads three signals out of that block, and
 * one of them — `secretScanning` — decides whether the secrets criterion grades or reports Unknown across
 * roughly 890 repositories. A listing that omitted the block would have moved every one of those rows
 * without failing anything.
 */

/**
 * One repository as the organisation listing names it.
 *
 * `security_and_analysis` is DECLARED AND NOT NARROWED: `hygieneFromMetadata` owns that schema, and it is
 * the only thing that should. Declaring it here is what says this type carries it onward.
 */
export interface EstateRepository {
  name: string;
  default_branch?: string;
  security_and_analysis?: unknown;
}

/**
 * What this file itself reads off a listed record: enough to key the map, and nothing else.
 *
 * `default_branch` is validated because the collector refuses a repository without one, and validating it
 * here would otherwise be the caller's problem twice.
 */
const listedRepositorySchema = z.object({ name: z.string(), default_branch: z.string().nullish() });

/** One failure's message, for a log line that names what went wrong rather than that something did. */
function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Every repository the organisation lists, keyed by name.
 *
 * THE RECORD IS STORED AS GITHUB SENT IT rather than rebuilt from parsed fields, and that is the one thing
 * this had to get right. `hygieneFromMetadata` reads `security_and_analysis` off the body it is handed, so a
 * projection that named the fields it kept would silently drop the block the moment GitHub renamed a key
 * inside it — and a dropped block is not an error, it is 890 repositories quietly changing grade. Passing the
 * body through means the hygiene signals are read from exactly the same shape they were read from before.
 *
 * A record naming no repository is SKIPPED rather than failing the listing, on `openAlerts`' rule: one
 * unreadable record must not turn the whole estate's answer into unknown.
 *
 * `undefined` where the listing could not be read at all, so the caller falls back to the per-repository
 * read it made before. Expensive, and the honest answer: a listing that refused is not evidence about any
 * repository in it.
 */
export async function readEstateMetadata(client: GitHubClient, organization: string): Promise<Map<string, EstateRepository> | undefined> {
  const listed = new Map<string, EstateRepository>();
  try {
    // `type=all` so archived, private and internal repositories are in it. The cohort holds all three, and a
    // listing narrower than the cohort would put the estate back on per-repository reads for the difference.
    for await (const page of client.paginate<unknown>(`/orgs/${organization}/repos`, { per_page: 100, type: "all" })) {
      for (const record of page) {
        const parsed = listedRepositorySchema.safeParse(record);
        if (!parsed.success) {
          continue;
        }
        // Cast rather than rebuild, for the reason above: the value is the record GitHub sent, now known to
        // name a repository.
        listed.set(parsed.data.name, record as EstateRepository);
      }
    }
  } catch (error) {
    console.warn(`Could not list the repositories of ${organization}, so each one's metadata will be read on its own: ${reason(error)}`);
    return undefined;
  }
  return listed;
}
