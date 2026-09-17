import { describe, expect, it } from "vitest";
import type { SonarState } from "../../domain/sonar.ts";
import { SONAR_UNATTEMPTED_DETAIL, storedSonar } from "./sonar.ts";

/**
 * The SonarCloud section as it was stored, and as the UI declares it.
 *
 * TWO THINGS ARE ASSERTED HERE and they are different in kind. The first is the WORDING: a repository nothing has
 * looked at, a repository with no project, and a mapped one are three answers, and until VIBE-591 every page in
 * the estate carried the second while the truth was the first. The second is the TRANSLATION: every field is
 * renamed between the two shapes and both call the interface `SonarMeasures`, so handing the stored object over
 * type-checks and renders a dash for every figure the collection holds.
 */

const FETCHED = "2026-09-17T14:00:00.000Z";

/** One state as it comes back out of `jsonb`: every instant a string, as `JSON.stringify` left it. */
function payload(state: Record<string, unknown>): unknown {
  return { defaultBranch: "main", sonar: state };
}

const MEASURES = {
  projectKey: "hmcts.cath",
  analysisAt: "2026-09-16T10:15:55.000Z",
  gate: { level: "ERROR", conditions: [{ metric: "coverage", level: "ERROR", comparator: "LT", errorThreshold: "80", actual: "62.1" }] },
  coverage: 62.1,
  duplicatedLinesDensity: 3.4,
  linesOfCode: 12_345,
  violations: 17,
  reliabilityIssues: 2,
  maintainabilityIssues: 40,
  securityIssues: 0,
  reliabilityRating: { value: 1 },
  maintainabilityRating: { value: 2 },
  securityRating: { value: 5 }
};

describe("the SonarCloud section a collection stored", () => {
  it("should say nothing was collected when the payload is not an object", () => {
    expect(storedSonar(undefined, FETCHED)).toEqual({ detail: "nothing has been collected for this repository" });
    expect(storedSonar("hmcts.cath", FETCHED)).toEqual({ detail: "nothing has been collected for this repository" });
  });

  it("should say nobody has looked when a collection stored no SonarCloud block at all", () => {
    // A row written before the layer was wired, or a run that found no map to read. NOT a claim that the
    // repository has no project, which is the sentence every page in the estate used to carry.
    expect(storedSonar({ defaultBranch: "main" }, FETCHED)).toEqual({ detail: SONAR_UNATTEMPTED_DETAIL });
  });

  it("should carry the collection's own reason where it looked and found no project", () => {
    const report = storedSonar(payload({ detail: "no SonarCloud project in hmcts analyses this repository" }), FETCHED);

    expect(report.detail).toBe("no SonarCloud project in hmcts analyses this repository");
    // Read, and said so: something was asked and answered, unlike the case above.
    expect(report.fetched_at).toBe(FETCHED);
  });

  it("should fall back to nobody-looked wording for a block that carries neither a mapping nor a reason", () => {
    expect(storedSonar(payload({}), FETCHED).detail).toBe(SONAR_UNATTEMPTED_DETAIL);
  });

  it("should rename every measure to the name the cards read", () => {
    const report = storedSonar(
      payload({ mapping: { projectKey: "hmcts.cath", repository: "cath-service", method: "analysis_revision" }, measures: MEASURES }),
      FETCHED
    );

    expect(report.measures).toEqual({
      project_key: "hmcts.cath",
      analysis_at: "2026-09-16T10:15:55.000Z",
      gate: { level: "ERROR", conditions: [{ metric: "coverage", level: "ERROR", comparator: "LT", threshold: "80", actual: "62.1" }] },
      coverage: 62.1,
      duplicated_lines_density: 3.4,
      lines_of_code: 12_345,
      violations: 17,
      reliability_issues: 2,
      maintainability_issues: 40,
      security_issues: 0,
      reliability_rating: { value: 1 },
      maintainability_rating: { value: 2 },
      security_rating: { value: 5 }
    });
  });

  it("should keep a measured zero, which is a fact about the code", () => {
    // The other half of the absent-versus-zero rule: `security_issues: 0` is a measurement and must survive.
    const report = storedSonar(
      payload({ mapping: { projectKey: "hmcts.cath", repository: "cath-service" }, measures: { projectKey: "hmcts.cath", securityIssues: 0 } }),
      FETCHED
    );

    expect(report.measures?.security_issues).toBe(0);
  });

  it("should leave a measure SonarCloud did not send absent rather than zero", () => {
    const report = storedSonar(payload({ mapping: { projectKey: "hmcts.cath", repository: "cath-service" }, measures: { projectKey: "hmcts.cath" } }), FETCHED);

    expect(report.measures).toEqual({ project_key: "hmcts.cath" });
    expect(report.measures?.coverage).toBeUndefined();
  });

  it("should report no gate for a level this build does not know, rather than a passing one", () => {
    const report = storedSonar(
      payload({ mapping: { projectKey: "hmcts.cath", repository: "cath-service" }, measures: { projectKey: "hmcts.cath", gate: { level: "WARN" } } }),
      FETCHED
    );

    expect(report.measures?.gate).toBeUndefined();
  });

  it("should name the project beside the reason its measures could not be read", () => {
    // The project a refusal was about is the first thing needed to chase it, so the mapping stays.
    const report = storedSonar(
      payload({ mapping: { projectKey: "hmcts.gone", repository: "cath-service", method: "stored_map" }, detail: "SonarCloud lists no project hmcts.gone" }),
      FETCHED
    );

    expect(report.mapping?.project_key).toBe("hmcts.gone");
    expect(report.measures).toBeUndefined();
    expect(report.detail).toBe("SonarCloud lists no project hmcts.gone");
  });

  it("should drop a mapping that names no repository rather than attribute a project to nothing", () => {
    // A row naming no repository is a remembered negative, and `collect` reports one as a reason. A half-written
    // mapping reaching here is a bug somewhere else, and rendering it would put a project on a blank repository.
    const report = storedSonar(payload({ mapping: { projectKey: "hmcts.cath" }, detail: "the map named no repository" }), FETCHED);

    expect(report.mapping).toBeUndefined();
    expect(report.detail).toBe("the map named no repository");
  });

  it("should accept the state a collection builds, so the two shapes cannot drift apart", () => {
    // Typed as the domain's own `SonarState`, which is what `collect` writes: a field renamed there and not here
    // fails to compile rather than rendering as unmeasured.
    const state: SonarState = {
      mapping: { projectKey: "hmcts.cath", repository: "cath-service", method: "stored_map", resolvedAt: new Date(FETCHED) },
      measures: { projectKey: "hmcts.cath", coverage: 92.5, securityRating: { value: 1 } }
    };

    const report = storedSonar(JSON.parse(JSON.stringify({ sonar: state })), FETCHED);

    expect(report.mapping?.repository).toBe("cath-service");
    expect(report.measures?.coverage).toBe(92.5);
    expect(report.measures?.security_rating).toEqual({ value: 1 });
  });
});
