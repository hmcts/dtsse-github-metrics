import { z } from "zod";
import { AvailabilityReason, GitHubError } from "../domain/availability.ts";
import { type MergeGateEvidence, type MergeGateReport, mergeGateReport, type PullRequestRule, type StatusChecksRule } from "../domain/merge-gate.ts";
import type { GitHubClient } from "../github/client.ts";

/**
 * Reading a repository's declared merge gate. Ported from `metrics.inventory`'s merge-gate half.
 *
 * TWO SOURCES, tried in order, because a repository can carry either or both: modern rulesets, and classic
 * branch protection. The fallback chain between them is the most consequential logic in this module, and
 * each step exists because of a specific way GitHub answers.
 */

/**
 * Every ruleset rule type this collector attributes.
 *
 * Anything outside this set is reported by name in `unmodelledRules` rather than dropped: a rule GitHub adds
 * later would otherwise make a gate look weaker than it is enforced.
 */
const MODELLED_RULE_TYPES = new Set([
  "pull_request",
  "required_status_checks",
  "deletion",
  "non_fast_forward",
  "required_linear_history",
  "branch_name_pattern"
]);

const ENFORCING = "active";

/**
 * The two answers that describe the REPOSITORY rather than the caller, and so are observations.
 *
 * Both readers of this set have already read the repository's metadata with the same token, so neither can
 * be looking at a repository that is missing or private. A 404 from a protection endpoint is GitHub saying
 * the feature is not turned on; a 403 whose own message says the feature is off, or that the plan does not
 * carry it, says the same thing in a different status. Each is reported on the block and NEITHER RECORDS A
 * FAILURE — recording one would fail a run for a repository that has no problem, only an unused feature.
 */
const FEATURE_NOT_CONFIGURED: ReadonlySet<AvailabilityReason> = new Set([AvailabilityReason.NotFoundOrInaccessible, AvailabilityReason.FeatureDisabled]);

const repositoryRuleSchema = z.object({
  type: z.string(),
  parameters: z.record(z.string(), z.unknown()).default({}),
  // Optional because a rule that names no ruleset is still a rule, and is kept rather than dropped for
  // lacking an attribution. It is also the only route to two things the branch-rules endpoint never
  // reports: whether that ruleset is enforced at all, and who is exempt from it.
  ruleset_id: z.number().nullish(),
  ruleset_source_type: z.string().nullish()
});

const rulesetSchema = z.object({
  enforcement: z.string().default(""),
  bypass_actors: z.array(z.object({ actor_id: z.number().nullish(), actor_type: z.string().default(""), bypass_mode: z.string().default("") })).default([])
});

const branchSchema = z.object({ protected: z.boolean() });

const classicProtectionSchema = z.object({
  required_pull_request_reviews: z
    .object({
      dismiss_stale_reviews: z.boolean().default(false),
      require_code_owner_reviews: z.boolean().default(false),
      require_last_push_approval: z.boolean().default(false),
      required_approving_review_count: z.number().default(0)
    })
    .nullish(),
  required_status_checks: z.object({ strict: z.boolean().default(false), checks: z.array(z.object({ context: z.string() })).default([]) }).nullish(),
  enforce_admins: z.object({ enabled: z.boolean() }).nullish(),
  allow_deletions: z.object({ enabled: z.boolean() }).nullish(),
  allow_force_pushes: z.object({ enabled: z.boolean() }).nullish(),
  required_linear_history: z.object({ enabled: z.boolean() }).nullish(),
  required_conversation_resolution: z.object({ enabled: z.boolean() }).nullish()
});

type RepositoryRule = z.infer<typeof repositoryRuleSchema>;
type Ruleset = z.infer<typeof rulesetSchema>;

/** Whether one exempt actor's exemption reaches a pull request, which is what an administrator bypass is. */
function bypassesAsAdministrator(actor: { bypass_mode: string }): boolean {
  return actor.bypass_mode === "always" || actor.bypass_mode === "pull_request";
}

/**
 * Whether every enforcing ruleset behind a branch binds administrators.
 *
 * ONE UNREADABLE RULESET RETURNS `undefined` for the whole branch rather than a majority verdict: an
 * exemption nobody was allowed to read is not an exemption that is absent, and the evidence keeps
 * `appliesToAdministrators` absent for exactly that.
 */
export function bindsAdministrators(rulesets: readonly (Ruleset | undefined)[]): boolean | undefined {
  if (rulesets.length === 0 || rulesets.some((ruleset) => ruleset === undefined)) {
    return undefined;
  }
  return !rulesets.some((ruleset) => ruleset?.bypass_actors.some((actor) => bypassesAsAdministrator(actor)));
}

/**
 * Keeps the rules whose ruleset actually blocks a merge.
 *
 * A rule whose ruleset COULD NOT BE READ IS KEPT, deliberately: refusing to disclose a ruleset is not
 * evidence that it stopped enforcing, and dropping it would report a gate as weaker than the rules GitHub
 * already disclosed.
 */
export function enforcingRules(rules: readonly RepositoryRule[], rulesets: Map<number, Ruleset | undefined>): RepositoryRule[] {
  return rules.filter((rule) => {
    if (rule.ruleset_id == null) {
      return true;
    }
    const ruleset = rulesets.get(rule.ruleset_id);
    return ruleset === undefined || ruleset.enforcement === ENFORCING;
  });
}

/**
 * Branch protection carrying no detailed rules.
 *
 * Two different situations produce empty rule arrays and only `rulesObserved` separates them: GitHub
 * reporting that a branch has no protection at all, and GitHub refusing to disclose the protection a branch
 * does have. The assessment reads the first as a red veto and the second as cannot-assess.
 */
export function mergeGateWithoutRuleDetails(branch: string, options: { protected: boolean; rulesObserved: boolean }): MergeGateEvidence {
  return {
    branch,
    protected: options.protected,
    pullRequests: [],
    statusChecks: [],
    restrictsDeletions: false,
    blocksForcePushes: false,
    rulesObserved: options.rulesObserved,
    requiresLinearHistory: false,
    restrictsBranchNames: false,
    unmodelledRules: []
  };
}

/** Normalises classic branch protection into merge-gate evidence. */
export function mergeGateFromClassicProtection(branch: string, protection: z.infer<typeof classicProtectionSchema>): MergeGateEvidence {
  const reviews = protection.required_pull_request_reviews;
  const pullRequests: PullRequestRule[] =
    reviews == null
      ? []
      : [
          {
            requiredApprovingReviewCount: reviews.required_approving_review_count,
            dismissStaleReviewsOnPush: reviews.dismiss_stale_reviews,
            requireCodeOwnerReview: reviews.require_code_owner_reviews,
            requireLastPushApproval: reviews.require_last_push_approval
          }
        ];

  const checks = protection.required_status_checks;
  const statusChecks: StatusChecksRule[] =
    checks == null ? [] : [{ contexts: [...new Set(checks.checks.map((check) => check.context))], strictRequiredStatusChecksPolicy: checks.strict }];

  return {
    branch,
    protected: true,
    pullRequests,
    statusChecks,
    // GitHub reports what is ALLOWED; the gate describes what is BLOCKED, so both are inverted.
    restrictsDeletions: protection.allow_deletions?.enabled === false,
    blocksForcePushes: protection.allow_force_pushes?.enabled === false,
    ...(protection.enforce_admins?.enabled === undefined ? {} : { appliesToAdministrators: protection.enforce_admins.enabled }),
    rulesObserved: true,
    requiresLinearHistory: protection.required_linear_history?.enabled === true,
    // Classic protection has no branch-name rule at all, so this is not "absent" but "not a thing here".
    restrictsBranchNames: false,
    // Only the ruleset path can produce this: classic protection has a fixed shape, so an uninterpreted key
    // there would be a schema surprise rather than an active rule.
    unmodelledRules: []
  };
}

/** Collects classic protection details, with a permission-limited fallback. */
async function collectClassicMergeGate(
  client: GitHubClient,
  organization: string,
  repository: string,
  defaultBranch: string,
  branch: string
): Promise<MergeGateReport> {
  try {
    const protection = classicProtectionSchema.parse(await client.get(`/repos/${organization}/${repository}/branches/${branch}/protection`));
    return mergeGateReport({ fetchedAt: new Date(), gate: mergeGateFromClassicProtection(defaultBranch, protection) });
  } catch (error) {
    if (!(error instanceof GitHubError)) {
      throw error;
    }
    if (FEATURE_NOT_CONFIGURED.has(error.reason)) {
      // GitHub answered: the branch has no protection, either because none is set or because the
      // repository's plan cannot carry any. Both are OBSERVATIONS, not blind spots.
      return mergeGateReport({ fetchedAt: new Date(), gate: mergeGateWithoutRuleDetails(defaultBranch, { protected: false, rulesObserved: true }) });
    }
    if (error.reason !== AvailabilityReason.PermissionDenied) {
      throw error;
    }
    // Refused the detail, so ask the one question a non-administrator may: is it protected at all. The gate
    // then carries `rulesObserved: false`, which the assessment reads as cannot-assess rather than as a
    // branch requiring no review.
    const { protected: isProtected } = branchSchema.parse(await client.get(`/repos/${organization}/${repository}/branches/${branch}`));
    return mergeGateReport({
      fetchedAt: new Date(),
      gate: mergeGateWithoutRuleDetails(defaultBranch, { protected: isProtected, rulesObserved: false })
    });
  }
}

/** Reads one ruleset's enforcement and exemptions, or `undefined` when it cannot be read. */
async function fetchRuleset(client: GitHubClient, organization: string, repository: string, rulesetId: number): Promise<Ruleset | undefined> {
  try {
    return rulesetSchema.parse(await client.get(`/repos/${organization}/${repository}/rulesets/${rulesetId}`));
  } catch (error) {
    // A refusal degrades one field rather than failing the repository: the rules themselves were already
    // collected, and losing a gate entirely because its bypass list is private would report less than
    // GitHub disclosed.
    if (error instanceof GitHubError) {
      return undefined;
    }
    throw error;
  }
}

/** Collects default-branch merge rules, or describes why they are unavailable. */
export async function collectMergeGate(client: GitHubClient, organization: string, repository: string, defaultBranch: string): Promise<MergeGateReport> {
  const branch = encodeURIComponent(defaultBranch);

  try {
    let records: unknown[] = [];
    try {
      for await (const page of client.paginate<unknown>(`/repos/${organization}/${repository}/rules/branches/${branch}`)) {
        records.push(...page);
      }
    } catch (error) {
      if (!(error instanceof GitHubError) || error.reason !== AvailabilityReason.FeatureDisabled) {
        throw error;
      }
      // "Upgrade to GitHub Pro or make this repository public to enable this feature": rules cannot be
      // configured on this repository at all, so there is no gate to be refused a sight of. READ AS NO
      // RULES, which is literally what it says, so the branch takes the route below that an empty ruleset
      // array takes — CLASSIC PROTECTION IS STILL ASKED. Asserting "unprotected" here instead would
      // publish that off a message about rulesets, for a branch classic protection may well be gating.
      records = [];
    }

    const rules = records.map((record) => repositoryRuleSchema.parse(record));
    if (rules.length === 0) {
      return await collectClassicMergeGate(client, organization, repository, defaultBranch, branch);
    }

    const rulesets = new Map<number, Ruleset | undefined>();
    for (const id of new Set(rules.map((rule) => rule.ruleset_id).filter((id): id is number => id != null))) {
      rulesets.set(id, await fetchRuleset(client, organization, repository, id));
    }

    // A branch whose every ruleset only EVALUATES is a branch no ruleset gates, so it takes the same route
    // as one that returned no rules at all: classic protection may still gate it, and commonly does — a
    // repository can carry both, and only the classic side reports on admins.
    const active = enforcingRules(rules, rulesets);
    if (active.length === 0) {
      return await collectClassicMergeGate(client, organization, repository, defaultBranch, branch);
    }

    const contributing = [...new Set(active.map((rule) => rule.ruleset_id))];

    return mergeGateReport({
      fetchedAt: new Date(),
      gate: {
        branch: defaultBranch,
        protected: true,
        pullRequests: active
          .filter((rule) => rule.type === "pull_request")
          .map((rule) => ({
            requiredApprovingReviewCount: Number(rule.parameters.required_approving_review_count ?? 0),
            dismissStaleReviewsOnPush: rule.parameters.dismiss_stale_reviews_on_push === true,
            requireCodeOwnerReview: rule.parameters.require_code_owner_review === true,
            requireLastPushApproval: rule.parameters.require_last_push_approval === true
          })),
        statusChecks: active
          .filter((rule) => rule.type === "required_status_checks")
          .map((rule) => ({
            contexts: Array.isArray(rule.parameters.required_status_checks)
              ? (rule.parameters.required_status_checks as { context?: unknown }[])
                  .map((check) => String(check.context ?? ""))
                  .filter((context) => context !== "")
              : [],
            strictRequiredStatusChecksPolicy: rule.parameters.strict_required_status_checks_policy === true
          })),
        restrictsDeletions: active.some((rule) => rule.type === "deletion"),
        blocksForcePushes: active.some((rule) => rule.type === "non_fast_forward"),
        rulesObserved: true,
        requiresLinearHistory: active.some((rule) => rule.type === "required_linear_history"),
        restrictsBranchNames: active.some((rule) => rule.type === "branch_name_pattern"),
        // The ruleset path reports this too. It was absent for every ruleset-governed repository until it
        // was added, which read as "not disclosed" when what GitHub had actually disclosed, one call away,
        // was often an administrator exemption.
        ...(() => {
          const binds = bindsAdministrators(contributing.map((id) => (id == null ? undefined : rulesets.get(id))));
          return binds === undefined ? {} : { appliesToAdministrators: binds };
        })(),
        unmodelledRules: [...new Set(active.map((rule) => rule.type).filter((type) => !MODELLED_RULE_TYPES.has(type)))].sort()
      }
    });
  } catch (error) {
    if (error instanceof GitHubError) {
      return mergeGateReport({ fetchedAt: new Date(), detail: error.message });
    }
    return mergeGateReport({
      fetchedAt: new Date(),
      detail: `GitHub returned invalid branch rules: ${error instanceof Error ? error.message : String(error)}`
    });
  }
}
