import { describe, expect, it } from "vitest";
import { CVE_PAGE_SIZE, cveDocumentQuery, cveDocumentsFrom } from "./documents.ts";

/**
 * What the container is asked for, and how a page of its answers is read.
 *
 * TESTED OVER AN INJECTED PAGE SOURCE, which needs no Cosmos account: the paging and the per-document guard are
 * decisions, and they were inside the driver call until this module existed.
 */

/** Pages as the driver hands them over, so a case can state a page boundary rather than only a flat list. */
async function* pagesOf(...pages: unknown[][]): AsyncGenerator<unknown[]> {
  for (const page of pages) {
    yield page;
  }
}

async function collected(pages: AsyncIterable<unknown[]>, database = "jenkins") {
  const documents = [];
  for await (const document of cveDocumentsFrom(pages, database)) {
    documents.push(document);
  }
  return documents;
}

describe("the query one database is read with", () => {
  it("should ask for master only, because four fifths of the container describes pull-request branches", () => {
    const query = cveDocumentQuery(undefined);

    expect(query.query).toContain("c.build.branch_name = @branch");
    expect(query.parameters).toEqual([{ name: "@branch", value: "master" }]);
  });

  it("should select the report body, because that is what the findings are parsed out of", () => {
    // It cannot be projected away, which is the whole reason the read is paged rather than fetched whole.
    expect(cveDocumentQuery(undefined).query).toContain("c.report");
  });

  it("should read from the watermark inclusively when one is given", () => {
    // `>=` and not `>`: `_ts` is second-granular, so a strict comparison would skip a document written in the
    // boundary second for ever. Re-reading that second is a no-op, because the write is an upsert.
    const query = cveDocumentQuery(1_789_726_965);

    expect(query.query).toContain("c._ts >= @from");
    expect(query.parameters).toEqual([
      { name: "@branch", value: "master" },
      { name: "@from", value: 1_789_726_965 }
    ]);
  });

  it("should carry no watermark predicate at all when there is nothing stored yet", () => {
    expect(cveDocumentQuery(undefined).query).not.toContain("@from");
  });

  it("should page small, because a page is this job's memory ceiling", () => {
    expect(CVE_PAGE_SIZE).toBe(100);
  });
});

describe("reading pages of documents", () => {
  it("should yield every document across every page, naming the database it came from", async () => {
    const documents = await collected(
      pagesOf(
        [{ _ts: 1, git_url: "https://github.com/hmcts/a.git", codebase_type: "java", build_tag: "t1", report: { dependencies: [] } }],
        [{ _ts: 2, git_url: "https://github.com/hmcts/b.git", codebase_type: "node", report: { vulnerabilities: [] } }]
      ),
      "sds-jenkins"
    );

    expect(documents).toHaveLength(2);
    expect(documents[0]).toEqual({
      database: "sds-jenkins",
      ts: 1,
      gitUrl: "https://github.com/hmcts/a.git",
      codebaseType: "java",
      buildTag: "t1",
      report: { dependencies: [] }
    });
    expect(documents[1]?.ts).toBe(2);
  });

  it("should leave out a document with no _ts rather than dating it now", async () => {
    // Dating it now would make it the newest report for its repository for ever, so no later build could
    // replace it — a stale scan pinned in place by the act of reading it.
    const documents = await collected(pagesOf([{ git_url: "https://github.com/hmcts/a.git", codebase_type: "java" }, { _ts: 5 }]));

    expect(documents).toHaveLength(1);
    expect(documents[0]?.ts).toBe(5);
  });

  it("should leave out a document whose _ts is not a number", async () => {
    expect(await collected(pagesOf([{ _ts: "1789726965" }, { _ts: null }]))).toEqual([]);
  });

  it("should carry the fields through untouched, because interpreting them is the parser's job", async () => {
    // A `git_url` this cannot attribute and a `codebase_type` with no parser are both decisions made later, by
    // `repositoryFromGitUrl` and `cveFindings` — so nothing is filtered here on either.
    const documents = await collected(pagesOf([{ _ts: 1, git_url: "https://gitlab.com/x.git", codebase_type: "dotnet" }]));

    expect(documents[0]).toMatchObject({ gitUrl: "https://gitlab.com/x.git", codebaseType: "dotnet" });
  });

  it("should read nothing when the container answered with no pages at all", async () => {
    expect(await collected(pagesOf())).toEqual([]);
  });

  it("should read nothing when a page came back empty", async () => {
    expect(await collected(pagesOf([], []))).toEqual([]);
  });
});
