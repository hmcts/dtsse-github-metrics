import { expect, test } from "@playwright/test";

/**
 * That every route renders at all, and that the week selector's span survives a navigation.
 *
 * NOTHING HERE ASSERTS A FIGURE. A preview deploys with its CronJob disabled and an empty database, so a test
 * expecting a non-zero count would fail on a perfectly good deployment. What is asserted is structure: the page
 * came back, its heading is there, and the span the reader chose is the span the next page reads.
 */

const ROUTES = [
  { path: "/repositories", heading: "Repositories" },
  { path: "/teams", heading: "Teams" },
  { path: "/contributors", heading: "Contributors" }
];

test.describe("navigation @smoke", () => {
  for (const route of ROUTES) {
    test(`should render ${route.path} @smoke`, async ({ page }) => {
      const response = await page.goto(route.path);

      expect(response?.status()).toBe(200);
      await expect(page.getByRole("link", { name: route.heading }).first()).toBeVisible();
    });
  }

  test("should redirect the root to repositories @smoke", async ({ page }) => {
    await page.goto("/");

    await expect(page).toHaveURL(/\/repositories/);
  });

  test("should carry the chosen span across a navigation @smoke", async ({ page }) => {
    // The nav links are rendered by the layout, which Next.js hands no search parameters, so they carry no
    // `?weeks=`. The span survives through the cookie `src/proxy.ts` writes — and that middleware running in a
    // standalone build is exactly what this asserts.
    await page.goto("/repositories?weeks=26");
    await page.getByRole("link", { name: "Teams" }).first().click();
    await expect(page).toHaveURL(/\/teams/);

    await page.getByRole("link", { name: "Repositories" }).first().click();
    await expect(page.getByRole("button", { name: "26 week window" })).toHaveAttribute("aria-pressed", "true");
  });

  test("should offer every configured span @smoke", async ({ page }) => {
    await page.goto("/repositories");

    const selector = page.getByRole("group", { name: "Reporting window" });
    for (const weeks of [1, 4, 8, 12, 26]) {
      await expect(selector.getByRole("button", { name: `${weeks} week window` })).toBeVisible();
    }
  });
});
