import { beforeEach, describe, expect, it, vi } from "vitest";
import { AvailabilityReason, GitHubError } from "../domain/availability.ts";
import { isSonarObservation, ratingLetter, SonarGateLevel, SonarMappingOutcome, SonarResolutionMethod, type StoredSonarMapping } from "../domain/sonar.ts";
import { createGitHubClient, type GitHubClient } from "../github/client.ts";
import { personalAccessToken } from "../github/credentials.ts";
import { alreadyAnswered, attributedRepository, attributeProject, resolveRevision, SEARCH_CALLS_PER_MINUTE, searchPacer } from "./attribute.ts";
import { createSonarClient, type SonarClient, SonarError, searchableRevisions, sonarToken } from "./client.ts";
import { sonarProjectMap } from "./map.ts";
import { declaredProject, gateLevel, measuredCount, measuredGate, measuredNumber, measuredRating, parseMeasures, parseProperties } from "./measures.ts";
import { createCallPacer } from "./pacer.ts";
import { checkDeclaration, confirmByCommit, confirmsCandidate, declaredKey, mappedProject, namesRepository, resolveRepositoryProject } from "./resolve.ts";

// Ported from tests/test_sonar.py.

/** A real object name, because `searchableRevisions` refuses anything that is not one. */
const REVISION = "671d77770bda9760854fcf0bc5e086eed92bfb3a";

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

/** A GitHub client whose every read fails with the one error given, for the paths a real response cannot reach. */
function refusingGitHub(error: Error): GitHubClient {
  return { get: () => Promise.reject(error) } as unknown as GitHubClient;
}

/** A SonarCloud client whose analyses read fails with the one error given. */
function refusingSonar(error: Error): SonarClient {
  return { projectAnalyses: () => Promise.reject(error) } as unknown as SonarClient;
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

  it("should fall back to the bare verdict when only alert_status was sent", () => {
    expect(measuredGate(values({ alert_status: "ERROR" }))).toEqual({ level: SonarGateLevel.Error });
  });

  it("should take the verdict's level when the details name none, and keep no conditions when they list none", () => {
    const gate = measuredGate(values({ alert_status: "OK", quality_gate_details: JSON.stringify({ level: 3, conditions: "none" }) }));

    expect(gate).toEqual({ level: SonarGateLevel.Ok });
  });

  it("should keep a sparse condition's absences as absences rather than inventing a comparator or threshold", () => {
    const gate = measuredGate(values({ quality_gate_details: JSON.stringify({ level: "OK", conditions: [{}] }) }));

    expect(gate).toEqual({ level: SonarGateLevel.Ok, conditions: [{ metric: "", level: "" }] });
  });

  it("should report no gate when neither the details nor the verdict name a known level", () => {
    expect(measuredGate(values({ quality_gate_details: JSON.stringify({ level: "WARN" }) }))).toBeUndefined();
  });

  it("should report no gate when unreadable details have no verdict to degrade to", () => {
    expect(measuredGate(values({ quality_gate_details: "not json" }))).toBeUndefined();
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

  it("should carry the gate when one was measured", () => {
    expect(parseMeasures("hmcts.cath", [{ metric: "alert_status", value: "OK" }], undefined).gate).toEqual({ level: SonarGateLevel.Ok });
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

  it("should skip a line that is not a property rather than guessing at it", () => {
    expect([...parseProperties("sonar.sources\nsonar.projectKey=hmcts.cath\n").keys()]).toEqual(["sonar.projectKey"]);
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

  it("should list projects through the endpoint an anonymous caller may read, asking for each analysis instant", async () => {
    // `/api/projects/search` answers 401 without a credential; this is the endpoint SonarCloud's own project
    // explorer reads. The instant is what the skip watermark compares against, so it is asked for by name.
    const fetch = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ components: [{ key: "hmcts.cath", analysisDate: "2026-09-16T10:15:55+0000" }] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      )
    ) as unknown as typeof globalThis.fetch;

    const projects = await createSonarClient({ organization: "hmcts", fetch }).projects();

    const asked = new URL(String((fetch as unknown as { mock: { calls: [string][] } }).mock.calls[0]?.[0]));
    expect(asked.pathname).toBe("/api/components/search_projects");
    expect(asked.searchParams.get("f")).toBe("analysisDate");
    expect(projects[0]?.analysisAt?.toISOString()).toBe("2026-09-16T10:15:55.000Z");
  });

  it("should keep a project's name where SonarCloud lists one", async () => {
    const fetch = replying({ body: { components: [{ key: "hmcts.cath", name: "CaTH" }] } });

    expect(await createSonarClient({ organization: "hmcts", fetch }).projects()).toEqual([{ key: "hmcts.cath", name: "CaTH" }]);
  });

  it("should send a token as the basic-auth username with an empty password, to the base URL given", async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ analyses: [] }), { status: 200 }))) as unknown as typeof globalThis.fetch;

    await createSonarClient({ organization: "hmcts", token: "squ_test", fetch, baseUrl: "https://sonar.example" }).projectAnalyses("hmcts.cath", 1);

    const [url, init] = (fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0] ?? [];
    expect(new URL(String(url)).origin).toBe("https://sonar.example");
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from("squ_test:").toString("base64")}`);
  });

  it("should keep an analysis that carries no date, and a measure sent as null, as absences", async () => {
    const analyses = await createSonarClient({ organization: "hmcts", fetch: replying({ body: { analyses: [{ revision: REVISION, date: null }] } }) }).projectAnalyses(
      "hmcts.cath",
      1
    );
    const measures = await createSonarClient({
      organization: "hmcts",
      fetch: replying({ body: { component: { measures: [{ metric: "coverage", value: null }] } } })
    }).measures("hmcts.cath", undefined);

    expect(analyses).toEqual([{ revision: REVISION }]);
    expect(measures.coverage).toBeUndefined();
  });

  it("should read through the global fetch where none is injected", async () => {
    const fetch = replying({ body: { analyses: [] } });
    vi.stubGlobal("fetch", fetch);
    try {
      expect(await createSonarClient({ organization: "hmcts" }).projectAnalyses("hmcts.cath", 1)).toEqual([]);
      expect(fetch).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("should carry a SonarCloud that could not be reached as a collection failure", async () => {
    const fetch = vi.fn(() => Promise.reject(new TypeError("fetch failed"))) as unknown as typeof globalThis.fetch;

    const error = await failing(createSonarClient({ organization: "hmcts", fetch }).projects());

    expect(error.reason).toBe(AvailabilityReason.CollectionFailed);
    expect(error.message).toMatch(/could not be reached/);
  });

  it("should carry a body that is not JSON as a collection failure", async () => {
    const error = await failing(createSonarClient({ organization: "hmcts", fetch: replying({ body: "<html>" }) }).projects());

    expect(error.reason).toBe(AvailabilityReason.CollectionFailed);
    expect(error.message).toMatch(/unreadable projects body/);
  });

  it("should carry a body of the wrong shape as a collection failure", async () => {
    const error = await failing(createSonarClient({ organization: "hmcts", fetch: replying({ body: { component: "none" } }) }).measures("hmcts.cath", undefined));

    expect(error.reason).toBe(AvailabilityReason.CollectionFailed);
    expect(error.message).toMatch(/cannot accept/);
  });
});

describe("sonarToken", () => {
  it("should read the variable SonarCloud's own scanner documents first", () => {
    expect(sonarToken({ SONAR_TOKEN: "first", SONARCLOUD_TOKEN: "second" })).toBe("first");
    expect(sonarToken({ SONARCLOUD_TOKEN: "second" })).toBe("second");
  });

  it("should read a blank variable as no token, which is the anonymous read this deployment makes", () => {
    expect(sonarToken({ SONAR_TOKEN: "  " })).toBeUndefined();
    expect(sonarToken({})).toBeUndefined();
  });
});

describe("searchableRevisions", () => {
  it("should drop an analysis carrying no revision to search for", () => {
    expect(searchableRevisions([{ analysisAt: new Date() }, { revision: REVISION, analysisAt: new Date() }]).map((entry) => entry.revision)).toEqual([
      REVISION
    ]);
  });

  it("should ask about one revision once when several analyses name it, since each question costs the scarcest quota", () => {
    expect(searchableRevisions([{ revision: REVISION }, { revision: REVISION }])).toHaveLength(1);
  });

  it("should drop a revision that is not an object name, which no commit can match", () => {
    expect(searchableRevisions([{ revision: "not-a-sha" }, { revision: "../../rate_limit" }])).toEqual([]);
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

  it("should not pause a call that arrives after the interval has already passed", async () => {
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
    now = 1010;
    await pacer.wait();
    now = 1012;
    await pacer.wait();

    // The second call claimed its slot at 1010, so the third is paced from there rather than from 1000.
    expect(paused).toEqual([4000]);
  });

  it("should pause on a real timer when no pause is injected", async () => {
    vi.useFakeTimers();
    try {
      const pacer = createCallPacer({ interval: 6, clock: () => 1000 });
      await pacer.wait();

      let settled = false;
      const waiting = pacer.wait().then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(5999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await waiting;

      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
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

  it("should raise any other failure, which says nothing about whether the repository holds the commit", async () => {
    const refused = new GitHubError("GitHub refused the read", AvailabilityReason.PermissionDenied, 403);

    await expect(confirmsCandidate(refusingGitHub(refused), "hmcts", "cath-service", "abc")).rejects.toBe(refused);
    await expect(confirmsCandidate(refusingGitHub(new Error("boom")), "hmcts", "cath-service", "abc")).rejects.toThrow("boom");
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
      fetch: replying({ body: { analyses: [{ revision: REVISION, date: "2026-08-01T00:00:00Z" }] } })
    });

    const checked = await checkDeclaration(
      sonarClient,
      githubClient(replying({ body: { sha: REVISION } })),
      "hmcts",
      "cath-service",
      "hmcts.cath",
      undefined,
      now
    );

    expect(checked.mapping?.method).toBe(SonarResolutionMethod.DeclaredConfirmedByCommit);
    expect(checked.mapping?.revision).toBe(REVISION);
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

  it("should keep the map's analysis instant and leave out a revision the map never recorded", async () => {
    const analysisAt = new Date("2026-07-01T00:00:00Z");
    const stored: StoredSonarMapping = { projectKey: "hmcts.cath", repository: "cath-service", analysisAt, resolvedAt: now };

    const checked = await checkDeclaration(sonar(), githubClient(replying()), "hmcts", "cath-service", "hmcts.cath", stored, now);

    expect(checked.mapping).toEqual({
      projectKey: "hmcts.cath",
      repository: "cath-service",
      method: SonarResolutionMethod.DeclaredConfirmedByMap,
      analysisAt,
      resolvedAt: now
    });
  });
});

describe("confirmByCommit", () => {
  const now = new Date("2026-08-08T00:00:00Z");
  const analysed = () => createSonarClient({ organization: "hmcts", fetch: replying({ body: { analyses: [{ revision: REVISION }] } }) });

  it("should confirm an undated analysis without inventing an instant for it", async () => {
    const checked = await confirmByCommit(analysed(), githubClient(replying({ body: { sha: REVISION } })), "hmcts", "cath-service", "hmcts.cath", now);

    expect(checked.mapping).toEqual({
      projectKey: "hmcts.cath",
      repository: "cath-service",
      method: SonarResolutionMethod.DeclaredConfirmedByCommit,
      revision: REVISION,
      resolvedAt: now
    });
  });

  it("should refute a declaration whose latest analysed commit the repository does not hold", async () => {
    const checked = await confirmByCommit(analysed(), githubClient(replying({ status: 404, body: {} })), "hmcts", "cath-service", "hmcts.cath", now);

    expect(checked.mapping).toBeUndefined();
    expect(checked.reason).toBeUndefined();
    expect(checked.note).toBe(`cath-service does not hold commit ${REVISION}, the latest analysis of hmcts.cath`);
  });

  it("should keep the reason when GitHub refused the commit read", async () => {
    const refused = new GitHubError("GitHub refused the read", AvailabilityReason.PermissionDenied, 403);

    const checked = await confirmByCommit(analysed(), refusingGitHub(refused), "hmcts", "cath-service", "hmcts.cath", now);

    expect(checked).toEqual({ note: "GitHub refused the read", reason: AvailabilityReason.PermissionDenied });
  });

  it("should raise a commit read that failed for a reason GitHub did not give", async () => {
    await expect(confirmByCommit(analysed(), refusingGitHub(new Error("boom")), "hmcts", "cath-service", "hmcts.cath", now)).rejects.toThrow("boom");
  });

  it("should raise an analyses read that failed for a reason SonarCloud did not give", async () => {
    await expect(confirmByCommit(refusingSonar(new Error("boom")), githubClient(replying()), "hmcts", "cath-service", "hmcts.cath", now)).rejects.toThrow("boom");
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

  it("should say which project it reads where several claim the repository, and carry only the evidence the map holds", () => {
    const claimed: StoredSonarMapping = { projectKey: "hmcts.cath", resolvedAt: new Date("2026-07-01Z") };

    const mapping = mappedProject(claimed, 2, "cath-service", now);

    expect(mapping).toEqual({ projectKey: "hmcts.cath", method: SonarResolutionMethod.StoredMap, resolvedAt: now });
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining("cath-service is claimed by 2 SonarCloud projects"));
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

  it("should settle on a declaration the map confirms, without consulting the repository's own claim", async () => {
    const stored: StoredSonarMapping = { projectKey: "hmcts.cath", repository: "cath-service", resolvedAt: now };
    const storedByRepository = vi.fn(() => undefined);

    const resolved = await ladder({ declaration: { projectKey: "hmcts.cath" }, storedByProject: () => stored, storedByRepository });

    expect(resolved.mapping?.method).toBe(SonarResolutionMethod.DeclaredConfirmedByMap);
    expect(storedByRepository).not.toHaveBeenCalled();
  });

  it("should keep the refutation's note when the map attributes no project to the repository either", async () => {
    const stored: StoredSonarMapping = { projectKey: "hmcts.template", repository: "the-template", resolvedAt: now };

    const resolved = await ladder({ declaration: { projectKey: "hmcts.template" }, storedByProject: () => stored });

    expect(resolved).toEqual({ note: "the declared project hmcts.template is mapped to the-template" });
  });

  it("should report nothing at all where there is neither a declaration nor a claim", async () => {
    expect(await ladder()).toEqual({});
  });
});

describe("attributedRepository", () => {
  it("should read the repository out of an owner/name pair", () => {
    expect(attributedRepository("hmcts", "HMCTS/cath-service")).toBe("cath-service");
  });

  it("should refuse a commit that belongs to another owner rather than trimming the owner off", () => {
    // The project analyses somebody else's code, and attributing it would put another organisation's quality gate
    // on this one's report.
    expect(attributedRepository("hmcts", "somebody/cath-service")).toBeUndefined();
    expect(attributedRepository("hmcts", "cath-service")).toBeUndefined();
  });
});

describe("attributeProject", () => {
  const now = new Date("2026-09-17T00:00:00Z");
  const analysed = new Date("2026-09-16T00:00:00Z");
  /** The pacing is asserted in `createCallPacer` above, against an injected clock rather than by waiting. */
  const IDLE_PACER = { spacing: () => 0, wait: () => Promise.resolve() };

  function attributing(options: { sonar: typeof globalThis.fetch; github: typeof globalThis.fetch }) {
    return attributeProject({
      sonarClient: createSonarClient({ organization: "hmcts", fetch: options.sonar }),
      githubClient: githubClient(options.github),
      organization: "hmcts",
      projectKey: "hmcts.cath",
      pacer: IDLE_PACER,
      now
    });
  }

  it("should name the repository that holds the analysed commit", async () => {
    const attempt = await attributing({
      sonar: replying({ body: { analyses: [{ revision: REVISION, date: analysed.toISOString() }] } }),
      github: replying({ body: { items: [{ repository: { full_name: "hmcts/cath-service" } }] } })
    });

    expect(attempt.outcome).toBe(SonarMappingOutcome.Resolved);
    expect(attempt.mapping).toMatchObject({ repository: "cath-service", method: SonarResolutionMethod.AnalysisRevision, revision: REVISION });
    expect(attempt.analysesTried).toBe(1);
  });

  it("should walk back to an older analysis when the newest commit is in no repository", async () => {
    // A pull-request analysis names a commit on a branch since force-pushed, which is then in no repository at
    // all — while the analysis under it, on the default branch, is permanent.
    const older = "0f".repeat(20);
    const attempt = await attributing({
      sonar: replying({
        body: {
          analyses: [
            { revision: REVISION, date: analysed.toISOString() },
            { revision: older, date: analysed.toISOString() }
          ]
        }
      }),
      github: replying({ body: { items: [] } }, { body: { items: [{ repository: { full_name: "hmcts/cath-service" } }] } })
    });

    expect(attempt.mapping?.revision).toBe(older);
    expect(attempt.analysesTried).toBe(2);
  });

  it("should answer for a project SonarCloud has never analysed without searching for anything", async () => {
    const github = vi.fn();
    const attempt = await attributing({ sonar: replying({ body: { analyses: [] } }), github: github as unknown as typeof globalThis.fetch });

    expect(attempt.outcome).toBe(SonarMappingOutcome.NoAnalysis);
    expect(attempt.detail).toContain("records no analysis");
    expect(github).not.toHaveBeenCalled();
  });

  it("should answer for a project whose analyses name no commit to search for", async () => {
    const attempt = await attributing({ sonar: replying({ body: { analyses: [{ date: analysed.toISOString() }] } }), github: replying() });

    expect(attempt.outcome).toBe(SonarMappingOutcome.NoRevision);
    expect(attempt.detail).toContain("names the commit it ran against");
  });

  it("should record a commit outside the organisation as an answer about the project", async () => {
    const attempt = await attributing({
      sonar: replying({ body: { analyses: [{ revision: REVISION, date: analysed.toISOString() }] } }),
      github: replying({ body: { items: [{ repository: { full_name: "somebody/cath-service" } }] } })
    });

    expect(attempt.outcome).toBe(SonarMappingOutcome.OutsideOrganization);
    expect(attempt.detail).toContain("which is outside hmcts");
  });

  it("should answer for a project no commit matches, which is what stops the next run re-paying", async () => {
    const attempt = await attributing({
      sonar: replying({ body: { analyses: [{ revision: REVISION, date: analysed.toISOString() }] } }),
      github: replying({ body: { items: [] } })
    });

    expect(attempt.outcome).toBe(SonarMappingOutcome.UnknownCommit);
    expect(attempt.mapping).toBeUndefined();
    expect(attempt.detail).toContain("no commit in hmcts matches");
  });

  it("should report a refused SonarCloud read as this run's failure rather than the project's answer", async () => {
    const attempt = await attributing({ sonar: replying({ status: 403, body: {} }), github: replying() });

    expect(attempt.outcome).toBe(SonarMappingOutcome.Failed);
    expect(isSonarObservation(attempt.outcome)).toBe(false);
  });

  it("should raise an analyses read that failed for a reason SonarCloud did not give", async () => {
    await expect(
      attributeProject({ sonarClient: refusingSonar(new Error("boom")), githubClient: githubClient(replying()), organization: "hmcts", projectKey: "hmcts.cath", pacer: IDLE_PACER, now })
    ).rejects.toThrow("boom");
  });

  it("should record a refused commit search as this project's failure", async () => {
    const refused = new GitHubError("GitHub refused the search", AvailabilityReason.PermissionDenied, 403);

    const attempt = await resolveRevision(refusingGitHub(refused), "hmcts", "hmcts.cath", REVISION, undefined, now, IDLE_PACER);

    expect(attempt).toEqual({ projectKey: "hmcts.cath", outcome: SonarMappingOutcome.Failed, analysesTried: 0, detail: "GitHub refused the search" });
  });

  it("should raise a commit search that failed for a reason GitHub did not give", async () => {
    await expect(resolveRevision(refusingGitHub(new Error("boom")), "hmcts", "hmcts.cath", REVISION, undefined, now, IDLE_PACER)).rejects.toThrow("boom");
  });

  it("should resolve an undated analysis without inventing an instant for it", async () => {
    const attempt = await attributing({
      sonar: replying({ body: { analyses: [{ revision: REVISION }] } }),
      github: replying({ body: { items: [{ repository: { full_name: "hmcts/cath-service" } }] } })
    });

    expect(attempt.mapping).toEqual({ projectKey: "hmcts.cath", repository: "cath-service", method: SonarResolutionMethod.AnalysisRevision, revision: REVISION, resolvedAt: now });
  });

  it("should raise a spent search quota rather than recording it as the project's dead end", async () => {
    const rateLimited = { status: 429, body: {} };
    const raised = await attributing({
      sonar: replying({ body: { analyses: [{ revision: REVISION, date: analysed.toISOString() }] } }),
      github: replying(rateLimited, rateLimited, rateLimited, rateLimited)
    }).then(
      () => undefined,
      (thrown: unknown) => thrown
    );

    expect(raised).toBeInstanceOf(GitHubError);
    expect((raised as GitHubError).reason).toBe(AvailabilityReason.RateLimited);
  });
});

describe("searchPacer", () => {
  it("should pace off the SEARCH budget rather than the core one, spreading what is left over the window", async () => {
    // The two names are deliberately different strings: the call is issued under `commit-search` so the client's
    // core-quota waiter leaves it alone, and the budget is read under `search`, which is what GitHub's own headers
    // call the quota it spends. Reading the wrong one would pace against 5,000 an hour instead of 10 a minute.
    const fetch = replying({ body: { items: [] } });
    const client = createGitHubClient({ credentials: personalAccessToken("ghp_test"), fetch, pause: () => Promise.resolve(), clock: () => 1000 });
    // `resetsAt` is relative to the wall clock, because `searchPacer` wires the pacer to the real one — the
    // injected clock in the cases above is the pacer's own seam and not this function's.
    const resetsAt = Date.now() / 1000 + 30;
    vi.spyOn(client, "budget").mockImplementation((resource: string) => (resource === "search" ? { limit: 10, remaining: 5, used: 5, resetsAt } : undefined));

    const pacer = searchPacer(client);

    expect(pacer.spacing()).toBeCloseTo(6, 1);
  });

  it("should fall back to the documented allowance until a response has reported a budget", () => {
    const client = createGitHubClient({ credentials: personalAccessToken("ghp_test"), fetch: replying(), pause: () => Promise.resolve(), clock: () => 1000 });

    expect(searchPacer(client).spacing()).toBe(60 / SEARCH_CALLS_PER_MINUTE);
  });
});

describe("alreadyAnswered", () => {
  const stored: StoredSonarMapping = { projectKey: "hmcts.cath", repository: "cath-service", resolvedAt: new Date("2026-09-16T00:00:00Z") };

  it("should skip a project nothing has been analysed since the row was written", () => {
    expect(alreadyAnswered(new Date("2026-09-15T00:00:00Z"), stored)).toBe(true);
  });

  it("should skip a project SonarCloud reports no analysis instant for, since nothing can have changed", () => {
    expect(alreadyAnswered(undefined, stored)).toBe(true);
  });

  it("should ask again once a newer analysis exists, which is the only thing that can change the answer", () => {
    expect(alreadyAnswered(new Date("2026-09-17T00:00:00Z"), stored)).toBe(false);
  });
});

describe("sonarProjectMap", () => {
  const resolvedAt = new Date("2026-09-17T00:00:00Z");

  it("should answer by project including a remembered negative, which is what stops a re-resolve", () => {
    const map = sonarProjectMap([{ projectKey: "hmcts.gone", resolvedAt, detail: "no commit matched" }]);

    expect(map.byProject("hmcts.gone")?.detail).toBe("no commit matched");
    expect(map.answered).toBe(1);
    // A negative names no repository, so nothing is attributed by it.
    expect(map.attributed).toBe(0);
  });

  it("should let the most recently analysed project win where two claim one repository", () => {
    const map = sonarProjectMap([
      { projectKey: "hmcts.cath.old", repository: "cath-service", analysisAt: new Date("2026-01-01T00:00:00Z"), resolvedAt },
      { projectKey: "hmcts.cath", repository: "cath-service", analysisAt: new Date("2026-09-16T00:00:00Z"), resolvedAt }
    ]);

    expect(map.byRepository("cath-service")).toMatchObject({ mapping: { projectKey: "hmcts.cath" }, candidates: 2 });
  });

  it("should never let an undated candidate beat a dated one, and should break a tie by key", () => {
    const undated = sonarProjectMap([
      { projectKey: "hmcts.a", repository: "cath-service", resolvedAt },
      { projectKey: "hmcts.b", repository: "cath-service", analysisAt: new Date("2026-01-01T00:00:00Z"), resolvedAt }
    ]);
    const tied = sonarProjectMap([
      { projectKey: "hmcts.b", repository: "cath-service", resolvedAt },
      { projectKey: "hmcts.a", repository: "cath-service", resolvedAt }
    ]);

    const undatedLast = sonarProjectMap([
      { projectKey: "hmcts.b", repository: "cath-service", analysisAt: new Date("2026-01-01T00:00:00Z"), resolvedAt },
      { projectKey: "hmcts.a", repository: "cath-service", resolvedAt }
    ]);

    expect(undated.byRepository("cath-service")?.mapping.projectKey).toBe("hmcts.b");
    expect(undatedLast.byRepository("cath-service")?.mapping.projectKey).toBe("hmcts.b");
    expect(tied.byRepository("cath-service")?.mapping.projectKey).toBe("hmcts.a");
  });

  it("should fold case, because one name was returned by GitHub and the other typed by a human", () => {
    const map = sonarProjectMap([{ projectKey: "hmcts.cath", repository: "CaTH-Service", resolvedAt }]);

    expect(map.byRepository("cath-service")?.mapping.projectKey).toBe("hmcts.cath");
  });
});
