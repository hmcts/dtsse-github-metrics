import type * as contract from "../../../lib/types.ts";
import { type AssuranceEvidence, assuranceGrade, type HygieneSignals, judgeAssurance } from "../../domain/assurance.ts";
import type { CohortEntry } from "../../org/cohort.ts";

/**
 * The assurance criteria one row is judged against, in the shape the UI declares.
 *
 * IN `report/contract/` for `./observation.ts`'s reason: a pure function of its two arguments, so the suite that runs
 * on every build holds it rather than the integration run.
 */

/**
 * The assurance criteria judged for one row, in the shape `src/lib/types.ts` declares.
 *
 * Judged HERE rather than in the UI, on the precedent every other graded figure on this contract follows: the
 * page renders a verdict the report reached, so the JSON a reader can curl and the table carry the same answer.
 *
 * TWO SOURCES, and that is why it takes the cohort entry as well as the payload. Ownership and maintenance are
 * facts about the repository that the GRAPH holds, so they answer on a repository nothing has been collected for;
 * hygiene and patching come from the collection. A criterion whose source is missing reads unknown, never unmet.
 */
export function reportedAssurance(entry: CohortEntry, payload: unknown): contract.AssuranceReport {
  const stored = (payload as { assurance?: AssuranceEvidence } | null | undefined)?.assurance;
  const judgements = judgeAssurance({
    ownerKind: entry.ownerKind,
    archived: entry.archived,
    unmaintained: entry.unmaintained,
    ...(stored === undefined ? {} : { evidence: stored })
  });
  return {
    grade: assuranceGrade(judgements),
    criteria: judgements.map((judgement) => ({ criterion: judgement.criterion, outcome: judgement.outcome, detail: judgement.detail })),
    // Lifted out of the criteria beside it so a column can print the number and a threshold can one day compare
    // it without either having to find the right judgement and parse its sentence.
    oldest_severe_alert_days: stored?.oldestSevereAlertDays,
    hygiene: reportedHygieneSignals(stored?.hygiene)
  };
}

/**
 * The hygiene signals on the contract's spelling, for the columns the Hygiene aggregate expands into.
 *
 * EMITTED BESIDE THE JUDGEMENT AND NOT INSIDE IT, for the reason `oldest_severe_alert_days` is: the judgement's
 * `detail` names the missing control in a sentence, and a column expanding the criterion needs the five values
 * themselves. Nothing here re-judges anything — `hygieneJudgement` is still the one place the four checks are
 * graded.
 *
 * Every key is passed through as it was collected, `undefined` included, so `stripAbsent` drops an undisclosed
 * signal rather than sending a `false` that would read as a control switched off. The whole block is absent for a
 * repository nothing has been collected for.
 */
function reportedHygieneSignals(signals: HygieneSignals | undefined): Record<string, unknown> | undefined {
  if (signals === undefined) {
    return undefined;
  }
  return {
    secret_scanning: signals.secretScanning,
    push_protection: signals.pushProtection,
    vulnerability_alerts: signals.vulnerabilityAlerts,
    dependabot_security_updates: signals.dependabotSecurityUpdates,
    update_configuration: signals.updateConfiguration
  };
}
