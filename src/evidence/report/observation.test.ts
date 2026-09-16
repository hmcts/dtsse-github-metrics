import { describe, expect, it } from "vitest";
import { sample, summarise } from "../../lib/format.ts";
import { percentile as p75Tail } from "../../lib/metrics.ts";
import type { DistributionObservation as ContractDistribution, Observation as ContractObservation, RateObservation as ContractRate } from "../../lib/types.ts";
import { mergeCycleTime, pullRequestSize, reviewDepth } from "../behaviour/metrics.ts";
import { type DistributionObservation, type Merges, ObservationStatus, type PullRequestFact } from "../domain/facts.ts";
import { contractObservation } from "./observation.ts";

/**
 * The seam between what a behaviour metric computes and what the UI declares.
 *
 * THE ONE TEST IN THIS TREE THAT IMPORTS BOTH SIDES, deliberately: `src/lib/**` and `src/evidence/**` do not import
 * each other, and that separation is what let three field-renaming bugs ship — the producer and the consumer were
 * each covered against objects somebody wrote by hand, and nothing exercised the join between them. So the
 * observations below come from the REAL metrics over real facts, and the assertions are the contract's own type and
 * the UI's own formatters. A fixture spelling `sample_size` by hand would pass whatever the producer emitted.
 *
 * Both `src/lib/types.ts` and `src/evidence/domain/facts.ts` export a `DistributionObservation`, which is the whole
 * bug class; the contract's is aliased here so which of the two is meant is never a question of import order.
 */

function pullRequest(): PullRequestFact {
  return {
    identifier: 101,
    repository: "cath-service",
    number: 11,
    createdAt: new Date("2026-08-01T00:00:00Z"),
    mergedAt: new Date("2026-08-03T00:00:00Z"),
    draft: false,
    authorLogin: "author",
    authorType: "User",
    additions: 10,
    deletions: 2,
    changedFiles: 3,
    reviews: [],
    checks: []
  };
}

/** A cohort of `count` merged pull requests, each a different size, so the percentiles are placeable and distinct. */
function cohort(count: number): Merges {
  return {
    pullRequests: Array.from({ length: count }, (_, index) => ({
      ...pullRequest(),
      identifier: index + 1,
      number: index + 1,
      additions: (index + 1) * 10,
      mergedAt: new Date(Date.UTC(2026, 7, 3, index))
    })),
    directCommits: []
  };
}

/**
 * Every field the contract declares on a distribution, exhaustively.
 *
 * `Record<keyof ContractDistribution, true>` rather than a string array, so the COMPILER is what checks this list: a
 * field renamed, added or removed in `src/lib/types.ts` fails to build here. That is the check that was missing when
 * `sample_size` was declared on one side and `sampleSize` emitted on the other.
 */
const CONTRACT_DISTRIBUTION_FIELDS: Record<keyof ContractDistribution, true> = {
  status: true,
  sample_size: true,
  unit: true,
  median: true,
  percentile_75: true,
  percentile_90: true
};

const CONTRACT_RATE_FIELDS: Record<keyof ContractRate, true> = { status: true, numerator: true, denominator: true };

/**
 * The emitted observation narrowed to the distribution arm, which is what the formatters below take.
 *
 * NARROWED AND NOT CAST, from VIBE-568. `contractObservation` declares the contract's own `Observation` now, so the
 * union arrives typed and `"unit" in` — the discriminator every reader of this contract uses — picks the arm. It was
 * a double cast through `Record<string, unknown>`, which is the cast `src/lib/api.ts` used to make on every read: it
 * would have accepted the DOMAIN's identically-named `DistributionObservation` without a word, which is the one
 * mistake this file exists to catch. Throwing on a rate is the honest branch — no case here passes one, and a case
 * that started to would be asserting formatters against a shape they do not take.
 */
function asContract(emitted: ContractObservation): ContractDistribution {
  if (!("unit" in emitted)) {
    throw new TypeError("a rate was handed to a distribution formatter, which is a fault in the case rather than in the translation");
  }
  return emitted;
}

describe("contractObservation", () => {
  it("emits a distribution in the contract's field names and nothing else", () => {
    const emitted = contractObservation(pullRequestSize.summary(cohort(8)));

    // SNAKE_CASE AND UNDERSCORED PERCENTILES. `sampleSize` reaching the contract is what made `format.sample`
    // print "undefined samples" under three of the nine cards on every repository page.
    expect(Object.keys(emitted).sort()).toEqual(["median", "percentile_75", "percentile_90", "sample_size", "status", "unit"]);
    for (const field of Object.keys(emitted)) {
      expect(CONTRACT_DISTRIBUTION_FIELDS).toHaveProperty(field);
    }
    expect(emitted).toEqual({ status: "observed", sample_size: 8, unit: "lines", median: 47, percentile_75: 64.5, percentile_90: 75 });
  });

  it("carries a rate's three fields, which the domain and the contract happen to spell alike", () => {
    // Rebuilt rather than spread, so this file states what the contract's rate IS and a rename on either side
    // fails a case rather than passing silently.
    const emitted = contractObservation(reviewDepth.summary(cohort(2)));

    expect(Object.keys(emitted).sort()).toEqual(["denominator", "numerator", "status"]);
    for (const field of Object.keys(emitted)) {
      expect(CONTRACT_RATE_FIELDS).toHaveProperty(field);
    }
    expect(emitted).toEqual({ status: "not_applicable", numerator: 0, denominator: 0 });
  });

  it("omits an unplaced percentile rather than sending it as undefined", () => {
    // The domain declares all three percentiles OPTIONAL — `distribution` returns none of them for an empty sample —
    // so the translation has to omit the key rather than set it to `undefined`. `metrics.percentile` guards on
    // `== null`, which is only sound if a missing figure arrives as a missing key. Built here rather than taken from
    // a metric because no producer emits an observed distribution with a gap in it today, and this is the shape the
    // contract has to be able to express when one does.
    const partial: DistributionObservation = { status: ObservationStatus.Observed, sampleSize: 3, unit: "hours", median: 4 };

    const emitted = contractObservation(partial);

    expect(Object.keys(emitted).sort()).toEqual(["median", "sample_size", "status", "unit"]);
    expect(emitted).not.toHaveProperty("percentile_75");
    expect(p75Tail(asContract(emitted))).toBeNull();
  });

  it("keeps a not-applicable distribution's sample size, so a card states what it was measured over", () => {
    // Zero is MEASURED AND MEASURED AS NOTHING, so the field is present and the percentiles are not.
    const emitted = contractObservation(mergeCycleTime.summary(cohort(0)));

    expect(emitted).toEqual({ status: "not_applicable", sample_size: 0, unit: "hours" });
  });
});

describe("what a metric card renders from it", () => {
  it("states a sample size and never the string undefined", () => {
    // THE RENDERED DEFECT. `format.sample` read `observation.sample_size` off the domain object and returned the
    // literal "undefined samples" — three times per repository page, once for each distribution metric.
    const rendered = sample(asContract(contractObservation(pullRequestSize.summary(cohort(8)))));

    expect(rendered).toBe("8 samples");
    expect(rendered).not.toContain("undefined");
  });

  it("renders the p75 tail for pull-request size, which is the percentile that metric is graded at", () => {
    // `metrics.percentile` returned null for every window, so the one figure `pull-request-size` is judged by was
    // the one figure its own card did not show.
    expect(p75Tail(asContract(contractObservation(pullRequestSize.summary(cohort(8)))))).toBe("p75 64.5 lines");
  });

  it("renders a median and a sample size for both flow distributions", () => {
    for (const metric of [mergeCycleTime, pullRequestSize]) {
      const observation = asContract(contractObservation(metric.summary(cohort(4))));

      expect(summarise(observation)).not.toContain("undefined");
      expect(sample(observation)).toBe("4 samples");
    }
  });
});
