import { expect, type Page, test } from "@playwright/test";

/**
 * The estate summary wheels, and the one thing about them that only a browser can answer.
 *
 * WHY THIS IS AN E2E CASE AT ALL, when `src/components/__tests__/repositories-url-state.test.tsx` already asserts
 * that a slice narrows the table and the file without a navigation. Two of the three things a wedge depends on do
 * not exist in jsdom: recharts draws its sectors from a MEASURED width, so the ring itself — as opposed to the
 * legend entry beside it — is only clickable where something laid the page out; and the `replaceState` the click
 * writes is patched by Next's real app-router here rather than by the two-line stand-in that file installs. A
 * regression that broke either would pass the unit suite and reach a reader.
 *
 * THE FIGURES ARE NOT ASSERTED HERE. This runs against AAT, whose estate moves with every collection, so what is
 * asserted is the BEHAVIOUR — the wheels are present, a wedge narrows the list, clicking it again widens it, the
 * state is in the URL and no request is made for any of it. `src/lib/__tests__/estate.test.ts` is where the four
 * distributions are held against their measured values, over a fixture that does not move.
 */

/** The four wheels, each named by the group its legend is announced as. */
const WHEELS = ["Code owner", "Maintained", "Code scanning", "Unsuppressed CVEs"];

/**
 * Clicks the first wheel's leading wedge — the ring itself, not the legend entry beside it.
 *
 * AIMED AT A POINT ON THE RING AND NOT AT A LOCATOR'S CENTRE, which is the whole reason this helper exists. The
 * leading wedge of a near-whole circle has a bounding box the size of the circle, so its centre is inside the
 * DONUT HOLE — `locator(".recharts-pie-sector").click()` lands there, the SVG surface takes the event and the
 * click times out as intercepted. Verified against a running server before this was written.
 *
 * So the point is computed from the ring's own geometry instead: `innerRadius` 48 and `outerRadius` 68 in
 * `SummaryPieChart`, giving 58 as the middle of the band, at 45° round from three o'clock — which recharts
 * measures anticlockwise from, so it is inside the first slice of any wheel whose leading slice spans more than a
 * eighth of the circle. Every one of the four does, by a wide margin.
 */
async function clickLeadingWedge(page: Page): Promise<void> {
  const surface = page.locator(".recharts-surface").first();
  const box = await surface.boundingBox();
  if (box === null) {
    throw new Error("the first wheel drew no ring to click");
  }
  await surface.click({ position: { x: box.width / 2 + 41, y: box.height / 2 - 41 } });
}

test.describe("estate summary @regression", () => {
  test("should draw the four wheels over the public estate @regression", async ({ page }) => {
    await page.goto("/repositories");

    for (const wheel of WHEELS) {
      await expect(page.getByRole("group", { name: `${wheel} filter` })).toBeVisible();
    }
    // The cohort is stated beside the heading, because a figure whose denominator is not the table's row count
    // reads as disagreeing with the table.
    await expect(page.getByText(/public repositor(y|ies); click a slice to filter the list/)).toBeVisible();
  });

  test("should narrow the table from the ring itself and clear it on a second click @regression", async ({ page }) => {
    await page.goto("/repositories");

    const rows = page.locator("tbody tr");
    await expect(rows.first()).toBeVisible();
    const whole = await rows.count();

    // THE RING AND NOT THE LEGEND. The leading wedge of the first wheel is the team-owned repositories — a wedge a
    // reader can see and aim at, and the half of this control jsdom cannot reach.
    await expect(page.locator(".recharts-pie-sector").first()).toBeVisible();
    await clickLeadingWedge(page);

    await expect(page).toHaveURL(/[?&]owner=team/);
    await expect.poll(() => rows.count()).toBeLessThan(whole);

    await clickLeadingWedge(page);

    await expect(page).not.toHaveURL(/[?&]owner=/);
    await expect.poll(() => rows.count()).toBe(whole);
  });

  test("should filter from a legend entry and say which slice is active @regression", async ({ page }) => {
    await page.goto("/repositories");

    const rows = page.locator("tbody tr");
    await expect(rows.first()).toBeVisible();
    const whole = await rows.count();

    const owner = page.getByRole("group", { name: "Code owner filter" });
    const nobody = owner.getByRole("button", { name: /Nobody/ });
    await expect(nobody).toHaveAttribute("aria-pressed", "false");

    await nobody.click();

    // `aria-pressed` and not a fill colour, because colour is never the only carrier of a state on this site.
    await expect(nobody).toHaveAttribute("aria-pressed", "true");
    await expect(page).toHaveURL(/[?&]owner=nobody/);
    await expect.poll(() => rows.count()).toBeLessThan(whole);
  });

  test("should issue no request to the server when a wedge is clicked @regression", async ({ page }) => {
    // THE DEFECT THE WHEELS WERE REBUILT TO AVOID, asserted where the real router is mounted. `filterRepositories`
    // runs over the rows already transferred, so a `router.replace` here would refetch the whole estate behind a
    // `force-dynamic` page — which is what made an earlier control read as a button that did nothing.
    await page.goto("/repositories");
    await expect(page.locator("tbody tr").first()).toBeVisible();

    const requested: string[] = [];
    page.on("request", (request) => void requested.push(`${request.method()} ${request.url()}`));

    await page
      .getByRole("group", { name: "Maintained filter" })
      .getByRole("button", { name: /Unmaintained/ })
      .click();
    await expect(page).toHaveURL(/[?&]maintained=unmaintained/);

    expect(requested.filter((entry) => entry.includes("/repositories"))).toEqual([]);
  });

  test("should carry a filtered view in a shared link @regression", async ({ page }) => {
    // The whole reason the state is in the URL rather than in component state: a reader can send somebody the view
    // they are looking at.
    await page.goto("/repositories?owner=nobody");

    await expect(page.getByRole("group", { name: "Code owner filter" }).getByRole("button", { name: /Nobody/ })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("tbody tr").first()).toBeVisible();
  });
});
