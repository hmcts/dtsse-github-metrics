import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import config from "../../../tailwind.config";

const SOURCE = fileURLToPath(new URL("../../", import.meta.url));

const UNSCANNED = new Set(["__tests__", "evidence", "cli", "health", "auth"]);

function scanned(): string[] {
  const globs = Array.isArray(config.content) ? config.content : [];
  return globs
    .filter((glob): glob is string => typeof glob === "string")
    .map((glob) => /^\.\/src\/([^/*]+)\//.exec(glob)?.[1])
    .filter((name): name is string => name !== undefined);
}

describe("tailwind content", () => {
  it("scans every source directory, so no class string goes unemitted", () => {
    const directories = readdirSync(SOURCE, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !UNSCANNED.has(entry.name))
      .map((entry) => entry.name);
    expect(directories.length).toBeGreaterThan(0);
    expect([...scanned()].sort()).toEqual([...directories].sort());
  });

  it("scans the directory the RAG classes are declared in", () => {
    expect(scanned()).toContain("lib");
  });
});
