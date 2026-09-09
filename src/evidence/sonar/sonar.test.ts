import { beforeEach, describe, expect, it, vi } from "vitest";
import { AvailabilityReason } from "../domain/availability.ts";
import { ratingLetter, SonarGateLevel, SonarResolutionMethod, type StoredSonarMapping } from "../domain/sonar.ts";
import { createGitHubClient } from "../github/client.ts";
import { personalAccessToken } from "../github/credentials.ts";
import { createSonarClient, SonarError, searchableRevisions } from "./client.ts";
import { declaredProject, gateLevel, measuredCount, measuredGate, measuredNumber, measuredRating, parseMeasures, parseProperties } from "./measures.ts";
import { createCallPacer } from "./pacer.ts";
import { checkDeclaration, confirmsCandidate, declaredKey, mappedProject, namesRepository, resolveRepositoryProject } from "./resolve.ts";

// Ported from tests/test_sonar.py.

function replying(...replies: { status?: number; body?: unknown }[]): typeof globalThis.fetch {
  const queue = [...replies];
  return vi.fn(() => {
    const next = queue.shift() ?? { status: 200, body: {} };
    return Promise.resolve(
      new Response(typeof next.body === "string" ? next.body : JSON.stringify(next.body ?? {}), {
        status: next.status ?? 200,
        headers: { "content-type": "application/json" }
      })
    );
  }) as unknown as typeof globalThis.fetch;
}

function githubClient(fetch: typeof globalThis.fetch) {
  return createGitHubClient({ credentials: personalAccessToken("ghp_test"), fetch, pause: () => Promise.resolve(), clock: () => 1000 });
}

function values(entries: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(entries));
}

/** Awaits a read that must fail, and hands back the SonarError it failed with. */
async function failing(work: Promise<unknown>): Promise<SonarError> {
  const outcome = await work.then(
    () => undefined,
    (thrown: unknown) => thrown
  );
  expect(outcome).toBeInstanceOf(SonarError);
  return outcome as SonarError;
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "debug").mockImplementation(() => undefined);
  // The client writes its per-call progress to stderr rather than through `console`, so that a command whose
  // product is a document can have stdout redirected. Silenced the same way, and here rather than globally:
  // a test that means to assert on stderr should have to say so.
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

describe("ratingLetter", () => {
  it.each([
    [1, "A"],
    [3, "C"],
    [5, "E"]
  ])("should name %f as %s", (value, expected) => {
    expect(ratingLetter({ value })).toBe(expected);
  });

  it.each([[0], [6], [2.5]])("should report no letter for the off-scale %f", (value) => {
    // A rating this build does not understand must not be reported as the best one, which is what defaulting
    // to A would do.
    expect(ratingLetter({ value })).toBeUndefined();
  });
});

describe("gateLevel", () => {
  it.each([
    ["OK", SonarGateLevel.Ok],
    ["ERROR", SonarGateLevel.Error],
    // SonarCloud's own value for a project created and never analysed: a third answer, not a failure.
    ["NONE", SonarGateLevel.None]
  ])("should read %s as %s", (value, expected) => {
    expect(gateLevel(value)).toBe(expected);
  });

  it("should report no gate for a level this build does not know, rather than a passing one", () => {
    expect(gateLevel("WARN")).toBeUndefined();
  });
});

describe("measuredNumber", () => {
  it("should read a numeric measure SonarCloud sent as a string", () => {
    expect(measuredNumber(values({ coverage: "87.4" }), "coverage")).toBe(87.4);
  });

  it.each([
    [{}, "coverage"],
    [{ coverage: "not a number" }, "coverage"]
  ])("should report absent rather than zero for %o", (entries, key) => {
    // A rendered 0.0% would be a claim about the code rather than about the measurement.
    expect(measuredNumber(values(entries), key)).toBeUndefined();
  });
});

describe("measuredCount", () => {
  it("should truncate a count SonarCloud sent as a decimal string", () => {
    expect(measuredCount(values({ ncloc: "1234.0" }), "ncloc")).toBe(1234);
  });
});

describe("measuredRating", () => {
  it("should keep the number the letter is derived from", () => {
    expect(measuredRating(values({ security_rating: "3.0" }), "security_rating")).toEqual({ value: 3 });
  });
});

describe("measuredGate", () => {
  it("should prefer the details, which carry every condition behind the verdict", () => {
    const details = JSON.stringify({ level: "ERROR", conditions: [{ metric: "coverage", level: "ERROR", op: "LT", error: "80", actual: "42.1" }] });

    const gate = measuredGate(values({ alert_status: "ERROR", quality_gate_details: details }));

    expect(gate?.level).toBe(SonarGateLevel.Error);
    expect(gate?.conditions).toEqual([{ metric: "coverage", level: "ERROR", comparator: "LT", errorThreshold: "80", actual: "42.1" }]);
  });

  it("should degrade to the bare verdict when the details cannot be read", () => {
    const gate = measuredGate(values({ alert_status: "OK", quality_gate_details: "not json" }));

    expect(gate).toEqual({ level: SonarGateLevel.Ok });
  });

  it("should report no gate at all when neither key was sent", () => {
    expect(measuredGate(values({}))).toBeUndefined();
  });
});

describe("parseMeasures", () => {
  it("should keep every absence an absence", () => {
    const measures = parseMeasures("hmcts.cath", [{ metric: "coverage", value: "91.2" }], new Date("2026-08-08T00:00:00Z"));

    expect(measures.coverage).toBe(91.2);
    expect(measures.violations).toBeUndefined();
    expect(measures.securityRating).toBeUndefined();
    expect(measures.gate).toBeUndefined();
  });

  it("should ignore a measure sent with no value", () => {
    expect(parseMeasures("hmcts.cath", [{ metric: "coverage" }], undefined).coverage).toBeUndefined();
  });
});

describe("parseProperties", () => {
  it("should let a later definition win, as the format specifies", () => {
    expect(parseProperties("sonar.projectKey=first\nsonar.projectKey=second\n").get("sonar.projectKey")).toBe("second");
  });

  it.each(["# sonar.projectKey=commented", "! sonar.projectKey=commented"])("should recognise the comment %s only at the start of a line", (line) => {
    expect(parseProperties(line).size).toBe(0);
  });

  it("should keep a hash inside a value, since only a leading one is a comment", () => {
    expect(parseProperties("sonar.projectKey=a#b\n").get("sonar.projectKey")).toBe("a#b");
  });

  it("should accept a colon separator as well as an equals", () => {
    expect(parseProperties("sonar.projectKey: hmcts.cath\n").get("sonar.projectKey")).toBe("hmcts.cath");
  });
});

describe("declaredProject", () => {
  it("should report nothing where the repository has no properties file", () => {
    // Absent means the file is not there, which is different from a file that declares no key.
    expect(declaredProject(undefined)).toBeUndefined();
  });

  it("should report a declaration with no key where the file exists but leaves it to the build", () => {
    const declaration = declaredProject("sonar.sources=src\n");

    expect(declaration).toEqual({});
  });

  it("should read the key and the organisation", () => {
    expect(declaredProject("sonar.projectKey=hmcts.cath\nsonar.organization=hmcts\n")).toEqual({ projectKey: "hmcts.cath", organization: "hmcts" });
  });
});

describe("createSonarClient", () => {
  it("should read one project's measures", async () => {
    const fetch = replying({ body: { component: { key: "hmcts.cath", measures: [{ metric: "coverage", value: "88.8" }] } } });

    const measures = await createSonarClient({ organization: "hmcts", fetch }).measures("hmcts.cath", undefined);

    expect(measures.coverage).toBe(88.8);
  });

  it("should carry a 404 as not-found, which the caller reads as a refutation", async () => {
    // 123 of one organisation's 240 declarations named a project that does not exist: stale keys, not failures.
    const fetch = replying({ status: 404, body: {} });

    const error = await failing(createSonarClient({ organization: "hmcts", fetch }).projectAnalyses("hmcts.gone", 1));

    expect(error.reason).toBe(AvailabilityReason.NotFoundOrInaccessible);
  });

  it.each([
    [401, AvailabilityReason.AuthenticationFailed],
    [403, AvailabilityReason.PermissionDenied],
    [429, AvailabilityReason.RateLimited],
    [500, AvailabilityReason.CollectionFailed]
  ])("should carry HTTP %i as %s", async (status, reason) => {
    const fetch = replying({ status, body: {} });

    const error = await failing(createSonarClient({ organization: "hmcts", fetch }).measures("hmcts.cath", undefined));

    expect(error.reason).toBe(reason);
  });

  it("should follow the project list's paging to the end", async () => {
    const fetch = replying(
      { body: { paging: { pageIndex: 1, pageSize: 1, total: 2 }, components: [{ key: "a" }] } },
      { body: { paging: { pageIndex: 2, pageSize: 1, total: 2 }, components: [{ key: "b" }] } }
    );

    expect((await createSonarClient({ organization: "hmcts", fetch }).projects()).map((project) => project.key)).toEqual(["a", "b"]);
  });
});

describe("searchableRevisions", () => {
  it("should drop an analysis carrying no revision to search for", () => {
    expect(searchableRevisions([{ analysisAt: new Date() }, { revision: "abc", analysisAt: new Date() }]).map((entry) => entry.revision)).toEqual(["abc"]);
  });
});

describe("createCallPacer", () => {
  it("should use the configured interval before any budget has been seen", () => {
    expect(createCallPacer({ interval: 6, clock: () => 1000 }).spacing()).toBe(6);
  });

  it("should spread the calls left over the time left in the window", () => {
    // The documented allowance is 30 a minute and the observed one was 10, so pacing off the live headers is
    // what stops a 403 every tenth search.
    const pacer = createCallPacer({ interval: 2, clock: () => 1000, budget: () => ({ limit: 10, remaining: 5, used: 5, resetsAt: 1060 }) });

    expect(pacer.spacing()).toBe(12);
  });

  it("should never go below the configured floor", () => {
    const pacer = createCallPacer({ interval: 6, clock: () => 1000, budget: () => ({ limit: 100, remaining: 100, used: 0, resetsAt: 1060 }) });

    expect(pacer.spacing()).toBe(6);
  });

  it("should wait out a window with nothing left", () => {
    const pacer = createCallPacer({ interval: 6, clock: () => 1000, budget: () => ({ limit: 10, remaining: 0, used: 10, resetsAt: 1060 }) });

    expect(pacer.spacing()).toBe(60);
  });

  it("should ignore a stale budget whose window has already closed", () => {
    // GitHub refills at the reset instant; the record is simply out of date, not an exhausted quota.
    const pacer = createCallPacer({ interval: 6, clock: () => 2000, budget: () => ({ limit: 10, remaining: 0, used: 10, resetsAt: 1060 }) });

    expect(pacer.spacing()).toBe(6);
  });

  it("should not pause before the first call", async () => {
    const paused: number[] = [];
    const pacer = createCallPacer({
      interval: 6,
      clock: () => 1000,
      pause: (ms) => {
        paused.push(ms);
        return Promise.resolve();
      }
    });

    await pacer.wait();

    expect(paused).toEqual([]);
  });

  it("should pause the remaining interval on a later call", async () => {
    const paused: number[] = [];
    let now = 1000;
    const pacer = createCallPacer({
      interval: 6,
      clock: () => now,
      pause: (ms) => {
        paused.push(ms);
        return Promise.resolve();
      }
    });

    await pacer.wait();
    now = 1002;
    await pacer.wait();

    expect(paused).toEqual([4000]);
  });

  it("should not stall when the wall clock is corrected backwards", async () => {
    // Flooring the elapsed time at zero is what makes this a pause rather than a hang.
    const paused: number[] = [];
    let now = 1000;
    const pacer = createCallPacer({
      interval: 6,
      clock: () => now,
      pause: (ms) => {
        paused.push(ms);
        return Promise.resolve();
      }
    });

    await pacer.wait();
    now = 400;
    await pacer.wait();

    expect(paused).toEqual([6000]);
  });
});

describe("namesRepository", () => {
  it("should fold case, since GitHub and SonarCloud names are case-insensitive", () => {
    expect(namesRepository("Cath-Service", "cath-service")).toBe(true);
    expect(namesRepository(undefined, undefined)).toBe(true);
    expect(namesRepository("a", "b")).toBe(false);
  });
});

describe("declaredKey", () => {
  it("should report the declared key", () => {
    expect(declaredKey({ projectKey: "hmcts.cath" }, "hmcts")).toEqual({ key: "hmcts.cath" });
  });

  it("should note a file that declares no key", () => {
    expect(declaredKey({}, "hmcts").note).toMatch(/declares no sonar\.projectKey/);
  });

  it("should discard a key declared for another organisation rather than testing it", () => {
    // Confirming it would attribute one organisation's quality gate to another's repository.
    const { key, note } = declaredKey({ projectKey: "other.cath", organization: "other" }, "hmcts");

    expect(key).toBeUndefined();
    expect(note).toMatch(/not hmcts/);
  });

  it("should report nothing at all where there is no declaration", () => {
    expect(declaredKey(undefined, "hmcts")).toEqual({});
  });
});

describe("confirmsCandidate", () => {
  it("should confirm a commit the repository holds", async () => {
    expect(await confirmsCandidate(githubClient(replying({ body: { sha: "abc" } })), "hmcts", "cath-service", "abc")).toBe(true);
  });

  it.each([[404], [422]])("should read HTTP %i as the repository not holding it", async (status) => {
    expect(await confirmsCandidate(githubClient(replying({ status, body: {} })), "hmcts", "cath-service", "abc")).toBe(false);
  });
});

describe("checkDeclaration", () => {
  const sonar = () => createSonarClient({ organization: "hmcts", fetch: replying({ status: 404, body: {} }) });
  const now = new Date("2026-08-08T00:00:00Z");

  it("should confirm from the map for nothing, spending no call", async () => {
    const stored: StoredSonarMapping = { projectKey: "hmcts.cath", repository: "cath-service", resolvedAt: now, revision: "abc" };

    const checked = await checkDeclaration(sonar(), githubClient(replying()), "hmcts", "cath-service", "hmcts.cath", stored, now);

    expect(checked.mapping?.method).toBe(SonarResolutionMethod.DeclaredConfirmedByMap);
    expect(checked.mapping?.revision).toBe("abc");
  });

  it("should refute as readily as it confirms, for a shared template's key", async () => {
    // 14 repositories declare one template's key and at most one of them owns it.
    const stored: StoredSonarMapping = { projectKey: "hmcts.template", repository: "the-template", resolvedAt: now };

    const checked = await checkDeclaration(sonar(), githubClient(replying()), "hmcts", "cath-service", "hmcts.template", stored, now);

    expect(checked.mapping).toBeUndefined();
    expect(checked.note).toMatch(/mapped to the-template/);
  });

  it("should confirm by commit where the map has never resolved the project", async () => {
    const sonarClient = createSonarClient({
      organization: "hmcts",
      fetch: replying({ body: { analyses: [{ revision: "abc", date: "2026-08-01T00:00:00Z" }] } })
    });

    const checked = await checkDeclaration(
      sonarClient,
      githubClient(replying({ body: { sha: "abc" } })),
      "hmcts",
      "cath-service",
      "hmcts.cath",
      undefined,
      now
    );

    expect(checked.mapping?.method).toBe(SonarResolutionMethod.DeclaredConfirmedByCommit);
    expect(checked.mapping?.revision).toBe("abc");
  });

  it("should refute a declared key SonarCloud does not list, without recording a failure", async () => {
    const checked = await checkDeclaration(sonar(), githubClient(replying()), "hmcts", "cath-service", "hmcts.gone", undefined, now);

    expect(checked.note).toMatch(/lists no project hmcts\.gone/);
    expect(checked.reason).toBeUndefined();
  });

  it("should keep the reason when the SonarCloud read was refused rather than refuted", async () => {
    const sonarClient = createSonarClient({ organization: "hmcts", fetch: replying({ status: 403, body: {} }) });

    const checked = await checkDeclaration(sonarClient, githubClient(replying()), "hmcts", "cath-service", "hmcts.cath", undefined, now);

    expect(checked.reason).toBe(AvailabilityReason.PermissionDenied);
  });

  it("should leave a project with no analysed commit unconfirmed rather than refuted", async () => {
    // Nothing was learned about it, which is not the same as learning it is wrong.
    const sonarClient = createSonarClient({ organization: "hmcts", fetch: replying({ body: { analyses: [] } }) });

    const checked = await checkDeclaration(sonarClient, githubClient(replying()), "hmcts", "cath-service", "hmcts.cath", undefined, now);

    expect(checked.note).toMatch(/no analysed commit/);
    expect(checked.reason).toBeUndefined();
  });
});

describe("mappedProject", () => {
  const now = new Date("2026-08-08T00:00:00Z");

  it("should rewrite the method to stored_map while keeping the map's own evidence", () => {
    const claimed: StoredSonarMapping = {
      projectKey: "hmcts.cath",
      repository: "cath-service",
      method: SonarResolutionMethod.DeclaredConfirmedByCommit,
      revision: "abc",
      analysisAt: new Date("2026-07-01Z"),
      resolvedAt: new Date("2026-07-01Z")
    };

    const mapping = mappedProject(claimed, 1, "cath-service", now);

    expect(mapping.method).toBe(SonarResolutionMethod.StoredMap);
    expect(mapping.revision).toBe("abc");
    expect(mapping.analysisAt?.toISOString()).toBe("2026-07-01T00:00:00.000Z");
  });
});

describe("resolveRepositoryProject", () => {
  const now = new Date("2026-08-08T00:00:00Z");

  function ladder(overrides: Partial<Parameters<typeof resolveRepositoryProject>[0]> = {}) {
    return resolveRepositoryProject({
      sonarClient: createSonarClient({ organization: "hmcts", fetch: replying({ status: 404, body: {} }) }),
      githubClient: githubClient(replying()),
      organization: "hmcts",
      sonarOrganization: "hmcts",
      repository: "cath-service",
      storedByProject: () => undefined,
      storedByRepository: () => undefined,
      now,
      ...overrides
    });
  }

  it("should let a configured override settle it, spending nothing", async () => {
    const resolved = await ladder({ configuredKey: "hmcts.override" });

    expect(resolved.mapping).toEqual({ projectKey: "hmcts.override", repository: "cath-service", method: SonarResolutionMethod.Configured, resolvedAt: now });
  });

  it("should fall back to the stored map where there is no declaration", async () => {
    const claimed: StoredSonarMapping = { projectKey: "hmcts.cath", repository: "cath-service", resolvedAt: now };

    const resolved = await ladder({ storedByRepository: () => ({ mapping: claimed, candidates: 1 }) });

    expect(resolved.mapping?.method).toBe(SonarResolutionMethod.StoredMap);
  });

  it("should fall back to the map when a declaration is refuted", async () => {
    // A repository declaring a shared template's key may still have a project of its own.
    const stored: StoredSonarMapping = { projectKey: "hmcts.template", repository: "the-template", resolvedAt: now };
    const own: StoredSonarMapping = { projectKey: "hmcts.cath", repository: "cath-service", resolvedAt: now };

    const resolved = await ladder({
      declaration: { projectKey: "hmcts.template" },
      storedByProject: () => stored,
      storedByRepository: () => ({ mapping: own, candidates: 1 })
    });

    expect(resolved.mapping?.projectKey).toBe("hmcts.cath");
    expect(resolved.mapping?.method).toBe(SonarResolutionMethod.StoredMap);
  });

  it("should resolve nothing when every rung fails", async () => {
    const resolved = await ladder({ declaration: {} });

    expect(resolved.mapping).toBeUndefined();
    expect(resolved.note).toMatch(/declares no sonar\.projectKey/);
  });
});
