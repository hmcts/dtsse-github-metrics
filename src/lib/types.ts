/**
 * TypeScript mirror of the shapes `metrics.service` emits.
 *
 * Field names are snake_case because the service emits the Python models verbatim; renaming them
 * here would put a translation layer between the JSON a reader can curl and the page rendering it.
 * Every route is registered `response_model_exclude_none`, so a field the service could not observe
 * is ABSENT rather than null — hence `?:` rather than `| null` throughout. The distinction matters:
 * an absent count means nobody measured it, and a zero means somebody measured nothing.
 *
 * Instants arrive as ISO-8601 strings, typed as `string` rather than parsed into `Date` at the
 * boundary, so the value a component holds is the value the service sent.
 */

export type ReadinessLabel = "green" | "amber" | "red" | "cannot_assess";

/**
 * A person, as the dashboard names them: their GitHub login, and the profile name where GitHub holds one.
 *
 * `name` IS ABSENT FOR MOST OF THE ORGANISATION and that is the norm rather than a collection gap. Measured on
 * the live estate, 325 of 778 organisation members have set a profile name — 41.8% — so a list of contributors
 * shows a real name for two people in five and a login for the other three. Every reader of this field therefore
 * falls back to `login`, and nothing derives a name from a login: `ef32` is `Tam Arah`, which no amount of
 * splitting on characters would have produced, and a wrong name attached to a real person is worse than a login.
 *
 * There is NO SECOND TIER BEHIND IT. The stored pull-request and direct-commit facts carry `authorLogin` and
 * `authorType` and no author email or git author name, so the email-derived lookup that finds a person outside
 * this service is not available from what is collected — an absent name here means GitHub holds none, and the
 * only way to fill it is for the person to set it.
 *
 * Extended rather than repeated by every row that names somebody, so the fallback rule has one statement and a
 * row type cannot acquire a login without the name that goes with it.
 */
export interface Contributor {
  login: string;
  /** GitHub's profile name. Absent, never an empty string — see `Contributor`. */
  name?: string;
}

export type ObservationStatus = "observed" | "not_applicable";

export type AlertSeverity = "critical" | "high" | "medium" | "low";

export type FindingSeverity = "high" | "medium" | "low";

export type SonarGateLevel = "OK" | "ERROR" | "NONE";

/**
 * Where a window's unreviewed substantial merging sat against the allowance it was judged by.
 *
 * `domain.UnreviewedSubstantialOutcome` verbatim. `within` is neither a pass nor a failure: it is the
 * allowance forgiving what it was configured to forgive, which is a different fact from nothing
 * having merged unreviewed at all — so the three words are three answers, not a scale of two.
 */
export type UnreviewedSubstantialOutcome = "none" | "within" | "above";

/**
 * Which of the three sources settled a repository's production answer.
 *
 * `store.ProductionSource` verbatim, restated here for this file's own rule: the UI contract imports nothing.
 *
 * - `approvals-list` — the organisation's production-approvals list, the deployment pipeline's own document. It
 *   is also what answers `false`: read, and silent about this repository.
 * - `configured-list` — the service's own list in `metrics.yaml`, which exists for the production services that
 *   document cannot name. It only ever adds, so it never answers `false`.
 * - `marked` — the column somebody edited, which decides in both directions over both lists.
 */
export type ProductionSource = "approvals-list" | "configured-list" | "marked";

export interface RateObservation {
  status: ObservationStatus;
  numerator: number;
  denominator: number;
}

/** Optional rather than nullable, for the `exclude_none` reason `MaintenanceEvidence` records. */
export interface DistributionObservation {
  status: ObservationStatus;
  sample_size: number;
  unit: string;
  median?: number;
  percentile_75?: number;
  percentile_90?: number;
}

/** A rate carries no `unit`, which is what tells the two observation shapes apart at runtime. */
export type Observation = RateObservation | DistributionObservation;

export interface BehaviourMetricSummary {
  metric: string;
  summary: Observation;
  classifications: Record<string, number>;
}

/**
 * `informational` marks a condition the policy reported without judging — the three neutral
 * merge-gate rules and a sufficient cohort. The assessment is recomputed on every build rather than
 * stored, so a service of this version always sends the boolean it holds, `false` for a graded
 * condition rather than omitted. It is optional because the field only exists from 2026-09-02: a
 * service deployed before the UI sends no key at all, which every read guards on `== null`.
 */
export interface ReadinessCondition {
  condition: string;
  label?: ReadinessLabel;
  detail: string;
  informational?: boolean;
}

export interface ReadinessAssessment {
  label: ReadinessLabel;
  blocking: ReadinessCondition[];
  caution: ReadinessCondition[];
  clear: ReadinessCondition[];
}

export interface WindowProvenance {
  offline: boolean;
  intervals_fetched: number;
}

/**
 * One window's merge cohort: what was walked, what is counted, and who the difference is owed to.
 *
 * `merged` is every merged pull request the walk found and `reported` is the ones the figures beside it were
 * computed over — `cohort.excluded_authors` names the dependency automation between them, and `excluded_authors`
 * counts what each of those authors landed by EITHER route, so its total is not always `merged - reported`.
 *
 * THE THREE COUNTS ARE OPTIONAL and the map is not, which is the same shape `OpenAlertCount` keeps: a count is
 * absent where nobody read that source, and an empty map beside a present count is the honest "nothing was
 * excluded". Absent counts with an empty map means nothing was measured, which is what a refused merge walk leaves
 * — `lib/repository.cohortCards` renders that as a dash and says so rather than as three zeros.
 */
export interface CohortSummary {
  merged?: number;
  reported?: number;
  excluded_authors: Record<string, number>;
  direct_commits?: number;
}

export interface PullRequestRule {
  dismiss_stale_reviews_on_push: boolean;
  require_code_owner_review: boolean;
  require_last_push_approval: boolean;
  required_approving_review_count: number;
  /**
   * Whether the branch requires every review thread resolved before a merge.
   *
   * OPTIONAL BECAUSE NOTHING MEASURES IT. The collector does not model the rule, so `contractGate` omits the field
   * rather than sending `false` — which would claim a repository does not require thread resolution when nobody
   * asked GitHub. Declared required here until 2026-09-15, which made the contract state that every gate carries an
   * answer it has never carried; no reader was affected only because nothing renders it.
   */
  required_review_thread_resolution?: boolean;
}

export interface StatusCheck {
  context: string;
  integration_id?: number;
}

export interface StatusChecksRule {
  strict_required_status_checks_policy: boolean;
  required_status_checks: StatusCheck[];
}

export interface MergeGateEvidence {
  branch: string;
  protected: boolean;
  pull_requests: PullRequestRule[];
  status_checks: StatusChecksRule[];
  restricts_deletions: boolean;
  blocks_force_pushes: boolean;
  applies_to_administrators?: boolean;
  rules_observed: boolean;
  requires_linear_history: boolean;
  restricts_branch_names: boolean;
  unmodelled_rules: string[];
}

export interface MergeGateReport {
  fetched_at?: string;
  gate?: MergeGateEvidence;
  detail?: string;
}

export interface OpenPullRequestSummary {
  opened_in_window: number;
  closed_without_merge: number;
  currently_open: number;
  stale_open: number;
}

export interface OpenPullRequestReport {
  fetched_at?: string;
  starts_at?: string;
  ends_at?: string;
  summary?: OpenPullRequestSummary;
  detail?: string;
}

export interface OpenAlertCount {
  open?: number;
  by_severity: Partial<Record<AlertSeverity, number>>;
  detail?: string;
}

export interface SecurityAlertEvidence {
  dependabot: OpenAlertCount;
  code_scanning: OpenAlertCount;
  secret_scanning: OpenAlertCount;
}

export interface SecurityAlertReport {
  fetched_at?: string;
  alerts?: SecurityAlertEvidence;
  detail?: string;
}

export interface CodeownersFile {
  path: string;
  size_bytes: number;
  recognised_by_github: boolean;
}

export interface CodeownersReport {
  fetched_at?: string;
  codeowners?: { files: CodeownersFile[] };
  detail?: string;
}

/**
 * OPTIONAL, NOT NULLABLE. Every route is registered `response_model_exclude_none`, and pydantic
 * applies it through nested models too, so an unobserved instant arrives as a MISSING KEY rather
 * than as `null` — `searched_back_to` is absent on the common path, where a human commit was found.
 */
export interface MaintenanceEvidence {
  branch: string;
  last_commit_at?: string;
  last_human_commit_at?: string;
  searched_back_to?: string;
}

export interface MaintenanceWindowStatus {
  months: number;
  committed_within: boolean;
  human_committed_within?: boolean;
  human_detail?: string;
}

export interface MaintenanceReport {
  fetched_at?: string;
  maintenance?: MaintenanceEvidence;
  windows: MaintenanceWindowStatus[];
  detail?: string;
}

export interface SonarRating {
  value: number;
}

export interface SonarQualityGateCondition {
  metric: string;
  comparator: string;
  threshold?: string;
  actual?: string;
  level: SonarGateLevel;
}

export interface SonarQualityGate {
  level: SonarGateLevel;
  conditions: SonarQualityGateCondition[];
}

export interface SonarProjectMapping {
  project_key: string;
  repository: string;
  method: string;
  analysis_at?: string;
  revision?: string;
}

export interface SonarMeasures {
  project_key: string;
  analysis_at?: string;
  gate?: SonarQualityGate;
  coverage?: number;
  duplicated_lines_density?: number;
  lines_of_code?: number;
  violations?: number;
  reliability_issues?: number;
  maintainability_issues?: number;
  security_issues?: number;
  reliability_rating?: SonarRating;
  maintainability_rating?: SonarRating;
  security_rating?: SonarRating;
}

export interface SonarReport {
  fetched_at?: string;
  mapping?: SonarProjectMapping;
  measures?: SonarMeasures;
  detail?: string;
}

export interface PracticePullRequestReference {
  number: number;
  url: string;
  merged_at: string;
  size_class: string;
  changed_lines?: number;
  changed_files?: number;
}

export interface PracticeCommitReference {
  sha: string;
  url: string;
  committed_at: string;
  size_class: string;
  changed_lines?: number;
  changed_files?: number;
}

export interface PracticeFinding {
  rule: string;
  severity: FindingSeverity;
  actor_login: string;
  occurrences: number;
  authored_merges: number;
  percentage: number;
  message: string;
  occurrences_by_size: Record<string, number>;
  pull_requests: PracticePullRequestReference[];
  direct_commits?: PracticeCommitReference[];
}

export interface RepositoryPracticeEvidence {
  repository: string;
  team: string;
  starts_at: string;
  ends_at: string;
  provenance: WindowProvenance;
  cohort: CohortSummary;
  assessment?: ReadinessAssessment;
  unreviewed_substantial?: UnreviewedSubstantialOutcome;
  merge_gate: MergeGateReport;
  open_pull_requests: OpenPullRequestReport;
  security: SecurityAlertReport;
  codeowners: CodeownersReport;
  maintenance: MaintenanceReport;
  sonar: SonarReport;
  metrics: BehaviourMetricSummary[];
  behaviour: PracticeFinding[];
}

export interface ActorRepositoryReadiness {
  readiness?: ReadinessLabel;
  repository: string;
  contributions: number;
  blocking: number;
  metrics: BehaviourMetricSummary[];
}

export interface ActorReadiness {
  actor_login: string;
  repositories: ActorRepositoryReadiness[];
}

/** The single percentile a distribution is compared at, named as the field it reads. */
export type Percentile = "median" | "percentile_75";

/** What arithmetic a delta reports: a rate moves in points, a count and a percentile in per cent. */
export type DeltaBasis = "percentage_points" | "percentage_change";

export type AlertFamily = "dependabot" | "code-scanning" | "secret-scanning";

/**
 * What KIND of thing a repository's owner name is, which the name itself cannot say.
 *
 * `domain.OwnerKind` verbatim. A team slug and a GitHub login are the same shape — `civil-admins` and
 * `a1i-hussain` are both lower-case hyphenated words — so a page holding the name alone has no way to
 * tell an owning team from one person who happens to hold admin on a repository. It needs to: `/teams`
 * lists TEAMS, so a `person` name has no page to link to, and `/repositories` marks the repository as
 * individually owned instead.
 *
 * `none` is the unowned bucket, which is a real destination rather than a missing answer — 141
 * repositories are reported under it and it has a card of its own.
 */
export type OwnerKind = "team" | "person" | "none";

/**
 * Which repository visibility, folded to the lower case the cohort compares by.
 *
 * THREE VALUES AND NOT TWO. `INTERNAL` is a real GitHub visibility and on this estate it is the second largest:
 * 1,043 public, 441 internal, 396 private among the non-archived. A filter offering "public or private" would
 * silently have no way to name 441 repositories.
 *
 * Lower-cased here even though `org_repositories` stores GitHub's capitals, so the UI compares one spelling —
 * `selectCohort` already folds it for exactly this reason.
 */
export type Visibility = "public" | "internal" | "private";

/**
 * Which "coding in the open" assurance criterion an answer is about.
 *
 * `domain.AssuranceCriterion` verbatim. SIX OF THE SEVEN, one of them partial, which is a set of decisions rather
 * than a gap:
 *
 *   • `no-committed-secrets` evidences HALF of "no secrets or sensitive operational detail" — the credential half,
 *     read from open secret-scanning alerts. Hostnames, IP ranges and thresholds need a human and are not covered,
 *     which is why the criterion is named for the half it answers.
 *   • `security-contact` is reported and NOT graded: `isSecurityPolicyEnabled` reads true for nearly the whole
 *     estate off the organisation's inherited `.github` policy, so counting it would be a free pass on every row.
 *   • Secure by design is absent entirely — it needs a threat model, and no GitHub signal stands in for one.
 *   • The seventh, a maintenance plan, has no column: a plan is a document, and `named-owner` is the collectable
 *     half of it.
 */
export type AssuranceCriterion = "named-owner" | "automated-hygiene" | "no-committed-secrets" | "security-contact" | "patching" | "maintained";

/** Met, not met, or nobody could read it. The third is never folded into the second. */
export type AssuranceOutcome = "met" | "unmet" | "unknown";

/**
 * How a repository's assurance reads overall.
 *
 * A DIFFERENT GRADE FROM `ReadinessLabel` and deliberately in different words. That one grades READINESS FOR AI
 * ENABLEMENT off ways-of-working conditions — branch protection, review coverage, force pushes — and reads
 * "Ready / Caution / Blocked". This grades whether the repository meets the published assurance criteria for
 * working in the open. A repository can be perfectly ready to enable agentic tooling on and still fail the
 * assurance criteria, and the reverse, so reusing the other's vocabulary would state something false. The two
 * share `lib/rag.ts`'s colours and nothing else, and they live on different pages: assurance on `/repositories`,
 * readiness on `/teams` and on a repository's own page.
 *
 * FOUR VALUES FROM 2026-09-15, and `partly-read` is the one a reader has to be told apart from `partial`. `met`
 * means every graded criterion was read and met; `partly-read` means every criterion that COULD be read was met
 * and some could not be, which one failed org-wide secret-scanning call produces for the entire estate at once;
 * `partial` means one of them was read and failed. Only the third is a finding about the repository. Before this,
 * an unread criterion counted as neutral and all three arrived as `met`.
 */
export type AssuranceGrade = "met" | "partly-read" | "partial" | "unknown";

export interface AssuranceCriterionResult {
  criterion: AssuranceCriterion;
  outcome: AssuranceOutcome;
  /** Which control is missing, how old the alert is, how long since the last push. */
  detail: string;
}

/**
 * The five signals the `automated-hygiene` criterion is judged over, each three-valued.
 *
 * ON THE REPORT RATHER THAN INSIDE THE CRITERION'S RESULT, on `oldest_severe_alert_days`'s precedent: the result
 * carries a SENTENCE naming the control that is missing, and a column cannot render a sentence. A reader expanding
 * the Hygiene column is asking which of the five is off, so the values reach the contract as values.
 *
 * ABSENT IS UNMEASURED AND NEVER `false`. A repository whose `security_and_analysis` block GitHub would not
 * disclose has not been shown to have scanning switched off, which is why each signal is optional rather than
 * defaulted — the same rule the outcomes keep by never folding `unknown` into `unmet`.
 *
 * `dependabot_security_updates` AND `update_configuration` ARE ONE REQUIREMENT BETWEEN THEM and are carried
 * separately because they are two facts: which tool keeps the dependencies current. Renovate does not turn
 * GitHub's Dependabot setting on, so requiring both marked down 244 repositories that update perfectly well.
 * `HYGIENE_CHECKS` in `lib/rows.ts` is where they are folded back into the one requirement they are.
 */
export interface AssuranceHygieneSignals {
  secret_scanning?: boolean;
  push_protection?: boolean;
  vulnerability_alerts?: boolean;
  dependabot_security_updates?: boolean;
  update_configuration?: boolean;
}

export interface AssuranceReport {
  grade: AssuranceGrade;
  criteria: AssuranceCriterionResult[];
  /**
   * The hygiene criterion's own signals, for the columns its aggregate expands into.
   *
   * Absent for a repository nothing was collected for; present with an absent signal where the collection ran and
   * GitHub disclosed nothing about that one control.
   */
  hygiene?: AssuranceHygieneSignals;
  /**
   * The oldest open critical or high alert, in days.
   *
   * Lifted out of `criteria` so the column can print the number and a threshold can one day compare it, rather
   * than either having to find the right judgement and parse its sentence. ABSENT means nothing severe is open OR
   * that the alerts could not be read — the `patching` criterion's own outcome is what separates those.
   */
  oldest_severe_alert_days?: number;
}

export interface TrendThroughput {
  merges: number;
  merged_pull_requests: number;
  direct_commits: number;
  active_contributors: number;
}

export interface TrendMetric {
  metric: string;
  summary: Observation;
  /** Absent exactly where the window observed no eligible sample — never a zero standing in for one. */
  value?: number;
  percentile?: Percentile;
}

export interface TrendDelta {
  measure: string;
  basis: DeltaBasis;
  baseline: number;
  period: number;
  change?: number;
  unit?: string;
  percentile?: Percentile;
  detail?: string;
}

export interface TrendWindow {
  starts_at: string;
  ends_at: string;
  provenance?: WindowProvenance;
  cohort?: CohortSummary;
  throughput?: TrendThroughput;
  metrics: TrendMetric[];
  detail?: string;
}

export interface TrendPeriod extends TrendWindow {
  index: number;
  deltas: TrendDelta[];
}

export interface AlertObservation {
  family: AlertFamily;
  fetched_at: string;
  open: number;
  by_severity: Partial<Record<AlertSeverity, number>>;
}

export interface RepositoryTrend {
  repository: string;
  enablement_at?: string;
  baseline?: TrendWindow;
  periods: TrendPeriod[];
  alert_observations: AlertObservation[];
  detail?: string;
  delta_detail?: string;
}

/**
 * The spans on offer, and the collection every one of them is anchored to.
 *
 * The collection state rides on this route because every page already fetches it for the span
 * selector, and the notice that the figures sit at an old collection belongs on every page rather
 * than on the overview alone. `collected_through` is ABSENT when nothing has been collected under
 * the current query signature — the one stale case with no instant to name.
 */
export interface WindowOptions {
  options: number[];
  default: number;
  /** The most periods one trend request may ask for, which a series must be cut to. */
  trend_periods: number;
  collected_through?: string;
  collection_stale: boolean;
}

export interface OverviewSummary {
  organization: string;
  weeks: number;
  starts_at: string;
  ends_at: string;
  built_at: string;
  /** The instant the caches cover to, which the window is anchored at; absent when nothing was collected. */
  collected_through?: string;
  repositories: number;
  unavailable: number;
  teams: number;
  actors: number;
  merged_pull_requests: number;
  direct_commits: number;
  labels: Record<string, number>;
}

/**
 * The `RepositoryRow.detail` that means nothing whatever was collected for the repository.
 *
 * ON THE CONTRACT rather than spelled in the report layer alone, because both sides need the same string for
 * different halves of one rule: `repositoryRow` emits it, and a page decides from it whether it has a reason worth
 * printing. Kept as one exported constant so the two cannot drift into a comparison that silently stops matching.
 */
export const UNCOLLECTED_DETAIL = "nothing has been collected for this repository";

/**
 * One repository in a list, whether this window could be reported for it or not.
 *
 * TWO KINDS OF FIELD, and the split is worth reading before adding a third. `pushed_at`, `visibility`,
 * `archived`, `unmaintained`, `owner_kind` and `assurance` are facts about WHAT THE REPOSITORY IS, so
 * the report sends them on every row including the one it could collect nothing for — when a repository
 * was last pushed to is not a fact about a reporting window. Everything else is a fact about the WINDOW
 * and is absent on that row.
 *
 * Each is UNMEASURED WHEN ABSENT: the two gate figures where there is no gate to read or its rules were
 * withheld, `unreviewed_substantial` where the policy graded nothing, `sonar_coverage` and the two
 * Sonar security measures where no SonarCloud project resolved, and `security` where the whole alert
 * block carries a reason instead of alerts. None is zero by default — an unprotected default branch is
 * the one thing that reads as a real `0`, because the gate was read and it requires nothing.
 *
 * SEVEN OF THESE ARE NEITHER SENT NOR READ, and are kept on the contract rather than deleted:
 * `currently_open`, `stale_open`, `finding_occurrences`, `sonar_coverage`, `sonar_reported`,
 * `sonar_security_rating` and `sonar_security_issues`. The report layer emits none of them, and the
 * reason is the same in each case: the open pull-request summary and the practice findings have no
 * producer at all, and the Sonar layer under `src/evidence/sonar/` is written but reached by nothing —
 * see `sonar/resolve.ts`, which states what would reach it. So every column keyed on one rendered a dash
 * for the whole estate, and those `/repositories` columns have gone.
 *
 * NOTHING READS THESE SEVEN OFF A `RepositoryRow`, and the near-miss is worth naming because it has been
 * mistaken for a reader twice. `lib/repository.ts` does render `currently_open` and `stale_open` — but off
 * `OpenPullRequestSummary`, a DIFFERENT interface where the two are required rather than optional, reached
 * through `OpenPullRequestReport.summary` and never through a row. It renders coverage and the security
 * measures too, off `SonarMeasures`, whose fields are spelled `coverage`, `security_rating` and
 * `security_issues` — not the `sonar_`-prefixed ones here. Same words, different contracts. Deleting a
 * field from this list will not break a render, so do not use a passing build as evidence that one is read.
 *
 * What keeps them is that each is the display half of a layer whose collection half is missing, so the work
 * to finish is an assembly rather than a contract change. That is a decision to revisit, not a fact: if the
 * Sonar layer is dropped rather than wired, these go with it.
 *
 * `codeowners_files` DID go, along with `codeownersPresent` in `lib/rows.ts`. It was in the same state and
 * differs in one way that matters: nothing anywhere else reads it, and `owner_kind` answers the question
 * its column was drawn to answer — whether a repository is assigned to a team — off a field that is
 * populated on every row.
 *
 * `security` carries `SecurityAlertEvidence` verbatim rather than flattened into scalars, because the
 * per-family `open`/`by_severity`/`detail` is what `lib/repository.ts` colours the page's security cards
 * from — a family with nothing open and one GitHub refused are different answers, they take different
 * tones, and only the block itself keeps them apart.
 */
export interface RepositoryRow {
  repository: string;
  /**
   * The team that leads this repository's ownership — the first in the reporting order.
   *
   * A STATED CONVENTION rather than a claim that there is only one owner. Where a repository is shared,
   * `teams` carries the full set and this field carries its head; absent `teams` means the convention and the
   * fact agree, which is the ordinary case.
   */
  team: string;
  /** Every owning team, present only where a repository has more than one. */
  teams?: string[];
  /**
   * What `team` and `teams` name: an owning team, one person, or the unowned bucket.
   *
   * OPTIONAL for `ActorRow.labels`' reason and no other — a service of this version always sends it, on
   * every row, so an absent value means a deployment older than 2026-09-11 rather than a repository
   * whose ownership nobody could read. That is why every read of it treats absence as `team`: it is the
   * answer the field had before it existed, and 1,499 of the estate's 1,846 owned repositories are
   * team-owned, so guessing the other way would mark most of the estate as somebody's personal project.
   */
  owner_kind?: OwnerKind;
  /**
   * When the repository was last pushed to, as an ISO-8601 string.
   *
   * AN INSTANT AS TEXT, like every other instant on this contract, and here that is load-bearing rather than
   * consistent: this is the table's default sort key, and `SortValue` in `lib/sort.ts` has no `Date` case — a
   * `Date` would fall through to `String(...).localeCompare(...)` and order the estate alphabetically by weekday
   * name, which looks plausible and is wrong.
   *
   * ABSENT IS MEANINGFUL AND IS NOT AN OLD PUSH. GitHub omits it for a repository never pushed to, so it must not
   * be defaulted to the epoch or to now — `sorted` holds an absent value back from both ends of the order, which
   * is exactly right here: "which repositories are stalest" is a question about the ones with a last push.
   */
  pushed_at?: string;
  /** Which visibility, folded to lower case. The table's default filter selects on it. */
  visibility?: Visibility;
  /** Whether GitHub has the repository archived, which the maintained criterion reads as handled. */
  archived?: boolean;
  /**
   * Whether the repository is past `cohort.unmaintained_after_days` — dead code that is not marked as such.
   *
   * Distinct from `archived`, and the pair is the finding: an archived repository is handled and an unarchived
   * one nobody has pushed to in years is the risk the criterion is about.
   */
  unmaintained?: boolean;
  /** How the repository reads against the assurance criteria. See `AssuranceGrade` for why it is not readiness. */
  assurance?: AssuranceReport;
  readiness?: ReadinessLabel;
  merged_pull_requests?: number;
  direct_commits?: number;
  currently_open?: number;
  stale_open?: number;
  finding_occurrences?: number;
  required_approving_reviews?: number;
  required_status_checks?: number;
  unreviewed_substantial?: UnreviewedSubstantialOutcome;
  /**
   * The four window figures a row carries FOR THE TEAM AGGREGATION, and that no component reads off a row.
   *
   * DECLARED BECAUSE THEY ARE SENT. `behaviourFigures` has emitted all four on every reportable row since the
   * port and the contract named none of them, which is the reverse of the seven fields above: those are
   * declared and never sent, these were sent and never declared. `teamPractice` folds them into `TeamPractice`,
   * where the same four names ARE declared and where `lib/team.ts` reads them — so a row is where they come
   * from and a team card is where they are shown.
   *
   * Each follows the row's own rule. The two counts are absent together where the readiness policy declined to
   * grade a thin cohort, so a page cannot state a rate the policy refused; the two medians are absent where the
   * window observed no eligible sample, never zero, because `0 hours` reads as instant review.
   */
  unreviewed_substantial_merges?: number;
  substantial_merges?: number;
  time_to_first_review_hours?: number;
  merge_cycle_time_hours?: number;
  sonar_coverage?: number;
  sonar_reported?: boolean;
  security?: SecurityAlertEvidence;
  sonar_security_rating?: SonarRating;
  sonar_security_issues?: number;
  /**
   * Why this row carries less than a full set of figures, joined where more than one reason applies.
   *
   * TWO KINDS OF REASON REACH THIS ONE FIELD, and a reader of it has to know which it is holding, because a page
   * shows a reason only where it shows the figures the reason is about. `UNCOLLECTED_DETAIL` says nothing at all was
   * collected, which leaves every column on every page empty; every other value comes from `unreportedDetail` and is
   * about the MERGE sources or the merge gate, which only the repository and team pages render. The two are mutually
   * exclusive — `repositoryRow` sets the first on the branch where it never calls the second — so comparing against
   * the constant is an exact test rather than a prefix match on prose. See `uncollectedDetail` in `lib/rows.ts`.
   */
  detail?: string;
  /**
   * Whether this repository is treated as a production service, by any of the three sources that say so.
   *
   * The one field here that is not read from the window at all, and it follows the same rule as
   * every count above it: ABSENT MEANS NOTHING COULD ANSWER — the organisation's approvals list was
   * unread, the service's own list does not name it and nobody has marked it — where `false` means
   * something answered no. Both render no badge — there is no non-production badge — but the filter
   * and its count can only be honest about the difference if the field keeps it.
   */
  production?: boolean;
  /**
   * WHICH of the three said so, absent exactly where `production` is.
   *
   * Carried because the column means three things now and a reader meeting "Yes" is owed which one.
   * It decides no filter, no order and no colour: it is shown as the cell's tooltip and nothing
   * branches on it, so an older service that sends none renders the cell exactly as before.
   */
  production_source?: ProductionSource;
}

/**
 * `metrics` is this person's own summaries for this repository, sent verbatim by the service.
 *
 * The columns the table shows are subtracted out of it by `lib/contributor.ts`: the service derives
 * nothing from these, so the page and the JSON a reader can curl carry the same figures.
 */
export interface ContributorRow extends Contributor {
  contributions: number;
  blocking: number;
  metrics: BehaviourMetricSummary[];
}

export interface RepositoryDetail {
  repository: string;
  team: string;
  /**
   * Where this repository lives on GitHub, for the header's one outbound link.
   *
   * Built from the configured organisation rather than read from GitHub: the collector never stores an `html_url`
   * and it would be the same string every time. Optional so a detail assembled without it still renders.
   */
  url?: string;
  /** What `team` names, under `RepositoryRow.owner_kind`'s rule: the header links a team and not a person. */
  owner_kind?: OwnerKind;
  evidence?: RepositoryPracticeEvidence;
  contributors: ContributorRow[];
  detail?: string;
  /**
   * Whether this repository deploys to production, under `RepositoryRow.production`'s rule.
   *
   * The service answers it on BOTH branches, the unavailable one included: whether a repository
   * deploys to production is not a fact about the reporting window, so a span with no evidence for
   * it still knows this. The header is built before the no-evidence branch for that reason.
   */
  production?: boolean;
}

/**
 * `labels` LISTS the distinct labels this person's reported repositories carry, best first.
 *
 * It combines nothing: there is no per-person label, no score and no count beside a name. The
 * service sends `[]` where nothing is left to label — `cannot_assess` repositories are excluded, as
 * they are from the text report's actor section, and a readiness policy that is off labels nothing.
 *
 * OPTIONAL for the reason `ReadinessCondition.informational` is: the field only exists from
 * 2026-09-02, and `API_URL` is read per request so a deployment can be pointed at a `metrics-serve`
 * older than that without a rebuild. A service of this version always sends the key, empty rather
 * than omitted, so the absent case means an older service and nothing else — but an unguarded read
 * of it would throw while rendering and take the whole `/contributors` page down, where the guard
 * shows the list unlabelled.
 */
export interface ActorRow extends Contributor {
  repositories: number;
  labels?: ReadinessLabel[];
}

export interface ActorDetail {
  actor: ActorReadiness;
  /**
   * This person's profile name, where the organisation graph holds one.
   *
   * It sits beside `teams` for `teams`' reason rather than on `ActorReadiness`: that model is the contract's own
   * and is passed through unchanged, and a name is accounting around it. `Contributor`'s fallback rule applies —
   * absent means GitHub holds no name, and the page heads itself with the login instead.
   */
  name?: string;
  teams: Record<string, string>;
  /**
   * Which of THIS PERSON'S repositories deploy to production, and nothing else.
   *
   * It sits beside `teams` for `teams`' own reason: it is accounting the contract's `ActorReadiness`
   * cannot state, and the contract model is passed through unchanged. ABSENT MEANS NO LIST COULD BE
   * READ, where an empty list means the list was read and none of this person's repositories is on
   * it — the distinction `RepositoryRow.production` keeps, in a list's shape.
   */
  production?: string[];
}

export interface TeamActorRow extends Contributor {
  repositories: number;
  contributions: number;
}

/**
 * One person GITHUB SAYS IS IN A TEAM, which is a different question from who contributed to its repositories.
 *
 * `TeamActorRow` above answers the second: it is folded from the merges and direct pushes in the repositories
 * attributed to a team, so somebody in no team at all appears under one as soon as they merge into a repository it
 * owns. A member and a contributor can be the same person and can be neither each other's subset — a member who
 * did nothing this window is on this list and not that one, and somebody from another team who merged is on that
 * one and not this.
 *
 * NO COUNTS, deliberately. Membership is not a measurement of anything somebody did, so there is no figure here to
 * order people by and nothing that could be read as a contribution. `role` is GitHub's own word for the person's
 * standing in the team — `MEMBER` or `MAINTAINER` — and is a fact rather than a grade.
 */
export interface TeamMemberRow extends Contributor {
  role: string;
}

/**
 * One merged pull request, as the team page lists it.
 *
 * THE CHANGES THEMSELVES, under the counts that summarise them. The ways-of-working figures say "37 of 40
 * substantial changes were reviewed"; this is the 40, so a reader can see which three were not rather than taking
 * the ratio on trust.
 *
 * EVERY ANSWER HERE IS OPTIONAL, including the two governance ones. A pull request with no eligible review was
 * not reviewed and reports `false` — but a payload stored before the collector recorded reviews at all carries no
 * `reviews` array, and that is unmeasured rather than unreviewed. The projection in
 * `loadCachedFactsForOrganisation` has already been narrowed once, so "every payload carries every field" is a
 * claim about history rather than a guarantee — the same reason `timingMedians` guards its two medians.
 */
export interface TeamMergeRow {
  repository: string;
  number: number;
  merged_at: string;
  author?: string;
  /** Whether anybody other than the author submitted a review before the merge. */
  reviewed?: boolean;
  /** Whether a check completed before the merge and none that completed had failed. */
  ci?: boolean;
  /** Additions plus deletions, absent where GitHub did not size the change. */
  lines?: number;
  files?: number;
}

/**
 * One commit that reached the default branch without a pull request.
 *
 * No `reviewed` field, and its absence is the finding rather than an omission: a direct push had no pull request,
 * so there was never anything for anybody to review. `ci` reads GitHub's rolled-up `checkState`, which is absent
 * on a commit no check ever reported for.
 */
export interface TeamDirectPushRow {
  repository: string;
  sha: string;
  committed_at: string;
  author?: string;
  ci?: boolean;
  lines?: number;
  files?: number;
}

/**
 * How one team works, counted over the repositories it owns.
 *
 * COUNTS OVER A STATED DENOMINATOR, never a score. Each `*_measured` field is the denominator its neighbours are
 * out of, and it is deliberately NOT the team's repository count: a repository whose gate GitHub withheld has no
 * answer, so dividing by the holding would report an unreadable gate as a repository that fails.
 *
 * This is the ways-of-working material — the merge gate and review mechanics — which lives on `/teams` because
 * that is where a reader asks how a team works. `/repositories` asks a different question, whether a repository
 * meets the assurance criteria, and carries `AssuranceReport` instead.
 *
 * Nothing here is combined into a team label and nothing orders the cards, which is the boundary `TeamsList`
 * states: the cards arrive largest-holding-first, and a holding is what a team is on the hook for rather than a
 * grade.
 */
export interface TeamPractice {
  /** How many of the team's repositories had a readable merge gate. The denominator for the two below. */
  gates_measured: number;
  /** How many of those gates require at least one approving review. */
  enforces_review: number;
  checks_measured: number;
  enforces_checks: number;
  /** How many the readiness policy graded for unreviewed substantial merging. */
  unreviewed_measured: number;
  unreviewed_clear: number;
  /** The allowance forgiving what it was configured to forgive, which is not the same as nothing merging. */
  unreviewed_within: number;
  unreviewed_above: number;
  /**
   * The CHANGES rather than the repositories: how many substantial changes reached the default branch with no
   * independent review, out of how many there were.
   *
   * A different denominator from the four counts above, and the one with teeth. Those say how many of a team's
   * repositories the policy graded clear; these say how much actually got through. Absent where the policy graded
   * nothing — `minimum_merges` declines thin evidence, and the team page must not state a rate the policy refused.
   */
  unreviewed_substantial_merges?: number;
  substantial_merges?: number;
  merged_pull_requests: number;
  direct_commits: number;
  /**
   * The typical repository's typical wait, in hours — a MEDIAN OF MEDIANS.
   *
   * Not the median across the team's changes, which would need every per-change value rather than each
   * repository's summary. Named as what it is on the page, because the two are different numbers and the
   * distinction is not obvious from a label. Absent where no repository observed one, never zero.
   */
  time_to_first_review_hours?: number;
  merge_cycle_time_hours?: number;
}

export interface TeamRow {
  team: string;
  /**
   * The name `metrics.yaml` gives this team, where somebody has overridden one, and the slug otherwise.
   *
   * SENT ON EVERY CARD AND RENDERED BY NOTHING. `TeamsList` prints `team` in monospace deliberately — a slug is
   * what links to a page and what a reader recognises — so this is an answer waiting on a decision about which
   * of the two a card should head itself with. Declared for `RepositoryRow`'s four figures' reason: the report
   * has emitted it since the port, and a field on the wire that the contract does not name is exactly the state
   * this file exists to prevent. Only an overridden team has a name of its own; the slug is the fallback rather
   * than a prettified guess, because a generated title would read as a name somebody chose.
   */
  display_name?: string;
  repositories: number;
  unavailable: number;
  /**
   * How many people landed a reported change in this team's repositories, by either route.
   *
   * A NUMBER here and a LIST on `TeamDetail`, which is not an inconsistency to tidy: a card prints a count and
   * the team page lists the people. Both are folded off the same two activity reports, so the figure on a card and
   * the length of the table it links to are one derivation rather than two that could disagree.
   *
   * TWO INTERFACES OF ONE NAME IS WHAT MADE THIS A BUG. The report layer emitted the list shape onto the card's
   * row until 2026-09-15, and every card read " contributors" with no figure — `count(...)` is a template literal,
   * so `[]` stringified to nothing. Nothing caught it because `src/lib/api.ts` reaches the contract through a
   * double cast. See `authorsByRepository` in the report layer.
   */
  actors: number;
  practice?: TeamPractice;
  labels: Record<string, number>;
}

export interface TeamDetail {
  team: string;
  repositories: RepositoryRow[];
  actors: TeamActorRow[];
  /**
   * Who GitHub says is in this team, alphabetically by login.
   *
   * ABSENT MEANS NO MEMBERSHIP WAS READ, and never that the team is empty. The graph is not told which teams a
   * collection walked in full, so a team with no stored row is indistinguishable from a team nobody walked — 15
   * teams on this estate have none — and the section says so in words rather than drawing an empty table under a
   * heading a reader would take for GitHub's answer. `unowned` is absent for the same reason, it being a reporting
   * bucket rather than a GitHub team.
   */
  members?: TeamMemberRow[];
  unavailable: number;
  /** How this team works, which is what the team page carries and `/repositories` does not. */
  practice?: TeamPractice;
  labels: Record<string, number>;
  /** The window's merged pull requests across this team's repositories, newest first. */
  merges?: TeamMergeRow[];
  /** The window's commits that reached a default branch with no pull request, newest first. */
  direct_pushes?: TeamDirectPushRow[];
}
