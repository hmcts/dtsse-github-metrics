import { expect, test } from "@playwright/test";

/**
 * Every other spec passed while the deployed dashboard rendered with no styling at all.
 *
 * `page.goto` resolves on the document, and asserting on a heading only needs the DOM — so a stylesheet that
 * never arrives is invisible to all of them. The front door hung on origin-compressed .css and .js, which left
 * the link tag present and correct in the HTML and `document.styleSheets` empty. These assertions are about the
 * browser having actually applied the CSS, not about the file being fetchable.
 */
test.describe("styling @regression", () => {
  test("should apply a stylesheet the browser could parse @regression", async ({ page }) => {
    await page.goto("/repositories");

    const sheets = await page.evaluate(() =>
      [...document.styleSheets].map((sheet) => {
        try {
          return sheet.cssRules.length;
        } catch {
          return -1;
        }
      })
    );

    expect(sheets.length).toBeGreaterThan(0);
    expect(Math.max(...sheets)).toBeGreaterThan(0);
  });

  test("should reach the load event, so no subresource is left hanging @regression", async ({ page }) => {
    // The failure mode was a pending request rather than a failed one: nothing errored, the page just never
    // finished. Waiting for load is what distinguishes the two.
    await page.goto("/repositories", { waitUntil: "load" });

    const pending = await page.evaluate(
      () => performance.getEntriesByType("resource").filter((entry) => (entry as PerformanceResourceTiming).responseEnd === 0).length
    );

    expect(pending).toBe(0);
  });

  test("should paint the dark theme the design depends on @regression", async ({ page }) => {
    await page.goto("/repositories");

    // Unstyled, this is rgba(0, 0, 0, 0); styled, it is the slate the whole dashboard is built on.
    await expect(page.locator("body")).toHaveCSS("background-color", "rgb(2, 6, 23)");
  });
});
