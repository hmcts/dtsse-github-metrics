import { describe, expect, it } from "vitest";
import { cveFindings, distinctFindings, parseable } from "./reports.ts";

/**
 * Reading the three published report shapes.
 *
 * THE FIXTURES BELOW ARE CUT FROM REAL DOCUMENTS in the `jenkins` database, read 2026-09-18, with the
 * descriptions and reference lists trimmed. Where a field surprised, the surprise is asserted here: the java
 * entry's own `severity` disagreeing with `cvssv3.baseSeverity`, the suppressed entry carrying no `severity` at
 * all, the node entry carrying `severity: null`, and the python report carrying no severity concept.
 */

const JAVA_REPORT = {
  dependencies: [
    {
      fileName: "angus-activation-2.0.3.jar",
      vulnerabilities: [
        // `severity: MEDIUM` and `cvssv3.baseSeverity: HIGH` in the same entry: the entry's own field follows
        // CVSS 4.0 where there is a v4 vector. CVSS v3 is what the suppressed side also carries.
        { name: "CVE-2025-7962", severity: "MEDIUM", cvssv3: { baseSeverity: "HIGH", baseScore: 7.5 }, cvssv4: { baseSeverity: "MEDIUM" } }
      ],
      suppressedVulnerabilities: []
    },
    {
      fileName: "commons-configuration-1.8.jar",
      vulnerabilities: [],
      // NO `severity` FIELD, which is true of all 2,499,605 suppressed findings in the database.
      suppressedVulnerabilities: [{ name: "CVE-2025-46392", cvssv3: { baseSeverity: "MEDIUM", baseScore: 6.5 } }]
    },
    {
      fileName: "legacy-1.0.jar",
      // Only CVSS v2, which 726 live findings in the database are graded by and nothing else.
      vulnerabilities: [{ name: "CVE-2014-0114", cvssv2: { severity: "HIGH", score: 7.5 } }],
      suppressedVulnerabilities: []
    },
    {
      fileName: "ungraded-1.0.jar",
      // Neither CVSS block, which 10 live findings in the database carry. Unknown, and never `low`.
      vulnerabilities: [{ name: "CVE-2099-0001" }],
      suppressedVulnerabilities: []
    }
  ]
};

const NODE_REPORT = {
  vulnerabilities: [
    { title: "a", cves: ["CVE-2026-1111"], severity: "moderate", cvss: { score: 7.5 }, module_name: "uuid", url: "https://github.com/advisories/GHSA-a" },
    // An advisory with no CVE assigned, graded. Named by its URL, and NOT dropped.
    { title: "b", cves: [], severity: "low", cvss: null, module_name: "lodash", url: "https://github.com/advisories/GHSA-b" },
    // THE PLACEHOLDER `YarnBuilder` EMITS ABOUT ONCE PER REPORT, verbatim from `rpx-xui-approve-org`'s latest
    // scan, where it is 1 of 18 entries. All nine fields null: not an ungraded finding, and not a finding at all.
    {
      title: null,
      cves: null,
      vulnerable_versions: null,
      patched_versions: null,
      severity: null,
      cwe: null,
      cvss: null,
      url: null,
      module_name: null
    }
  ],
  suppressed: [
    { title: "c", cves: ["CVE-2026-41907"], severity: "critical", cvss: { score: 9.8 }, module_name: "tar", url: "https://github.com/advisories/GHSA-c" }
  ],
  summary: {}
};

const PYTHON_REPORT = {
  vulnerabilities: [
    {
      summary: "AIOHTTP: Out-of-bounds heap read",
      fix_versions: ["3.14.3"],
      installed: "3.14.1",
      aliases: ["CVE-2026-69244", "PYSEC-2026-3545"],
      package: "aiohttp",
      dependency: { name: "aiohttp", version: "3.14.1" },
      display_id: "GHSA-cq5v-8q36-5273",
      id: "GHSA-cq5v-8q36-5273"
    }
  ]
};

describe("which reports can be read at all", () => {
  it("should name the three codebase types a CNP builder publishes when asked", () => {
    expect(parseable("java")).toBe(true);
    expect(parseable("node")).toBe(true);
    expect(parseable("python")).toBe(true);
  });

  it("should report nothing when the codebase type has no parser, so the repository stays unmeasured", () => {
    // NOT an empty list. An empty list is a clean scan, which is the most misleading answer available for a
    // report nothing here understands.
    expect(cveFindings("dotnet", { vulnerabilities: [] })).toBeUndefined();
    expect(cveFindings(undefined, {})).toBeUndefined();
  });

  it("should report nothing when the report is not an object, so a malformed document is not a clean scan", () => {
    expect(cveFindings("java", null)).toBeUndefined();
    expect(cveFindings("java", "not a report")).toBeUndefined();
    expect(cveFindings("java", [])).toBeUndefined();
  });

  it("should report an empty list when a scan ran and found nothing, which is a measured zero", () => {
    expect(cveFindings("java", { dependencies: [] })).toEqual([]);
    expect(cveFindings("node", { vulnerabilities: [], summary: {} })).toEqual([]);
    expect(cveFindings("python", { vulnerabilities: [] })).toEqual([]);
  });
});

describe("reading an OWASP dependency-check report", () => {
  const findings = cveFindings("java", JAVA_REPORT) ?? [];

  it("should grade a live finding by CVSS v3 and not by the entry's own severity field", () => {
    // `severity` says MEDIUM; v3 says HIGH. v3 is the field the suppressed side also carries, so it is the only
    // one that makes the two figures comparable.
    expect(findings.find((finding) => finding.identifier === "CVE-2025-7962")).toEqual({
      identifier: "CVE-2025-7962",
      package: "angus-activation-2.0.3.jar",
      suppressed: false,
      severity: "high",
      score: 7.5
    });
  });

  it("should grade a suppressed finding even though it carries no severity field of its own", () => {
    expect(findings.find((finding) => finding.identifier === "CVE-2025-46392")).toEqual({
      identifier: "CVE-2025-46392",
      package: "commons-configuration-1.8.jar",
      suppressed: true,
      severity: "medium",
      score: 6.5
    });
  });

  it("should fall back to CVSS v2 when a finding carries no v3 block", () => {
    expect(findings.find((finding) => finding.identifier === "CVE-2014-0114")).toMatchObject({ severity: "high", score: 7.5 });
  });

  it("should leave severity absent when a finding carries neither CVSS block, rather than reading it as low", () => {
    const ungraded = findings.find((finding) => finding.identifier === "CVE-2099-0001");
    expect(ungraded).toEqual({ identifier: "CVE-2099-0001", package: "ungraded-1.0.jar", suppressed: false });
    expect(ungraded).not.toHaveProperty("severity");
  });

  it("should skip an entry with no name or no dependency file, because neither can be keyed", () => {
    const parsed = cveFindings("java", {
      dependencies: [
        { fileName: "a.jar", vulnerabilities: [{ cvssv3: { baseSeverity: "HIGH" } }], suppressedVulnerabilities: [] },
        { vulnerabilities: [{ name: "CVE-2026-0001" }], suppressedVulnerabilities: [] },
        "not a dependency",
        { fileName: "b.jar", vulnerabilities: ["not an entry"], suppressedVulnerabilities: [] }
      ]
    });
    expect(parsed).toEqual([]);
  });
});

describe("reading a yarn audit report", () => {
  const findings = cveFindings("node", NODE_REPORT) ?? [];

  it("should fold moderate to medium, which is most of what the node estate reports", () => {
    expect(findings.find((finding) => finding.package === "uuid")).toEqual({
      identifier: "CVE-2026-1111",
      package: "uuid",
      suppressed: false,
      severity: "medium",
      score: 7.5
    });
  });

  it("should drop the entirely-null placeholder entry rather than counting it as an ungraded finding", () => {
    // It names no CVE and no package, so it is not a finding. Counting it would put one phantom CVE on every
    // node repository on the estate; counting it as ungraded would hide that phantom in the unknown band.
    expect(findings).toHaveLength(3);
    expect(findings.every((finding) => finding.identifier !== "" && finding.package !== "")).toBe(true);
  });

  it("should leave severity absent when a graded entry carries none, rather than reading it as low", () => {
    const ungraded = cveFindings("node", { vulnerabilities: [{ cves: ["CVE-2026-9999"], module_name: "ws", severity: null }] }) ?? [];
    expect(ungraded).toEqual([{ identifier: "CVE-2026-9999", package: "ws", suppressed: false }]);
    expect(ungraded[0]).not.toHaveProperty("severity");
  });

  it("should read report.suppressed as the suppressed side, which is where yarn audit puts accepted findings", () => {
    expect(findings.find((finding) => finding.package === "tar")).toEqual({
      identifier: "CVE-2026-41907",
      package: "tar",
      suppressed: true,
      severity: "critical",
      score: 9.8
    });
  });

  it("should name a finding by its advisory URL when no CVE has been assigned to it", () => {
    expect(findings.find((finding) => finding.package === "lodash")?.identifier).toBe("https://github.com/advisories/GHSA-b");
  });

  it("should skip an entry with neither a CVE nor a URL, because there is nothing to key it by", () => {
    expect(cveFindings("node", { vulnerabilities: [{ module_name: "orphan", severity: "high" }, "not an entry"] })).toEqual([]);
  });

  it("should skip an entry naming no module, because a finding against nothing cannot be reported", () => {
    expect(cveFindings("node", { vulnerabilities: [{ cves: ["CVE-2026-2222"], severity: "high" }] })).toEqual([]);
  });
});

describe("reading a uv audit report", () => {
  const findings = cveFindings("python", PYTHON_REPORT) ?? [];

  it("should record a finding with no severity, because uv audit states none", () => {
    expect(findings).toEqual([{ identifier: "GHSA-cq5v-8q36-5273", package: "aiohttp", suppressed: false }]);
    expect(findings[0]).not.toHaveProperty("severity");
  });

  it("should record every finding as live, because uv audit has no suppression concept to report", () => {
    // A measured zero suppressed, which is true: there is nothing to suppress with.
    expect(findings.every((finding) => !finding.suppressed)).toBe(true);
  });

  it("should fall back to the CVE alias when a finding carries no GHSA identifier", () => {
    const parsed = cveFindings("python", { vulnerabilities: [{ aliases: ["CVE-2026-3333"], package: "requests" }] });
    expect(parsed).toEqual([{ identifier: "CVE-2026-3333", package: "requests", suppressed: false }]);
  });

  it("should fall back to the dependency name when a finding names no package", () => {
    const parsed = cveFindings("python", { vulnerabilities: [{ id: "GHSA-x", dependency: { name: "urllib3" } }] });
    expect(parsed).toEqual([{ identifier: "GHSA-x", package: "urllib3", suppressed: false }]);
  });

  it("should skip an entry with no identifier or no package at all", () => {
    expect(cveFindings("python", { vulnerabilities: [{ package: "nameless" }, { id: "GHSA-y" }, "not an entry"] })).toEqual([]);
  });
});

describe("deduplicating one report's findings", () => {
  it("should keep one row when the same CVE is listed twice against the same package", () => {
    const deduplicated = distinctFindings([
      { identifier: "CVE-1", package: "a.jar", suppressed: false, severity: "low" },
      { identifier: "CVE-1", package: "a.jar", suppressed: false, severity: "low" }
    ]);
    expect(deduplicated).toHaveLength(1);
  });

  it("should keep the worse grading when two listings of one finding disagree", () => {
    // The direction that cannot understate a finding.
    expect(
      distinctFindings([
        { identifier: "CVE-1", package: "a.jar", suppressed: false, severity: "low" },
        { identifier: "CVE-1", package: "a.jar", suppressed: false, severity: "critical" }
      ])
    ).toEqual([{ identifier: "CVE-1", package: "a.jar", suppressed: false, severity: "critical" }]);
  });

  it("should prefer any grading over none when one listing states no severity", () => {
    expect(
      distinctFindings([
        { identifier: "CVE-1", package: "a.jar", suppressed: false },
        { identifier: "CVE-1", package: "a.jar", suppressed: false, severity: "low" }
      ])
    ).toEqual([{ identifier: "CVE-1", package: "a.jar", suppressed: false, severity: "low" }]);
  });

  it("should keep the live and the suppressed listing apart when one CVE appears as both", () => {
    // `suppressed` is part of the key, which is what keeps a suppressed finding out of the live figure.
    expect(
      distinctFindings([
        { identifier: "CVE-1", package: "a.jar", suppressed: false, severity: "high" },
        { identifier: "CVE-1", package: "a.jar", suppressed: true, severity: "high" }
      ])
    ).toHaveLength(2);
  });

  it("should keep one CVE against two packages as two findings, because both are real", () => {
    expect(
      distinctFindings([
        { identifier: "CVE-1", package: "a.jar", suppressed: false, severity: "high" },
        { identifier: "CVE-1", package: "b.jar", suppressed: false, severity: "high" }
      ])
    ).toHaveLength(2);
  });
});
