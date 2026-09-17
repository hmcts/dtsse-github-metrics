import type * as contract from "../../../lib/types.ts";
import { type DistributionObservation, type Observation, ObservationStatus, type RateObservation } from "../../domain/facts.ts";

/**
 * One behaviour metric's observation in the shape the UI declares, which is NOT the shape it is computed in.
 *
 * THE THIRD FIELD-RENAMING TRANSLATION AT THIS BOUNDARY, after the merge gate's and the alert families' — see
 * `contractGate` in `./merge-gate.ts` and `securityReport` in `./security.ts`, whose headers name this bug class.
 * The domain holds
 * `sampleSize`, `percentile75` and `percentile90`; `src/lib/types.ts` declares `sample_size`, `percentile_75` and
 * `percentile_90`. Both files call the interface `DistributionObservation`, so handing the stored object straight
 * over type-checks, and `src/lib/api.ts` bridges the report layer with a cast, so nothing downstream sees it
 * either. What a reader saw instead was `format.sample` reading an absent `sample_size` and printing the literal
 * string "undefined samples" under three of the nine metric cards on EVERY repository page, and `metrics.percentile`
 * reading an absent `percentile_75` and dropping the `· p75 N lines` tail from `pull-request-size` — the one metric
 * graded at p75, so the figure it is judged by was the figure not shown.
 *
 * IN `report/contract/` WITH THE FIVE TRANSLATIONS BESIDE IT, and the reason is the coverage bar rather than tidiness.
 * All six used to sit in the module that reads the estate, which imports the store and so the Prisma client: no unit
 * test could reach them, the coverage gate exempted the file, and that exemption is why two translations of exactly
 * this kind shipped broken. Each is now a pure function of its argument, held at 95% by the suite that runs on every
 * build — `./observation.test.ts` asserts the key set this one emits against the contract.
 *
 * A RATE IS REBUILT RATHER THAN PASSED THROUGH, even though its three field names happen to agree in both files.
 * Spelling them out makes this function the single statement of what the contract's `Observation` is; a spread
 * would leave the rate branch silently right today and silently wrong the day either side renames a field.
 */
export function contractObservation(observation: Observation): contract.Observation {
  // `"unit" in` is the discriminator `medianOf` narrows on, and `lib/format.isRate` asks the same question from the
  // other side. A rate carries no unit; a distribution carries one even when it observed nothing.
  return "unit" in observation ? contractDistribution(observation) : contractRate(observation);
}

/**
 * One distribution's median, or nothing where it observed no eligible sample.
 *
 * ABSENT AND NEVER ZERO, which is the same rule the whole contract follows: a repository whose pull requests were
 * never reviewed has no wait to report, and `0 hours` would read as instant review.
 *
 * NARROWED RATHER THAN CAST. `BehaviourMetric.summary` returns a rate or a distribution and only the two timing
 * metrics that read this return the second, so `assessment.ts` casts at its call sites. A cast would be wrong here
 * for a reason that does not apply there: this is the SERVING path, and a metric later changed from a distribution
 * to a rate would put `undefined` on the contract as a silent absence rather than failing. `"unit" in` is the
 * discriminator `contractObservation` above and `lib/format.ts` already use, so there is one definition of which
 * shape an observation is.
 */
export function medianOf(observation: DistributionObservation | RateObservation): number | undefined {
  if (!("unit" in observation) || observation.status !== ObservationStatus.Observed) {
    return undefined;
  }
  return observation.median;
}

function contractRate(observation: RateObservation): contract.RateObservation {
  return { status: observation.status, numerator: observation.numerator, denominator: observation.denominator };
}

function contractDistribution(observation: DistributionObservation): contract.DistributionObservation {
  return {
    status: observation.status,
    sample_size: observation.sampleSize,
    unit: observation.unit,
    // ABSENT AND NEVER ZERO, the rule `distribution` in `behaviour/analysis.ts` keeps at the other end: a
    // percentile the sample was too small to place is a figure nobody has, and a zero would read as a change of no
    // lines. Omitted here rather than left as `undefined` for `stripAbsent` to drop at the boundary, so the key set
    // this emits is right where it is built and a test can read it without the boundary's help.
    ...(observation.median === undefined ? {} : { median: observation.median }),
    ...(observation.percentile75 === undefined ? {} : { percentile_75: observation.percentile75 }),
    ...(observation.percentile90 === undefined ? {} : { percentile_90: observation.percentile90 })
  };
}
