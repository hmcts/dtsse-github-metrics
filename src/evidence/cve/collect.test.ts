import { describe, expect, it } from "vitest";
import { type CveDocument, cveFolder, foldCveDocuments, readFrom } from "./collect.ts";

/**
 * Folding a stream of published reports into one scan per repository per language.
 *
 * WHAT IS DROPPED IS AS IMPORTANT AS WHAT IS KEPT, so the skip counts are asserted rather than the scans alone: a
 * report nothing can attribute or nothing can read must leave its repository UNMEASURED, and a run that says how
 * many it dropped is the only way anybody finds out that a fourth builder has started publishing.
 */

function document(overrides: Partial<CveDocument> = {}): CveDocument {
  return {
    database: "jenkins",
    ts: 1_789_726_965,
    gitUrl: "https://github.com/HMCTS/pcs-api.git",
    codebaseType: "java",
    buildTag: "jenkins-HMCTS-pcs-api-master-1",
    report: { dependencies: [] },
    ...overrides
  };
}

describe("folding published reports into scans", () => {
  it("should keep the newest report when a repository has built many times", () => {
    const { scans } = foldCveDocuments([
      document({ ts: 1000, buildTag: "old" }),
      document({ ts: 3000, buildTag: "newest" }),
      document({ ts: 2000, buildTag: "middle" })
    ]);

    expect(scans).toHaveLength(1);
    expect(scans[0]?.buildTag).toBe("newest");
    expect(scans[0]?.reportedAt).toEqual(new Date(3_000_000));
  });

  it("should keep the first of two reports written in the same second, so a re-run folds the same way", () => {
    const { scans } = foldCveDocuments([document({ ts: 1000, buildTag: "first" }), document({ ts: 1000, buildTag: "second" })]);

    expect(scans[0]?.buildTag).toBe("first");
  });

  it("should keep one scan per language when a repository publishes two reports", () => {
    // Neither supersedes the other: a java report says nothing about the repository's JavaScript dependencies.
    const { scans } = foldCveDocuments([
      document({ codebaseType: "java", ts: 1000 }),
      document({ codebaseType: "node", ts: 2000, report: { vulnerabilities: [], summary: {} } })
    ]);

    expect(scans.map((scan) => scan.codebaseType).sort()).toEqual(["java", "node"]);
  });

  it("should casefold the repository name when the document spells the owner differently", () => {
    const { scans } = foldCveDocuments([document({ gitUrl: "https://github.com/HMCTS/PCS-API.git" })]);

    expect(scans[0]).toMatchObject({ organization: "hmcts", repository: "pcs-api" });
  });

  it("should record which database answered when a report comes from the SDS estate", () => {
    const { scans } = foldCveDocuments([document({ database: "sds-jenkins" })]);

    expect(scans[0]?.sourceDatabase).toBe("sds-jenkins");
  });

  it("should record a scan with no findings when a report found nothing, which is a measured zero", () => {
    const { scans } = foldCveDocuments([document({ report: { dependencies: [] } })]);

    expect(scans).toHaveLength(1);
    expect(scans[0]?.findings).toEqual([]);
  });

  it("should count a report it cannot attribute and record no scan for it", () => {
    const { scans, skipped } = foldCveDocuments([document({ gitUrl: "https://gitlab.com/hmcts/pcs-api.git" })]);

    expect(scans).toEqual([]);
    expect(skipped.unattributable).toBe(1);
  });

  it("should record no scan when the codebase type has no parser, so the repository stays unmeasured", () => {
    // The whole point: a fourth publishing builder must not make its repositories look clean on the day it lands.
    const { scans, skipped } = foldCveDocuments([document({ codebaseType: "dotnet" })]);

    expect(scans).toEqual([]);
    expect(skipped.unreadable).toBe(1);
    expect(skipped.unreadableTypes).toEqual(["dotnet"]);
  });

  it("should name every unparseable codebase type once when several appear", () => {
    const { skipped } = foldCveDocuments([
      document({ codebaseType: "dotnet" }),
      document({ codebaseType: "dotnet" }),
      document({ codebaseType: "go" }),
      document({ codebaseType: 42 })
    ]);

    expect(skipped.unreadable).toBe(4);
    expect(skipped.unreadableTypes).toEqual(["(absent)", "dotnet", "go"]);
  });

  it("should omit the build tag when a document carries none rather than storing a placeholder", () => {
    const { scans } = foldCveDocuments([document({ buildTag: undefined })]);

    expect(scans[0]).not.toHaveProperty("buildTag");
  });

  it("should deduplicate one report's findings so the store's key is never violated", () => {
    const { scans } = foldCveDocuments([
      document({
        report: {
          dependencies: [
            { fileName: "a.jar", vulnerabilities: [{ name: "CVE-1", cvssv3: { baseSeverity: "LOW" } }], suppressedVulnerabilities: [] },
            { fileName: "a.jar", vulnerabilities: [{ name: "CVE-1", cvssv3: { baseSeverity: "CRITICAL" } }], suppressedVulnerabilities: [] }
          ]
        }
      })
    ]);

    expect(scans[0]?.findings).toEqual([{ identifier: "CVE-1", package: "a.jar", suppressed: false, severity: "critical" }]);
  });

  it("should report nothing at all when there are no documents to fold", () => {
    expect(foldCveDocuments([])).toEqual({ scans: [], skipped: { unattributable: 0, unreadable: 0, unreadableTypes: [] } });
  });
});

describe("folding documents as they stream", () => {
  it("should keep no report body once a document has been folded, which is what bounds the accumulator", () => {
    // Buffering the read instead reached 3.7 GB of RSS against a 1Gi CronJob limit. The parsed finding is the
    // only thing retained, and a superseded document's is replaced rather than kept beside it.
    const folder = cveFolder();
    folder.add(document({ ts: 1000, report: { dependencies: [] } }));
    folder.add(document({ ts: 2000, report: { dependencies: [] } }));

    const { scans } = folder.fold();
    expect(scans).toHaveLength(1);
    expect(scans[0]).not.toHaveProperty("report");
  });

  it("should report the fold so far without ending it, so a caller may read it while streaming", () => {
    const folder = cveFolder();
    folder.add(document({ gitUrl: "https://github.com/hmcts/a.git" }));
    expect(folder.fold().scans).toHaveLength(1);

    folder.add(document({ gitUrl: "https://github.com/hmcts/b.git" }));
    expect(folder.fold().scans).toHaveLength(2);
  });
});

describe("where an incremental read starts", () => {
  it("should read everything when nothing has been stored yet", () => {
    expect(readFrom(undefined)).toBeUndefined();
  });

  it("should re-read the watermark's own second, so a document written in it is not skipped for ever", () => {
    // Cosmos `_ts` is second-granular and the predicate is `>=`; re-reading is harmless because the write is an
    // upsert keyed on the repository and its language.
    expect(readFrom(new Date(1_789_726_965_400))).toBe(1_789_726_965);
  });
});
