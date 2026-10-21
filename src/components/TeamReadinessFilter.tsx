"use client";

import { useSearchParams } from "next/navigation";
import { ReadinessFilter } from "@/components/ReadinessFilter";
import { matchesCivilServant, parseCivilServantFilter } from "@/lib/civil-servant";
import { classify, readinessTiles, teamLabels } from "@/lib/readiness";
import type { TeamRow } from "@/lib/types";

/**
 * `/teams`' readiness tiles, counted over the teams the civil-servant toggle lets through.
 *
 * `ContributorReadinessFilter` for teams, and counted in the browser for its reason: the toggle writes the URL with
 * `replaceState`, so tiles counted on the server would go on counting every team while the cards below showed only
 * the flagged ones.
 */
export function TeamReadinessFilter({ rows }: Readonly<{ rows: readonly TeamRow[] }>) {
  const parameters = useSearchParams();
  const civilServantsOnly = parseCivilServantFilter((parameter) => parameters.get(parameter));
  const counted = rows.filter((row) => matchesCivilServant(row, civilServantsOnly));
  return <ReadinessFilter tiles={readinessTiles(counted.map((row) => classify(teamLabels(row.labels))))} />;
}
