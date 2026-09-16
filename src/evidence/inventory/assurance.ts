import { z } from "zod";
import type { AssuranceEvidence, HygieneSignals, SecretAlertSummary } from "../domain/assurance.ts";
import { ageInDays } from "../domain/assurance.ts";
import { GitHubError } from "../domain/availability.ts";
import type { GitHubClient } from "../github/client.ts";

/**
 * Collecting the assurance signals. The cheap half of `domain/assurance.ts`'s inputs.
 *
 * COSTS ONE GRAPHQL DOCUMENT PER BATCH AND NOT ONE REST CALL PER REPOSITORY, which is the point. Three of the
 * five hygiene signals ride on `security_and_analysis`, and that comes back on the metadata read `collect` ALREADY
 * MAKES to learn the default branch — so those are free, and this file only reads them off a response somebody
 * else paid for. The other two, `hasVulnerabilityAlertsEnabled` and the presence of an update configuration, are
 * GraphQL-only and are aliased 50 repositories to a document.
 *
 * The patching age comes off the Dependabot alerts the collector already fetches for the security block, so it
 * costs nothing either — see `severeAlertAge`.
 */

/**
 * `security_and_analysis`, as REST reports it.
 *
 * Permissive for `behaviour/responses.ts`' reason: GitHub keeps adding keys here, and the sample showed eight
 * where three are read. `nullish` throughout because the whole object is absent for a token that may not see it,
 * which is a DIFFERENT ANSWER from a feature being off and is why every signal is tri-valued.
 */
const securityAnalysisSchema = z
  .object({
    secret_scanning: z.object({ status: z.string() }).nullish(),
    secret_scanning_push_protection: z.object({ status: z.string() }).nullish(),
    dependabot_security_updates: z.object({ status: z.string() }).nullish()
  })
  .nullish();

/** GitHub's own word for a feature being on. Anything else — including `disabled` — is off. */
const ENABLED = "enabled";

/** One `{status}` block as a flag, or nothing where GitHub named no block at all. */
function statusFlag(block: { status: string } | null | undefined): boolean | undefined {
  return block == null ? undefined : block.status === ENABLED;
}

/**
 * The three hygiene signals carried on a repository's metadata.
 *
 * Takes the ALREADY-FETCHED metadata body rather than fetching it, which is what makes these free. The parameter
 * is `unknown` because the caller holds it as the response to a request it made for another reason entirely, and
 * narrowing it here keeps the schema in one place.
 */
export function hygieneFromMetadata(metadata: unknown): HygieneSignals {
  const parsed = securityAnalysisSchema.safeParse((metadata as { security_and_analysis?: unknown } | null | undefined)?.security_and_analysis);
  // A body this build cannot read leaves every signal ABSENT rather than false: an unparseable response is not
  // evidence that scanning is off. Same rule as `openAlerts` applies to an invalid alert record.
  if (!parsed.success || parsed.data == null) {
    return {};
  }
  const analysis = parsed.data;
  return {
    ...(statusFlag(analysis.secret_scanning) === undefined ? {} : { secretScanning: statusFlag(analysis.secret_scanning) }),
    ...(statusFlag(analysis.secret_scanning_push_protection) === undefined ? {} : { pushProtection: statusFlag(analysis.secret_scanning_push_protection) }),
    ...(statusFlag(analysis.dependabot_security_updates) === undefined ? {} : { dependabotSecurityUpdates: statusFlag(analysis.dependabot_security_updates) })
  };
}

/**
 * How old the oldest OPEN CRITICAL OR HIGH Dependabot alert is, in days.
 *
 * Reads the records the security-alert collection already fetched, so the patching criterion costs no request of
 * its own. `created_at` is when GitHub raised the alert, which is the closest thing available to "how long has
 * this gone unpatched" — the alert cannot say when the vulnerable dependency was introduced.
 *
 * CRITICAL AND HIGH ONLY, matching what the criterion is about and what `tone.ts` already calls severe. A
 * medium alert open for two years is worth knowing and is not what a patching expectation is written against.
 */
export function severeAlertAge(records: readonly unknown[], reference: Date): number | undefined {
  const ages = records
    .map((record) => {
      const parsed = z
        .object({ created_at: z.string().nullish(), security_advisory: z.object({ severity: z.string().nullish() }).nullish() })
        .safeParse(record);
      if (!parsed.success) {
        return undefined;
      }
      const severity = parsed.data.security_advisory?.severity?.toLowerCase();
      if (severity !== "critical" && severity !== "high") {
        return undefined;
      }
      const raisedAt = parsed.data.created_at == null ? undefined : new Date(parsed.data.created_at);
      // An unreadable instant is dropped rather than counted as zero days, which would report the estate's
      // oldest alert as its newest.
      return raisedAt === undefined || Number.isNaN(raisedAt.getTime()) ? undefined : ageInDays(raisedAt, reference);
    })
    .filter((age): age is number => age !== undefined);
  return ages.length === 0 ? undefined : Math.max(...ages);
}

/** How many repositories one assurance document reads. */
export const DefaultAssuranceBatchSize = 50;

/** Built documents by batch size, since the text is a function of the size and never of the data. */
const assuranceDocuments = new Map<number, string>();

/**
 * The paths a repository may declare its dependency update tooling at.
 *
 * Both, because HMCTS uses both: Renovate is the platform's own standard and Dependabot is GitHub's default, so a
 * repository configuring either has configured one. Reading only `dependabot.yml` would report every
 * Renovate-managed repository as having no update tooling, which on this estate is most of them.
 */
export const UpdateConfigurationPaths: readonly string[] = [".github/dependabot.yml", ".github/renovate.json", "renovate.json"];

/**
 * One document reading up to `batchSize` repositories' GraphQL-only assurance signals.
 *
 * NAMES TRAVEL AS VARIABLES AND ALIASES CARRY ONLY POSITION, verbatim from `ownershipFilesQuery` and for its two
 * reasons: a repository name reaching a document as TEXT is an injection surface however small, and a document
 * whose text depends only on its batch size is built once and reused. `name` is echoed back so a mismatched
 * alias is caught rather than silently attributing one repository's signals to another.
 *
 * 50 per document against 25 for the CODEOWNERS walk, because this reads fewer nodes per repository: two scalars
 * and three cheap object lookups against three blobs whose text is fetched. At 1,880 repositories that is 38
 * documents.
 */
export function assuranceQuery(batchSize: number = DefaultAssuranceBatchSize): string {
  const built = assuranceDocuments.get(batchSize);
  if (built !== undefined) {
    return built;
  }
  const positions = Array.from({ length: batchSize }, (_unused, index) => index);
  const declarations = positions.map((index) => `, $r${index}: String!`).join("");
  // `__typename` alone rather than the blob's text: the question is whether the file EXISTS, and fetching its
  // contents would pay for bytes nothing reads. The paths are interpolated and that is safe for
  // `ownershipFilesQuery`'s stated reason — they are constants in this codebase, not values fetched from anywhere.
  const files = UpdateConfigurationPaths.map((path, at) => `c${at}: object(expression: "HEAD:${path}") { __typename }`).join("\n            ");
  const repositories = positions
    .map(
      (index) => `
          a${index}: repository(owner: $organization, name: $r${index}) {
            name
            hasVulnerabilityAlertsEnabled
            isSecurityPolicyEnabled
            ${files}
          }`
    )
    .join("");
  const document = `
        query AssuranceSignals($organization: String!${declarations}) {${repositories}
          rateLimit { cost limit remaining resetAt }
        }
    `;
  assuranceDocuments.set(batchSize, document);
  return document;
}

const assuranceEntrySchema = z.object({
  name: z.string().nullish(),
  hasVulnerabilityAlertsEnabled: z.boolean().nullish(),
  isSecurityPolicyEnabled: z.boolean().nullish()
});

/**
 * What the aliased GraphQL document answers for one repository.
 *
 * Two hygiene signals plus the security policy, which is NOT a hygiene signal and is kept apart from them: hygiene
 * asks whether tooling is switched on and the policy is a separate criterion — one that is reported and
 * deliberately not graded. Folding it into `HygieneSignals` would have put it into the hygiene composite, where a
 * value that is true everywhere would have made that criterion easier to meet for no reason.
 */
export interface GraphAssurance extends Pick<HygieneSignals, "vulnerabilityAlerts" | "updateConfiguration"> {
  securityPolicy?: boolean;
}

/** One failure's message, for a log line that names what went wrong rather than that something did. */
function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Reads one repository's aliased entry, or nothing where GitHub would not name it.
 *
 * NO ENTRY MEANS UNREAD, and the caller leaves both signals absent for it — which the domain then grades as
 * unknown rather than as a repository with scanning switched off. Same three-outcome discipline
 * `readOwnershipRepository` keeps.
 */
function readAssuranceEntry(organization: string, repository: string, value: unknown): GraphAssurance | undefined {
  if (value == null || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const parsed = assuranceEntrySchema.safeParse(record);
  if (!parsed.success) {
    return undefined;
  }
  // The one check that guards the aliasing scheme, as the CODEOWNERS walk's does: `a3` must be the repository
  // `$r3` named, or the batch has been read off by one and every signal in it belongs to the wrong repository.
  const echoed = parsed.data.name;
  if (echoed != null && echoed.toLowerCase() !== repository.toLowerCase()) {
    console.warn(`GitHub answered assurance signals for ${organization}/${echoed} where ${repository} was asked for; refusing the answer`);
    return undefined;
  }
  const configured = UpdateConfigurationPaths.some((_path, at) => record[`c${at}`] != null);
  return {
    ...(parsed.data.hasVulnerabilityAlertsEnabled == null ? {} : { vulnerabilityAlerts: parsed.data.hasVulnerabilityAlertsEnabled }),
    ...(parsed.data.isSecurityPolicyEnabled == null ? {} : { securityPolicy: parsed.data.isSecurityPolicyEnabled }),
    updateConfiguration: configured
  };
}

/**
 * Every repository's GraphQL-only assurance signals, batched.
 *
 * A FAILING BATCH IS RE-READ ONE AT A TIME, verbatim from `readOwnershipBatch` and for its measured reason:
 * GitHub answers a document naming one unreadable repository with errors beside partial data, so without the
 * retry one archived-and-transferred name would record "nobody could look" for the 49 beside it.
 */
export async function collectAssuranceSignals(
  client: GitHubClient,
  organization: string,
  repositories: readonly string[],
  batchSize: number = DefaultAssuranceBatchSize
): Promise<Map<string, GraphAssurance>> {
  const signals = new Map<string, GraphAssurance>();
  const size = Math.max(1, Math.trunc(batchSize));
  for (let at = 0; at < repositories.length; at += size) {
    await readAssuranceBatch(client, organization, repositories.slice(at, at + size), signals);
  }
  return signals;
}

async function readAssuranceBatch(client: GitHubClient, organization: string, batch: readonly string[], into: Map<string, GraphAssurance>): Promise<void> {
  if (batch.length === 0) {
    return;
  }
  const variables: Record<string, unknown> = { organization };
  for (const [index, name] of batch.entries()) {
    variables[`r${index}`] = name;
  }

  let body: Record<string, unknown>;
  try {
    body = await client.graphql<Record<string, unknown>>(assuranceQuery(batch.length), variables);
  } catch (error) {
    if (batch.length > 1) {
      console.warn(`Could not read assurance signals for a batch of ${batch.length} repositories, re-reading them one at a time: ${reason(error)}`);
      for (const name of batch) {
        await readAssuranceBatch(client, organization, [name], into);
      }
      return;
    }
    console.warn(`Could not read assurance signals for ${organization}/${batch[0] as string}: ${reason(error)}`);
    return;
  }

  for (const [index, name] of batch.entries()) {
    const read = readAssuranceEntry(organization, name, body[`a${index}`]);
    if (read !== undefined) {
      into.set(name, read);
    }
  }
}

/**
 * The open Dependabot alerts for one repository, for the patching age.
 *
 * SEPARATE FROM `openAlerts` in `security-alerts.ts` even though both read the same endpoint, and the reason is
 * that the two want different things from it: that one counts by severity and discards the records, this one
 * needs `created_at` off each record. Rather than widen the counter's return shape — which every reader of the
 * security block would then carry — the collector reads the records once and hands them to both. See
 * `collectRepository`.
 *
 * Returns `undefined` for a family nobody could read, which is what keeps `severeAlertsRead` honest.
 */
export async function readDependabotAlerts(client: GitHubClient, organization: string, repository: string): Promise<unknown[] | undefined> {
  const records: unknown[] = [];
  try {
    // `per_page=100`, matching the org-wide read below. GitHub's default of 30 was three or four pages for a
    // repository carrying the 50-200 open alerts that are ordinary here.
    for await (const page of client.paginate<unknown>(`/repos/${organization}/${repository}/dependabot/alerts`, { state: "open", per_page: 100 })) {
      records.push(...page);
    }
  } catch (error) {
    if (!(error instanceof GitHubError)) {
      throw error;
    }
    // A feature that is off answers 404 or an explained 403, and both mean there are no alerts to age rather
    // than a repository nobody may look at. Reported as unread all the same: "Dependabot is not enabled here" is
    // not "no critical alert is open", and the column must not read as a pass for a repository with no scanner.
    return undefined;
  }
  return records;
}

/**
 * Every open secret-scanning alert in the ORGANISATION, keyed by repository.
 *
 * ONE CALL FOR THE WHOLE ESTATE, and that shape is the whole reason this criterion is reportable. The
 * per-repository endpoint works too and is deliberately not used: 1,880 calls against one, and — the part that
 * matters more — a repository absent from THIS response is genuinely clean, where a per-repository absence cannot
 * be told from a refusal. Measured on AAT: 18 alerts across 12 repositories, one page, oldest raised 2022-05-26.
 *
 * NO SECRET VALUE IS READ OUT OF THE RESPONSE. Each alert carries the literal detected credential in a `secret`
 * field — which is why `github/client.ts` refuses to log response bodies at all — so this projects each record to
 * a repository name and an instant before anything else touches it. Nothing downstream can leak what it never
 * received, and `secret_type` is left behind too: "Azure Storage Account Access Key" beside a repository name
 * tells a reader of the dashboard what to go looking for and where.
 *
 * `undefined` for a failed read, so the caller can report every repository as UNKNOWN rather than as clean. A
 * `{}` here would mean "the whole estate has no leaked credentials", which is the one wrong answer that reads
 * like good news.
 */
export async function collectOrganisationSecretAlerts(
  client: GitHubClient,
  organization: string,
  reference: Date
): Promise<Map<string, SecretAlertSummary> | undefined> {
  // THE COUNT AND THE INSTANTS ARE TALLIED SEPARATELY, and conflating them was a real bug in the first version of
  // this: counting `instants.length` reported a repository whose only alert had an unreadable `created_at` as
  // having ZERO open, which turns a leaked credential into a clean bill. An alert with no readable instant is
  // still an alert; it just cannot contribute an age.
  const open = new Map<string, number>();
  const raised = new Map<string, Date[]>();
  try {
    for await (const page of client.paginate<unknown>(`/orgs/${organization}/secret-scanning/alerts`, { state: "open", per_page: 100 })) {
      for (const record of page) {
        const parsed = organisationSecretAlertSchema.safeParse(record);
        // A record this build cannot read is skipped rather than failing the estate: one unparseable alert must
        // not turn every repository's answer into unknown.
        const repository = parsed.success ? parsed.data.repository?.name : undefined;
        if (repository == null) {
          continue;
        }
        open.set(repository, (open.get(repository) ?? 0) + 1);
        const createdAt = parsed.data?.created_at == null ? undefined : new Date(parsed.data.created_at);
        if (createdAt !== undefined && !Number.isNaN(createdAt.getTime())) {
          raised.set(repository, [...(raised.get(repository) ?? []), createdAt]);
        }
      }
    }
  } catch (error) {
    console.warn(`Could not read the open secret-scanning alerts of ${organization}; every repository's answer will be unknown: ${reason(error)}`);
    return undefined;
  }

  const summaries = new Map<string, SecretAlertSummary>();
  for (const [repository, count] of open) {
    const instants = raised.get(repository) ?? [];
    const oldest = instants.length === 0 ? undefined : new Date(Math.min(...instants.map((instant) => instant.getTime())));
    const age = ageInDays(oldest, reference);
    summaries.set(repository, { open: count, ...(age === undefined ? {} : { oldestOpenDays: age }) });
  }
  return summaries;
}

/**
 * One organisation-wide secret-scanning alert, projected to the two fields this reads.
 *
 * Deliberately NARROW. The schema names `repository.name` and `created_at` and nothing else, so the `secret` field
 * carrying the live credential is dropped at the boundary rather than carried and then ignored — the safest place
 * to lose it is before it reaches a variable.
 */
const organisationSecretAlertSchema = z.object({
  created_at: z.string().nullish(),
  repository: z.object({ name: z.string().nullish() }).nullish()
});

/** One repository's assurance evidence, assembled from the three sources that carry it. */
export function assuranceEvidence(
  metadata: unknown,
  graph: GraphAssurance | undefined,
  alerts: readonly unknown[] | undefined,
  reference: Date,
  /**
   * The org-wide secret-scanning answer: this repository's summary, or `undefined` where the read failed.
   *
   * A THREE-WAY PARAMETER carried as an object rather than as a bare summary, because "no alerts for this
   * repository" and "the whole read failed" must not collapse into the same `undefined`. `{ read: true }` with no
   * summary is clean — the org-wide call covers every repository, so absence from it is an answer — and
   * `{ read: false }` is unknown.
   */
  secrets: { read: boolean; summary?: SecretAlertSummary } = { read: false }
): AssuranceEvidence {
  const age = alerts === undefined ? undefined : severeAlertAge(alerts, reference);
  // The policy is lifted OUT of the hygiene signals it arrives beside: it is its own criterion, and leaving it in
  // `hygiene` would have folded a value that is true everywhere into the hygiene composite.
  const { securityPolicy, ...hygieneFromGraph } = graph ?? {};
  return {
    hygiene: { ...hygieneFromMetadata(metadata), ...hygieneFromGraph },
    ...(age === undefined ? {} : { oldestSevereAlertDays: age }),
    severeAlertsRead: alerts !== undefined,
    ...(securityPolicy === undefined ? {} : { securityPolicy }),
    // Clean is `{ open: 0 }` rather than an absence, so the domain can tell it from an unread estate.
    ...(secrets.read ? { secrets: secrets.summary ?? { open: 0 } } : {}),
    secretsRead: secrets.read
  };
}
