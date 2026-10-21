import { prisma } from "./prisma.ts";
import { StorageError } from "./storage-error.ts";

/**
 * Which contributors are civil servants, as far as a PERSON is concerned.
 *
 * NOTHING THAT IS COLLECTED CAN ANSWER THIS. The SSO mapping does give a work address for most members, but the
 * domain is not the answer — contractors hold `@justice.gov.uk` addresses too — so the flag comes from a list
 * somebody keeps, matched to logins once by hand and stored here as logins alone. See `CivilServant` in
 * `prisma/schema.prisma` for why this is a table of its own rather than a field on the change-versioned
 * `org_people`.
 *
 * PRESENCE IS THE FLAG. There is no `false`: a login with no row is somebody nobody has said anything about, and
 * the badge's absence makes no claim, as the production badge's absence makes none.
 *
 * Written by `metrics civil-servants`, which stamps the collection revision afterwards so the built reports that
 * carry the flag are rebuilt on the next read rather than after the next collection.
 *
 * CASEFOLDED on the way in and on the way out, held so by a CHECK constraint: GitHub logins are case-insensitive,
 * and the merge facts this is joined to spell them however the author field did.
 */

/** Every flagged login in one organisation, folded. */
export async function civilServants(organization: string): Promise<Set<string>> {
  try {
    const rows = await prisma.civilServant.findMany({ where: { organization: organization.toLowerCase() }, select: { login: true } });
    return new Set(rows.map((row) => row.login));
  } catch (error) {
    throw new StorageError("could not read the civil servants", error);
  }
}

/**
 * Flags each login, reporting how many were not already flagged.
 *
 * `skipDuplicates`, so loading the same file twice adds nothing and changes nothing — including who added a row
 * and when, which stay as the first load left them. Blank lines and repeats in the input are dropped first.
 */
export async function addCivilServants(organization: string, logins: readonly string[], addedBy?: string): Promise<number> {
  const folded = foldedLogins(logins);
  if (folded.length === 0) {
    return 0;
  }
  try {
    const { count } = await prisma.civilServant.createMany({
      data: folded.map((login) => ({ organization: organization.toLowerCase(), login, ...(addedBy === undefined ? {} : { addedBy }) })),
      skipDuplicates: true
    });
    return count;
  } catch (error) {
    throw new StorageError("could not add the civil servants", error);
  }
}

/** Removes each login's flag, reporting how many were flagged. A login with no row is not an error. */
export async function removeCivilServants(organization: string, logins: readonly string[]): Promise<number> {
  const folded = foldedLogins(logins);
  if (folded.length === 0) {
    return 0;
  }
  try {
    const { count } = await prisma.civilServant.deleteMany({ where: { organization: organization.toLowerCase(), login: { in: folded } } });
    return count;
  } catch (error) {
    throw new StorageError("could not remove the civil servants", error);
  }
}

/** The logins trimmed, folded and deduplicated, with blanks dropped. */
function foldedLogins(logins: readonly string[]): string[] {
  return [...new Set(logins.map((login) => login.trim().toLowerCase()).filter((login) => login !== ""))];
}
