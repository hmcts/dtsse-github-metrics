import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const ROUTES = ["/repositories", "/teams", "/contributors"];

test.describe("accessibility @nightly", () => {
  for (const route of ROUTES) {
    test(`should raise no WCAG A or AA violations on ${route} @nightly @a11y`, async ({ page }) => {
      await page.goto(route);

      const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();

      expect(results.violations).toEqual([]);
    });
  }
});
