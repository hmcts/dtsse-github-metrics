import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/evidence/store/prisma.ts";
import { type RepositoryStatePayload, recordRepositoryState, storedRepositoryState } from "../../src/evidence/store/repository-state.ts";

/**
 * The repository state store, against the `jsonb` column it writes to.
 *
 * What a TypeScript signature cannot show is the round trip: a `Date` in the payload goes in as an object and comes
 * back as the ISO string `jsonb` holds, and an `undefined` field is dropped rather than stored. Both are what the
 * readers of `payload` are written against, so they are asserted here and not assumed.
 */

const ORGANIZATION = "hmcts";
const FIRST = new Date(Date.UTC(2026, 8, 1, 2));
const SECOND = new Date(Date.UTC(2026, 8, 2, 2));

function state(overrides: Partial<RepositoryStatePayload> = {}): RepositoryStatePayload {
  return {
    defaultBranch: "main",
    fetchedAt: FIRST,
    securityAlerts: { dependabot: { open: 0 }, codeScanning: { open: 2 }, secretScanning: {} },
    ...overrides
  };
}

async function wipe(): Promise<void> {
  await prisma.repositoryState.deleteMany();
}

beforeEach(wipe);

afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

describe("recordRepositoryState", () => {
  it("should store what a collection observed, as the JSON the readers parse", async () => {
    await recordRepositoryState(ORGANIZATION, "pcs-api", state({ deploysToProduction: undefined }));

    expect(await storedRepositoryState(ORGANIZATION, "pcs-api")).toEqual({
      fetchedAt: FIRST,
      payload: {
        defaultBranch: "main",
        fetchedAt: FIRST.toISOString(),
        securityAlerts: { dependabot: { open: 0 }, codeScanning: { open: 2 }, secretScanning: {} }
      }
    });
  });

  it("should replace the last collection's state rather than keep both", async () => {
    await recordRepositoryState(ORGANIZATION, "pcs-api", state({ deploysToProduction: true }));

    await recordRepositoryState(ORGANIZATION, "pcs-api", state({ fetchedAt: SECOND, defaultBranch: "master" }));

    expect(await prisma.repositoryState.count()).toBe(1);
    const stored = await storedRepositoryState(ORGANIZATION, "pcs-api");
    expect(stored?.fetchedAt).toEqual(SECOND);
    expect(stored?.payload).toMatchObject({ defaultBranch: "master" });
    expect(stored?.payload).not.toHaveProperty("deploysToProduction");
  });
});

describe("storedRepositoryState", () => {
  it("should answer nothing for a repository no collection has reached", async () => {
    expect(await storedRepositoryState(ORGANIZATION, "never-collected")).toBeUndefined();
  });
});
