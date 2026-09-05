import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { applyDatabaseUrl } from "./database-url.ts";
import { PrismaClient } from "./generated/client.js";

const connectionString = applyDatabaseUrl();

const pool = new pg.Pool({ connectionString });
const adapter = new PrismaPg(pool);

// A `globalThis` singleton, because Next.js reloads modules in development and a fresh pool per reload
// exhausts the server's connection slots within a few edits.
const globalForPrisma = globalThis as unknown as { prisma: PrismaClient | undefined };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"]
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

export type { PrismaClient } from "./generated/client.js";
