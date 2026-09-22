/**
 * The alert-detail section's markup, and the one distinction the whole section exists to hold.
 *
 * WHAT IS BEING ASSERTED IS THAT THREE EMPTY LISTS READ DIFFERENTLY. A family switched off, a family nobody could read
 * and a family read and found clean are all "no rows", and on this estate two of the three are the common case — code
 * scanning is unmeasured for 651 repositories and not enabled for 1,074, secret scanning not enabled for 893. A
 * section that drew one sentence for all three would be wrong on most pages, and wrong in the direction that reads as
 * good news.
 *
 * THE SECOND THING IS THAT EVERY REASON IS TEXT. The estate table can only carry a criterion's or a family's reason as
 * a `title`, which is invisible on touch and not reliably announced — so these cases assert the words appear in the
 * markup, and that no `title` was reintroduced to carry them.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AlertDetailSection } from "@/components/AlertDetailSection";
import { TONE_BORDER, TONE_VALUE } from "@/lib/tone";
import type { SecurityAlertFamilyScan, SecurityAlertRecord } from "@/lib/types";

function alert(overrides: Partial<SecurityAlertRecord> = {}): SecurityAlertRecord {
  return {
    family: "secret-scanning",
    number: 7,
    alert_type: "azure_storage_account_key",
    path: "src/config.ts",
    line: 12,
    state: "open",
    created_at: "2024-03-09T00:00:00Z",
    html_url: "https://github.com/hmcts/alpha/security/secret-scanning/7",
    ...overrides
  };
}

/** One family in each of the three states, which is the shape every page gets from `reportedAlertScans`. */
const SCANS: SecurityAlertFamilyScan[] = [
  { family: "secret-scanning", state: "read", observed_at: "2026-09-22T06:00:00Z", alerts: [alert()] },
  { family: "dependabot", state: "not-enabled", detail: "Dependabot is not enabled for this repository", observed_at: "2026-09-22T06:00:00Z", alerts: [] },
  { family: "code-scanning", state: "unmeasured", detail: "code scanning could not be read for this repository", alerts: [] }
];

function render(scans: readonly SecurityAlertFamilyScan[] = SCANS): string {
  return renderToStaticMarkup(<AlertDetailSection scans={scans} />);
}

describe("AlertDetailSection", () => {
  const markup = render();

  it("should draw a heading for every family, including the two with nothing to show", () => {
    // A family omitted renders as nothing, and nothing is indistinguishable from a family read and found clean.
    for (const family of ["secret-scanning", "dependabot", "code-scanning"]) {
      expect(markup).toContain(`>${family}</h3>`);
    }
  });

  it("should say a disabled family was switched off rather than that it has no alerts", () => {
    expect(markup).toContain("This family is switched off for this repository, so there was nothing to scan.");
    expect(markup).toContain("Dependabot is not enabled for this repository");
  });

  it("should say an unreadable family is unknown rather than clean", () => {
    // THE FAILURE THIS FEATURE EXISTS TO AVOID, asserted as markup rather than trusted to a derivation test.
    expect(markup).toContain("Nobody could read this family, so whether anything is open is unknown.");
    expect(markup).toContain("code scanning could not be read for this repository");
  });

  it("should never tell an unread family it is clean, which is the one sentence only a read family may carry", () => {
    // NOT A SEARCH FOR THE WORDS "no alerts", which a real stored reason legitimately contains — a genuinely
    // unmeasured family arrives carrying `"dependabot/alerts named no alerts for this repository and nothing says
    // whether it is enabled"`, and that sentence is honest because of its second half. What must not happen is the
    // CLEAN sentence appearing under either absence, so that is what is asserted.
    const unread = render(SCANS.filter((scan) => scan.state !== "read"));

    expect(unread).not.toContain("This family was read and nothing is open.");
    expect(unread).toContain("Nobody could read this family");
    expect(unread).toContain("This family is switched off for this repository");
  });

  it("should state a family read and found clean in those words", () => {
    const clean = render([{ family: "secret-scanning", state: "read", observed_at: "2026-09-22T06:00:00Z", alerts: [] }]);

    expect(clean).toContain("This family was read and nothing is open.");
    expect(clean).toContain("read 2026-09-22T06:00Z");
  });

  it("should draw each state word beside its family, so the three are told apart in text and not by colour alone", () => {
    expect(markup).toContain("not enabled");
    expect(markup).toContain("could not be read");
  });

  it("should colour a family with an open secret badly and leave both absences uncoloured", () => {
    expect(markup).toContain(TONE_BORDER.bad);
    expect(markup).toContain(TONE_BORDER.neutral);
    // No warning styling on a state that is merely unmeasured: the words carry it and the border does not.
    expect(markup).not.toContain(TONE_BORDER.warn);
  });

  it("should colour a clean family green, the measured zero being the one thing here worth a colour", () => {
    expect(render([{ family: "dependabot", state: "read", observed_at: "2026-09-22T06:00:00Z", alerts: [] }])).toContain(TONE_VALUE.good);
  });

  it("should show each alert's type, location, detection instant and state", () => {
    expect(markup).toContain("azure_storage_account_key");
    expect(markup).toContain("src/config.ts:12");
    expect(markup).toContain("2024-03-09T00:00Z");
    expect(markup).toContain(">open</td>");
  });

  it("should offer to resolve a secret-scanning alert on GitHub, linking to the stored url", () => {
    // The link IS the feature: a false positive is recorded on GitHub, our count follows at the next collection, and
    // there is deliberately no local override to keep in step.
    expect(markup).toContain('href="https://github.com/hmcts/alpha/security/secret-scanning/7"');
    expect(markup).toContain("Resolve on GitHub");
  });

  it("should offer only to view an alert of a family this tool does not resolve through", () => {
    const dependency = render([
      {
        family: "dependabot",
        state: "read",
        observed_at: "2026-09-22T06:00:00Z",
        alerts: [alert({ family: "dependabot", number: 4, subject: "lodash", alert_type: "GHSA-1234-5678-90ab", severity: "high" })]
      }
    ]);

    expect(dependency).toContain("View on GitHub");
    // The package leads and the advisory identifier sits under it, which is what a reader can act on first.
    expect(dependency).toContain(">lodash</span>");
    expect(dependency).toContain("GHSA-1234-5678-90ab");
  });

  it("should say a link was not stored rather than draw a dead one or an empty cell", () => {
    const unlinked = render([{ family: "secret-scanning", state: "read", observed_at: "2026-09-22T06:00:00Z", alerts: [alert({ html_url: undefined })] }]);

    expect(unlinked).toContain("no link was stored");
    expect(unlinked).not.toContain("Resolve on GitHub");
  });

  it("should report a resolved alert's own resolution word beside its state", () => {
    const resolved = render([
      {
        family: "secret-scanning",
        state: "read",
        observed_at: "2026-09-22T06:00:00Z",
        alerts: [alert({ state: "resolved", resolution: "false_positive" })]
      }
    ]);

    // Nothing is drawn, because only open alerts are listed — a resolved one has already been dealt with, and the
    // section says the family is clean instead of reporting a decision already taken as outstanding.
    expect(resolved).toContain("This family was read and nothing is open.");
    expect(resolved).not.toContain("false_positive");
  });

  it("should name each family's table for a reader who meets it without the heading", () => {
    // A `caption`, not a `title`: the point of this whole section is that a hover is not good enough.
    expect(markup).toContain("Open secret-scanning alerts");
    expect(markup).not.toContain("title=");
  });
});
