import type * as contract from "../../../lib/types.ts";
import { UNCOLLECTED_DETAIL } from "../../../lib/types.ts";
import type { ReadinessPolicy } from "../../assessment/assessment.ts";
import type { CveEvidence } from "../../domain/cves.ts";
import type { Merges } from "../../domain/facts.ts";
import { requiredApprovals, requiredContexts } from "../../domain/merge-gate.ts";
import type { SecurityAlertEvidence } from "../../domain/security-alerts.ts";
import type { CohortEntry } from "../../org/cohort.ts";
import { type ProductionLayers, reportedProduction } from "../../store/production-override.ts";
import { reportedAssurance } from "../contract/assurance.ts";
import { cveReport } from "../contract/cve.ts";
import { storedGate } from "../contract/merge-gate.ts";
import { reportedAlerts } from "../contract/security.ts";
import type { MeasuredRow } from "../measured.ts";
import { behaviourFigures, unreportedDetail } from "./figures.ts";

/**
 * One row of the estate table, whether this window could be reported for the repository or not.
 *
 * PURE OVER WHAT IT IS HANDED, and that is what keeps the cost of the estate proportional to the estate rather than
 * to the estate times a round trip: the state, the merges, the two production layers, the measured-ness and the
 * readiness policy all arrive resolved. `buildEstateReports` in `../reports.ts` states what each read cost before it
 * was hoisted out of this path.
 */

/**
 * One repository's row, whether this window could be reported for it or not.
 *
 * `teams` carries every owner and `team` carries the first of them. Both, rather than widening `team` to a
 * list: every component that renders a row reads `team` as a string, and `src/lib/**` is held at 100%
 * coverage, so widening it would be a large change to prove for no gain a second field does not give. That
 * `team` is the first owner in the reporting order is a STATED CONVENTION, not a claim that there is only
 * one — silent truncation is the failure mode here, and naming the rule is the fix.
 *
 * `owner_kind` is what those names ARE, and it is sent on EVERY ROW rather than only on the person-owned
 * ones. A team slug and a login are the same shape, so a reader with the names alone cannot tell them apart:
 * the estate table needs it to mark an individually-owned repository and to not link one to a team page that
 * no longer exists, since `/teams` lists teams only. Always present, so an absent field means an older
 * service and nothing about this repository — the rule `ActorRow.labels` follows.
 *
 * THE POLICY IS HANDED IN AND NOT BUILT HERE. `readinessPolicy` closes over the assessment and triviality blocks and
 * has no per-row state, so constructing one inside this function was roughly 1,880 constructions per span and five
 * spans per warm — in a path whose own header records a 7.89s to 0.71s tuning. It is built once per report build.
 */
export function repositoryRow(
  policy: ReadinessPolicy,
  entry: CohortEntry,
  state: { fetchedAt: Date; payload: unknown } | undefined,
  merges: Merges,
  production: ProductionLayers,
  measured: MeasuredRow,
  cves: CveEvidence | undefined
): contract.RepositoryRow {
  const teams = entry.owners;
  const ownerKind = entry.ownerKind;
  const repository = entry.repository;
  const team = teams[0] ?? "";
  // Absent for the ordinary single-owner repository, so a reader is not shown a one-element list restating
  // `team` on every row of an estate where sharing is the exception.
  const shared = teams.length > 1 ? teams : undefined;

  // WHAT A REPOSITORY IS, rather than what happened in the window, so these are on BOTH branches — the rule
  // `owner_kind` already follows. `pushed_at` is the table's default sort and `visibility` its default filter,
  // so a row missing either would sort and filter as unmeasured on a fact the graph knows perfectly well.
  //
  // `pushed_at` is an ISO STRING and never a `Date`. `stripAbsent` passes a `Date` through untouched and
  // `SortValue` has no `Date` case, so a raw one would fall to `String(...).localeCompare(...)` and sort
  // alphabetically by weekday name — plausible-looking and wrong. Every other instant on the contract is a
  // string for the same reason; `builtOverviewSummary` in `../overview.ts` is the pattern.
  const facts = {
    owner_kind: ownerKind,
    pushed_at: entry.pushedAt?.toISOString(),
    visibility: reportedVisibility(entry.visibility),
    archived: entry.archived,
    unmaintained: entry.unmaintained,
    assurance: reportedAssurance(entry, state?.payload),
    // ON BOTH BRANCHES OF MEASURED-NESS, and not because the answer is cheap: a published CVE report is a fact
    // about the repository that came from the Jenkins pipeline, so whether THIS tool walked the repository's
    // merge history has no bearing on it. Withholding the figures from an uncollected row would report a
    // repository whose scan found four critical CVEs as having no CVE information, on the strength of an
    // unrelated collection having failed.
    cves: cveReport(cves)
  };

  if (state === undefined) {
    // Nothing collected: the row exists so the estate is complete, and says why it carries no figures.
    //
    // THE PRODUCTION ANSWER IS ON THIS BRANCH TOO, on `owner_kind`'s precedent and for a stronger reason: two of
    // its three layers are STATEMENTS rather than observations, so a repository nobody has collected can still be
    // named in `production_repositories` or marked in the column, and answering nothing there would make policy
    // conditional on a walk having happened. The approvals list is passed as unread — that answer really does
    // live in the collected payload — so nothing here can invent a `false`.
    return {
      repository,
      team,
      teams: shared,
      ...facts,
      ...reportedRowProduction(undefined, production, repository),
      // The contract's own constant, not a literal: this is the one `detail` a page can print without also
      // rendering merge figures, so `uncollectedDetail` selects on it and both sides must spell it identically.
      detail: UNCOLLECTED_DETAIL
    };
  }

  const gate = storedGate(state.payload);
  const assessment = policy.enabled ? policy.assess(merges, gate) : undefined;
  const payload = state.payload as { securityAlerts?: SecurityAlertEvidence; deploysToProduction?: boolean };

  return {
    repository,
    team,
    teams: shared,
    ...facts,
    // GRADED ON BOTH BRANCHES OF MEASURED-NESS, unlike the figures below, and the label is why: an unread merge
    // history grades `cannot_assess` through `insufficient-merges`, which is the right verdict for a repository
    // nobody walked. Suppressing it would take 650 repositories out of the readiness distribution the donut
    // accounts for, to say in an absence what the label already says in a word.
    readiness: assessment?.label,
    // The two gate figures are ABSENT where there is no gate to read them off, rather than zero: a repository
    // whose rules nobody may see is not a repository requiring no reviews.
    required_approving_reviews: gate.gate === undefined ? undefined : requiredApprovals(gate.gate),
    required_status_checks: gate.gate === undefined ? undefined : requiredContexts(gate.gate).length,
    ...behaviourFigures(policy, merges, measured),
    security: reportedAlerts(payload.securityAlerts),
    // THE COLUMN OVER THE UNION OF THE TWO LISTS, in both directions, and `undefined` where none of the three has
    // an answer — `reportedProduction` holds the whole rule, including the fold that lets a repository the graph
    // spells `PCS-API` be listed as `pcs-api`. Absent stays absent: an unread approvals list, a configured list
    // that does not name it and nobody with an opinion reports no key at all rather than a confident `false`.
    //
    // `production_source` rides beside it because the answer now has three possible authors — see
    // `ProductionSource`. Absent exactly where `production` is, so a reader cannot meet a provenance for an
    // answer nobody gave.
    ...reportedRowProduction(payload.deploysToProduction, production, repository),
    detail: unreportedDetail(gate, measured)
  };
}

/**
 * One repository's visibility, folded to the case the contract compares by, or nothing for a word it does not name.
 *
 * NARROWED RATHER THAN CAST, for the reason `medianOf` in `../contract/observation.ts` is. `CohortEntry.visibility`
 * is a `string` because `org_repositories` stores whatever GitHub answered, and the contract declares three words —
 * so a lower-cased string is not a `Visibility` and the compiler is right to say so. A fourth visibility GitHub
 * introduces reads as UNMEASURED here, which is the contract's own rule for a fact nothing could answer:
 * `selectCohort` then leaves the row out of a visibility filter rather than admitting it under a word no filter
 * offers, and no reader meets a value its own union does not hold. Casting instead would put that word on the wire
 * and take the filter down.
 */
function reportedVisibility(visibility: string): contract.Visibility | undefined {
  const folded = visibility.toLowerCase();
  return folded === "public" || folded === "internal" || folded === "private" ? folded : undefined;
}

/**
 * The production answer in the row's own spelling: `production` and, where something answered, `production_source`.
 *
 * SNAKE_CASE HERE AND NOWHERE ELSE, which is the same seam `reportedAlerts` crosses: the rule returns a domain
 * answer and this names it as the UI contract does. Both keys pass through `undefined` for `stripAbsent` to drop
 * rather than being conditionally spread, because the pair is absent or present together and one test of that is
 * enough.
 */
function reportedRowProduction(
  deploysToProduction: boolean | undefined,
  layers: ProductionLayers,
  repository: string
): Pick<contract.RepositoryRow, "production" | "production_source"> {
  const answer = reportedProduction(deploysToProduction, layers, repository);
  return { production: answer.production, production_source: answer.source };
}
