"use client";

import { useSearchParams } from "next/navigation";
import { ReadinessFilter } from "@/components/ReadinessFilter";
import { matchesCivilServant, parseCivilServantFilter } from "@/lib/civil-servant";
import { classify, contributorLabels, readinessTiles } from "@/lib/readiness";
import type { ActorRow } from "@/lib/types";

/**
 * `/contributors`' readiness tiles, counted over the people the civil-servant toggle lets through.
 *
 * COUNTED IN THE BROWSER, unlike `/teams`' tiles, because the toggle is: it writes the URL with `replaceState`
 * and nothing re-renders on the server, so tiles counted there would keep showing everybody while the list below
 * showed only civil servants. With the toggle on, the tiles answer "how ready are the civil servants".
 *
 * ONLY THAT TOGGLE MOVES THEM. The filter box still does not, for `ReadinessFilter`'s reason — a figure that
 * changed with every keystroke could not be quoted — and the tiles do not move with their own selection either,
 * or picking a group would zero every other count.
 */
export function ContributorReadinessFilter({ rows, labelled }: Readonly<{ rows: readonly ActorRow[]; labelled: boolean }>) {
  const parameters = useSearchParams();
  const civilServantsOnly = parseCivilServantFilter((parameter) => parameters.get(parameter));
  const counted = rows.filter((row) => matchesCivilServant(row, civilServantsOnly));
  return <ReadinessFilter tiles={readinessTiles(counted.map((row) => classify(contributorLabels(row.labels, labelled))))} />;
}
