import { SkeletonHeader, SkeletonPage, SkeletonSection } from "@/components/Skeleton";

/**
 * One team's bones: the entity header over the four sections the page always renders — the
 * repositories the team owns, its merges, its direct pushes, and the people who worked in them.
 *
 * NO READINESS DONUT, from 2026-09-15, and TWO SECTIONS MORE. This drew `SkeletonChart` above two
 * sections, which was the page as it stood before the donut was removed and before Merges and Direct
 * pushes were added — so it was wrong in both directions at once, drawing a chart that never arrives
 * and half the tables that do. `Ways of working` is deliberately not drawn: it renders only where
 * `TeamDetail.practice` was collected, and a bone for a section that is often absent would jump the
 * page the same way the donut's did.
 */
export default function LoadingTeam() {
  return (
    <SkeletonPage>
      <SkeletonHeader />
      <SkeletonSection rows={8} />
      <SkeletonSection rows={10} />
      <SkeletonSection rows={5} />
      <SkeletonSection rows={6} />
    </SkeletonPage>
  );
}
