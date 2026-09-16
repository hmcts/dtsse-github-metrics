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

/**
 * Where the production-approval list is published, and the ONE statement of that URL.
 *
 * Pinned to `master` because that is the branch the deployment pipeline itself reads. It lives here rather
 * than beside the fetch in `inventory/production.ts`: this is the schema's default for
 * `production_list_url`, so the fetch is handed whatever the configuration resolved and never reaches for a
 * literal of its own.
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
    mutable_hours: positiveInt.default(6),
    // How old the last collection may be before reporting says so. Collection runs daily, so two days
    // is one missed run rather than one missed day: a warning raised the morning after every run would
    // say nothing about whether the figures can still be trusted. Keep this a run behind the cadence —
    // it was eight while collection was weekly.
    stale_collection_days: positiveInt.default(2)
  })
  .strict();

/**
 * One OWNERSHIP OVERRIDE, which is all `teams:` is now.
 *
 * It used to be the cohort — the estate was whatever this block listed. It is not any more: the cohort comes
 * from the collected graph and `cohort:` selects from it. What survives is the override, feeding the ladder's
 * `configured` rung so a hand-set owner still beats every inferred one. `display_name` still names a team that
 * the graph only knows by slug.
 *
 * `repositories` may therefore be SHORT, and listing a repository here no longer puts it in the estate — if the
 * cohort policy excludes it, an override says who would own it and nothing reports it. That is the right way
 * round: an override is an answer to "whose is this", not to "does this count".
 */
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
    // Above this many members a team is a population rather than an owner — an "all developers" group, which
    // neither of the other two filters catches: it is not named, and it may hold an unremarkable number of
    // repositories. Measured on this estate, 50 would disown about 44 repositories belonging to ordinary
    // product teams that are simply large, and the distribution jumps from 92 members to 217, so the ceiling
    // sits in that gap. See DefaultMaximumTeamMembers for the figures.
    maximum_team_members: positiveInt.default(100),
    // Handles that are not owners BY IDENTITY rather than by size. `all-org-members` is the organisation
    // wearing a team's clothes: attributing a repository to it says only that the repository is in the
    // organisation, which the graph already says by listing it, and no threshold makes that an owner.
    excluded_teams: z.array(nonEmpty).default(["all-org-members"]),
    // A ceiling on the repositories one run may pay the per-repository rungs for, not a target. The residue
    // left after the free rungs is not knowable in advance at this scale, and a run that walks all of it is
    // better discovered as an incomplete exit than as a six-hour job.
    unresolved_repository_limit: positiveInt.default(500),
    // How many merges a team's members must have authored before the `authoring-team` rung reads it as the
    // owner. Two, because one merge is a person passing through: measured on this estate, 310 of 1,124
    // team-repository pairs sit at exactly one, and dropping them is what separates an owner from a visitor.
    // See DefaultMinimumAuthoredMerges.
    minimum_authored_merges: positiveInt.default(2),
    // How far back authorship is read, in days. Matches `lookback.operational_days` rather than being a
    // second window nobody reconciles — `collect` fills the fact cache over exactly that span, so a wider
    // one here reads a cache that does not reach. Ownership is a fact about NOW, and 90 days is a working
    // quarter: long enough to survive a holiday and a release freeze, short enough not to survive a
    // reorganisation.
    authorship_days: positiveInt.default(90)
  })
  .strict();

/**
 * WHICH REPOSITORIES THE ESTATE IS, and which authors count inside it.
 *
 * The repository half is new, and it replaces `teams:` as the answer to "what is reported on". The cohort is now
 * read from the collected graph and this block selects from it, because a hand-maintained list of 1,872 names is
 * stale the day it lands — a repository created on Tuesday stays invisible and one archived on Wednesday keeps
 * being collected. Policy is reviewable; membership at that scale is not.
 */
const cohort = z
  .object({
    // Dependency bots raise mechanical version bumps; agent-authored PULL REQUESTS stay in the cohort
    // deliberately, because one was opened, reviewed and merged through the gate.
    excluded_authors: z.array(z.string()).default(["renovate", "dependabot"]),
    // Accounts that are not people, where nothing in GitHub's own answer says so. `isHumanAccount` reads the
    // `Bot` account type and the `[bot]` login suffix first; this is the third signal, and on the commit path
    // it is the ONLY one that fires. Measured over 9,663 stored direct commits: not one carries
    // `authorType: "Bot"` — GitHub answers `User` for every linked account — and these three author 44% of
    // them, `fluxcdbot` alone 32.9%. A named list rather than a substring rule because `gemmatalbot` is a
    // person with 53 pull requests, and calling somebody's work automation is worse than the miscount.
    //
    // A SEPARATE QUESTION from `excluded_authors` above: this says "this account is not a person", which also
    // keeps it out of the contributor lists, where that one says "this author's work is not the cohort's".
    bot_accounts: z.array(z.string()).default(["fluxcdbot", "hmcts-platform-operations", "claude"]),
    // Repositories where no person can push to the default branch, declared. A repository named here reports `0`
    // direct commits rather than an absence, whether or not its commit walk was ever read: the count still comes
    // from the facts, so this settles only whether the figure may be stated.
    //
    // A DECLARATION AND NOT AN INFERENCE, which is the whole reason it is a list of names. A branch ruleset
    // requiring a pull request looks like proof that a direct push is impossible and is not: 91 of the 413
    // repositories on this estate carrying such a gate still hold direct-commit facts, so a rule reading the gate
    // as the answer would be wrong 91 times. Nothing observable settles it; somebody has to state it.
    //
    // What it is FOR is a repository whose commit walk cannot finish — `cnp-flux-config` is 362,987 commits on
    // `master`, 18,714 of them inside a 90-day window — so the walk writes no coverage and the row reports its
    // direct commits as unmeasured for good. Automation's pushes are already out through `bot_accounts`, so the
    // figure this permits is the human one.
    //
    // Matched case-insensitively against the cohort's own spelling: a name here is typed by hand and a repository
    // name is not. A name matching no repository does nothing, as an `enablement` key that matches nothing does.
    no_direct_pushes: z.array(z.string()).default([]),
    // Which visibilities count. All three by default, because narrowing the estate is a decision a deployment
    // should have to state. Worth stating on this one: 830 of 1,796 active repositories are private or internal,
    // and every one is refused until the App's pending `pull_requests: read` is approved — so a deployment that
    // wants figures rather than `unavailable` rows narrows this to `[public]` until that lands.
    visibilities: z
      .array(z.enum(["public", "internal", "private"]))
      .min(1)
      .default(["public", "internal", "private"]),
    // Archived repositories are out by default: nobody is working in one, so every figure it carries is a fact
    // about the past that no team can act on.
    include_archived: z.boolean().default(false),
    // How recently a repository must have been pushed to for its BEHAVIOUR to be collected. It no longer
    // decides who is in the estate: dropping stale repositories from the report hid exactly the ones the
    // assurance criteria are about — 334 unarchived repositories on this estate are a year or more stale and
    // not one had ever been collected. Still the cheapest lever on cost, since the merge walks are most of a
    // run: 90 days walks roughly 1,230 of 1,880. `null` collects every repository's behaviour.
    active_within_days: positiveInt.nullable().default(90),
    // How long since the last push before a repository reads as one that should have been archived. A WIDER
    // AND SEPARATE window from the one above, and the two answer different questions — a repository at six
    // months has no behaviour collected and is not flagged, which is a real third state.
    //
    // ONE YEAR from 2026-09-15, where it was two, and THE DEFAULT MOVED WITH `metrics.yaml` rather than being
    // left behind. The reasoning behind a boundary is the reasoning behind the default: a default of two years
    // under a deployment running one would be this file recommending a policy the service does not hold, and the
    // measurements below would have to argue both.
    //
    // Measured at the move: non-archived repositories on this estate sit 1,250 inside 90 days, 306 between 90
    // days and a year, 186 between one and two years, 100 between two and three and 48 beyond three. Two years
    // flagged 148; a year flags 334. The old boundary was set to spare annually-released services, and that is
    // the argument this move rejects — a service released once a year is pushed to far more often than it is
    // released, so a whole year of silence is worth an answer rather than an allowance. `null` flags none, for a
    // deployment that would rather report the age and judge it by eye.
    unmaintained_after_days: positiveInt.nullable().default(365)
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

export const configurationSchema = z
  .object({
    version: z.literal(1),
    organization: nonEmpty,
    lookback: lookback.default({}),
    cohort: cohort.default({}),
    triviality: triviality.default({}),
    assessment: assessment.default({}),
    traceability: traceability.default({}),
    org_graph: orgGraph.default({}),
    // Removed from the cohort outright, whatever the graph says. Kept from the file era unchanged: the graph
    // can say what a repository IS but not that somebody decided it should not be reported, and that decision
    // is exactly the kind that belongs in a reviewed file.
    excluded_repositories: z.array(z.string()).default([]),
    // OWNERSHIP OVERRIDES, not the cohort — see `team`. Empty is now the normal case rather than the thing a
    // cohort command refuses: the estate comes from the graph, so a file naming no team is a file that simply
    // disagrees with no inference. What a cohort command refuses is an EMPTY GRAPH, which is checked where the
    // graph is read rather than here.
    teams: z.array(team).default([]),
    // When agentic tooling was turned on for a repository. The tool cannot observe it — GitHub cannot
    // be asked — so it is an input fact like every other policy input. A repository with no date gets
    // no series rather than a guessed anchor.
    enablement: z.record(z.string(), enablementInstant).default({}),
    // Where the list of repositories approved to deploy to production is published. The default is an
    // HMCTS URL, stated as a policy default to argue with rather than a fact about every
    // organisation. `null` turns the fetch off, which is what an organisation with no such list
    // wants: the field is then absent on every row and no repository carries a production badge.
    production_list_url: z.string().nullable().default(PRODUCTION_LIST_URL),
    // REPOSITORIES THIS ORGANISATION STATES ARE PRODUCTION SERVICES, which is the middle of the three layers a
    // row's answer is resolved through: the approvals list above, then this, then `repository_production.production`.
    //
    // IT EXISTS FOR THE SERVICES THE APPROVALS LIST CANNOT NAME. That document is the deployment pipeline's, so a
    // production service the pipeline never approved is invisible to it — of the 290 names this deployment lists,
    // 179 are absent from it and 114 of those are Crime Platform repositories, which were never onboarded to CNP.
    // Policy belongs in a reviewed file for the reason every other list here does: it can be argued with without
    // waiting for a release.
    //
    // A UNION AND NEVER AN OVERRIDE — this list can only ADD. Saying "not a production service" is the manual
    // column's job, and that is also how an entry here is retired: `UPDATE repository_production SET production =
    // false`, and not by deleting the name, which loses the record that the repository was ever considered.
    //
    // Matched case-insensitively against the cohort's own spelling, as `cohort.no_direct_pushes` is: a name here
    // is typed by hand and a repository name is not. A name matching no repository does nothing.
    production_repositories: z.array(z.string()).default([])
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
    // Sorted only so the message reads the same twice, which is why this one collates rather than comparing by
    // code point: nothing downstream decides anything from the order.
    const repeated = [...new Set(entry.repositories.filter((name, index) => entry.repositories.indexOf(name) !== index))].sort((left, right) =>
      left.localeCompare(right)
    );
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

  // AN `enablement:` KEY IS NOT CHECKED AGAINST THE COHORT, and that is a consequence of the cohort moving
  // to the graph rather than an oversight. Nothing here can check it: the file cannot know the cohort without
  // reading the database, and a schema that opened a connection would make `--help` need Postgres. The
  // mistake such a check would catch — a typo anchoring nothing — is caught where the answer lives, by the
  // report naming a key that matched no repository in the cohort.
}

// Declared for `validateCrossReferences`'s parameter type only: `configurationSchema` cannot name its
// own inferred output inside the `superRefine` that builds it.
const baseObject = z.object({
  teams: z.array(team),
  excluded_repositories: z.array(z.string()),
  enablement: z.record(z.string(), z.date())
});

export type Configuration = z.infer<typeof configurationSchema>;
export type AssessmentConfiguration = z.infer<typeof assessment>;
export type TrivialityConfiguration = z.infer<typeof triviality>;
export type TraceabilityConfiguration = z.infer<typeof traceability>;
export type ReadinessThresholds = z.infer<typeof readinessThresholds>;
export type DistributionThreshold = z.infer<typeof distributionThreshold>;

export { PRODUCTION_LIST_URL };
