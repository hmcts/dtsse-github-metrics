/**
 * One team's page: which span it reads at, what it counts, and what it refuses to combine.
 *
 * The rule this page is built around is that a team is COUNTED and never graded. There is no team
 * label, no team score and no comparison against another team anywhere on it — the reversal of
 * 2026-09-01 permitted per-team counts for display and nothing beyond them — so what is asserted
 * here is the label distribution as counts, the two headline counts beside them, and the absence of
 * any verdict about the team itself. The rest is the join no component below can see: the span the
 * team was fetched at is the span its repository and contributor links carry.
 *
 * Stubbed as `repository-page.test.ts` and `contributor-page.test.ts` stub theirs: `next/headers`
 * for the cookie, `next/navigation` for the router the week selector owns and for `notFound`, and
 * `fetch` for the service.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TeamPage, { dynamic } from "@/app/teams/[team]/page";
import { RepositoryUnknownError } from "@/lib/not-found";
import type { RepositoryRow, TeamActorRow, TeamDetail, WindowOptions } from "@/lib/types";

const WINDOWS: WindowOptions = {
  options: [4, 12, 26],
  default: 4,
  trend_periods: 8,
  collection_stale: false
};

/** The `weeks` cookie this render sees, which a test sets to reach the second resolution step. */
let cookie: string | undefined;

vi.mock("next/headers", () => ({
  cookies: () => Promise.resolve({ get: () => (cookie === undefined ? undefined : { value: cookie }) })
}));

/** What the donut and the table below it read the URL as, which the filtering case sets. */
let search = new URLSearchParams();

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("notFound");
  },
  useRouter: () => ({ replace: () => undefined }),
  usePathname: () => "/teams/platform",
  useSearchParams: () => search
}));

const REPOSITORIES: RepositoryRow[] = [
  { repository: "api", team: "platform", readiness: "green" },
  { repository: "web", team: "platform", readiness: "amber" }
];

const ACTORS: TeamActorRow[] = [
  { login: "ada", repositories: 2, contributions: 9 },
  { login: "grace", repositories: 1, contributions: 3 }
];

/** One team, full in every block the page draws, before any narrowing. */
function team(): TeamDetail {
  return {
    team: "platform",
    repositories: REPOSITORIES,
    actors: ACTORS,
    unavailable: 0,
    labels: { green: 1, amber: 1 }
  };
}

/** Every path the stubbed service was asked for, in the order the page asked for them. */
let requested: string[] = [];

/**
 * Answer `/windows` and `/teams/<team>` from the fixtures, at whatever the case is about.
 *
 * `status` is how a refusal is chosen: 404 for an identifier the configuration does not hold, and
 * anything else for a fault the page must surface rather than dress up as a team nobody configured.
 */
const api = vi.hoisted(() => ({ getWindows: vi.fn(), getTeam: vi.fn() }));

// Mocked by path, so `api.ts` — and the Postgres pool and `server-only` guard behind it — is never loaded here.
vi.mock("@/lib/api", async () => {
  const { RepositoryUnknownError, isNotFound } = await import("@/lib/not-found");
  return { ...api, RepositoryUnknownError, isNotFound };
});

function stubService(change: (detail: TeamDetail) => TeamDetail = (detail) => detail, status = 200): void {
  requested = [];
  const detail = change(team());
  api.getWindows.mockImplementation(() => {
    requested.push("windows");
    return Promise.resolve(WINDOWS);
  });
  api.getTeam.mockImplementation((name: string, weeks: number) => {
    requested.push(`team?weeks=${weeks}`);
    if (status === 404) {
      // A name the configuration does not hold. The page branches on the TYPE now, where it used to branch on a
      // status: there is no response left to carry one.
      return Promise.reject(new RepositoryUnknownError(`${name} is not configured`));
    }
    if (status !== 200) {
      return Promise.reject(new Error("the evidence could not be read"));
    }
    return Promise.resolve(detail);
  });
}

/** The span the team was read at, which `/windows` itself does not take. */
function span(): string | null {
  const entry = requested.find((each) => each !== "windows");
  return entry === undefined ? "none" : new URL(entry, "https://x.test").searchParams.get("weeks");
}

async function render(weeks?: string): Promise<string> {
  const page = await TeamPage({
    params: Promise.resolve({ team: "platform" }),
    searchParams: Promise.resolve(weeks === undefined ? {} : { weeks })
  });
  return renderToStaticMarkup(page);
}

beforeEach(() => {
  cookie = undefined;
  search = new URLSearchParams();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the team page", () => {
  it("names the team and counts what it holds and who worked in it", async () => {
    stubService();
    const markup = await render();

    expect(markup).toContain(">platform<");
    expect(markup).toContain("team");
    expect(markup).toContain("2 repositories");
    expect(markup).toContain("2 contributors");
  });

  it("reads the team at the span asked for, and links at the same one", async () => {
    stubService();
    const markup = await render("26");

    expect(span()).toBe("26");
    expect(markup).toContain('href="/repositories/api?weeks=26"');
    expect(markup).toContain('href="/contributors/ada?weeks=26"');
  });

  it("falls back to the reader’s cookie, and then to the service default", async () => {
    cookie = "12";
    stubService();
    expect(await render()).toContain('href="/repositories/api?weeks=12"');
    expect(span()).toBe("12");

    cookie = undefined;
    stubService();
    expect(await render()).toContain('href="/repositories/api?weeks=4"');
    expect(span()).toBe("4");
  });

  /**
   * The unreported count, which is what makes the other two readable.
   *
   * Six repositories with two unreported is a different window from six with none, and the label
   * counts under it only add up to the reported ones.
   */
  it("says how much of the team the span could not report, and nothing where it reported all", async () => {
    stubService((detail) => ({ ...detail, unavailable: 2 }));
    expect(await render()).toContain("2 repositories not reported at this span");

    stubService();
    expect(await render()).not.toContain("not reported at this span");
  });

  /**
   * The scope boundary, which outlived the donut that used to carry it in a tooltip.
   *
   * Per-team COUNTS are permitted and a team GRADE is not, so the one thing this page must never grow is a
   * readiness word beside the team's name. The donut's tooltip used to say so in prose; the rule is now only
   * enforceable by asserting the absence, which is what this does.
   */
  it("grades the team with no label of its own, however its repositories are labelled", async () => {
    stubService();
    const markup = await render();

    const [header] = markup.split("</header>");
    expect(header).toContain("platform");
    expect(header).not.toMatch(/Ready|Caution|Blocked|Not assessed|score|average/i);
  });

  it("draws no chart at all, the readiness donut having gone the way of the estate's", async () => {
    stubService();
    const markup = await render();

    expect(markup).not.toContain(">Readiness</h3>");
    // `recharts` renders into this wrapper, so its absence is the absence of every chart on the page.
    expect(markup).not.toContain("recharts");
  });

  /**
   * The donut counts the team the table below it holds, unreportable repositories included.
   *
   * `label_counts` distributes the REPORTED repositories only, while `team_detail.repositories`
   * carries every configured one — so a donut drawn off the distribution alone totals less than the
   * table beneath it, so its ungraded slice has to account for the rows the span could not report — otherwise
   * the legend totals fewer repositories than the table lists, which is the one way a distribution can lie
   * without any figure in it being wrong.
   *
   * It no longer SELECTS those rows: the donut stopped being a control when the estate's filters went, so what is
   * asserted here is the arithmetic rather than a click.
   */
  it("lists every repository the team holds, the ones the span could not report included", async () => {
    // What the donut's ungraded slice used to account for, asserted where it still matters: the TABLE holds every
    // configured repository, so a row the span reported nothing for is listed rather than dropped.
    stubService((detail) => ({
      ...detail,
      repositories: [...REPOSITORIES, { repository: "legacy", team: "platform" }],
      unavailable: 1
    }));
    const markup = await render();

    expect(markup).toContain('href="/repositories/legacy?weeks=4"');
    expect(markup).toContain('href="/repositories/api?weeks=4"');
    expect(markup).toContain("1 repository not reported at this span");
  });

  /**
   * A stale `?label=` in somebody's bookmark must not narrow anything.
   *
   * The page used to draw a donut that filtered on `?label=`, which the shared table read back through
   * `ESTATE_FILTERS`. The filters went with the estate's donuts and the donut itself went on 2026-09-15, so the
   * parameter is now read by nothing — and a link somebody saved while it still worked has to show the whole
   * table rather than an empty one.
   */
  it("ignores a label parameter nothing reads any more", async () => {
    stubService();
    search = new URLSearchParams("label=green&weeks=26");
    const markup = await render("26");

    expect(markup).not.toContain('aria-label="Readiness filter"');
    expect(markup).not.toContain("Remove Readiness filter");
    expect(markup).toContain('href="/repositories/api?weeks=26"');
    expect(markup).toContain('href="/repositories/web?weeks=26"');
  });

  it("says so where the configuration holds no repository for the team", async () => {
    stubService((detail) => ({ ...detail, repositories: [], labels: {} }));
    const markup = await render();

    expect(markup).toContain("No repository is configured for platform.");
    expect(markup).toContain("Add repositories to this team");
    expect(markup).toContain("0 repositories");
  });

  it("says so where nobody authored a reported merge in the team’s repositories", async () => {
    stubService((detail) => ({ ...detail, actors: [] }));
    const markup = await render();

    expect(markup).toContain("Nobody authored a reported merge in platform’s repositories");
    expect(markup).toContain("0 contributors");
  });

  it("answers an identifier the configuration does not hold as not found", async () => {
    stubService((detail) => detail, 404);
    await expect(render()).rejects.toThrow("notFound");
  });

  it("lets every other refusal surface as the fault it is", async () => {
    stubService((detail) => detail, 503);
    await expect(render()).rejects.toThrow("the evidence could not be read");
  });

  it("is dynamic, so a page is never served at another reader’s span", () => {
    expect(dynamic).toBe("force-dynamic");
  });
});
