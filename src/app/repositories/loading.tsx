import { SkeletonCards, SkeletonHeader, SkeletonPage, SkeletonSection } from "@/components/Skeleton";

/**
 * The landing page's bones: the organisation header, the four estate figures and the repositories
 * table, in that order and at those sizes.
 *
 * The one page whose skeleton is not just a header over a table, because it is the one page carrying
 * figures above its list — a reader arriving here on a cold span should see the shape they are about
 * to get rather than a table that then has three blocks pushed in above it.
 *
 * NO DONUT BONES, from 2026-09-15. This drew `SkeletonChart count={6}` until the six donuts were
 * removed from the page on 2026-09-14 and the skeleton was left behind — roughly 750px of animated
 * placeholder for content that never arrives, which is the layout jump `Skeleton.tsx` exists to
 * prevent, running in reverse. The three blocks above are what the page actually renders.
 */
export default function LoadingRepositories() {
  return (
    <SkeletonPage>
      <SkeletonHeader />
      <SkeletonCards count={4} />
      <SkeletonSection rows={12} />
    </SkeletonPage>
  );
}
