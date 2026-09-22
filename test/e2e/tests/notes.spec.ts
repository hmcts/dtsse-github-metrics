import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

/**
 * The repository notes section, asserted WITHOUT EVER SUBMITTING ONE.
 *
 * THIS SUITE IS DELIBERATELY READ-ONLY, and that is the most important thing about it. `@regression` runs on
 * every master build against `https://dtsse-github-metrics.aat.platform.hmcts.net`, whose values set
 * `AUTH_DISABLED=true` — so a form posted from here would succeed as the anonymous author. That release shares
 * the REAL estate database with the persistent AAT release readers use (see
 * `charts/dtsse-github-metrics/values.aat.template.yaml`: "these credentials and this database are the real
 * ones"), so a spec that added a note would insert a row into production on every master build, visible to
 * actual readers, and a cleanup that flaked would leave it there for good.
 *
 * What a `@regression` spec is for here is the risk that adding a form to the repository page BREAKS the page —
 * which is exactly the failure a green PR build cannot predict, since PR builds run `@smoke` and that is the
 * health endpoint and nothing else. Rendering the section, its controls and its field is the whole of that
 * risk, and it needs no write.
 *
 * The write path is covered where it can be covered honestly: `src/app/repositories/[repository]/notes.test.ts`
 * for the session gate, and `test/integration/notes.test.ts` against a real Postgres for the table's own rules.
 *
 * THE REPOSITORY IS REACHED BY NAVIGATION rather than by a hardcoded name. Any name written here is a name that
 * can be archived or renamed out of the cohort, which would fail this suite for a reason that has nothing to do
 * with notes.
 */
async function openARepository(page: Page): Promise<void> {
  await page.goto("/repositories");
  // The first link into a repository's own page. The estate table links every row, so this finds one whatever
  // the cohort currently holds.
  const first = page.locator('a[href^="/repositories/"]').first();
  await expect(first).toBeVisible();
  await first.click();
  await expect(page).toHaveURL(/\/repositories\/[^/]+/);
}

test.describe("repository notes @regression", () => {
  test("should carry a notes section on a repository page @regression", async ({ page }) => {
    await openARepository(page);

    await expect(page.getByRole("heading", { name: "Notes" })).toBeVisible();
  });

  test("should offer a field to add a note @regression", async ({ page }) => {
    await openARepository(page);

    await expect(page.getByLabel("Add a note")).toBeVisible();
    await expect(page.getByRole("button", { name: "Add note" })).toBeVisible();
  });

  test("should state the length a note is held to @regression", async ({ page }) => {
    // The cap is stated where a writer can read it before they reach it, which is the half of the limit that
    // is a courtesy rather than a control.
    await openARepository(page);

    await expect(page.getByText(/at most \d+ characters/)).toBeVisible();
  });

  test("should raise no WCAG A or AA violations on a page carrying the form @nightly @a11y", async ({ page }) => {
    // THE FIRST INTERACTIVE CONTROL IN THE APPLICATION, so the first one that can fail an accessibility gate:
    // an unlabelled textarea, or a disclosure with no accessible name. The three list routes in
    // `accessibility.spec.ts` have no form on them, so this page is not covered by that loop.
    //
    // IT IS ALSO THE ONLY AXE SCAN OF THIS WHOLE PAGE, which since VIBE-598 is more than the form: the assurance
    // criteria and the alert detail both put their reasons here as text precisely because a `title` tooltip was not
    // readable on touch and not reliably announced, and this scan is what holds the markup they landed as — a `<dl>`
    // of pairs and a `<table>` with a caption — to the same bar. `repository-detail.spec.ts` asserts the content.
    await openARepository(page);

    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();

    expect(results.violations).toEqual([]);
  });
});
