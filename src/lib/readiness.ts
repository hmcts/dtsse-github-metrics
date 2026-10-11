/**
 * The four readiness groups a team or a contributor falls into, read off the labels their repositories carry.
 *
 * ONE RULE FOR BOTH LISTS, from 2026-10-11. `/teams` and `/contributors` each state the labels behind a row, and a
 * reader wanted to count and filter them by one question — is everything this team or person owns ready, mixed, or
 * blocked — without the two pages answering it two ways. So the grouping lives here, the pages tally through it,
 * and the lists filter through it.
 *
 * THE GROUPS ARE MADE OF SUBGROUPS, and a subgroup is one COMBINATION of the three graded labels. Every non-empty
 * combination of green, amber and red is in exactly one subgroup, so a row lands in one place and a group's count
 * is always the sum of the counts shown beneath it:
 *
 *  - Ready: {Ready}, {Ready, Caution}
 *  - Review: {Ready, Caution, Blocked}, {Ready, Blocked}, {Caution}
 *  - Blocked: {Caution, Blocked}, {Blocked}
 *  - Cannot assess: nothing graded, and at least one repository the policy could not read. No subgroups.
 *
 * Caution on its own sits in Review on the user's instruction of 2026-10-11: nothing in it is ready and nothing is
 * blocked, which is the question Review asks.
 *
 * `cannot_assess` is dropped from the combination, as `combinationKey` drops it: a team with a ready repository
 * and an unreadable one is Ready, and the unreadable one is stated on the team's own page. A row with no label at
 * all — a policy switched off — is in no group and counted nowhere.
 */

import type { RAGState } from "@/lib/rag";
import { RAG_LABEL, RAG_STATES } from "@/lib/rag";
import type { ReadinessLabel } from "@/lib/types";

/** The parameter the readiness tiles write on `/teams` and `/contributors`, which the lists below them read back. */
export const READINESS_PARAMETER = "readiness";

export type ReadinessGroup = "ready" | "review" | "blocked" | "cannot_assess";

/** The labels a combination can be made of: the three the policy grades with. */
type GradedLabel = Exclude<ReadinessLabel, "cannot_assess">;

/** Where one row falls: its group, and the subgroup within it where the group has them. */
export interface ReadinessClass {
  group: ReadinessGroup;
  subgroup?: string;
}

interface GroupDefinition {
  key: ReadinessGroup;
  name: string;
  /** The colour the tile is drawn in, from the palette every label on the site is drawn in. */
  state: RAGState;
  /** Each subgroup's combination, in RAG order within it. */
  subgroups: readonly (readonly GradedLabel[])[];
}

/**
 * The groups in the order the tiles are drawn, ready first.
 *
 * Within a group the subgroups run from the better combination to the worse, which is the order `combinationKey`
 * sorts the contributor list in.
 */
const GROUPS: readonly GroupDefinition[] = [
  { key: "ready", name: "Ready", state: "green", subgroups: [["green"], ["green", "amber"]] },
  { key: "review", name: "Review", state: "amber", subgroups: [["green", "amber", "red"], ["green", "red"], ["amber"]] },
  { key: "blocked", name: "Blocked", state: "red", subgroups: [["amber", "red"], ["red"]] },
  { key: "cannot_assess", name: "Cannot assess", state: "cannot_assess", subgroups: [] }
];

/** The graded labels in RAG order, which is the order a combination's key is spelled in. */
const GRADED: readonly GradedLabel[] = ["green", "amber", "red"];

/**
 * A combination's key, which is what the URL carries for a subgroup: its labels in RAG order, joined.
 *
 * The labels rather than the words, for `PieSlice.key`'s reason — a link with `?readiness=green-red` in it has to
 * keep working when somebody rewords a tile. It never collides with a group's key, so one parameter holds either.
 */
function subgroupKey(labels: readonly GradedLabel[]): string {
  return labels.join("-");
}

/** Which group each subgroup key belongs to, built once from `GROUPS` so the two cannot disagree. */
const SUBGROUP_GROUP = new Map<string, ReadinessGroup>(GROUPS.flatMap((group) => group.subgroups.map((labels) => [subgroupKey(labels), group.key] as const)));

/** Where a row with these labels falls, or nothing where none of its repositories carries a label at all. */
export function classify(labels: readonly ReadinessLabel[]): ReadinessClass | undefined {
  const graded = GRADED.filter((label) => labels.includes(label));
  if (graded.length > 0) {
    const subgroup = subgroupKey(graded);
    // Total over every combination of the three, which `readiness.test.ts` holds it to — so this never misses.
    return { group: SUBGROUP_GROUP.get(subgroup) as ReadinessGroup, subgroup };
  }
  return labels.includes("cannot_assess") ? { group: "cannot_assess" } : undefined;
}

/**
 * The labels a team's repositories carry, off its label distribution: every label at least one repository holds.
 *
 * `not_assessed` and any key the service adds later are not labels and are left out, so a team graded nothing
 * classifies as nothing.
 */
export function teamLabels(labels: Record<string, number>): ReadinessLabel[] {
  return RAG_STATES.filter((state): state is ReadinessLabel => state !== "none" && (labels[state] ?? 0) > 0);
}

/**
 * The labels a contributor's repositories carry, read the way `ActorsTable` reads them.
 *
 * An empty list means every repository came back unreadable — but only where the policy graded anything in this
 * window, which `labelled` says and no one person's row can. Where it graded nothing, the person is in no group,
 * as an ungraded team is. An absent list, from a service older than 2026-09-02, reads as an empty one.
 */
export function contributorLabels(labels: readonly ReadinessLabel[] | undefined, labelled: boolean): readonly ReadinessLabel[] {
  if (!labelled) {
    return [];
  }
  return labels === undefined || labels.length === 0 ? ["cannot_assess"] : labels;
}

/** One count a tile shows and the key a click on it writes. */
export interface ReadinessCount {
  key: string;
  name: string;
  count: number;
}

/** A subgroup's count, with the labels it is the combination of so the tile can draw their colours. */
export interface ReadinessSubgroupCount extends ReadinessCount {
  labels: readonly GradedLabel[];
}

/** One tile: a group's count, and its subgroups' counts beneath it. */
export interface ReadinessTile extends ReadinessCount {
  state: RAGState;
  subgroups: readonly ReadinessSubgroupCount[];
}

/**
 * The four tiles, counted over every row the page holds.
 *
 * EVERY GROUP AND SUBGROUP IS RETURNED, including one counted at zero: "nobody is blocked" is a finding, and an
 * absent tile would not state it. A row in no group is counted nowhere, so the four totals can sum to fewer than
 * the rows listed.
 */
export function readinessTiles(classes: readonly (ReadinessClass | undefined)[]): ReadinessTile[] {
  const tally = (predicate: (entry: ReadinessClass) => boolean) => classes.filter((entry) => entry !== undefined && predicate(entry)).length;
  return GROUPS.map((group) => ({
    key: group.key,
    name: group.name,
    state: group.state,
    count: tally((entry) => entry.group === group.key),
    subgroups: group.subgroups.map((labels) => {
      const key = subgroupKey(labels);
      return { key, name: subgroupName(labels), labels, count: tally((entry) => entry.subgroup === key) };
    })
  }));
}

/**
 * A subgroup's words: its labels joined, and a single label marked as alone.
 *
 * "Ready only" rather than "Ready", which is also the name of the tile it sits in — two counts of one name in one
 * tile would leave a reader, and a screen reader, guessing which of them is the subgroup.
 */
function subgroupName(labels: readonly GradedLabel[]): string {
  const words = labels.map((label) => RAG_LABEL[label]);
  return words.length === 1 ? `${words[0]} only` : words.join(" + ");
}

/** Whether a key names a group or a subgroup. Anything else — a stale bookmark — reads as unfiltered. */
export function isReadinessKey(key: string): boolean {
  return GROUPS.some((group) => group.key === key) || SUBGROUP_GROUP.has(key);
}

/** Whether a row stays in a list filtered on `selected`, which is a group's key, a subgroup's, or nothing. */
export function matchesReadiness(entry: ReadinessClass | undefined, selected: string): boolean {
  if (!isReadinessKey(selected)) {
    return true;
  }
  return entry !== undefined && (entry.group === selected || entry.subgroup === selected);
}
