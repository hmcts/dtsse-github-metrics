import { describe, expect, it } from "vitest";
import { CollectionStatus } from "../evidence/domain/availability.ts";
import { collectionStatus, EXIT_COMPLETE, EXIT_FAILED, EXIT_INCOMPLETE, EXIT_USAGE, runStatus } from "./exit-status.ts";
import { COHORT_COMMANDS, COMMANDS, parseArguments, UsageError, usage } from "./parse-arguments.ts";

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

  // A flag nothing reads is refused rather than accepted, so `--help` and the behaviour cannot disagree.
  // Each of these parsed and was then ignored by every command, four of them while `usage` advertised them
  // against `evidence` — which is implemented and read none of them.
  it.each([
    "--logging=debug",
    "--metric=review-depth",
    "--refresh",
    "--offline",
    "--identities",
    "--format=json",
    "--period-days=28",
    "--periods=3"
  ])("should refuse %s, which no command reads", (flag) => {
    expect(() => parseArguments(["evidence", "--config", "m.yaml", flag])).toThrow(UsageError);
  });

  it("should refuse --maximum-days, which never raised the window span it claimed to", () => {
    expect(() => parseArguments(["collect", "--config", "m.yaml", "--maximum-days=400"])).toThrow(UsageError);
  });

  // A usage error and not a failed run: `trend` was dispatched and could only report itself unwired, so a caller
  // got exit 1 for asking correctly. Exit 2 says the command line was wrong, which is the true answer.
  it("should refuse the unimplemented command trend as a usage error", () => {
    expect(() => parseArguments(["trend", "--config", "m.yaml"])).toThrow(/unknown command/);
  });

  it("should accept map-sonar, which resolves the project map rather than reporting the cohort", () => {
    expect(parseArguments(["map-sonar", "--config", "m.yaml", "--tolerate-partial"])).toMatchObject({
      command: "map-sonar",
      toleratePartial: true
    });
    expect(COHORT_COMMANDS.has("map-sonar")).toBe(false);
  });
});

describe("COHORT_COMMANDS", () => {
  it("should name the commands whose subject is the reported cohort", () => {
    expect([...COHORT_COMMANDS].sort()).toEqual(["collect", "evidence"]);
    expect(COHORT_COMMANDS.has("prune")).toBe(false);
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

    for (const command of COMMANDS) {
      expect(text).toContain(command);
    }
    expect(text).toMatch(/exit status/);
  });

  /**
   * The help text and the parser say the same thing, which is what stops a flag being promised and ignored.
   *
   * Read off `OPTIONS` through the parser rather than asserted as a list: a flag added to one and not the
   * other is exactly the drift this catches, and a hardcoded list here would be a third place to forget.
   */
  it("should promise no flag the parser refuses", () => {
    const promised = [...usage().matchAll(/^ {2}(--[a-z-]+)/gm)].map((match) => match[1] as string);

    expect(promised.length).toBeGreaterThan(0);
    for (const flag of promised) {
      // Rejection with "Unknown option" is the parser saying it does not have the flag at all. Any other
      // usage error — a missing value, a bad number — means the flag exists and this one is satisfied.
      expect(() => parseArguments(["collect", "--config", "m.yaml", flag])).not.toThrow(/Unknown option/);
    }
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

describe("--write", () => {
  it("should be off unless asked for, so the default of the command that rewrites payloads is to write nothing", () => {
    expect(parseArguments(["reduce-descriptions", "--config", "m.yaml"]).write).toBe(false);
  });

  it("should be read as a flag", () => {
    expect(parseArguments(["reduce-descriptions", "--config", "m.yaml", "--write"]).write).toBe(true);
  });
});

describe("--batch-size", () => {
  it("should be absent unless given, leaving the default to the command", () => {
    expect(parseArguments(["reduce-descriptions", "--config", "m.yaml"]).batchSize).toBeUndefined();
  });

  it("should be read as a whole number of rows", () => {
    expect(parseArguments(["reduce-descriptions", "--config", "m.yaml", "--batch-size", "250"]).batchSize).toBe(250);
  });

  it("should refuse a batch of no rows, which would walk the table forever", () => {
    expect(() => parseArguments(["reduce-descriptions", "--config", "m.yaml", "--batch-size", "0"])).toThrow(UsageError);
  });

  it("should refuse a batch size that is not a number", () => {
    expect(() => parseArguments(["reduce-descriptions", "--config", "m.yaml", "--batch-size", "lots"])).toThrow(/whole number/);
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
