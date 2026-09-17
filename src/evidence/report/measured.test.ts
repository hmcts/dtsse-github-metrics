import { describe, expect, it } from "vitest";
import { EvidenceSource } from "../domain/coverage.ts";
import type { CohortEntry } from "../org/cohort.ts";
import { OwnerKind } from "../org/graph.ts";
import { measuredSources } from "./measured.ts";

/**
 * Which repositories a collection READ each source for, which is what separates an absent figure from a zero.
 *
 * The whole absent-versus-zero contract turns on this one answer, and until VIBE-569 it needed five mocked tables to
 * reach: a refused merge walk and a quiet window are indistinguishable in the FACTS, and the only thing that tells
 * them apart is whether the coverage table records a walk that reached the anchor.
 */

const ANCHOR = new Date(Date.UTC(2026, 8, 15));

function entry(repository: string): CohortEntry {
  return {
    repository,
    owners: ["dtsse"],
    ownerKind: OwnerKind.Team,
    archived: false,
    visibility: "public",
    behaviourCollectable: true,
    unmaintained: false
  };
}

/** The coverage a walk of the named sources leaves, each recorded as having reached `edge`. */
function edges(entries: Record<string, Partial<Record<string, Date>>>): Map<string, Map<string, Date>> {
  return new Map(Object.entries(entries).map(([repository, bySource]) => [repository, new Map(Object.entries(bySource) as [string, Date][])]));
}

describe("which repositories each behaviour source was read for", () => {
  it("should report both sources as measured when a walk of each reached the anchor", () => {
    const measured = measuredSources(edges({ alpha: { [EvidenceSource.PullRequests]: ANCHOR, [EvidenceSource.DirectCommits]: ANCHOR } }), ANCHOR, [], []);

    expect(measured.pullRequests.has("alpha")).toBe(true);
    expect(measured.directCommits.has("alpha")).toBe(true);
  });

  it("should gate the two sources independently when only one walk came back", () => {
    // TWO WALKS RECORDING TWO SERIES. A repository whose pull requests were refused and whose commits answered has
    // one honest figure and one absence, and folding them would throw the honest one away.
    const measured = measuredSources(edges({ alpha: { [EvidenceSource.DirectCommits]: ANCHOR } }), ANCHOR, [], []);

    expect(measured.pullRequests.has("alpha")).toBe(false);
    expect(measured.directCommits.has("alpha")).toBe(true);
  });

  it("should report a repository as unmeasured when its coverage stops short of the anchor", () => {
    // A repository the last run never reached sits behind the modal edge, which is what says something about the
    // repository rather than about arithmetic.
    const behind = new Date(ANCHOR.getTime() - 1);

    const measured = measuredSources(edges({ alpha: { [EvidenceSource.PullRequests]: behind } }), ANCHOR, [], []);

    expect(measured.pullRequests.has("alpha")).toBe(false);
  });

  it("should report a repository as measured when its coverage runs past the anchor", () => {
    // READ UP TO THE ANCHOR and not containing the span: collection fills 90 days against a widest span of 26
    // weeks, so containment would report the whole estate as unmeasured at the long spans.
    const ahead = new Date(ANCHOR.getTime() + 86_400_000);

    const measured = measuredSources(edges({ alpha: { [EvidenceSource.PullRequests]: ahead } }), ANCHOR, [], []);

    expect(measured.pullRequests.has("alpha")).toBe(true);
  });

  it("should report a repository with no coverage row at all as unmeasured", () => {
    // A refused walk leaves a `repository_state` row and no coverage, which is not the same as a quiet window.
    const measured = measuredSources(edges({}), ANCHOR, [entry("alpha")], []);

    expect(measured.pullRequests.has("alpha")).toBe(false);
    expect(measured.directCommits.has("alpha")).toBe(false);
  });

  it("should count a declared repository's direct commits as read whatever was walked", () => {
    // `cohort.no_direct_pushes` is a DECLARATION and not a second reading of the coverage table: somebody has
    // stated that no person pushes to the default branch, so none is a measurement rather than an absence.
    const measured = measuredSources(edges({}), ANCHOR, [entry("alpha")], ["alpha"]);

    expect(measured.directCommits.has("alpha")).toBe(true);
    // It permits the one figure and says nothing about the merge walk.
    expect(measured.pullRequests.has("alpha")).toBe(false);
  });

  it("should hold the repository's own spelling when the declared name is cased differently", () => {
    // The configured name is typed by hand and the repository's is not, and both readers of this set look the
    // repository up by its own spelling.
    const measured = measuredSources(edges({}), ANCHOR, [entry("PCS-API")], ["pcs-api"]);

    expect([...measured.directCommits]).toEqual(["PCS-API"]);
  });

  it("should leave a declared name matching no cohort repository out of the set", () => {
    const measured = measuredSources(edges({}), ANCHOR, [entry("alpha")], ["beta"]);

    expect(measured.directCommits.size).toBe(0);
  });
});
