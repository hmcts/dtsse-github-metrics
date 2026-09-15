import clsx from "clsx";
import { ExternalLink } from "lucide-react";
import { ProductionBadge } from "@/components/ProductionBadge";
import { RAGLabel } from "@/components/RAGCard";
import { borderClass } from "@/lib/rag";
import type { ReadinessLabel } from "@/lib/types";

/**
 * The head of a repository, contributor or team page: where you are now, and nothing about how you
 * got here.
 *
 * NO BREADCRUMBS. Drill-through here is a graph, not a tree — a repository leads to its
 * contributors, a contributor back to other repositories, either to a team — so a trail would claim
 * a hierarchy that does not exist and would differ depending on which link the reader happened to
 * follow. The `context` line instead names what this entity is related to, as links onward.
 *
 * The kind is RENDERED, as the word above the entity name, which is why its members are the reader's
 * words rather than the contract's: `contributor` from 2026-09-02, where the service still calls the
 * author of a merge an actor. The page's route followed the word later the same day —
 * `/contributors/[login]`, where it was `/actors/[login]` — and the service's own `/actors` endpoints
 * and field names did not move.
 */
export type EntityKind = "repository" | "contributor" | "team";

export function EntityHeader({
  kind,
  name,
  label,
  production,
  context,
  action,
  href
}: {
  kind: EntityKind;
  name: string;
  /** Present only for a repository: contributors and teams are never graded. */
  label?: ReadinessLabel;
  /**
   * Whether this repository deploys to production, badged beside the label.
   *
   * Also a repository's alone, but unlike the label it is not a grade and not a fact about the
   * window: the header carries it even where the span holds no evidence, which is why the page
   * passes it in above the unavailable branch.
   */
  production?: boolean;
  context?: React.ReactNode;
  /** The header's own control — the week selector, which every page carries at the top right. */
  action?: React.ReactNode;
  /**
   * Where this entity lives on GitHub, as the one link on the site that leaves it.
   *
   * The whole dashboard is a report ABOUT GitHub that never pointed at it: a reader looking at an unreviewed merge
   * or a gate with no required checks had to retype the name into a new tab to go and look. Optional because only
   * a repository has an obvious destination — a contributor's profile and a team's page are both a click away
   * through the organisation, and neither is what a reader of this page came for.
   */
  href?: string;
}) {
  return (
    <header className={clsx("bg-slate-900 border border-slate-800 rounded-lg p-5 space-y-2", label === undefined ? null : borderClass(label))}>
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">{kind}</span>
        <h1 className="font-mono text-xl text-slate-100 break-all">{name}</h1>
        {label ? <RAGLabel label={label} /> : null}
        <ProductionBadge production={production} />
        {/* A PLAIN ANCHOR and not `next/link`: this leaves the app, so there is nothing to prefetch and no client
            router to involve. `rel="noreferrer"` alongside `noopener` because the destination does not need to be
            told which of our pages somebody was reading. The icon is decoration — the visible words carry the
            meaning, so it is `aria-hidden` and the link is named by its text. */}
        {href === undefined ? null : (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-sm text-indigo-400 transition-colors hover:text-indigo-300 focus:outline-none focus-visible:ring-1 focus-visible:ring-indigo-500 rounded"
          >
            View on GitHub
            <ExternalLink className="w-3 h-3" aria-hidden="true" />
          </a>
        )}

        {action ? <div className="ml-auto">{action}</div> : null}
      </div>
      {context ? <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-400">{context}</div> : null}
    </header>
  );
}
