import { z } from "zod";
import type { RepositorySettings } from "../../domain/repository-settings.ts";

/**
 * The repository settings a collection stored, read back for the secure-by-design checks.
 *
 * Each block is checked on its own, so a malformed block reads as unread and the other block is kept. Unread is
 * what the assessment already reports honestly, as an informational clear, which is the right answer for a value
 * nobody can trust. A payload stored before `settings` existed has no `settings` at all and comes back `undefined`,
 * which the assessment reports the same way.
 *
 * IN `report/contract/` for `./observation.ts`'s reason: a pure function of its argument, so the suite that runs on
 * every build holds it.
 */

const actionsSchema = z.object({ enabled: z.boolean(), allowedActions: z.string().optional(), shaPinningRequired: z.boolean().optional() });
const issuesSchema = z.object({ enabled: z.boolean(), creationPolicy: z.string().optional() });

/** The settings one collection stored, or `undefined` where there are none to read. */
export function storedSettings(payload: unknown): RepositorySettings | undefined {
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }
  const stored = (payload as { settings?: unknown }).settings;
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) {
    return undefined;
  }
  const actions = actionsSchema.safeParse((stored as { actions?: unknown }).actions);
  const issues = issuesSchema.safeParse((stored as { issues?: unknown }).issues);
  return {
    ...(actions.success ? { actions: actions.data } : {}),
    ...(issues.success ? { issues: issues.data } : {})
  };
}
