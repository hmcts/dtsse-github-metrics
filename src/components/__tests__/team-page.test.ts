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
import type { RepositoryRow, TeamActorRow, TeamDetail, TeamMemberRow, WindowOptions } from "@/lib/types";

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

/**
 * Who GitHub says is in the team, which overlaps the contributors above without matching them.
 *
 * `ada` is both. `alan` is a member who landed nothing at this span, and `grace` contributed without being in the
 * team — the two directions the page has to keep legible. Real names on two of the three, because a member is named
 * through the same seam a contributor is.
 */
const MEMBERS: TeamMemberRow[] = [
  { login: "ada", name: "Ada Lovelace", role: "MAINTAINER" },
  { login: "alan", name: "Alan Turing", role: "MEMBER" },
  { login: "ef32", role: "MEMBER" }
];

/** One team, full in every block the page draws, before any narrowing. */
function team(): TeamDetail {
  return {
    team: "platform",
    repositories: REPOSITORIES,
    actors: ACTORS,
    members: MEMBERS,
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
  it("names the team and counts what it holds, who is in it and who worked in it", async () => {
    stubService();
    const markup = await render();

    expect(markup).toContain(">platform<");
    expect(markup).toContain("team");
    expect(markup).toContain("2 repositories");
    // TWO COUNTS OF PEOPLE AND NOT ONE. Three members and two contributors, which is the arithmetic that says they
    // are counts of different sets: one figure headed neither way would be read as membership and is not.
    expect(markup).toContain("3 members");
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
});

/**
 * The two sections about people, which answer two questions and used to answer them as one.
 *
 * `platform-operations` is the case these are written from: 56 GitHub members, and a Contributors section that
 * listed people in none of its teams because it holds admin on 328 repositories and their authors were folded under
 * it. The figure was never wrong — the section's own detail said "counted within this team's repositories" — but the
 * heading read as the team's people, so the page now answers both questions and names the source of each.
 */
describe("the team’s members and its contributors", () => {
  /** What the section headings and their details say, which is the whole of the distinction a reader gets. */
  function sections(markup: string): string {
    return markup.replace(/href="[^"]*"/g, "");
  }

  it("heads each section with what it is and where it came from, so neither reads as the other", async () => {
    stubService();
    const markup = sections(await render());

    // GitHub is named on the membership side and the repositories on the contribution side. A reader meeting either
    // heading alone must not be able to take it for the other.
    expect(markup).toContain(">Members<");
    expect(markup).toContain("who GitHub says is in this team, whatever they worked on");
    expect(markup).toContain(">Contributors to its repositories<");
    expect(markup).toContain("authors of the changes above, in or out of the team");
  });

  it("lists a member who contributed nothing at this span", async () => {
    // `alan` is in the team and authored nothing, so he is in the membership table and absent from the contributor
    // one. A section that could only list people who merged would lose him entirely.
    stubService();
    const markup = await render();

    const [, members = "", contributorsSection = ""] = markup.split(/>(?:Members|Contributors to its repositories)</);

    expect(markup).toContain("Alan Turing");
    expect(members).toContain("Alan Turing");
    expect(contributorsSection).not.toContain("Alan Turing");
  });

  it("lists a contributor who is not in the team, which is the whole confusion", async () => {
    // The `linusnorton` case: he is in 28 teams, none of them this one, and appears here because he merged into
    // repositories it owns. He belongs in the contributor list and must not appear in the membership one.
    stubService((detail) => ({
      ...detail,
      actors: [{ login: "linusnorton", name: "Linus Norton", repositories: 6, contributions: 7 }],
      members: [{ login: "alan", name: "Alan Turing", role: "MEMBER" }]
    }));
    const markup = await render();

    const [, members = "", contributorsSection = ""] = markup.split(/>(?:Members|Contributors to its repositories)</);

    expect(members).not.toContain("Linus Norton");
    expect(contributorsSection).toContain("Linus Norton");
    expect(markup).toContain("1 member");
    expect(markup).toContain("1 contributor");
  });

  it("lists the members of a team nobody contributed to at this span", async () => {
    // Both answers at once, and both true: GitHub says three people are in the team, and none of them landed a
    // change in its repositories in this window.
    stubService((detail) => ({ ...detail, actors: [] }));
    const markup = await render();

    expect(markup).toContain("Ada Lovelace");
    expect(markup).toContain("Nobody authored a reported merge in platform’s repositories");
    expect(markup).toContain("3 members");
    expect(markup).toContain("0 contributors");
  });

  it("reads an unread membership as unmeasured rather than as a team with nobody in it", async () => {
    // ABSENT IS NOT ZERO. Nothing records which teams a collection walked in full, so a team with no stored row is
    // indistinguishable from one nobody walked — and `unowned`, a reporting bucket rather than a GitHub team,
    // arrives here too. The header states no figure at all rather than "0 members".
    stubService((detail) => ({ ...detail, members: undefined }));
    const markup = await render();

    expect(markup).toContain("No membership has been read for platform.");
    expect(markup).toContain("Nothing read is not the same as nobody in the team.");
    expect(markup).not.toContain("0 members");
    // The contributor list is untouched by an unread membership: it is built from the window's merges.
    expect(markup).toContain("2 contributors");
  });

  it("names a member through the same seam a contributor is named through", async () => {
    // `contributorNames` resolves every live member of the organisation, so a member who merged nothing is named as
    // well as one who merged fifty — and a login with no resolved name falls back to the login on both lists rather
    // than being blanked. One naming path, so the two sections cannot call one person two things.
    stubService();
    const markup = await render();

    expect(markup).toContain("Ada Lovelace");
    expect(markup).toContain("Alan Turing");
    expect(markup).toContain("ef32");
  });

  it("links nobody in the membership list, there being no page for a member who landed nothing", async () => {
    // `/contributors/<login>` is built from the window's merges and refuses a login with none, so `alan` has no
    // page. The contributor table below carries the links.
    stubService();
    const markup = await render();

    expect(markup).not.toContain('href="/contributors/alan');
    expect(markup).toContain('href="/contributors/ada?weeks=4"');
  });
});

describe("the team page’s refusals", () => {
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
