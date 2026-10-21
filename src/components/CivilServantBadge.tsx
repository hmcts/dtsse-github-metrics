import clsx from "clsx";
import { CIVIL_SERVANT_BADGE, CIVIL_SERVANT_LABEL } from "@/lib/civil-servant";

/**
 * The `Civil servant` badge, as a word beside a person's name.
 *
 * `ProductionBadge`'s shape and its rule: it renders nothing for anything but `true`, so an unflagged person
 * shows no badge and no "not a civil servant" either — the table cannot say that, so neither does the page.
 */
export function CivilServantBadge({ civilServant, className }: Readonly<{ civilServant?: boolean; className?: string }>) {
  if (civilServant !== true) {
    return null;
  }
  return <span className={clsx("inline-block rounded px-1.5 py-0.5 text-xs whitespace-nowrap", CIVIL_SERVANT_BADGE, className)}>{CIVIL_SERVANT_LABEL}</span>;
}
