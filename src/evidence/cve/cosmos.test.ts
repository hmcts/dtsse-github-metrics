import { describe, expect, it } from "vitest";
import { CVE_ACCOUNT_VARIABLE, CVE_KEY_VARIABLE, cveCredentials } from "./cosmos.ts";

/**
 * Whether this process was given a Cosmos account to read.
 *
 * THE ONLY TESTABLE PART OF THE READER. Everything below `cveCredentials` is a driver call against a production
 * account, so the module is excluded from coverage for `store/**`'s reason; this function is where a
 * misconfiguration is either caught or turned into a silent no-op, so it is tested here.
 */

describe("resolving the Cosmos credential", () => {
  it("should build the account endpoint when both secrets are mounted", () => {
    const credentials = cveCredentials({ [CVE_ACCOUNT_VARIABLE]: "pipeline-metrics", [CVE_KEY_VARIABLE]: "a-key" });

    expect(credentials?.endpoint).toBe("https://pipeline-metrics.documents.azure.com:443/");
  });

  it("should trim the mounted values, because a properties volume writes a file and files gain newlines", () => {
    const credentials = cveCredentials({ [CVE_ACCOUNT_VARIABLE]: " pipeline-metrics\n", [CVE_KEY_VARIABLE]: " a-key\n" });

    expect(credentials).toEqual({ endpoint: "https://pipeline-metrics.documents.azure.com:443/", key: "a-key" });
  });

  it("should report nothing when the account name is missing, so the run reports it rather than reading nothing quietly", () => {
    expect(cveCredentials({ [CVE_KEY_VARIABLE]: "a-key" })).toBeUndefined();
  });

  it("should report nothing when the key is missing", () => {
    expect(cveCredentials({ [CVE_ACCOUNT_VARIABLE]: "pipeline-metrics" })).toBeUndefined();
  });

  it("should report nothing when either value is mounted blank", () => {
    // A key vault reference that resolved to an empty file satisfies "the variable is set" and authenticates
    // nothing, so it has to be the same answer as absent.
    expect(cveCredentials({ [CVE_ACCOUNT_VARIABLE]: "   ", [CVE_KEY_VARIABLE]: "a-key" })).toBeUndefined();
    expect(cveCredentials({ [CVE_ACCOUNT_VARIABLE]: "pipeline-metrics", [CVE_KEY_VARIABLE]: "" })).toBeUndefined();
  });
});
