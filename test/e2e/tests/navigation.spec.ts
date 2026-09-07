import { expect, test } from "@playwright/test";

const ROUTES = [
  { path: "/repositories", heading: "Repositories" },
  { path: "/teams", heading: "Teams" },
  { path: "/contributors", heading: "Contributors" }
];

test.describe("navigation @smoke @regression", () => {
  for (const route of ROUTES) {
    test(`should render ${route.path} @smoke @regression`, async ({ page }) => {
      const response = await page.goto(route.path);

      expect(response?.status()).toBe(200);
      await expect(page.getByRole("link", { name: route.heading }).first()).toBeVisible();
    });
  }

  test("should redirect the root to repositories @smoke @regression", async ({ page }) => {
    await page.goto("/");

    await expect(page).toHaveURL(/\/repositories/);
  });

  test("should carry the chosen span across a navigation @smoke @regression", async ({ page }) => {
    await page.goto("/repositories?weeks=26");
    await page.getByRole("link", { name: "Teams" }).first().click();
    await expect(page).toHaveURL(/\/teams/);

    await page.getByRole("link", { name: "Repositories" }).first().click();
    await expect(page.getByRole("button", { name: "26 week window" })).toHaveAttribute("aria-pressed", "true");
  });

  test("should offer every configured span @smoke @regression", async ({ page }) => {
    await page.goto("/repositories");

    const selector = page.getByRole("group", { name: "Reporting window" });
    for (const weeks of [1, 4, 8, 12, 26]) {
      await expect(selector.getByRole("button", { name: `${weeks} week window` })).toBeVisible();
    }
  });
});
