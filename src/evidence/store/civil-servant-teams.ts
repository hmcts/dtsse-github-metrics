import { prisma } from "./prisma.ts";
import { StorageError } from "./storage-error.ts";

/**
 * Which teams are civil servant teams, kept by hand.
 *
 * PRESENCE IS THE FLAG, as in `civil-servants.ts`: a team with no row carries no badge, and the absence makes no
 * claim. Written by `metrics civil-servant-teams`, which reads a file naming each team with or without the
 * `Civil Servant` label, flags the labelled ones and clears the rest, then stamps the collection revision so the
 * team cards are rebuilt on the next read.
 *
 * CASEFOLDED on the way in and on the way out, held so by a CHECK constraint, because the report layer keys teams
 * on the folded slug.
 */

/** Every flagged team in one organisation, folded. */
export async function civilServantTeams(organization: string): Promise<Set<string>> {
  try {
    const rows = await prisma.civilServantTeam.findMany({ where: { organization: organization.toLowerCase() }, select: { team: true } });
    return new Set(rows.map((row) => row.team));
  } catch (error) {
    throw new StorageError("could not read the civil servant teams", error);
  }
}

/**
 * Flags each team, reporting how many were not already flagged.
 *
 * `skipDuplicates`, so a team that is already flagged keeps who added it and when. Blank names and repeats in the
 * input are dropped first.
 */
export async function addCivilServantTeams(organization: string, teams: readonly string[], addedBy?: string): Promise<number> {
  const folded = foldedTeams(teams);
  if (folded.length === 0) {
    return 0;
  }
  try {
    const { count } = await prisma.civilServantTeam.createMany({
      data: folded.map((team) => ({ organization: organization.toLowerCase(), team, ...(addedBy === undefined ? {} : { addedBy }) })),
      skipDuplicates: true
    });
    return count;
  } catch (error) {
    throw new StorageError("could not add the civil servant teams", error);
  }
}

/** Removes each team's flag, reporting how many were flagged. A team with no row is not an error. */
export async function removeCivilServantTeams(organization: string, teams: readonly string[]): Promise<number> {
  const folded = foldedTeams(teams);
  if (folded.length === 0) {
    return 0;
  }
  try {
    const { count } = await prisma.civilServantTeam.deleteMany({ where: { organization: organization.toLowerCase(), team: { in: folded } } });
    return count;
  } catch (error) {
    throw new StorageError("could not remove the civil servant teams", error);
  }
}

/** The slugs trimmed, folded and deduplicated, with blanks dropped. */
function foldedTeams(teams: readonly string[]): string[] {
  return [...new Set(teams.map((team) => team.trim().toLowerCase()).filter((team) => team !== ""))];
}
