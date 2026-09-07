import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

/**
 * An axe pass over every route.
 *
 * Worth having on a dashboard whose whole vocabulary is colour: RAG bars, donut wedges and severity chips all
 * carry meaning that a contrast regression or a missing accessible name silently removes. It also partly
 * restores what dropping `eslint-plugin-jsx-a11y` gave up, since the upstream UI came without it.
 *
 * `@nightly` rather than `@smoke`, because it needs a deployed URL and runs long enough that gating every PR on
 * it would not pay for itself.
 */

const ROUTES = ["/repositories", "/teams", "/contributors"];

test.describe("accessibility @nightly", () => {
  for (const route of ROUTES) {
    test(`should raise no WCAG A or AA violations on ${route} @nightly @a11y`, async ({ page }) => {
      await page.goto(route);

      const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();

      // The violations themselves rather than a count, so a failure names the rule and the element instead of
      // reporting that a number went up.
      expect(results.violations).toEqual([]);
    });
  }
});
