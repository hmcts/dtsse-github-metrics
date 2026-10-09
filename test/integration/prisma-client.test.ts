import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../../src/evidence/store/prisma.ts";

/**
 * The process's one client, built the way a fresh process builds it.
 *
 * Every other case imports `prisma.ts` once and shares what it made, so none of them sees the module decide
 * anything. These reset the module registry and the `globalThis` slot, so the client is built in front of them —
 * and they reach the database through it, because a client that constructs and cannot query is the failure a pod
 * would actually show.
 */

const slot = globalThis as unknown as { prisma?: PrismaClient };
const environment = process.env.NODE_ENV;

afterEach(async () => {
  await slot.prisma?.$disconnect();
  delete slot.prisma;
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function freshClient(): Promise<PrismaClient> {
  delete slot.prisma;
  vi.resetModules();
  return (await import("../../src/evidence/store/prisma.ts")).prisma;
}

describe("the Prisma client", () => {
  it.each(["development", environment ?? "test"])("should build a client that reaches the database when NODE_ENV is %s", async (mode) => {
    vi.stubEnv("NODE_ENV", mode);

    const prisma = await freshClient();

    expect(slot.prisma).toBe(prisma);
    expect(await prisma.$queryRaw`SELECT 1 AS reached`).toEqual([{ reached: 1 }]);
  });

  it("should hand back the client already on globalThis rather than open a second pool", async () => {
    const first = await freshClient();
    vi.resetModules();

    const { prisma: second } = await import("../../src/evidence/store/prisma.ts");

    expect(second).toBe(first);
  });
});
