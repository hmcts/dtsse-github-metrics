/**
 * Which repository a published CVE report is about.
 *
 * THERE IS NO REPOSITORY FIELD. `CVEPublisher.publishCVEReport` stores `build.git_url` and nothing else that
 * names the repository, so every report has to be attributed by parsing a remote URL. That makes this module the
 * single point where the whole collection can quietly attribute findings to the wrong repository, or to none.
 */

/** GitHub owner and repository, both casefolded, as the store keys them. */
export interface RepositoryIdentity {
  organization: string;
  repository: string;
}

const HTTPS_GITHUB_PREFIX = "https://github.com/";
const HTTPS_GITHUB = /^https:\/\/github\.com\/[^/]+\/[^/]+$/;

/**
 * One `build.git_url` read as an owner and a repository, or nothing for a URL this cannot attribute.
 *
 * `.git` IS STRIPPED AS A SUFFIX AND NOT AS A SUBSTRING, which is the one correctness detail here. The existing
 * SQL in `hmcts/dtsse-dashboard-ingestion` does `replace(git_url, '.git', '')` for the node report, and that
 * turns `https://github.com/hmcts/foo.github.io.git` into `https://github.com/hmcts/foohubio` — a repository
 * name that matches nothing, so its findings are attributed to a repository that does not exist and the real one
 * reads unmeasured. Anchoring the pattern is the whole fix.
 *
 * NOTHING FOR A URL THIS DOES NOT RECOGNISE, and never a guess. A remote that is not a GitHub repository URL is
 * a report nothing can attribute, and attributing it to a plausible name would put another repository's findings
 * on a row. The caller counts these and says how many it dropped rather than letting them vanish.
 *
 * THE TWO SSH AND GIT-PROTOCOL REWRITES ARE DEFENSIVE AND ARE NOT EXERCISED BY TODAY'S DATA. All 158,641
 * `master` documents in the `jenkins` database carry an `https://github.com/…` URL ending `.git`, measured
 * 2026-09-18. They are here because the URL is whatever Jenkins was checked out with, which is a pipeline
 * configuration rather than a guarantee, and because a report silently dropped is a repository reading
 * unmeasured for a reason nobody would look for.
 */
export function repositoryFromGitUrl(gitUrl: unknown): RepositoryIdentity | undefined {
  if (typeof gitUrl !== "string") {
    return undefined;
  }
  const normalised = gitUrl
    .trim()
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/^git:\/\/github\.com\//, "https://github.com/")
    .replace(/\.git$/, "")
    .toLowerCase();
  if (!HTTPS_GITHUB.test(normalised)) {
    return undefined;
  }
  // The pattern admits exactly one slash after the prefix, between two non-empty segments, so the owner is
  // everything before it and the repository everything after. Slicing rather than reading capture groups keeps
  // both typed as strings without a guard for a group that cannot be missing.
  const path = normalised.slice(HTTPS_GITHUB_PREFIX.length);
  const slash = path.indexOf("/");
  return { organization: path.slice(0, slash), repository: path.slice(slash + 1) };
}
