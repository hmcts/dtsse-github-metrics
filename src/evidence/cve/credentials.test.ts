import { describe, expect, it } from "vitest";
import { CVE_ACCOUNT_VARIABLE, CVE_KEY_VARIABLE, cveCredentials } from "./credentials.ts";

/**
 * Whether this process was given a Cosmos account to read.
 *
 * WHERE A MISCONFIGURATION IS CAUGHT OR TURNED INTO A SILENT NO-OP, which is why it is a module of its own. It
 * used to live inside `./cosmos.ts`, excluded from coverage because that file is a driver call — so the one
 * decision in it that a test can reach was hidden along with the part that cannot be.
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
