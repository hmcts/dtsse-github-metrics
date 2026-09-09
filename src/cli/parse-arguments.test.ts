import { describe, expect, it } from "vitest";
import { CollectionStatus } from "../evidence/domain/availability.ts";
import { collectionStatus, EXIT_COMPLETE, EXIT_FAILED, EXIT_INCOMPLETE, EXIT_USAGE, runStatus } from "./exit-status.ts";
import { COHORT_COMMANDS, parseArguments, UsageError, usage } from "./parse-arguments.ts";

describe("parseArguments", () => {
  it("should parse a command with its configuration", () => {
    const parsed = parseArguments(["collect", "--config", "metrics.yaml"]);

    expect(parsed.command).toBe("collect");
    expect(parsed.config).toEqual(["metrics.yaml"]);
  });

  it("should keep a repeated --config in the order given, so a later file wins", () => {
    const parsed = parseArguments(["collect", "--config", "policy.yaml", "--config", "teams.yaml"]);

    expect(parsed.config).toEqual(["policy.yaml", "teams.yaml"]);
  });

  it("should require a configuration", () => {
    expect(() => parseArguments(["collect"])).toThrow(/--config is required/);
  });

  it("should take migrate without a configuration", () => {
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
    expect([...COHORT_COMMANDS].sort()).toEqual(["collect", "evidence", "trend"]);
    expect(COHORT_COMMANDS.has("prune")).toBe(false);
    expect(COHORT_COMMANDS.has("map-sonar")).toBe(false);
  });

  it("should not oblige collect-org to have a cohort, since it is what establishes one", () => {
    expect(COHORT_COMMANDS.has("collect-org")).toBe(false);
  });
});

describe("collect-org", () => {
  it("should be a recognised command", () => {
    expect(parseArguments(["collect-org", "--config", "m.yaml"]).command).toBe("collect-org");
  });

  it("should leave the proposal flag off unless asked for", () => {
    expect(parseArguments(["collect-org", "--config", "m.yaml"]).proposeTeams).toBe(false);
  });

  it("should read the proposal flag", () => {
    expect(parseArguments(["collect-org", "--config", "m.yaml", "--propose-teams"]).proposeTeams).toBe(true);
  });

  it("should leave the unresolved limit absent so the configured ceiling stands", () => {
    expect(parseArguments(["collect-org", "--config", "m.yaml"]).unresolvedLimit).toBeUndefined();
  });

  it("should read an unresolved limit that overrides the configured ceiling", () => {
    expect(parseArguments(["collect-org", "--config", "m.yaml", "--unresolved-limit", "25"]).unresolvedLimit).toBe(25);
  });

  it("should accept a zero limit, which skips the per-repository rungs entirely", () => {
    expect(parseArguments(["collect-org", "--config", "m.yaml", "--unresolved-limit", "0"]).unresolvedLimit).toBe(0);
  });

  // `--unresolved-limit -1` never reaches the guard: `parseArgs` reads `-1` as an option rather than as this
  // one's value and refuses it first. `=` is how a negative is written, and is what the guard actually sees.
  it("should refuse a negative limit rather than reading it as no limit", () => {
    expect(() => parseArguments(["collect-org", "--config", "m.yaml", "--unresolved-limit=-1"])).toThrow(/may not be negative/);
  });

  it("should refuse a limit that is not a whole number", () => {
    expect(() => parseArguments(["collect-org", "--config", "m.yaml", "--unresolved-limit", "many"])).toThrow(/must be a whole number/);
  });
});

describe("runStatus", () => {
  it.each([
    [CollectionStatus.Complete, EXIT_COMPLETE],
    [CollectionStatus.Failed, EXIT_FAILED],
    [CollectionStatus.Partial, EXIT_INCOMPLETE]
  ])("should map %s onto exit status %i", (status, expected) => {
    expect(runStatus(status)).toBe(expected);
  });

  it("should keep a usage error apart from a partial run", () => {
    expect(EXIT_USAGE).toBe(2);
    expect(EXIT_INCOMPLETE).toBe(3);
  });
});

describe("usage", () => {
  it("should document every command and every exit status", () => {
    const text = usage();

    for (const command of ["doctor", "collect", "collect-org", "prune", "map-sonar", "evidence", "trend"]) {
      expect(text).toContain(command);
    }
    expect(text).toMatch(/exit status/);
  });
});

describe("--tolerate-partial", () => {
  it("should be off unless asked for", () => {
    expect(parseArguments(["collect", "--config", "m.yaml"]).toleratePartial).toBe(false);
  });

  it("should be read as a flag", () => {
    expect(parseArguments(["collect", "--config", "m.yaml", "--tolerate-partial"]).toleratePartial).toBe(true);
  });
});

describe("collectionStatus", () => {
  it("should report a partial run as incomplete when nobody asked to tolerate it", () => {
    expect(collectionStatus(CollectionStatus.Partial, false)).toBe(EXIT_INCOMPLETE);
  });

  it("should report a partial run as success for a scheduled caller", () => {
    // What the CronJob needs: something always refuses across an estate this size, so exit 3 would make every
    // weekly run read as Failed to Kubernetes and the alert would mean nothing.
    expect(collectionStatus(CollectionStatus.Partial, true)).toBe(EXIT_COMPLETE);
  });

  it("should never tolerate a run that produced nothing usable", () => {
    expect(collectionStatus(CollectionStatus.Failed, true)).toBe(EXIT_FAILED);
  });

  it("should leave a complete run alone either way", () => {
    expect(collectionStatus(CollectionStatus.Complete, true)).toBe(EXIT_COMPLETE);
    expect(collectionStatus(CollectionStatus.Complete, false)).toBe(EXIT_COMPLETE);
  });
});
