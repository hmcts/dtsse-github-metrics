import { expect, type Page, test } from "@playwright/test";

/**
 * The two sections that state REASONS rather than figures, against the real estate.
 *
 * WHY A `@regression` SPEC AND NOT ONLY UNIT COVERAGE. `repository-page.test.ts` renders this page against a fixture
 * where every block is populated; master runs this against `https://dtsse-github-metrics.aat.platform.hmcts.net` and
 * the real collection, where most repositories have at least one alert family that is off or unreadable. A section
 * that renders from a full fixture and throws on a family with no scan row is exactly the fault a green PR build
 * cannot predict, since PR builds run `@smoke` and that is the health endpoint.
 *
 * READ-ONLY, as `notes.spec.ts` is and for its reason: that release shares the real estate database with the
 * persistent AAT release readers use.
 *
 * THE REPOSITORY IS REACHED BY NAVIGATION rather than by name, also `notes.spec.ts`'s rule: any name written here is
 * one that can be archived or renamed out of the cohort, which would fail this suite for a reason that has nothing to
 * do with what it is about.
 */
async function openARepository(page: Page): Promise<void> {
  await page.goto("/repositories");
  const first = page.locator('a[href^="/repositories/"]').first();
  await expect(first).toBeVisible();
  await first.click();
  await expect(page).toHaveURL(/\/repositories\/[^/]+/);
}

/**
 * Whether the repository this run landed on has evidence for the default span at all.
 *
 * A REPOSITORY WITH NONE KEEPS ITS PAGE AND SAYS WHY — see the page's own header — and on that branch none of the
 * evidence sections is drawn, this spec's two included. That is correct behaviour and not something to assert around,
 * so a run that lands on such a repository skips rather than failing: a skip is visible in the report, where a
 * conditional assertion would quietly stop testing anything.
 */
async function hasEvidence(page: Page): Promise<boolean> {
  return (await page.getByRole("heading", { name: "Behaviour" }).count()) > 0;
}

test.describe("the reasons behind a repository's outcomes @regression", () => {
  test("should name every assurance criterion with its outcome @regression", async ({ page }) => {
    await openARepository(page);
    test.skip(!(await hasEvidence(page)), "this repository has no evidence for the default span, so no criterion is drawn");

    await expect(page.getByRole("heading", { name: "Assurance criteria" })).toBeVisible();
    // All six, by the words the estate table's columns use, so a reader moving between the pages meets one vocabulary.
    for (const label of ["Code owner", "Hygiene", "Secrets", "Security contact", "Patching cycle", "Maintained"]) {
      await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
    }
  });

  test("should state each alert family's position rather than an empty table @regression", async ({ page }) => {
    // THE ASSERTION THIS FEATURE IS JUDGED ON, and the reason it is worth running against the real estate: code
    // scanning is unmeasured for 651 repositories and not enabled for 1,074, so whichever repository this lands on is
    // very likely to have a family in one of the two states that must NOT read as clean.
    await openARepository(page);
    test.skip(!(await hasEvidence(page)), "this repository has no evidence for the default span, so no family is drawn");

    await expect(page.getByRole("heading", { name: "Alert detail" })).toBeVisible();
    for (const family of ["secret-scanning", "dependabot", "code-scanning"]) {
      await expect(page.getByRole("heading", { name: family, exact: true })).toBeVisible();
    }
    // WHAT IS NOT ASSERTED HERE, deliberately: which of the three states each family is in. That depends on the
    // collection and is not this run's to know, and the words the three states read in are held where they can be
    // controlled — `AlertDetailSection.test.tsx` drives one family into each. What is asserted here is that all three
    // families are STATED, which is the failure mode against a real estate: a family with no scan row being omitted,
    // and a reader having no way to tell an omission from a family read and found clean.
  });
});
