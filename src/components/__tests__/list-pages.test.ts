/**
 * The three list routes' own wiring: which span they fetch at, and which span their links carry.
 *
 * The estate was one page until 2026-09-02 and is `/repositories`, `/contributors` and `/teams`
 * now. `/contributors` and `/teams` each resolve the span for themselves and hand it to their own table. That
 * resolution is the same three lines twice, and a page that fetched at `windows.default` while linking at
 * the resolved span — or the reverse — type-checks perfectly and reads as a window that changes
 * when a reader follows a link. Nothing below the page can see it: `resolveWeeks` is tested on its
 * own inputs and the tables are tested on the `weeks` they are handed, so the join between them is
 * only visible from here.
 *
 * `/repositories` RESOLVES NO SPAN AT ALL from 2026-09-17: it reports control state, pins `windows.default` to get
 * a bundle, and links bare. Its join is the opposite one and is asserted just as closely — that no link it draws
 * names a span — because a `weeks` parameter reintroduced there would be written into the reader's cookie by
 * `proxy` and would silently reset a window they chose elsewhere.
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
import type { ActorRow, Contributor, OverviewSummary, RepositoryRow, TeamRow, WindowOptions } from "@/lib/types";
import { UNCOLLECTED_DETAIL } from "@/lib/types";

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
  repositories: 4,
  // BOTH ROWS THAT CARRY A `detail`, which is what the report layer counts and what the windowed pages state. The
  // repositories page counts only the uncollected one of the two — see `uncollectedCount` — so this figure and the
  // one that page prints deliberately disagree, and the tests below assert on the difference.
  unavailable: 2,
  teams: 1,
  actors: 1,
  merged_pull_requests: 9,
  direct_commits: 1,
  // The reported two only: `label_counts` counts the unreportable repository nowhere, which is why
  // the readiness donut has to be told how many the span left out.
  labels: { green: 1, amber: 1 }
};

/**
 * Four repositories: one measured well, one measured badly, and two carrying a reason of a different kind each.
 *
 * The last two are the pair the repositories page has to tell apart — see the comment on them below — and they are
 * also the rows with no label and every field absent, which is what the estate's label counts are taken over.
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
  // THE TWO KINDS OF `detail`, one row each, because the repositories page treats them differently. `batch` carries
  // the merge-source sentence `unreportedDetail` produces, which explains figures that page draws no column for;
  // `ghost` carries `UNCOLLECTED_DETAIL`, which explains every column it does draw.
  {
    repository: "batch",
    team: "platform",
    detail: "no merge history was read for this repository, so its merges are unmeasured rather than none"
  },
  { repository: "ghost", team: "platform", detail: UNCOLLECTED_DETAIL }
];

const ACTORS: ActorRow[] = [{ login: "ada", repositories: 2, labels: ["green"] }];

const TEAMS: TeamRow[] = [{ team: "platform", repositories: 2, unavailable: 0, actors: 1, labels: { green: 1 } }];

/** Who the estate table's export unpacks under `platform`: one person with a profile name and one without. */
const TEAM_CONTRIBUTORS: Record<string, Contributor[]> = {
  platform: [{ login: "ef32", name: "Tam Arah" }, { login: "nameless" }]
};

/** Every path the stubbed service was asked for, in the order the pages asked for them. */
let requested: string[] = [];

const api = vi.hoisted(() => ({
  getWindows: vi.fn(),
  getOverview: vi.fn(),
  getRepositories: vi.fn(),
  getTeamContributors: vi.fn(),
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
  // The export's own read, which only `/repositories` makes: the table needs no contributors and the other two
  // pages do not export. Recorded like the rest, so the span assertions below cover it.
  api.getTeamContributors.mockImplementation((weeks: number) => {
    requested.push(`team-contributors?weeks=${weeks}`);
    return Promise.resolve(TEAM_CONTRIBUTORS);
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
  /**
   * The repositories page pins the service's default span and asks the reader for none.
   *
   * THREE READS AND NOT TWO: the overview, the rows, and the owning teams' contributors that the export unpacks.
   * All three at one span — an export scoped to a different window from the table above it would hand somebody a
   * file that disagreed with the page they took it from — and that span is `windows.default` rather than anything
   * off the URL, because the page reports no window and the default's bundle is the one already built.
   */
  it("reads the repositories list at the pinned default span, whatever the URL says", async () => {
    stubService();
    // A span in the URL is not even accepted by the page's signature now, so this is the stronger statement: the
    // reader's client-side URL carries one and nothing on the page picks it up.
    search = new URLSearchParams("weeks=26");
    const markup = renderToStaticMarkup(await RepositoriesPage());

    expect(spans()).toEqual(["4", "4", "4"]);
    expect(markup).toContain("api");
  });

  /**
   * NO DRILL-THROUGH LINK CARRIES `weeks`, which is the regression this page must never reintroduce.
   *
   * `proxy` writes any span a URL names into the `weeks` cookie. So a link out of this page that named its pinned
   * default would reset a reader who had chosen 26 weeks on the teams pages back to four — silently, on a click
   * about a repository rather than about a window. Bare paths leave the destination to resolve the remembered
   * preference. Asserted on the absence of the parameter and not just on the presence of the bare href, because
   * `toContain` on `/repositories/api` matches `/repositories/api?weeks=4` too.
   */
  it("links to a repository and to a team without naming a span", async () => {
    stubService();
    search = new URLSearchParams("weeks=26");
    const markup = renderToStaticMarkup(await RepositoriesPage());

    expect(markup).toContain('href="/repositories/api"');
    expect(markup).toContain('href="/teams/platform"');
    expect(markup).not.toContain("weeks=");
  });

  /**
   * The week selector is not on this page, and its absence is asserted rather than left to the eye.
   *
   * The control legitimately navigates — `weeks` is the only parameter read server-side — so one reintroduced here
   * would work perfectly while changing figures the page states no window for. `NavWeekSelector` is untouched and
   * still rendered by the two windowed lists, which the assertions above and below cover.
   */
  it("renders no window selector, having no window to select", async () => {
    stubService();
    const markup = renderToStaticMarkup(await RepositoriesPage());

    expect(markup).not.toContain('aria-label="Reporting window"');
    expect(markup).not.toContain("week window");
  });

  /**
   * The header states provenance and no span, and names the import gap in words that do not imply one.
   *
   * "Not reported at this span" was never a statement about a span — `spanWindow` anchors every span at the same
   * `collectedAnchor`, so the coverage comparison behind the figure returns the same answer at every one of them.
   * With no span on the page those words would name a window nothing else here mentions.
   */
  it("states the collection and the build, with no span and no span-flavoured wording", async () => {
    stubService();
    const markup = renderToStaticMarkup(await RepositoriesPage());

    expect(markup).toContain("Collected through");
    expect(markup).toContain("Report built");
    expect(markup).toContain("the last import did not reach");
    expect(markup).not.toContain("not reported at this span");
    // The window's own dates, which the header prints on the two windowed lists and must not print here.
    expect(markup).not.toContain("2026-06-08 to 2026-08-31");
  });

  /**
   * The two windowed cards name their window; the two cohort cards do not.
   *
   * `overview.actors`, `overview.merged_pull_requests` and `overview.direct_commits` are folds over the window's
   * merge cohort, so they are the only figures here a different span would move. A page with no selector that
   * showed them unlabelled would be reporting one window's throughput as though it were part of the snapshot.
   * `Repositories` and `Teams` are counted off the cohort and the ownership graph, so a window label on either
   * would be a claim about them that is not true.
   */
  it("labels the throughput cards with the window they cover, and the cohort cards not at all", async () => {
    stubService();
    const markup = renderToStaticMarkup(await RepositoriesPage());

    // TWELVE AND NOT FOUR, which is the fixture's own mismatch put to work: the report says it covers 12 weeks
    // while the span this page pins is `WINDOWS.default`, 4. So asserting on 12 proves the label is read off
    // `overview.weeks` — what the bundle actually covers — rather than written from the number the page asked for.
    expect(markup).toContain("Contributors (12 weeks)");
    expect(markup).toContain("Merged pull requests (12 weeks)");
    expect(markup).toContain("Repositories (excluding archived)");
    expect(markup).not.toContain("Teams (12 weeks)");
  });

  /** And it tracks the report rather than being pinned to one number of its own. */
  it("moves the window label when the report's own window moves", async () => {
    stubService();
    api.getOverview.mockResolvedValue({ ...OVERVIEW, weeks: 26 });
    const markup = renderToStaticMarkup(await RepositoriesPage());

    expect(markup).toContain("Merged pull requests (26 weeks)");
    expect(markup).not.toContain("(12 weeks)");
  });

  /**
   * Only the reason that explains a column this table draws is printed, and only it is counted.
   *
   * The fixture has one row of each kind. `batch`'s merge-source sentence explains merged-pull-request and
   * direct-commit figures, neither of which is a column here, so printing it put a reason for an invisible
   * absence under the name of every repository whose private-and-internal walk the App installation does not
   * cover (VIBE-590). `ghost` has nothing collected at all, which is exactly what every column here shows.
   *
   * The count follows the same rule, which is why the header says one and `overview.unavailable` says two.
   */
  it("prints and counts only the uncollected reason, not the merge-history one", async () => {
    stubService();
    const markup = renderToStaticMarkup(await RepositoriesPage());

    expect(markup).toContain(UNCOLLECTED_DETAIL);
    expect(markup).not.toContain("no merge history was read");
    // One, off the rows — not the overview's two, which counts `batch` as well.
    expect(markup).toContain("1 repository the last import did not reach");
    expect(markup).not.toContain("2 repositories the last import did not reach");
  });

  /**
   * An estate whose every repository was collected says so, and does not report the merge gap as unreported.
   *
   * The case the live estate is actually in: 1,890 active repositories, none without collected state. Arranged by
   * dropping the uncollected row rather than by emptying the list, so the merge-reason row is still present and
   * still has to be ignored — the empty case must not be reached by hardcoding it.
   */
  it("reports every repository where only the merge history was unread", async () => {
    stubService();
    api.getRepositories.mockResolvedValue(REPOSITORIES.filter((row) => row.detail !== UNCOLLECTED_DETAIL));
    const markup = renderToStaticMarkup(await RepositoriesPage());

    expect(markup).toContain("all reported");
    expect(markup).not.toContain("did not reach");
    expect(markup).not.toContain("no merge history was read");
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
   * A WINDOWED page asked for no span falls back to the service's default, and links there too.
   *
   * This is the case a nav link arrives in: the links carry no parameter, so the span comes from the cookie and
   * then from `/windows`. A page hard-coding a span, or one linking at the span it was last rendered at, reads
   * identically until the default moves.
   *
   * Asserted on `/contributors` since 2026-09-17, `/repositories` having stopped resolving a span at all — its own
   * pinned-span and bare-link tests are above. The invariant still needs holding for the two pages that do resolve
   * one, and it is the join between fetching and linking that nothing below a page can see.
   */
  it("falls back to the service default where no span was asked for", async () => {
    stubService();
    const markup = renderToStaticMarkup(await ContributorsPage({ searchParams: Promise.resolve({}) }));

    expect(spans()).toEqual(["4", "4"]);
    expect(markup).toContain('href="/contributors/ada?weeks=4"');
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
    const repositories = renderToStaticMarkup(await RepositoriesPage());
    const contributors = renderToStaticMarkup(await ContributorsPage({ searchParams: Promise.resolve({}) }));

    expect(repositories).toContain("No repository is configured for this organisation.");
    expect(repositories).toContain("Add repositories to the configuration");
    expect(contributors).toContain("Nobody contributed to a reported repository at this span.");
    expect(contributors).toContain("Run metrics collect for the span being asked for");
    // The headline figures are still drawn: the overview answered, and zero is a figure.
    expect(repositories).toContain("Merged pull requests");
  });

  /**
   * How many of the estate the last collection reached, stated on the card it qualifies.
   *
   * `4 repositories` with one of them uncollected is a different estate from four collected ones, and the detail
   * under the count is the only place the page says which of the two it is. Counted off the rows rather than off
   * `overview.unavailable` — the fixture's `unavailable` is 2 and the honest answer here is 1 — so this asserts
   * `4 - 1` and not `4 - 2`. The "all reported" arm is the test above it, which drops the uncollected row.
   */
  it("says how many repositories the collection reached, where it did not reach them all", async () => {
    stubService();
    const partial = renderToStaticMarkup(await RepositoriesPage());

    expect(partial).toContain("3 reported");
    expect(partial).not.toContain("2 reported");
    expect(partial).not.toContain("all reported");
  });

  /**
   * The cohort excludes archived repositories, and the page has to say so.
   *
   * `cohort.include_archived` defaults to `false` in `src/evidence/policy/schema.ts` and `metrics.yaml` does not
   * override it, so `selectCohort` drops every archived repository and this table has never held one. Nothing on
   * the page stated it, which left the estate's count reading as the whole organisation. On the section's `detail`
   * rather than its heading, because that is where what a section was measured over belongs.
   */
  it("says the estate is unarchived only, beside the list that excludes them", async () => {
    stubService();

    const markup = renderToStaticMarkup(await RepositoriesPage());

    expect(markup).toContain("unarchived only");
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
    const markup = renderToStaticMarkup(await RepositoriesPage());

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
    // no longer exists, so the honest reading is that the parameter means nothing. `weeks=26` rides along as the
    // other parameter an old bookmark carries, and is ignored on the same principle rather than redirected away.
    search = new URLSearchParams("coverage=high&label=green&weeks=26");
    stubService();
    const markup = renderToStaticMarkup(await RepositoriesPage());

    expect(markup).toContain('href="/repositories/api"');
    expect(markup).toContain('href="/repositories/web"');
    expect(spans()).toEqual(["4", "4", "4"]);
  });

  it("keeps the term box and the four toggles, which are the controls that remain", async () => {
    stubService();
    const markup = renderToStaticMarkup(await RepositoriesPage());

    expect(markup).toContain('aria-label="Repository filters"');
    expect(markup).toContain("Filter by repository or team…");
    for (const visibility of ["public", "internal", "private"]) {
      expect(markup).toContain(`>${visibility}<`);
    }
  });
});
