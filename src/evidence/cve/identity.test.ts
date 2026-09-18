import { describe, expect, it } from "vitest";
import { repositoryFromGitUrl } from "./identity.ts";

/**
 * Attributing a published report to a repository, which is the only thing `build.git_url` is for.
 *
 * THE `.git` SUBSTRING CASE IS THE ONE THAT MATTERS. The existing ingestion SQL replaces `.git` anywhere in the
 * URL, and a repository whose name contains it is silently attributed to a name that does not exist.
 */

describe("reading a repository out of build.git_url", () => {
  it("should read the owner and the repository when given the form every real document carries", () => {
    expect(repositoryFromGitUrl("https://github.com/HMCTS/idam-web-public.git")).toEqual({ organization: "hmcts", repository: "idam-web-public" });
  });

  it("should casefold the owner when the document spells it differently from the organisation graph", () => {
    // Every `master` document spells it `HMCTS` and the graph spells it `hmcts`; without the fold the row read
    // finds nothing.
    expect(repositoryFromGitUrl("https://github.com/HMCTS/PCS-API.git")).toEqual({ organization: "hmcts", repository: "pcs-api" });
  });

  it("should strip .git as a suffix only when the repository name also contains it", () => {
    expect(repositoryFromGitUrl("https://github.com/hmcts/foo.github.io.git")).toEqual({ organization: "hmcts", repository: "foo.github.io" });
  });

  it("should read a repository whose URL carries no .git suffix at all", () => {
    expect(repositoryFromGitUrl("https://github.com/hmcts/pcs-api")).toEqual({ organization: "hmcts", repository: "pcs-api" });
  });

  it("should rewrite an SSH remote when Jenkins was checked out over SSH", () => {
    expect(repositoryFromGitUrl("git@github.com:hmcts/pcs-api.git")).toEqual({ organization: "hmcts", repository: "pcs-api" });
  });

  it("should rewrite a git-protocol remote when one is published", () => {
    expect(repositoryFromGitUrl("git://github.com/hmcts/pcs-api.git")).toEqual({ organization: "hmcts", repository: "pcs-api" });
  });

  it("should ignore surrounding whitespace when the stored URL carries any", () => {
    expect(repositoryFromGitUrl("  https://github.com/hmcts/pcs-api.git\n")).toEqual({ organization: "hmcts", repository: "pcs-api" });
  });

  it("should report nothing when the remote is not a GitHub repository", () => {
    // Attributing this to a plausible name would put one repository's findings on another's row.
    expect(repositoryFromGitUrl("https://gitlab.com/hmcts/pcs-api.git")).toBeUndefined();
  });

  it("should report nothing when the URL names an owner but no repository", () => {
    expect(repositoryFromGitUrl("https://github.com/hmcts")).toBeUndefined();
  });

  it("should report nothing when the URL carries a path deeper than a repository", () => {
    expect(repositoryFromGitUrl("https://github.com/hmcts/pcs-api/tree/master")).toBeUndefined();
  });

  it("should report nothing when the field is absent or is not a string", () => {
    expect(repositoryFromGitUrl(undefined)).toBeUndefined();
    expect(repositoryFromGitUrl(null)).toBeUndefined();
    expect(repositoryFromGitUrl(42)).toBeUndefined();
  });
});
