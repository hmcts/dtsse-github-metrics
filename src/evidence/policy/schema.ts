import { z } from "zod";
import { parseInstant } from "../window/instant.ts";

/**
 * The `metrics.yaml` policy document, ported from `metrics.config`.
 *
 * Every number here is a policy judgement rather than a measurement, which is why it is configuration
 * and never hardcoded: an organisation must be able to argue with a threshold without waiting for a
 * release. Defaults are stated openly as policy choices, not presented as facts. The merge-gate
 * vetoes in the assessment are deliberately NOT configurable — they are the definition of the
 * question being asked.
 *
 * `.strict()` on every object reproduces pydantic's `extra="forbid"`. That is load-bearing rather
 * than tidy: a misspelled threshold key would otherwise be silently ignored and the default reported
 * as though somebody had chosen it. The scalar `maximum_unreviewed_substantial_merges` this schema
 * replaced is rejected for the same reason, rather than quietly doing nothing.
 *
 * Keys stay snake_case, matching the YAML a reader edits and the upstream document verbatim.
 */

const PRODUCTION_LIST_URL = "https://raw.githubusercontent.com/hmcts/cnp-jenkins-config/refs/heads/master/environment-approvals.yml";

const positiveInt = z.number().int().positive();
const nonNegativeInt = z.number().int().nonnegative();
const percentage = z.number().min(0).max(100);
const nonEmpty = z.string().min(1);

/**
 * One enablement instant, parsed exactly as a reporting window edge is.
 *
 * A bare `2026-01-05` in YAML may arrive as a `Date` (js-yaml resolves the timestamp type) or as
 * text, so both are routed through the one `parseInstant` implementation. That keeps a single rule
 * for every instant in the system — bare date means UTC midnight, a naive datetime means UTC — rather
 * than a second rule that could drift from the window edges an enablement date is compared against.
 *
 * A bare number is rejected rather than read as a Unix timestamp: that would be a third instant rule,
 * arriving by accident, that no configuration file should be able to reach.
 */
const enablementInstant = z.union([z.string(), z.date()]).transform((value, ctx) => {
  try {
    return value instanceof Date ? parseInstant(value.toISOString()) : parseInstant(value);
  } catch (error) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: error instanceof Error ? error.message : String(error) });
    return z.NEVER;
  }
});

const lookback = z
  .object({
    operational_days: positiveInt.default(90),
    // Behaviour is a pattern, so a window may legitimately reach back the life of a project.
    maximum_days: positiveInt.default(365),
    mutable_hours: positiveInt.default(6),
    // Measured from an open pull request's last update, not from when it was opened.
    stale_open_days: positiveInt.default(14),
    // How old the last collection may be before reporting says so. Collection runs weekly, so eight
    // days is one missed run rather than one missed day: a warning raised the morning after every run
    // would say nothing about whether the figures can still be trusted.
    stale_collection_days: positiveInt.default(8)
  })
  .strict();

const team = z
  .object({
    identifier: nonEmpty,
    display_name: nonEmpty,
    github_team_slugs: z.array(z.string()).default([]),
    repositories: z.array(z.string()).min(1)
  })
  .strict();

/**
 * How the organisation graph decides who owns a repository.
 *
 * Every number here is a policy judgement about how far to guess, not a measurement, which is why it is
 * configuration. The defaults are the ones the Python generator this ladder was ported from ran with against
 * this estate, so changing one is arguing with a tuned figure rather than filling in a blank.
 */
const orgGraph = z
  .object({
    // Off by default so that adding this block is what turns the walk on, and no existing configuration
    // changes meaning by being upgraded.
    enabled: z.boolean().default(false),
    // Attributed repositories a name prefix needs before it may attribute others.
    prefix_support: positiveInt.default(3),
    // Proportion of a prefix that must agree on one team before it may speak.
    prefix_dominance: z.number().min(0).max(1).default(0.8),
    // Above this share of the estate a team holds access administratively rather than editorially, and is
    // not read as a claim. A quarter is far past any team that could be said to own what it holds: on 3,277
    // repositories that is over 800, which no service team reaches.
    maximum_team_share: z.number().min(0).max(1).default(0.25),
    // Handles that are not owners BY IDENTITY rather than by size. `all-org-members` is the organisation
    // wearing a team's clothes: attributing a repository to it says only that the repository is in the
    // organisation, which the graph already says by listing it, and no threshold makes that an owner.
    excluded_teams: z.array(nonEmpty).default(["all-org-members"]),
    // A ceiling on the repositories one run may pay the per-repository rungs for, not a target. The residue
    // left after the free rungs is not knowable in advance at this scale, and a run that walks all of it is
    // better discovered as an incomplete exit than as a six-hour job.
    unresolved_repository_limit: positiveInt.default(500)
  })
  .strict();

const cohort = z
  .object({
    // Dependency bots raise mechanical version bumps; agent-authored code stays in the cohort
    // deliberately.
    excluded_authors: z.array(z.string()).default(["renovate", "dependabot"])
  })
  .strict();

/**
 * The size below which a change is treated as trivial. A one-line configuration fix merged without
 * independent review is a different fact from a three-file feature merged the same way.
 */
const triviality = z
  .object({
    maximum_lines: positiveInt.default(10),
    maximum_files: positiveInt.default(1)
  })
  .strict();

/** Where one observed rate stops being green and stops being amber. */
const readinessThresholds = z
  .object({
    green_percentage: percentage,
    amber_percentage: percentage
  })
  .strict()
  .refine((value) => value.green_percentage >= value.amber_percentage, {
    message: "the green percentage may not be below the amber percentage"
  });

/**
 * Where one observed percentile stops being at target.
 *
 * A distribution measures cost, not compliance, so the comparison runs the opposite way from
 * `readinessThresholds`: smaller is better, and the boundary is a maximum a value must stay at or
 * below rather than a minimum it must reach.
 *
 * ONE boundary, not a green/amber pair, because a flow signal decides no label at all: a value above
 * the maximum is reported as a caution and imposes no ceiling. How long a change waited and how large
 * it was are costs a team carries, not evidence that anything ungoverned reached the default branch.
 */
const distributionThreshold = z
  .object({
    maximum: z.number().positive()
  })
  .strict();

/**
 * How much unreviewed substantial merging a repository may do before it is reported.
 *
 * Two allowances rather than one, because a bare count says nothing on its own: two unreviewed merges
 * out of 246 is a pair of lapses in a repository that reviews almost everything, and two out of 20 is
 * a habit. A repository is within the policy when EITHER allowance forgives it, so a small cohort is
 * not condemned by arithmetic and a large one cannot dilute a real pattern away.
 *
 * The 1% default is a policy choice to argue with, not a measurement: it was set after every
 * assessable HMCTS repository tripped the previous fixed maximum of zero, which made the condition
 * fire universally and therefore say nothing about any repository in particular.
 */
const unreviewedSubstantialThresholds = z
  .object({
    maximum_count: nonNegativeInt.default(0),
    maximum_percentage: percentage.default(1)
  })
  .strict();

const assessment = z
  .object({
    enabled: z.boolean().default(true),
    // Below this many merges a rate is arithmetic, not a pattern, so nothing is graded. It counts
    // direct commits as well as merged pull requests, because a repository whose work bypasses pull
    // requests would otherwise escape grading by having too few of them.
    minimum_merges: positiveInt.default(10),
    "independent-review-coverage": readinessThresholds.default({ green_percentage: 90, amber_percentage: 70 }),
    // Graded beside review coverage, not folded into it: an approval is the reviewer's explicit
    // sign-off, and a team that reviews without ever approving leaves no record of who accepted it.
    "approval-coverage": readinessThresholds.default({ green_percentage: 90, amber_percentage: 70 }),
    "checks-passing-at-merge": readinessThresholds.default({ green_percentage: 90, amber_percentage: 70 }),
    // Flow signals graded by cost rather than compliance. Which percentile answers the question lives
    // in the assessment rather than here, since it does not vary by organisation the way a boundary
    // does. Each is reported as a caution whatever the shortfall, so no flow signal can hold a
    // repository below ready on its own.
    "pull-request-size": distributionThreshold.default({ maximum: 400 }),
    "merge-cycle-time": distributionThreshold.default({ maximum: 24 }),
    "time-to-first-review": distributionThreshold.default({ maximum: 8 }),
    "unreviewed-substantial-merges": unreviewedSubstantialThresholds.default({ maximum_count: 0, maximum_percentage: 1 }),
    // A caution boundary, not a green/amber pair: no defensible label-deciding threshold exists yet,
    // so a shallow rate is something to weigh rather than something that holds the label down.
    "review-depth-minimum-percentage": percentage.default(50)
  })
  .strict();

/**
 * What counts as a well-described, traceable pull request.
 *
 * Neither number decides the readiness label: a description is a documentation habit, not evidence a
 * change was governed. `reference_patterns` is a LIST because HMCTS traces work through both a GitHub
 * issue and a Jira key, and the next organisation reached for will use neither.
 */
const traceability = z
  .object({
    minimum_description: positiveInt.default(30),
    reference_patterns: z
      .array(z.string())
      .default(["#\\d+", "[A-Z][A-Z0-9]+-\\d+"])
      // Rejected at load time rather than at every pull request the pattern scans.
      .superRefine((patterns, ctx) => {
        for (const pattern of patterns) {
          try {
            new RegExp(pattern);
          } catch (error) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `invalid reference pattern ${JSON.stringify(pattern)}: ${error instanceof Error ? error.message : String(error)}`
            });
          }
        }
      })
  })
  .strict();

const practiceRule = z
  .object({
    enabled: z.boolean().default(true),
    severity: z.enum(["high", "medium", "low"]).default("high"),
    minimum_occurrences: positiveInt.default(1),
    excluded_logins: z.array(z.string()).default([])
  })
  .strict();

const practices = z
  .object({
    "unreviewed-merge": practiceRule.default({ enabled: true, severity: "high", minimum_occurrences: 1, excluded_logins: [] })
  })
  .strict();

export const configurationSchema = z
  .object({
    version: z.literal(1),
    organization: nonEmpty,
    lookback: lookback.default({}),
    cohort: cohort.default({}),
    triviality: triviality.default({}),
    assessment: assessment.default({}),
    traceability: traceability.default({}),
    practices: practices.default({}),
    org_graph: orgGraph.default({}),
    excluded_repositories: z.array(z.string()).default([]),
    // Optional at the schema, required by the commands whose subject is the cohort. `map-sonar`
    // resolves every project a SonarCloud organisation lists and `prune` deletes stale cache rows:
    // neither is about any repository a team owns, so neither should oblige a team file to be layered
    // in. A run that DOES report the cohort refuses an empty one where the message can name the
    // command.
    teams: z.array(team).default([]),
    // When agentic tooling was turned on for a repository. The tool cannot observe it — GitHub cannot
    // be asked — so it is an input fact like every other policy input. A repository with no date gets
    // no series rather than a guessed anchor.
    enablement: z.record(z.string(), enablementInstant).default({}),
    // Usually the GitHub organisation name, and at HMCTS exactly it. Left absent rather than
    // defaulted to the same text so the common case is not restated in every configuration file.
    sonar_organization: z.string().nullish(),
    // The answer of last resort for a repository whose project the stored map cannot settle.
    sonar_projects: z.record(z.string(), z.string()).default({}),
    // Where the list of repositories approved to deploy to production is published. The default is an
    // HMCTS URL, stated as a policy default to argue with rather than a fact about every
    // organisation. `null` turns the fetch off, which is what an organisation with no such list
    // wants: the field is then absent on every row and no repository carries a production badge.
    production_list_url: z.string().nullable().default(PRODUCTION_LIST_URL)
  })
  .strict()
  .superRefine(validateCrossReferences);

/**
 * The rules that span more than one key, ported from `Configuration`'s model validators.
 *
 * Each names the mistake at load time rather than letting it surface as a silently absent figure — a
 * typo in a repository name under `enablement:` would otherwise anchor nothing and be reported as "no
 * enablement date configured", indistinguishable from having forgotten it.
 */
function validateCrossReferences(value: z.infer<typeof baseObject>, ctx: z.RefinementCtx): void {
  const identifiers = value.teams.map((entry) => entry.identifier);
  if (new Set(identifiers).size !== identifiers.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["teams"], message: "team identifiers must be unique" });
  }

  // RELAXED from "a repository may belong to only one team". Shared ownership is real — a platform repository
  // can carry two teams holding admin, and the collected organisation graph reports exactly that — so the
  // schema must be able to say it. The old rule's message claimed more than the mistake it was catching.
  //
  // What is still refused is a repository listed TWICE UNDER ONE TEAM, which cannot mean anything other than a
  // copy-paste, and which would double that repository in `ownedRepositories` and in every count taken over it.
  for (const entry of value.teams) {
    const repeated = [...new Set(entry.repositories.filter((name, index) => entry.repositories.indexOf(name) !== index))].sort();
    if (repeated.length > 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["teams"], message: `${entry.identifier} lists a repository twice: ${repeated.join(", ")}` });
    }
  }

  const repositories = value.teams.flatMap((entry) => entry.repositories);

  const owned = new Set(repositories);
  const ownedExclusions = value.excluded_repositories.filter((name) => owned.has(name)).sort();
  if (ownedExclusions.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["excluded_repositories"],
      message: `excluded repositories may not have an owner: ${ownedExclusions.join(", ")}`
    });
  }

  // A blank override is rejected whatever was configured: it is a fact about the override itself.
  // Resolution treats an override as the answer that short-circuits every other step, so a blank one
  // would silently mean "unresolved" while reading as a decision somebody made.
  const blank = Object.entries(value.sonar_projects)
    .filter(([, project]) => project.trim() === "")
    .map(([repository]) => repository)
    .sort();
  if (blank.length > 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["sonar_projects"], message: `sonar project keys may not be empty: ${blank.join(", ")}` });
  }

  // The cross-checks below are conditional, and only on there being a cohort to check against: a
  // policy file read on its own for `map-sonar` or `prune` owns no repository, so every name in it
  // would be "unconfigured" and the load would fail over a key neither command reads.
  if (value.teams.length === 0) {
    return;
  }

  const unconfiguredSonar = Object.keys(value.sonar_projects)
    .filter((repository) => !owned.has(repository))
    .sort();
  if (unconfiguredSonar.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sonar_projects"],
      message: `sonar projects must name a configured repository: ${unconfiguredSonar.join(", ")}`
    });
  }

  const unconfiguredEnablement = Object.keys(value.enablement)
    .filter((repository) => !owned.has(repository))
    .sort();
  if (unconfiguredEnablement.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["enablement"],
      message: `enablement dates must name a configured repository: ${unconfiguredEnablement.join(", ")}`
    });
  }
}

// Declared for `validateCrossReferences`'s parameter type only: `configurationSchema` cannot name its
// own inferred output inside the `superRefine` that builds it.
const baseObject = z.object({
  teams: z.array(team),
  excluded_repositories: z.array(z.string()),
  enablement: z.record(z.string(), z.date()),
  sonar_projects: z.record(z.string(), z.string())
});

export type Configuration = z.infer<typeof configurationSchema>;
export type TeamConfiguration = z.infer<typeof team>;
export type LookbackConfiguration = z.infer<typeof lookback>;
export type AssessmentConfiguration = z.infer<typeof assessment>;
export type TrivialityConfiguration = z.infer<typeof triviality>;
export type OrgGraphConfiguration = z.infer<typeof orgGraph>;
export type TraceabilityConfiguration = z.infer<typeof traceability>;
export type PracticeRuleConfiguration = z.infer<typeof practiceRule>;
export type ReadinessThresholds = z.infer<typeof readinessThresholds>;
export type DistributionThreshold = z.infer<typeof distributionThreshold>;
export type UnreviewedSubstantialThresholds = z.infer<typeof unreviewedSubstantialThresholds>;

export { PRODUCTION_LIST_URL };
