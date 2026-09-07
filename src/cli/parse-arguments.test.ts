import { describe, expect, it } from "vitest";
import { CollectionStatus } from "../evidence/domain/availability.ts";
import { EXIT_COMPLETE, EXIT_FAILED, EXIT_INCOMPLETE, EXIT_USAGE, runStatus } from "./exit-status.ts";
import { COHORT_COMMANDS, parseArguments, UsageError, usage } from "./parse-arguments.ts";

// Ported from the argument-parsing and exit-status cases of tests/test_cli.py. The output-formatting cases are
// deliberately not ported: render.py was dropped, so there is no ASCII layout to assert.

describe("parseArguments", () => {
  it("should parse a command with its configuration", () => {
    const parsed = parseArguments(["collect", "--config", "metrics.yaml"]);

    expect(parsed.command).toBe("collect");
    expect(parsed.config).toEqual(["metrics.yaml"]);
  });

  it("should keep a repeated --config in the order given, so a later file wins", () => {
    // The files are read as ONE document, which is how a team file restates a shared policy key.
    const parsed = parseArguments(["collect", "--config", "policy.yaml", "--config", "teams.yaml"]);

    expect(parsed.config).toEqual(["policy.yaml", "teams.yaml"]);
  });

  it("should require a configuration", () => {
    expect(() => parseArguments(["collect"])).toThrow(/--config is required/);
  });

  it("should take migrate without a configuration", () => {
    // The web pod migrates at start, before anything has read a policy — and the schema is the same whichever
    // repositories are being reported on, so requiring one would only be an obstacle.
    expect(parseArguments(["migrate"]).command).toBe("migrate");
  });

  it("should refuse an unknown command, naming the ones it takes", () => {
    expect(() => parseArguments(["invent", "--config", "metrics.yaml"])).toThrow(/unknown command "invent"/);
  });

  it("should report usage when asked for help", () => {
    expect(() => parseArguments(["--help"])).toThrow(UsageError);
  });

  it("should report usage when given nothing at all", () => {
    expect(() => parseArguments([])).toThrow(UsageError);
  });

  it("should refuse an unknown option rather than ignoring it", () => {
    expect(() => parseArguments(["collect", "--config", "metrics.yaml", "--invented"])).toThrow(UsageError);
  });

  it.each([
    ["2026-08-01", "2026-08-01T00:00:00.000Z"],
    ["2026-08-01T14:30", "2026-08-01T14:30:00.000Z"],
    ["2026-08-01T14:30:00+01:00", "2026-08-01T13:30:00.000Z"]
  ])("should parse the window edge %s exactly as the policy file's instants are parsed", (written, expected) => {
    expect(parseArguments(["evidence", "--config", "m.yaml", "--from", written]).startsAt?.toISOString()).toBe(expected);
  });

  it("should name the option when a window edge cannot be parsed", () => {
    expect(() => parseArguments(["evidence", "--config", "m.yaml", "--from", "last tuesday"])).toThrow(/--from: expected a date or datetime/);
  });

  it("should refuse all three of --from, --to and --days together", () => {
    expect(() => parseArguments(["evidence", "--config", "m.yaml", "--from", "2026-08-01", "--to", "2026-08-08", "--days", "7"])).toThrow(
      /at most two of --from, --to, and --days/
    );
  });

  it("should refuse a non-numeric --days", () => {
    expect(() => parseArguments(["collect", "--config", "m.yaml", "--days", "seven"])).toThrow(/--days must be a whole number/);
  });

  it("should default a trend period to 28 days", () => {
    expect(parseArguments(["trend", "--config", "m.yaml"]).periodDays).toBe(28);
  });

  it("should refuse a period that cannot describe a window, before any repository is read", () => {
    // A configuration where nobody is enabled yet must still refuse this rather than report an empty series as
    // though the request were fine.
    expect(() => parseArguments(["trend", "--config", "m.yaml", "--period-days", "0"])).toThrow(/--period-days must be at least one day/);
  });

  it("should accept a known metric identifier", () => {
    expect(parseArguments(["evidence", "--config", "m.yaml", "--metric", "review-depth"]).metric).toBe("review-depth");
  });

  it("should refuse an unknown metric, listing the ones it takes", () => {
    expect(() => parseArguments(["evidence", "--config", "m.yaml", "--metric", "invented"])).toThrow(/--metric must be one of independent-review-coverage/);
  });

  it("should default the format to json", () => {
    expect(parseArguments(["evidence", "--config", "m.yaml"]).format).toBe("json");
  });

  it("should name the replacement when the dropped report format is asked for", () => {
    // Recognised rather than unknown, so the failure explains itself instead of reading as a typo.
    expect(() => parseArguments(["evidence", "--config", "m.yaml", "--format", "report"])).toThrow(/use --format json and filter it with jq/);
  });

  it("should refuse a format that was never supported", () => {
    expect(() => parseArguments(["evidence", "--config", "m.yaml", "--format", "csv"])).toThrow(/--format must be json or report/);
  });

  it.each([
    ["--refresh", "refresh"],
    ["--offline", "offline"],
    ["--identities", "identities"]
  ])("should read the flag %s", (flag, field) => {
    const parsed = parseArguments(["evidence", "--config", "m.yaml", flag]) as unknown as Record<string, boolean>;

    expect(parsed[field]).toBe(true);
  });
});

describe("COHORT_COMMANDS", () => {
  it("should name the commands whose subject is the reported cohort", () => {
    // map-sonar resolves every project an organisation lists and prune deletes cache rows: neither is about a
    // repository a team owns, so neither should oblige a team file to be layered in.
    expect([...COHORT_COMMANDS].sort()).toEqual(["collect", "evidence", "trend"]);
    expect(COHORT_COMMANDS.has("prune")).toBe(false);
    expect(COHORT_COMMANDS.has("map-sonar")).toBe(false);
  });
});

describe("runStatus", () => {
  it.each([
    [CollectionStatus.Complete, EXIT_COMPLETE],
    [CollectionStatus.Failed, EXIT_FAILED],
    // Its own status: neither 0 nor 1 describes twelve of fourteen repositories.
    [CollectionStatus.Partial, EXIT_INCOMPLETE]
  ])("should map %s onto exit status %i", (status, expected) => {
    expect(runStatus(status)).toBe(expected);
  });

  it("should keep a usage error apart from a partial run", () => {
    // A caller must be able to tell "you invoked me wrongly" from "part of the org would not answer".
    expect(EXIT_USAGE).toBe(2);
    expect(EXIT_INCOMPLETE).toBe(3);
  });
});

describe("usage", () => {
  it("should document every command and every exit status", () => {
    const text = usage();

    for (const command of ["doctor", "collect", "prune", "map-sonar", "evidence", "trend"]) {
      expect(text).toContain(command);
    }
    expect(text).toMatch(/exit status/);
  });
});
