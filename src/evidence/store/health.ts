import { prisma } from "./prisma.ts";

/**
 * Whether Postgres is answering. Reports the failure rather than throwing, because the caller is a
 * readiness probe: it needs a status to serve, not an exception to handle.
 */
export async function checkDatabase(): Promise<DatabaseHealth> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { status: "UP" };
  } catch (error) {
    return { status: "DOWN", detail: error instanceof Error ? error.message : String(error) };
  }
}

export interface DatabaseHealth {
  status: "UP" | "DOWN";
  detail?: string;
}
