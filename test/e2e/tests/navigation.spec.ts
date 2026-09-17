import { expect, test } from "@playwright/test";

const ROUTES = [
  { path: "/repositories", heading: "Repositories" },
  { path: "/teams", heading: "Teams" },
  { path: "/contributors", heading: "Contributors" }
];

test.describe("navigation @regression", () => {
  for (const route of ROUTES) {
    test(`should render ${route.path} @regression`, async ({ page }) => {
      const response = await page.goto(route.path);

      expect(response?.status()).toBe(200);
      await expect(page.getByRole("link", { name: route.heading }).first()).toBeVisible();
    });
  }

  test("should redirect the root to repositories @regression", async ({ page }) => {
    await page.goto("/");

    await expect(page).toHaveURL(/\/repositories/);
  });

  /**
   * A LONGER TIMEOUT THAN THE SUITE'S, because this is the only case that lands on a span the warmer may not
   * have reached yet. The pipeline installs a fresh `-staging` release and starts testing seconds later — build
   * 30 deployed at 16:48:10 and this navigated at 16:48:26 — so the 26-week report is being built on demand
   * rather than served from the cache the warmer fills. Warm it is under a second in the pod; cold over a VPN it
   * took 40 s, which is what the default 30 s was failing on.
   *
   * The right fix is patience rather than speed: 26 weeks is a real span a reader can choose, and a cold build of
   * it is correct behaviour on a pod that started moments ago.
   */
  test("should carry the chosen span across a navigation @regression", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("/teams?weeks=26");
    await page.getByRole("link", { name: "Repositories" }).first().click();
    await expect(page).toHaveURL(/\/repositories/);

    // The span has to survive a page that does not offer one. The repositories list emits bare paths precisely so
    // that a visit to it cannot rewrite the remembered window through `proxy`, and this is the assertion that
    // holds it to that: a reader who chose 26 weeks still has 26 weeks after passing through.
    await page.getByRole("link", { name: "Teams" }).first().click();
    await expect(page.getByRole("button", { name: "26 week window" })).toHaveAttribute("aria-pressed", "true");
  });

  test("should offer every configured span @regression", async ({ page }) => {
    await page.goto("/teams");

    const selector = page.getByRole("group", { name: "Reporting window" });
    for (const weeks of [1, 4, 8, 12, 26]) {
      await expect(selector.getByRole("button", { name: `${weeks} week window` })).toBeVisible();
    }
  });

  test("should offer no span on the repositories list @regression", async ({ page }) => {
    await page.goto("/repositories");

    // The list reports the last import rather than a window, so a control that implies otherwise is the defect.
    await expect(page.getByRole("group", { name: "Reporting window" })).toHaveCount(0);
  });
});
