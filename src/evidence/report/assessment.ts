import type * as contract from "../../lib/types.ts";
import type { ReadinessAssessment, ReadinessCondition } from "../domain/readiness.ts";

/**
 * One repository's readiness verdict in the shape the UI declares, which today is the shape it is computed in.
 *
 * THE TRANSLATION THAT WAS A COINCIDENCE. `domain/readiness.ts` and `src/lib/types.ts` both declare
 * `ReadinessAssessment` and `ReadinessCondition`, and EVERY FIELD ON BOTH IS A SINGLE WORD — `condition`, `detail`,
 * `label`, `informational`, `blocking`, `caution`, `clear` — so there is no case difference to get wrong and the
 * domain object could be handed to the contract unchanged. `repositoryEvidence` did exactly that. It type-checked
 * for the reason the three shipped bugs beside it type-checked: two interfaces of one name, one per module, and
 * nothing between them able to disagree. That it also happened to be CORRECT is luck, not a property of the code.
 *
 * ADD ONE CAMELCASE FIELD TO `ReadinessCondition` AND THE PASS-THROUGH BREAKS SILENTLY. It would land on the wire
 * untranslated with nothing complaining — the same failure as `sampleSize` reaching a card that reads `sample_size`,
 * which printed "undefined samples" on every repository page, and the same as `codeScanning` reaching a reader of
 * `code_scanning`, which took the page down twice. So the fields are spelled out here: this function is now the
 * single statement of what the contract's assessment IS, and a rename on either side fails a case rather than
 * shipping. `contractObservation` states the same argument for rebuilding a rate whose three names already agree.
 *
 * IN ITS OWN MODULE for `./observation.ts`'s reason. `./repositories.ts` imports the store and so the Prisma client,
 * which no unit test can reach — it is excluded from the unit coverage config for that, and it is why translations
 * of exactly this kind have already shipped broken. Here the translation is a pure function of its argument and
 * `./assessment.test.ts` asserts its key set against the contract on every build.
 *
 * NAMED FOR WHAT IT TRANSLATES, which repeats `../assessment/assessment.ts`. That module is the POLICY — it decides
 * a label from the merge cohort and the gate; this one only renames what the policy decided, and neither is a better
 * home for the other's job.
 */
export function contractAssessment(assessment: ReadinessAssessment): contract.ReadinessAssessment {
  return {
    label: assessment.label,
    blocking: assessment.blocking.map(contractCondition),
    caution: assessment.caution.map(contractCondition),
    clear: assessment.clear.map(contractCondition)
  };
}

/**
 * One condition the policy checked, in the contract's own field names.
 *
 * `label` and `informational` are OMITTED rather than sent as `undefined`, the rule `contractDistribution` states:
 * the key set this emits is then right where it is built, so a test can read it without `stripAbsent`'s help. `label`
 * is present only on a blocking condition — it is what that condition imposes — and `informational` marks a condition
 * the policy reported without judging, which is why a reader meeting one under `clear` is owed the flag.
 */
function contractCondition(condition: ReadinessCondition): contract.ReadinessCondition {
  return {
    condition: condition.condition,
    detail: condition.detail,
    ...(condition.label === undefined ? {} : { label: condition.label }),
    ...(condition.informational === undefined ? {} : { informational: condition.informational })
  };
}
