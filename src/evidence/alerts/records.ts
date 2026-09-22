import { z } from "zod";
import { AlertFamily, type SecurityAlertDetail } from "../domain/alert-detail.ts";
import { gradedSeverity } from "../domain/security-alerts.ts";
import { alertRepositoryName } from "../inventory/security-alerts.ts";

/**
 * Reading one alert out of one GitHub record, for each of the three families.
 *
 * THE SECRET VALUE IS DROPPED HERE, AND HERE IS THE ONLY PLACE IT COULD BE. A secret-scanning record carries the
 * detected credential in a top-level `secret` field — confirmed present on all 146 records the HMCTS installation
 * returns — and `secretScanningAlertSchema` below does not name it. A `z.object` STRIPS every key it does not
 * declare, so `parse` returns an object with no `secret` on it: the credential is discarded inside the parse, and
 * nothing downstream is ever handed a value it could store, log or serialise.
 *
 * THAT ORDERING IS THE WHOLE SAFETY ARGUMENT, and it is why this is not a filter applied after the fact. A filter
 * lives at a call site, and a call site can be refactored, bypassed by a second caller, or lose its filter in a
 * conflict resolution while still compiling and still passing every test about counts. A schema that never
 * declares the field cannot be bypassed, because there is no code path from the response to a credential — the
 * only way to reintroduce one is to add the field to the schema, which is a change nobody makes by accident.
 *
 * NOTHING HERE MAY BE GIVEN `.passthrough()`. That single call would undo the paragraph above for all three
 * families at once, and for secret scanning it would copy live credentials into Postgres.
 *
 * `github/client.ts` holds the other half of the same rule: it logs no response body for any endpoint, precisely
 * so that a debug run cannot write the credential to a file before this code ever sees the record.
 */

/**
 * The repository an organisation-wide record belongs to, plus GitHub's own alert number.
 *
 * SHARED BY ALL THREE FAMILIES because it is the identity every stored alert is keyed by, and the two fields have
 * to be read the same way for all of them or one family's rows land under a differently-spelled repository.
 */
const identitySchema = z.object({
  number: z.number(),
  repository: z.object({ name: z.string().nullish(), full_name: z.string().nullish() }).nullish()
});

/**
 * One secret-scanning alert, projected to the fields a reader needs.
 *
 * `secret` IS ABSENT ON PURPOSE AND MUST STAY ABSENT. So is `secret_type_display_name`, and so is everything else
 * on a record that names 34 fields: what is stored is the TYPE of credential and where it was found, which is what
 * tells somebody what to go and revoke. `first_location_detected` is itself narrowed to a path and a line rather
 * than taken whole, so no future field added inside that block can ride in either.
 */
const secretScanningAlertSchema = identitySchema.extend({
  state: z.string().nullish(),
  secret_type: z.string().nullish(),
  resolution: z.string().nullish(),
  created_at: z.string().nullish(),
  resolved_at: z.string().nullish(),
  html_url: z.string().nullish(),
  first_location_detected: z.object({ path: z.string().nullish(), start_line: z.number().nullish() }).nullish()
});

/**
 * One Dependabot alert.
 *
 * TWO IDENTIFYING FIELDS, because neither alone is any use to a reader: `ghsa_id` says which advisory and
 * `dependency.package.name` says which of a repository's packages it lands on, and one repository routinely
 * carries the same advisory against several packages. The location is the MANIFEST PATH and there is no line —
 * GitHub reports none, and inventing one from the lockfile would be this tool asserting something it did not read.
 */
const dependabotAlertSchema = identitySchema.extend({
  state: z.string().nullish(),
  security_advisory: z.object({ ghsa_id: z.string().nullish(), severity: z.string().nullish() }).nullish(),
  dependency: z.object({ package: z.object({ name: z.string().nullish() }).nullish(), manifest_path: z.string().nullish() }).nullish(),
  created_at: z.string().nullish(),
  fixed_at: z.string().nullish(),
  dismissed_at: z.string().nullish(),
  auto_dismissed_at: z.string().nullish(),
  dismissed_reason: z.string().nullish(),
  html_url: z.string().nullish()
});

/**
 * One code-scanning alert.
 *
 * `rule.security_severity_level` AND NOT `rule.severity`, which is the same distinction `codeScanningSeverity`
 * already draws for the counts: `severity` grades the rule's confidence and `security_severity_level` grades the
 * security impact, and a non-security rule has the first and not the second.
 */
const codeScanningAlertSchema = identitySchema.extend({
  state: z.string().nullish(),
  rule: z.object({ id: z.string().nullish(), security_severity_level: z.string().nullish() }).nullish(),
  most_recent_instance: z.object({ location: z.object({ path: z.string().nullish(), start_line: z.number().nullish() }).nullish() }).nullish(),
  created_at: z.string().nullish(),
  fixed_at: z.string().nullish(),
  dismissed_at: z.string().nullish(),
  dismissed_reason: z.string().nullish(),
  html_url: z.string().nullish()
});

/** An instant GitHub stated, or nothing where it stated none or stated one that does not parse. */
function instant(value: string | null | undefined): Date | undefined {
  if (value == null) {
    return undefined;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/** A string GitHub stated, or nothing where it stated null or the empty string, which say the same thing. */
function stated(value: string | null | undefined): string | undefined {
  return value == null || value === "" ? undefined : value;
}

/**
 * Drops the keys whose value is absent, so an unread field is missing rather than explicitly `undefined`.
 *
 * The absent-versus-zero rule reaches the store through this: a `SecurityAlertDetail` with `path: undefined` and
 * one with no `path` at all are the same thing to TypeScript, and the writer turns both into a NULL column — but
 * only one of them survives a `JSON.stringify` intact, and these records are compared field by field in tests.
 */
function withoutAbsent(detail: SecurityAlertDetail): SecurityAlertDetail {
  return Object.fromEntries(Object.entries(detail).filter(([, value]) => value !== undefined)) as unknown as SecurityAlertDetail;
}

/**
 * One record read, or `undefined` where it could not be attributed to a repository.
 *
 * A RECORD THIS BUILD CANNOT READ IS SKIPPED AND NOT FATAL, on `openAlerts`' rule: one unparseable alert must not
 * turn every repository's answer into unmeasured. An alert naming no repository or no number is skipped for a
 * different reason — those three fields are its identity, and there is nowhere to store it without them.
 */
function readRecord<T extends z.ZodTypeAny>(
  schema: T,
  family: AlertFamily,
  record: unknown,
  project: (parsed: z.infer<T>) => Omit<SecurityAlertDetail, "repository" | "family" | "number">
): SecurityAlertDetail | undefined {
  const parsed = schema.safeParse(record);
  if (!parsed.success) {
    return undefined;
  }
  const identity = parsed.data as z.infer<typeof identitySchema>;
  const repository = alertRepositoryName(identity.repository);
  if (repository === undefined) {
    return undefined;
  }
  return withoutAbsent({ repository, family, number: identity.number, ...project(parsed.data) });
}

/** One secret-scanning alert, or nothing. The credential is discarded inside `safeParse` and never returned. */
export function readSecretScanningAlert(record: unknown): SecurityAlertDetail | undefined {
  return readRecord(secretScanningAlertSchema, AlertFamily.SecretScanning, record, (alert) => ({
    alertType: stated(alert.secret_type),
    // NO SEVERITY, and `noSeverity` states why at length: GitHub grades no secret-scanning alert, and grading
    // every leaked credential critical here would rank a test fixture alongside a live production key.
    path: stated(alert.first_location_detected?.path),
    line: alert.first_location_detected?.start_line ?? undefined,
    state: stated(alert.state),
    resolution: stated(alert.resolution),
    createdAt: instant(alert.created_at),
    resolvedAt: instant(alert.resolved_at),
    htmlUrl: stated(alert.html_url)
  }));
}

/** One Dependabot alert, or nothing. */
export function readDependabotAlert(record: unknown): SecurityAlertDetail | undefined {
  return readRecord(dependabotAlertSchema, AlertFamily.Dependabot, record, (alert) => ({
    alertType: stated(alert.security_advisory?.ghsa_id),
    subject: stated(alert.dependency?.package?.name),
    severity: gradedSeverity(alert.security_advisory?.severity),
    path: stated(alert.dependency?.manifest_path),
    state: stated(alert.state),
    // `dismissed_reason` IS GITHUB'S OWN RESOLUTION WORD for this family, which spells the field differently from
    // secret scanning's `resolution` and means the same thing. An alert GitHub fixed or auto-dismissed carries no
    // reason at all, and `state` is what says which of those happened — so nothing is invented to fill it.
    resolution: stated(alert.dismissed_reason),
    createdAt: instant(alert.created_at),
    // THREE FIELDS FOR ONE INSTANT, in the order of how the alert stopped being open: fixed by a bump, dismissed
    // by a person, or auto-dismissed by GitHub. Only one is ever set, and collapsing them here is what lets the
    // stored column mean "when it stopped being open" for every family.
    resolvedAt: instant(alert.fixed_at) ?? instant(alert.dismissed_at) ?? instant(alert.auto_dismissed_at),
    htmlUrl: stated(alert.html_url)
  }));
}

/** One code-scanning alert, or nothing. */
export function readCodeScanningAlert(record: unknown): SecurityAlertDetail | undefined {
  return readRecord(codeScanningAlertSchema, AlertFamily.CodeScanning, record, (alert) => ({
    alertType: stated(alert.rule?.id),
    severity: gradedSeverity(alert.rule?.security_severity_level),
    path: stated(alert.most_recent_instance?.location?.path),
    line: alert.most_recent_instance?.location?.start_line ?? undefined,
    state: stated(alert.state),
    resolution: stated(alert.dismissed_reason),
    createdAt: instant(alert.created_at),
    resolvedAt: instant(alert.fixed_at) ?? instant(alert.dismissed_at),
    htmlUrl: stated(alert.html_url)
  }));
}
