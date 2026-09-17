import { contributorLabel } from "@/lib/person";
import { memberRole } from "@/lib/team";
import type { TeamMemberRow } from "@/lib/types";

/**
 * Who GitHub says is in one team, alphabetically by login.
 *
 * NOT THE CONTRIBUTOR TABLE WITH DIFFERENT ROWS. `TeamActorsTable` counts what somebody did inside the team, and
 * every column it has is a count; this table has none, because membership is not a measurement of anything anybody
 * did. A member who wrote nothing all window belongs here in full standing, and a figure beside their name would
 * invite exactly the reading this section exists to prevent.
 *
 * NOBODY HERE IS LINKED, which is the one visible difference from every other person on the site. `/contributors/`
 * pages are built from the window's merges — `getActor` refuses a login that landed nothing in it — so linking a
 * member would send a reader to a not-found page for precisely the people this section is here to name, and
 * linking only the ones who happen to have merged would make the column's own formatting say which. The
 * contributor table below carries the links.
 *
 * `contributorLabel` is the same rule every other person on the site is named by: the name where the organisation
 * graph holds one, the login where it does not, and the login shown underneath either way — see `ContributorName`,
 * whose two-line shape this follows without its anchor.
 */
export function TeamMembersTable({ rows }: { rows: readonly TeamMemberRow[] }) {
  return (
    // No border of its own: the table sits inside a `Section` panel that already draws one.
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="text-slate-400 border-b border-slate-800">
          <tr>
            <th scope="col" className="py-2 pl-3 pr-3 text-left font-medium">
              Member
            </th>
            {/* GitHub's own standing in the team, which is a fact about the person and not a grade of them. */}
            <th scope="col" className="py-2 pr-3 text-right font-medium">
              Role in team
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800/50">
          {rows.map((row) => (
            <tr key={row.login} className="hover:bg-slate-800/30">
              <td className="py-2 pl-3 pr-3">
                {/* Mono where the login is the only line, for `ContributorName`'s reason: a mono line is a machine
                    identifier and a proper-case line in the body font is a person's name, so a mixed column is
                    never ambiguous about which of the two a row is showing. */}
                <p className={row.name === undefined ? "font-mono text-slate-300 break-all" : "text-slate-300 break-all"}>{contributorLabel(row)}</p>
                {row.name === undefined ? null : <p className="font-mono text-slate-500 mt-0.5 break-all">{row.login}</p>}
              </td>
              <td className="py-2 pr-3 text-right text-slate-300">{memberRole(row)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
