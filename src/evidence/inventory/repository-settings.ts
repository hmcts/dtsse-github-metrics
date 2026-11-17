import { z } from "zod";
import { messageOf } from "../../platform/error-message.ts";
import { AvailabilityReason, GitHubError } from "../domain/availability.ts";
import type { RepositorySettings } from "../domain/repository-settings.ts";
import type { GitHubClient } from "../github/client.ts";

/**
 * Reading the repository settings the secure-by-design checks need over REST.
 *
 * Only the Actions permissions are read here. The issue creation policy is a GraphQL-only field, and is read in
 * the aliased assurance batch at no extra call cost.
 */

/**
 * The answers that describe the repository rather than the caller, as in merge-gate.ts. The repository's metadata
 * was already read with the same token, so a 404 or a "feature is off" 403 is GitHub saying there is nothing to
 * report. Neither is warned about, because nothing went wrong.
 */
const FEATURE_NOT_CONFIGURED: ReadonlySet<AvailabilityReason> = new Set([AvailabilityReason.NotFoundOrInaccessible, AvailabilityReason.FeatureDisabled]);

/**
 * The answers that say the whole run is in trouble rather than this one read, so they are rethrown as the merge
 * gate rethrows them: a run that has lost its token or its rate budget should stop, not warn once per repository.
 */
const RUN_FAILURES: ReadonlySet<AvailabilityReason> = new Set([AvailabilityReason.AuthenticationFailed, AvailabilityReason.RateLimited]);

/**
 * `allowed_actions` is absent when Actions is disabled, and kept as a string so a value GitHub adds later is stored.
 * `sha_pinning_required` is nullish so a response without it reads as unread rather than as a refusal.
 */
const actionsPermissionsSchema = z.object({
  enabled: z.boolean(),
  allowed_actions: z.string().nullish(),
  sha_pinning_required: z.boolean().nullish()
});

/** The outcome of one read: the settings when GitHub answered, and why not when something went wrong. */
export interface ActionsPermissionsAnswer {
  actions?: NonNullable<RepositorySettings["actions"]>;
  /** Set only for a failure worth naming. A feature-off answer leaves both fields absent. */
  failure?: string;
}

/**
 * Reads `/repos/{organization}/{repository}/actions/permissions`. Needs the App's `administration: read`.
 *
 * Never throws for a refusal, a failed read or a malformed body: the setting is left unread, which the assessment
 * reports as an informational clear rather than as a weak setting. An authentication or rate-limit failure is
 * rethrown, because it is not about this repository.
 */
export async function collectActionsPermissions(client: GitHubClient, organization: string, repository: string): Promise<ActionsPermissionsAnswer> {
  try {
    const body = actionsPermissionsSchema.parse(await client.get(`/repos/${organization}/${repository}/actions/permissions`));
    return {
      actions: {
        enabled: body.enabled,
        ...(body.allowed_actions == null ? {} : { allowedActions: body.allowed_actions }),
        ...(body.sha_pinning_required == null ? {} : { shaPinningRequired: body.sha_pinning_required })
      }
    };
  } catch (error) {
    if (error instanceof GitHubError) {
      if (RUN_FAILURES.has(error.reason)) {
        throw error;
      }
      return FEATURE_NOT_CONFIGURED.has(error.reason) ? {} : { failure: `Actions permissions could not be read: ${error.message}` };
    }
    return { failure: `GitHub returned invalid Actions permissions: ${messageOf(error)}` };
  }
}
