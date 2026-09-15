/**
 * The three list routes' own wiring: which span they fetch at, and which span their links carry.
 *
 * The estate was one page until 2026-09-02 and is `/repositories`, `/contributors` and `/teams`
 * now, each resolving the span for itself and each handing it to its own table. That resolution is
 * the same three lines three times, and a page that fetched at `windows.default` while linking at
 * the resolved span — or the reverse — type-checks perfectly and reads as a window that changes
 * when a reader follows a link. Nothing below the page can see it: `resolveWeeks` is tested on its
 * own inputs and the tables are tested on the `weeks` they are handed, so the join between them is
 * only visible from here.
 *
 * The pages are async server components reading cookies and the evidence code, so `next/headers` and
 * `@/lib/api` are stubbed and the awaited tree is handed to `renderToStaticMarkup`, exactly as
 * `repository-page.test.ts` does it.
 *
 * The stub is on `@/lib/api` rather than on `fetch`: this port calls the ported evidence code in-process, so
 * there is no HTTP client left to intercept. Each getter records the span it was asked at, which is the same
 * observation the URL's `?weeks=` used to carry.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import ContributorsPage from "@/app/contributors/page";
import RepositoriesPage from "@/app/repositories/page";
import TeamsPage from "@/app/teams/page";
import type { ActorRow, OverviewSummary, RepositoryRow, TeamRow, WindowOptions } from "@/lib/types";

const WINDOWS: WindowOptions = {
  options: [4, 12, 26],
  default: 4,
  trend_periods: 8,
  collection_stale: false
};

const OVERVIEW: OverviewSummary = {
  organization: "hmcts",
  weeks: 12,
  starts_at: "2026-06-08T00:00:00Z",
  ends_at: "2026-08-31T00:00:00Z",
  built_at: "2026-08-31T01:00:00Z",
  collected_through: "2026-08-31T00:00:00Z",
  repositories: 3,
  unavailable: 1,
  teams: 1,
  actors: 1,
  merged_pull_requests: 9,
  direct_commits: 1,
  // The reported two only: `label_counts` counts the unreportable repository nowhere, which is why
  // the readiness donut has to be told how many the span left out.
  labels: { green: 1, amber: 1 }
};

/**
 * Three repositories: one measured well, one measured badly, and one nothing could be read on.
 *
 * The third is what the donuts are counted against — no label and every field absent, so each of
 * the six bands it lands in is the ungraded one and every donut still totals three.
 */
const CLEAR_ALERTS = {
  dependabot: { open: 0, by_severity: {} },
  code_scanning: { open: 0, by_severity: {} },
  secret_scanning: { open: 0, by_severity: {} }
};

const REPOSITORIES: RepositoryRow[] = [
  {
    repository: "api",
    team: "platform",
    readiness: "green",
    required_approving_reviews: 2,
    required_status_checks: 3,
    unreviewed_substantial: "none",
    sonar_coverage: 92.5,
    security: CLEAR_ALERTS,
    sonar_security_rating: { value: 1 },
    sonar_security_issues: 0
  },
  {
    repository: "web",
    team: "platform",
    readiness: "amber",
    required_approving_reviews: 0,
    required_status_checks: 0,
    unreviewed_substantial: "above",
    sonar_coverage: 41,
    security: { ...CLEAR_ALERTS, dependabot: { open: 2, by_severity: { critical: 1, low: 1 } } },
    sonar_security_rating: { value: 2 },
    sonar_security_issues: 3
  },
  { repository: "batch", team: "platform", detail: "no window could be reported for this repository" }
];

const ACTORS: ActorRow[] = [{ login: "ada", repositories: 2, labels: ["green"] }];

const TEAMS: TeamRow[] = [{ team: "platform", repositories: 2, unavailable: 0, actors: 1, labels: { green: 1 } }];

/** Every path the stubbed service was asked for, in the order the pages asked for them. */
let requested: string[] = [];

const api = vi.hoisted(() => ({
  getWindows: vi.fn(),
  getOverview: vi.fn(),
  getRepositories: vi.fn(),
  getActors: vi.fn(),
  getTeams: vi.fn()
}));

// Mocked by path, so `api.ts` — and the Postgres pool and `server-only` guard behind it — is never loaded here.
vi.mock("@/lib/api", () => api);

vi.mock("next/headers", () => ({
  cookies: () => Promise.resolve({ get: () => undefined })
}));

/** What the client components on the page read the URL as, which a test about filtering sets. */
let search = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => undefined }),
  usePathname: () => "/repositories",
  useSearchParams: () => search
}));

/** Answer each getter from the fixtures above, recording the getter and the span it was asked at. */
function stubService(): void {
  requested = [];
  api.getWindows.mockImplementation(() => {
    requested.push("windows");
    return Promise.resolve(WINDOWS);
  });
  api.getOverview.mockImplementation((weeks: number) => {
    requested.push(`overview?weeks=${weeks}`);
    return Promise.resolve(OVERVIEW);
  });
  api.getRepositories.mockImplementation((weeks: number) => {
    requested.push(`repositories?weeks=${weeks}`);
    return Promise.resolve(REPOSITORIES);
  });
  api.getActors.mockImplementation((weeks: number) => {
    requested.push(`actors?weeks=${weeks}`);
    return Promise.resolve(ACTORS);
  });
  api.getTeams.mockImplementation((weeks: number) => {
    requested.push(`teams?weeks=${weeks}`);
    return Promise.resolve(TEAMS);
  });
}

/** The spans the data getters were asked at, which `getWindows` itself does not take. */
function spans(): string[] {
  return requested.filter((entry) => entry !== "windows").map((entry) => new URL(entry, "https://x.test").searchParams.get("weeks") ?? "none");
}

afterEach(() => {
  vi.unstubAllGlobals();
  search = new URLSearchParams();
});

describe("the three list routes", () => {
  it("fetches the repositories list at the span asked for, and links at the same one", async () => {
    stubService();
    const markup = renderToStaticMarkup(await RepositoriesPage({ searchParams: Promise.resolve({ weeks: "26" }) }));

    expect(spans()).toEqual(["26", "26"]);
    expect(markup).toContain('href="/repositories/api?weeks=26"');
    expect(markup).toContain('href="/teams/platform?weeks=26"');
  });

  it("fetches the contributors list at the span asked for, and links at the same one", async () => {
    stubService();
    const markup = renderToStaticMarkup(await ContributorsPage({ searchParams: Promise.resolve({ weeks: "26" }) }));

    expect(spans()).toEqual(["26", "26"]);
    expect(markup).toContain('href="/contributors/ada?weeks=26"');
    // The caption is the only statement of what the list is ordered by, and `ActorsTable`'s default
    // column is what makes it true: change one without the other and the page misdescribes itself.
    // The apostrophe is matched either way round because `react-dom/server` escapes it in text.
    expect(markup).toMatch(/by their repositories(&#x27;|') labels/);
  });

  it("fetches the teams list at the span asked for, and links at the same one", async () => {
    stubService();
    const markup = renderToStaticMarkup(await TeamsPage({ searchParams: Promise.resolve({ weeks: "26" }) }));

    expect(spans()).toEqual(["26", "26"]);
    expect(markup).toContain('href="/teams/platform?weeks=26"');
  });

  /**
   * The teams page says what its order is, which nothing below it can.
   *
   * The cards arrive in `cohortTeams`' order and `TeamsList` keeps it, so the page is the only place a reader is
   * told that order is by repository count. A default that moved without this line moving reads as arbitrary.
   */
  it("says the cards are ordered by what each team owns, which is the order they arrive in", async () => {
    stubService();
    const markup = renderToStaticMarkup(await TeamsPage({ searchParams: Promise.resolve({}) }));

    expect(markup).toContain("most repositories first");
  });

  /**
   * A page asked for no span falls back to the service's default, and links there too.
   *
   * This is the case a nav link arrives in: the links carry no parameter, so the span comes from the
   * cookie and then from `/windows`. A page hard-coding a span, or one linking at the span it was
   * last rendered at, reads identically until the default moves.
   */
  it("falls back to the service default where no span was asked for", async () => {
    stubService();
    const markup = renderToStaticMarkup(await RepositoriesPage({ searchParams: Promise.resolve({}) }));

    expect(spans()).toEqual(["4", "4"]);
    expect(markup).toContain('href="/repositories/api?weeks=4"');
  });

  /** A span off the list is not a span: `/windows` says what is on offer and the page keeps to it. */
  it("ignores a span the service does not offer", async () => {
    stubService();
    renderToStaticMarkup(await ContributorsPage({ searchParams: Promise.resolve({ weeks: "99" }) }));

    expect(spans()).toEqual(["4", "4"]);
  });

  /** Answer every list endpoint with nothing in it, which each of the three pages must say aloud. */
  function stubEmptyService(): void {
    stubService();
    api.getRepositories.mockResolvedValue([]);
    api.getActors.mockResolvedValue([]);
    api.getTeams.mockResolvedValue([]);
  }

  it("says so rather than drawing an empty table where a list came back empty", async () => {
    stubEmptyService();
    const markup = renderToStaticMarkup(await TeamsPage({ searchParams: Promise.resolve({}) }));

    // No longer "no team is configured": the cohort names the teams, not the file, and from 2026-09-11 an
    // estate can have owners and still no cards — where every one of them is an individual. The remedy is on
    // the repositories list, which names them, so the sentence sends a reader there.
    expect(markup).toContain("No team owns a repository in this organisation.");
    expect(markup).toContain("attributed to individuals");
  });

  /**
   * The other two lists' empty states, which are three different sentences and not one.
   *
   * An estate with no repository configured, and one whose repositories nobody contributed to at
   * this span, are different facts with different remedies — the first is a configuration that names
   * nothing, the second a window too short or a collection not run — so each page names its own.
   */
  it("names what is missing per list, with the remedy that list has", async () => {
    stubEmptyService();
    const repositories = renderToStaticMarkup(await RepositoriesPage({ searchParams: Promise.resolve({}) }));
    const contributors = renderToStaticMarkup(await ContributorsPage({ searchParams: Promise.resolve({}) }));

    expect(repositories).toContain("No repository is configured for this organisation.");
    expect(repositories).toContain("Add repositories to the configuration");
    expect(contributors).toContain("Nobody contributed to a reported repository at this span.");
    expect(contributors).toContain("Run metrics collect for the span being asked for");
    // The headline figures are still drawn: the overview answered, and zero is a figure.
    expect(repositories).toContain("Merged pull requests");
  });

  /**
   * The repositories the span could not be reported for, stated on the card it qualifies.
   *
   * `12 repositories` with two of them unreported is a different estate from twelve reported ones,
   * and the detail under the count is the only place the page says which of the two it is.
   */
  it("says how many repositories the span reported, where it could not report them all", async () => {
    stubService();
    // The fixture estate is three repositories with one of them unreportable, which is the row the
    // donuts are counted against.
    const partial = renderToStaticMarkup(await RepositoriesPage({ searchParams: Promise.resolve({}) }));
    expect(partial).toContain("2 reported");
    expect(partial).not.toContain("all reported");

    stubService();
    api.getOverview.mockResolvedValue({ ...OVERVIEW, repositories: 12, unavailable: 0 });
    const reported = renderToStaticMarkup(await RepositoriesPage({ searchParams: Promise.resolve({}) }));

    expect(reported).toContain("all reported");
  });

  /**
   * THE SIX DONUTS ARE GONE, and this asserts the absence rather than describing it.
   *
   * Five drew ways-of-working dimensions — the readiness distribution, the declared gate's two halves, unreviewed
   * substantial merges — which `/teams` now reports per team. The sixth read `sonar_coverage`, which the report
   * layer has never emitted, so it drew an all-unknown circle.
   *
   * Worth a test rather than left to the eye, because a donut reintroduced by a merge would render perfectly well
   * while drawing from a field nothing populates, and the chips are worse: the donuts were the only way to CREATE
   * one of those filters, so a chip surviving here would be a control a reader can dismiss and never apply.
   */
  it("draws no donut and no filter chip, the dimensions they carried having moved to /teams", async () => {
    stubService();
    const markup = renderToStaticMarkup(await RepositoriesPage({ searchParams: Promise.resolve({}) }));

    for (const title of ["Readiness", "Peer review enforced", "Enforces CI", "Unreviewed substantial merges", "Test coverage", "Security issues"]) {
      expect(markup).not.toContain(`>${title}</h3>`);
    }
    // A chip's own marks rather than a class shared with every heading on the page: it carried a dismiss button
    // labelled "Remove <dimension> filter" and a coloured dot styled inline from the slice's hex. Both are gone,
    // and asserting on `uppercase tracking-wide` — which the chips did use — would have failed against the section
    // headings that also use it, so the two specific marks are what this checks.
    expect(markup).not.toContain("Remove ");
    expect(markup).not.toContain("backgroundColor");
  });

  it("ignores a stale donut parameter rather than filtering the estate on it", async () => {
    // Links shared before this change carry `?coverage=high`. The page must show the whole estate: the dimension
    // no longer exists, so the honest reading is that the parameter means nothing.
    search = new URLSearchParams("coverage=high&label=green");
    stubService();
    const markup = renderToStaticMarkup(await RepositoriesPage({ searchParams: Promise.resolve({}) }));

    expect(markup).toContain('href="/repositories/api?weeks=4"');
    expect(markup).toContain('href="/repositories/web?weeks=4"');
  });

  it("keeps the term box and the four toggles, which are the controls that remain", async () => {
    stubService();
    const markup = renderToStaticMarkup(await RepositoriesPage({ searchParams: Promise.resolve({}) }));

    expect(markup).toContain('aria-label="Repository filters"');
    expect(markup).toContain("Filter by repository or team…");
    for (const visibility of ["public", "internal", "private"]) {
      expect(markup).toContain(`>${visibility}<`);
    }
  });
});
