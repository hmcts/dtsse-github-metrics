import clsx from "clsx";
import Link from "next/link";
import { contributorLabel } from "@/lib/person";
import type { Contributor } from "@/lib/types";
import { withWeeks } from "@/lib/weeks";

/**
 * One person in a table cell: their name, with their login under it.
 *
 * A PRIMARY VALUE AND A SECONDARY ONE, which is the shape this site already uses for a cell that has two things
 * to say — the estate table's Repository cell leads on the name and puts the row's `detail` under it in dimmer
 * text, and `MetricCard` leads on a figure and puts what it was measured over beneath. This follows it rather
 * than inventing a "Name" column beside a "Login" one, which would leave 58% of an already wide table blank.
 *
 * THE LOGIN IS SHOWN AS WELL AS THE NAME, never instead of it. A reader needs the login to find the person on
 * GitHub, and the mixed column has to be unambiguous about which of the two it is showing on any given row —
 * so the login is the one thing on the row rendered `font-mono`, which is what this codebase already reserves
 * for machine identifiers and what every other login and repository name on the site is drawn in. A proper-case
 * line in the body font is a name; a mono line is a login; and where GitHub holds no name the mono login is the
 * only line, so it is never in doubt.
 *
 * THE SECOND LINE IS OMITTED AND NOT EMPTIED where there is no name. `contributorLabel` has already put the login
 * on the first line in that case, so a second copy of it would be noise — and an element rendered for an absent
 * value is how a team card came to read " contributors" with no figure in front of it.
 *
 * THE LINK IS ON THE PRIMARY LINE ONLY, as the Repository cell's is. One target per row, whichever value is
 * leading it, so a reader clicking what they can see always reaches the same page.
 */
export function ContributorName({ person, weeks }: { person: Contributor; weeks: number }) {
  const label = contributorLabel(person);
  return (
    <>
      <Link
        href={withWeeks(`/contributors/${encodeURIComponent(person.login)}`, weeks)}
        className={clsx("text-indigo-400 hover:text-indigo-300 break-all", person.name === undefined && "font-mono")}
      >
        {label}
      </Link>
      {person.name === undefined ? null : <p className="font-mono text-slate-500 mt-0.5 break-all">{person.login}</p>}
    </>
  );
}
