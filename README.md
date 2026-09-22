# dtsse-github-metrics

Collects and grades evidence of software delivery practice from GitHub, and serves it as a dashboard.

A TypeScript rewrite of [`hmcts/github-metrics`](https://github.com/hmcts/github-metrics), whose Next.js UI is
carried over unchanged; what was rewritten is the Python collector and its read-only API.

## How it fits together

One Next.js application and one image, with two entry points:

| Entry point | Runs as | Does |
| --- | --- | --- |
| `node server.js` | the web pod | serves the dashboard, reading collected evidence from Postgres |
| `node dist/cli/run.js collect` | a daily CronJob | contacts GitHub, caches facts, stamps the collection |
| `node dist/cli/run.js collect-org` | a second daily CronJob | walks the organisation's teams, people and repository ownership |
| `node dist/cli/run.js collect-cve` | a daily CronJob at 13:00 | reads the CVE reports the Jenkins security stage publishes to Cosmos |
| `node dist/cli/run.js collect-alerts` | a daily CronJob at 11:00 | walks each alert family's organisation-wide endpoint for the individual alerts |
| `node dist/cli/run.js map-sonar` | a weekly CronJob, Mondays 09:00 | resolves each SonarCloud project to the repository it analyses |

The web pod holds **no GitHub credential** and no Cosmos credential. It never contacts anything but Postgres,
which is what keeps both credentials the collectors' alone.

The serving path writes **exactly one table**, `repository_notes`, and nothing else. A signed-in reader may add,
edit and delete a free-text note against a repository; every other table the pages touch is read-only to them.
The write needs no new credential — it is the same Postgres connection the reads use — so the property above is
unchanged. `src/evidence/store/notes.ts` is the whole of that surface, the session gate is
`src/auth/author.ts`, and the three server actions are `src/app/repositories/[repository]/notes.ts`. Where
`AUTH_DISABLED=true` there is no session and a note is attributed to **anonymous**.

`src/lib/api.ts` is the seam between the two halves: the pages call it, and it calls the ported evidence code
in-process. Upstream reached a FastAPI service over loopback; there is no HTTP hop here.

## Running locally

```bash
yarn install
yarn deps:up                 # Postgres in Docker
yarn db:migrate:dev
yarn dev                     # http://localhost:3000
```

### The deployed secrets are opt-in

**`yarn dev` and `yarn cli` are the two commands here that can reach production.** Both load the properties
volume, which resolves the `dtsse-aat` Key Vault — the credentials for the production database and for the
collector's GitHub App. There is one estate and no non-production copy of it, so a laptop that reads that vault
is attached to the same 1,890 repositories the dashboard serves.

Neither reads it unless it is allowed to: `NODE_ENV=production`, which the runtime image sets and a laptop does
not, or `USE_KEY_VAULT=true` set on purpose. Local runs get the compose defaults instead, so the failure mode is
an empty dashboard rather than a silent attachment to production.

Every start-up prints the database it resolved, host and database name and no credential:

```
database: localhost:5432/github_metrics
```

Read that line before believing a local run is local. Reaching AAT is still one variable away, and is then a
decision somebody made:

```bash
USE_KEY_VAULT=true yarn dev
```

Two things made the old behaviour wider than it looked, and are the reason the guard covers both commands.
`getPropertiesVolumeSecrets` finds `keyVaults:` at any depth of the chart, so locally it merged the web pod's
secret list **with the collector's** — handing a dev server the GitHub App credentials the web pod deliberately
does not hold in production. And `yarn cli` is not a reader: `collect` writes to whatever database it resolved,
and `prune` deletes from it.

Nothing renders until something has been collected. `metrics.yaml` is the POLICY this deployment reports under —
which repositories count, and the thresholds they are graded against — and `metrics.example.yaml` documents every
option beside it. The estate itself comes from the graph, so `collect-org` runs first:

```bash
export GH_TOKEN=...                                  # or the App variables below
yarn cli collect-org --config metrics.yaml           # the estate, which `collect` reads
yarn cli collect --config metrics.yaml --days 90
yarn cli evidence --config metrics.yaml --days 90    # the same figures as JSON
```

## What the estate is

**The cohort comes from the collected graph, not from `metrics.yaml`.** `collect-org` walks the organisation
and stores every repository it holds; `metrics.yaml` then states which of them count:

```yaml
cohort:
  visibilities: [public]        # narrow to what the credential can actually read
  include_archived: false       # nobody is working in an archived repository
  active_within_days: 90        # what `collect` WALKS: 1,889 repositories becomes roughly 1,240
  unmaintained_after_days: 365  # past this, a repository reads "should be archived"
excluded_repositories: []       # removed outright, whatever the graph says
```

**`active_within_days` decides what is COLLECTED, not who is in the estate.** It used to decide both, and
dropping stale repositories from the report hid exactly the ones an assurance report is most about: 334
unarchived repositories are a year or more stale, and not one of them had ever been collected. They are
reported now, carrying the assurance answers that need no merge history and none of the behaviour figures that
do — so the window still keeps the expensive half of collection as narrow as it was.

Two windows therefore exist and they answer different questions. A repository quiet for six months has no
behaviour collected AND is not flagged as unmaintained; that is a real third state rather than a gap.

## Who counts inside it

Two more lists decide which of a repository's merges are reported, and they answer different questions:

```yaml
cohort:
  excluded_authors: [renovate, dependabot]                    # whose merges are not the cohort's
  bot_accounts: [fluxcdbot, hmcts-platform-operations, claude] # which accounts are not people
```

**Both are applied when a report is BUILT, not when facts are collected.** The cache holds every merge the walk
found, so changing either list changes the figures on the next render with nothing refetched.

`excluded_authors` drops **dependency automation from the pull-request cohort**. A Renovate pull request is small,
single-file, frequently auto-approved and merges in minutes, so counting them inflated the throughput counts and
the substantial-merge denominators, deflated the merge-cycle-time and time-to-first-review medians that are graded
against a maximum, and lifted quiet repositories past `assessment.minimum_merges` — a repository with no human
activity at all graded green instead of declining for insufficient sample. Agent-authored pull requests stay in:
one was opened, reviewed and merged through the gate, which is the practice being measured.

`bot_accounts` answers whether an account is a **person**, which decides the direct-commit cohort and the
contributor lists. It exists because GitHub's own answer is useless on that path: of 9,663 stored direct commits
**not one** carries `authorType: "Bot"` — every linked account comes back `User` — and three suffix-less service
accounts author 44% of them, `fluxcdbot` alone 32.9%. A deploy bot reconciling an image tag is not a person
bypassing review, so those are dropped; a direct commit is counted as a change that reached the default branch
unreviewed, and that figure is about people.

It is a NAMED LIST and never a substring rule. `gemmatalbot` is Gemma Talbot, who has 53 pull requests here, and
any `login.includes("bot")` test calls her work automation — a wrongness a reader cannot correct.

Where GitHub matched no account at all — 976 of those commits — authorship falls back to the git author NAME,
which is whatever the committer's tooling wrote. Automation signing a name that matches nothing still reads as a
person; that is a stated limitation of `isHumanCommitAuthor` rather than a gap in these lists.

`teams:` used to list the estate one repository at a time. It doesn't any more — at 1,872 repositories a
committed list is stale the day it lands, because a repository created on Tuesday stays invisible and one
archived on Wednesday keeps being collected. What `teams:` still does is **override ownership**, feeding the
`configured` rung below so a hand-set owner beats every inferred one.

The trade is deliberate: adding a team is no longer a reviewed change. A stale list is the worse failure, and
because the graph tables are change-versioned, "what joined the cohort this week" is a query rather than a
diff of a file nobody updated. **Review the policy, not the membership.**

One consequence worth knowing: **`collect` now depends on `collect-org` having run.** The chart sequences them
at 13:30 and 14:00, and on an empty database `collect` refuses and says no graph has been collected rather
than reporting an estate of zero repositories. `doctor` is the exception — it reports an uncollected graph as
a finding, because it is the command you run to find out why the others are refusing.

## Who owns what

`collect-org` attributes every repository in the organisation — not only the ones in the cohort — to the teams
or people that own it, by walking the organisation's teams, their members and their repository access.

```bash
yarn cli collect-org --config metrics.yaml                     # walk it and store the graph
yarn cli collect-org --config metrics.yaml --propose-teams     # print the attribution without storing it
```

`--propose-teams` no longer exists to be committed — the cohort is read from the graph, so there is nothing to
paste. It prints the same block as a way of READING the attribution: which team got which repository, and by
which rung, in a form that diffs against last week's.

**Attribution is best effort and some of it is wrong.** GitHub has no field for "owner", so each repository is
decided by the first of these that answers, and every stored row names the rung that decided it:

The ladder is `RungOrder` in `src/evidence/org/graph.ts`, and that declaration is the authority — this table
restates it and the arguments for each departure are in `OwnershipRung` beside the rung they justify.

| Rung | What it reads |
| --- | --- |
| `configured` | a reviewed `metrics.yaml` entry, which short-circuits every collected rung below |
| `authoring-team` | a team with access whose OWN MEMBERS author the merges here — observed behaviour, not a declaration |
| `teams-api-admin` | the teams holding `admin` — the closest thing to a declared owner the API has |
| `teams-api-write` | several teams hold write-or-better: most permissive wins, ties to the smallest team |
| `direct-collaborator-admin` | a direct collaborator holding admin, once no team's access claims the repository |
| `codeowners-sole` | CODEOWNERS names exactly one team, once no access rung has answered |
| `codeowners-first` | CODEOWNERS names several teams: the one owning fewest wins, then alphabetically |
| `codeowners-person` | a bare `@login`, once no team the file names has answered — the individual-owner outlier |
| `name-prefix` | the name shares a family prefix with repositories the evidenced rungs agreed on |
| `unowned` | nothing answered. A normal outcome, stored as a row rather than left as a silence |

**`authoring-team` sits above `teams-api-admin`, and it is the rung that fixed this ladder's largest error.**
`teams-api-admin` names whoever holds `admin`, and at HMCTS `admin` is granted to an access administrator
rather than to a delivery team. Measured on AAT before this rung existed, 1,346 of 1,846 attributed
repositories were decided by `teams-api-admin`, and its largest owners were `platform-operations` (288),
`cpp-development-admin` (178), `idam-admins` (139) and `bots` (44) — administrators, not the teams doing the
work. What separates the two is not the team's name but whether its members merge code here, which
`pull_request_facts` and `org_team_memberships` already say. It is deliberately not a name rule: a
`-admin`/`-admins`/`-tl` suffix test misses `bots` and `platform-operations` and would strip any team
legitimately named that way.

Measured on AAT after the rung landed, the tally the ladder now produces is `teams-api-admin` 923,
`authoring-team` 457 of 1,880 non-archived repositories, the three CODEOWNERS rungs 39 between them, and
`unowned` 141 — see the measurements recorded in `ownership.ts` and `graph.ts` beside the code that produced
them. Nearly a quarter of the estate is attributed by observed authorship rather than by any declaration,
which is the single largest reason this table needs to be read in `RungOrder`'s order and not in a plausible
one.

**Every access rung outranks every CODEOWNERS rung.** Access says who *can* merge and CODEOWNERS says who is
*expected* to review; the first is a live grant and the second is a committed file that nothing forces anyone
to update, so a current claim beats a stated one. `name-prefix` stays below all three CODEOWNERS rungs for
the mirror-image reason: an inferred name family is a guess this codebase makes, and a stale statement a human
wrote about this repository still outranks it.

That precedence decides which repositories are worth paying for, and the rule is mechanical: a rung that
decides from data already in hand is free, so the expensive fetches are scoped to the repositories none of
them answered — see `unresolvedRepositories` in `src/evidence/org/ownership.ts`. The free rungs are
`configured`, `authoring-team`, `teams-api-admin` and `teams-api-write`: an override is in the file, and the
other three read the team walk and the fact cache, both complete before the residue is taken. What is paid
for is CODEOWNERS (up to three content requests) and the direct-collaborator listing (one more), so **a
repository with any owning access claim is settled for free and its file is never fetched**. Measured on AAT,
that residue is roughly 260 of the organisation's repositories.

Because a rung's cost and its precedence are the same rule, the two must not be tuned apart: scoping the
CODEOWNERS fetch more narrowly than the ladder's own order makes a rung unreachable, and scoping it more
widely pays for files that cannot change an answer.

A worked shape, measured on AAT: `platform-operations` alone is credited with 217 repositories at
`teams-api-admin`, 76 at `authoring-team`, 17 at `teams-api-write`, 10 at `codeowners-sole` and 8 at
`name-prefix`. One team, five rungs — which is why the rung is stored on every row rather than being
inferred from the owner.

Three filters keep a handle from being read as an owner, and each answers a question the others cannot:
`excluded_teams` by **identity** (`all-org-members` is the organisation wearing a team's clothes),
`maximum_team_share` by **breadth** (a team holding access across the estate holds it administratively), and
`maximum_team_members` by **size** (an "all developers" group is everyone, whatever it holds). Every team an
exclusion removes is named in the run's output beside the figure that removed it, because a filter quietly
turning a well-owned repository into an `unowned` row is the one thing here that should never be silent.

**A person is an owner, and not a team.** Two of those rungs resolve to an individual rather than a team, and on
this estate they account for 206 repositories across 126 people. `/teams` therefore lists **teams only** — it
was drawing a card and a page for every one of those logins, so 126 of its 280 cards were individuals — and
`/repositories` marks a person-owned row **Individual** instead, with the owner's name left unlinked because
there is no team page for them. The `unowned` bucket keeps its card: "nobody owns this" and "one person does"
are different findings, and the 141 repositories under the first are accounted for there.

No membership threshold does that job, and one was tried and rejected: `cdm-tl` has 2 members and 38
repositories, `opal-review-admins` 2 and 22, and 15 teams have no membership row at all, so a size rule would
drop real estates for a gap in the data. What separates a team from a person is the rung's own answer.

The team cards are ordered by **how many repositories each team holds**, largest first, so a reader opening 154
of them meets the largest estates rather than whichever slug begins with `a`. That is not a ranking of teams:
the count is what a team is on the hook for, and no readiness label or score takes part in the order.

The graph is change-versioned rather than overwritten, because GitHub serves only the present — nobody can ask
it who was in a team last June. A run that sees a fact unchanged moves `last_observed_at` and writes no row.

The team, repository and people walks are about 250 GraphQL calls; the ownership ladder adds up to three
CODEOWNERS requests per unresolved repository and one collaborator listing after that, bounded by
`unresolved_repository_limit`. The whole run fits inside one hour of the installation's quota (15,000 core and
12,500 GraphQL), so it runs as its own CronJob at 13:30, half an hour ahead of `collect`, and each day's
figures are read against the same day's ownership. A repository may have several owners.

## Which SonarCloud project analyses which repository

Neither GitHub nor SonarCloud records the pairing, so the commit SHA is the identifier the two share.
`map-sonar` lists the SonarCloud organisation's projects, reads each one's most recent analyses, and asks GitHub
which repository in the organisation holds the analysed commit:

```bash
yarn cli map-sonar --config metrics.yaml                   # build or refresh the map
```

```yaml
# sonar_organization: hmcts     # absent falls back to `organization`
# sonar_projects:               # the answer of last resort, for a genuine ambiguity
#   rpx-xui-icp-api: uk.gov.hmcts.reform:rpx-xui-icp-api
```

**Every answer is stored, including the ones that say there is no repository.** A project SonarCloud has never
analysed, one whose analyses name no commit, and one whose commit is in no repository of this organisation are
all *answered* — there is nothing more to learn until it is analysed again — so each is written to
`sonar_project_map` with its reason. That row is a **remembered negative**, and it is what stops the next run
re-paying the quota; the table's `(repository IS NULL) <> (detail IS NULL)` CHECK is what keeps it from being
confused with a half-written one. A project is skipped entirely when nothing has been analysed since its row was
written, which is the only thing that can change the answer. **`prune` may never delete from this table.**

`collect` then asks the reverse question of every repository in the estate, and it costs nothing: the map is one
read, the project listing is one more, and only a repository the map attributes a project to pays for its
measures. `sonar/resolve.ts` holds the ladder — a configured override, then the map's own answer, with two
declaration rungs that a collection reading `sonar-project.properties` would reach.

**Name matching is deliberately absent.** It was measured and rejected: wrong for 6 of 70 projects, which is
close enough to look right and wrong often enough to mislead. A declaration is a hypothesis rather than an
answer for the same reason — of 240 repositories declaring a key, 123 name a project SonarCloud does not list
and 69 sit in collision groups where several repositories declare one template's key.

The reads are **anonymous**: there is no SonarCloud token in the `dtsse` vault, and the project listing, a
project's analyses and its measures all answer without one. Set `SONAR_TOKEN` to widen them to the
organisation's private projects; nothing else changes.

A repository's page distinguishes three answers, which is the whole point of the wording: the mapping has not
been run, no project analyses this repository, or here are the figures. Absent means unmeasured and a stated
reason means measured-as-nothing — the same rule the rest of the contract follows.

### Only one collector runs at a time, and the database enforces it

AAT runs this application on **two clusters** — `cft-aat-00` and `cft-aat-01` — and both mount the same
`dtsse-aat` Key Vault, so both resolve the same `POSTGRES_*` and the same GitHub App installation. Two clusters,
one database, one rate-limit budget. `concurrencyPolicy: Forbid` does not help: it stops a CronJob overlapping
*itself* in *one* cluster and says nothing about its twin next door.

Two concurrent collectors do more than duplicate work:

- The GitHub budget is per **installation**, against 15,000 core and 12,500 GraphQL an hour. This used to be the
  decisive reason — a full `collect` was ~15,500 calls, so one run fitted and two did not. It is now the
  *weakest* of the three: the estate-wide reads brought a run well inside one hour's budget. The two below are
  unaffected and are each sufficient on their own.
- Each run stamps `observed_at` at its own start instant, so the later-starting run committing first makes the
  other close a row at an instant *before* it was observed, which `<table>_interval_ordered` rejects.
- The live-row partial unique indexes catch two writers inserting one key — as a unique violation, which rolls
  back the whole transaction. A colliding run writes **no graph at all**.

So `collect`, `collect-org`, `map-sonar` and `collect-alerts` all take one Postgres advisory lock, the same
mechanism `migrate` uses for the same reason. `map-sonar` takes it for a reason of its own on top: it is paced against a per-minute
quota rather than an hourly one, so two concurrent runs would each pace off a budget the other was also
spending — slower than one run, and writing the same rows twice. A run that does not get it stands down and **exits 0**: on an estate where both clusters share a
schedule one of them loses every day, and a CronJob reporting Failed daily for correct behaviour is an alert
nobody reads.

**The platform already picks one cluster, and the lock is not a substitute for it.** The `job` chart emits
`suspend: {{ not $activeCronCluster }}` on every CronJob it renders, and cnp-flux-config injects
`global.activeCronCluster` into every HelmRelease from a value defined on `aat/00` alone. The effect is
visible with `kubectl get cronjob -n dtsse`: on `cft-aat-00-aks` both metrics CronJobs report `SUSPEND=false`
and on `cft-aat-01-aks` both report `true`. So which of the two AAT clusters collects is decided in git, by
the platform, without this repo declaring anything — and it is `suspend` that decides it, a field Helm does
manage.

What the lock adds is the case that mechanism does not cover: **two releases in one cluster.** Every master
build installs a throwaway `-staging` release into the same `dtsse` namespace as the persistent one, on the
same `activeCronCluster`, so both sets of CronJobs are unsuspended together — which is how duplicate
collectors were actually observed. The chart turns them off there (`values.aat.template.yaml`), but that is a
value anybody can flip, in a release that exists for eight minutes. The lock is the backstop that does not
depend on getting a value right: whichever release fires, exactly one writes.

### Where a run's calls went

Both collectors end by printing what they spent, and the two numbers there answer different questions.
**`GitHub calls` counts OPERATIONS**, one per thing the run asked for however many attempts it took. The lines
under it count **ATTEMPTS**, largest first, so they sum to more than the total whenever anything was retried.
The shape of it, with the counts standing in for whatever a given run's were:

```
collected 1889 of 1889 repositories (1240 walked for behaviour) in N GitHub calls
  200 ok GET https://api.github.com/repos/{organization}/{repository}/code-scanning/alerts?state=open&per_page=100 (x1240)
  200 ok POST https://api.github.com/graphql AssuranceSignals (x38)
  200 ok GET https://api.github.com/orgs/{organization}/dependabot/alerts?state=open&per_page=100 (x24)
  200 ok GET https://api.github.com/orgs/{organization}/repos?per_page=100&type=all (x19)
  502 retried POST https://api.github.com/graphql MergedPullRequests (x11)
  0 exhausted POST https://api.github.com/graphql MergedPullRequests (x1)
  waited 612s for the graphql quota across 3 pauses
```

**Three whole-estate reads replace three per-repository ones.** `security_and_analysis` and the default branch
come off one paginated `GET /orgs/{org}/repos`; the open Dependabot alerts off `GET /orgs/{org}/dependabot/alerts`;
the open secret-scanning alerts off `GET /orgs/{org}/secret-scanning/alerts`, which is one page for the whole
organisation. Each is a few dozen pages against 1,240–1,889 calls. A repository the organisation's metadata
listing does not name — renamed, transferred or deleted since `collect-org` ran — falls back to its own read and
is named in the log, and `--repository` keeps the direct reads throughout, because paging an organisation to find
one repository costs more than asking for it.

**An absence from one of those responses is not an answer on its own**, and this is the part to understand before
reading an alert column. They name only the repositories the feature is switched **on** for. So a repository not
in the Dependabot response reads as *clean* where `hasVulnerabilityAlertsEnabled` says alerts are on, as *not
enabled* where it says they are off, and as **unmeasured** where that signal could not be read at all — three
answers, never collapsed into a zero. Secret scanning is read the same way against
`security_and_analysis.secret_scanning`.

**Code scanning is still read per repository**, and deliberately. `GET /orgs/{org}/code-scanning/alerts` works and
would save about 1,240 calls, but nothing collected says whether code scanning is *enabled* on a repository —
`hasVulnerabilityAlertsEnabled` answers for Dependabot and `security_and_analysis` answers for secret scanning,
and the eight keys GitHub returns in that block name code scanning nowhere. An absence would therefore be
indistinguishable from a repository that never turned it on, and reporting an unmeasured posture as zero open
findings is the one thing this collector will not do. Those 1,240 calls buy that distinction.

Five words carry the answers a total cannot. `retried` and `rate-limited` are attempts that came back and were
asked again — a 502 that succeeded second time, and a spent quota this client waited out, which is kept apart
from `refused` because a 403 is GitHub's answer to both. `unreachable` is an attempt no response arrived for,
counted at status 0 because there is none. **`exhausted` is an operation that gave up**, and it is the one worth
grepping for: a run that spent its afternoon waiting and got nothing was previously recorded as no outcome at
all, so the run that failed could not be explained from its own log. The `waited` lines are not calls — no
request is made while standing still — and are the only place an hour of a run is accounted for.

GraphQL is counted **by operation name**, because every GraphQL call is a POST to one address: without the name
an assurance batch of 38 documents and a merge walk of several thousand are one indistinguishable line.

### Authenticating

A run authenticates **either as a GitHub App installation or with a personal access token**, and the two do not
read the same things. Measured on the HMCTS estate, a PAT is refused on classic branch protection and on all
three alert families, so those report as unavailable rather than as numbers. An App installation reads every one
of them.

App auth is selected only when all three are set; anything less falls back to `GH_TOKEN`.

```bash
export GH_APP_ID=...
export GH_APP_INSTALLATION_ID=...
export GH_APP_PRIVATE_KEY_PATH=~/.config/metrics/github-app.pem   # keep it outside the repository
yarn cli doctor --config metrics.yaml
```

`doctor` mints a token at startup, so a wrong key fails while somebody is still watching rather than 1,850
repositories in. Either PKCS#1 (`BEGIN RSA PRIVATE KEY`, what GitHub's download gives you) or PKCS#8 will do.

It also checks whether the credential can see any merged pull requests at all, and fails if it can see none
anywhere. That check exists because of a fault it would otherwise have hidden: GitHub answers a request it will
not serve with an EMPTY RESULT rather than a refusal, so a credential that reads every repository and sees none of
their pull requests produces a report full of zeroes and a run that claims to have succeeded.

**`doctor` reads a sample of about 30 repositories, spread across owners**, and both of its questions are about
the *credential* rather than about the estate. It used to read the whole cohort — one `GET /repos/{org}/{repo}`
and one full merge walk each, the heaviest document here, asked for what amounts to a boolean — which cost around
3,800 calls and made the cheap check somebody runs first more expensive than a collection. The sample is
deterministic, so two runs read the same repositories and a fault that comes and goes is a fault rather than a
different sample; ownership is what it spreads across, because that is what the interesting permission faults
follow. `--all` reads every cohort repository and names each unreadable one, for when that is the question.

### Nothing here uses GitHub search, except the SonarCloud map

Collection walks `repository.pullRequests`, never `search`. An App installation token is served an **empty search**
over repositories it reads perfectly well — the same query returns 1807 rows with a personal access token and 0
with the App's — so anything derived from search reports zero and claims to have succeeded.

`map-sonar` is the one exception, and it uses a different endpoint for a different question: `/search/commits`,
asked which repository in the organisation holds one commit. It is the only quota here counted in **calls a
minute** — 30 documented, 10 observed — which is why it is the only call this codebase paces rather than
retries, and why it runs weekly in a CronJob of its own instead of inside `collect`. If the installation is ever
served an empty commit search the way it is served an empty repository search, `map-sonar` reports every project
as unresolvable rather than resolving it wrongly, and the reason is stored beside each one.

The walk is ordered by `updatedAt` descending, which is what lets it stop: `mergedAt <= updatedAt` always, so
once `updatedAt` falls below the window start nothing later can be inside it.

### The installation must hold every permission the App declares

Adding a permission to a GitHub App puts existing installations into **pending approval**, and they lose it until
an organisation administrator accepts — so the App's list and the installation's list drift apart with nothing
announcing it.

A public repository's pull requests are readable with `contents` and `metadata`; a private or internal one's need
`pull_requests: read`. A repository missing that is refused outright rather than answered emptily, so it is
counted as a failure and only `--tolerate-partial` keeps the exit status at 0:

```
GitHub errors 403 (equivalent) POST https://api.github.com/graphql: FORBIDDEN: Resource not accessible by integration
github-metrics: merged pull requests were not collected: GitHub refused part of a GraphQL query
```

Compare the two lists whenever a private or internal repository reports no evidence:

```bash
# both lists, from a JWT signed with the App key — the difference is the pending request
curl -H "authorization: Bearer $JWT" https://api.github.com/app | jq .permissions
curl -H "authorization: Bearer $JWT" https://api.github.com/app/installations/$GH_APP_INSTALLATION_ID | jq .permissions
```

## Published CVE reports

The CNP pipeline's security stage publishes a CVE report per build to the `pipeline-metrics` CosmosDB account, and
`collect-cve` reads it. Three facts about that data shape everything here:

**Only three builders publish.** `CVEPublisher.publishCVEReport` in `cnp-jenkins-library` is reached from
`YarnBuilder` (`node`), `GradleBuilder` (`java`) and `PythonBuilder` (`python`) and from nothing else. Measured
2026-09-18, **361 repositories** have a `master` report against an estate of about 1,890 — so **a repository with
no report is UNMEASURED, and one whose scan found nothing is ZERO**. Those are stored as different things:
`cve_scans` records that a scan happened and `cve_findings` records what it found, so a scan row with no findings
is the honest zero and no row at all is the honest absence. A column that read absence as zero would report four
repositories in five as free of known vulnerabilities when nothing has ever looked at them.

**A repository is reported in DISTINCT CVEs, and suppressed is a subset of the total.** The question a reader has
is "how many CVEs does this repository have, and how many of those have been accepted" — one number and a part of
it, never two numbers to add up. The store keeps the fine grain, one row per **(package, CVE)**, because that is
the evidence; but one CVE routinely spans many packages, so the two figures differ by about an order of magnitude.
`pcs-api`'s newest java scan holds **262 occurrences of 26 distinct CVEs**, with three CVEs reaching 13 packages
each. The reported figures are distinct CVEs; `occurrences` carries the finer number so nobody meeting it
elsewhere thinks one of them is wrong.

**A CVE suppressed against one package and open against another counts as LIVE.** Something unsuppressed is still
exposed, and the other rule would let a team retire a live vulnerability from the figures by accepting it
somewhere else. It is a stated decision in `distinctCves`, with a test, rather than whatever a `GROUP BY` happened
to produce.

**Both databases have to be read.** `CosmosDbTargetResolver` picks the database from the repository's GitHub
topics: `jenkins-sds` routes to `sds-jenkins` and everything else defaults to `jenkins`. The 361 repositories
divide **316 in `jenkins`, 55 in `sds-jenkins` and 10 in both** — the ten being repositories that gained the
`jenkins-sds` topic, so their history is in one container and their present in the other. Reading only `jenkins`
reports **45 repositories** as never scanned while looking like a complete run. The stored key does not include
the database, so one repository is one answer and the newest report wins whichever container it came from.

**Severity is sometimes absent, and absent is not `low`.** `uv audit` states no severity at all; `yarn audit`
calls the middle band `moderate`, which is folded to `medium`. dependency-check grades in upper case, and its
entries carry a `severity` field of their own that is present on every one of the 208,384 live findings and on
**none** of the 2,499,605 suppressed ones — so severity is read off `cvssv3.baseSeverity ?? cvssv2.severity`,
which is the only grading the live and suppressed sides both carry. Findings with no severity are counted in an
`unknown` band; the `severity` column is NULL for them and a CHECK constraint stops `unknown` ever becoming a
stored value.

One trap worth knowing before touching the node parser: **51,359 live yarn-audit entries carry `severity: null`,
and every one of them has all nine fields null.** It is a placeholder `YarnBuilder` emits about once per report,
not an ungraded finding — it names no CVE and no package — so it is dropped rather than counted. Counting it
would put one phantom CVE on every node repository on the estate.

**A suppression's justification is the most useful thing here, and only java has one.** dependency-check
suppression entries carry a `notes` field, and HMCTS practice fills it with a ticket and a rationale:

> HDPI-8150: temporary. CVE-2026-53914 against kotlin-stdlib; no fixed release published upstream yet. … The risk
> vector (build-cache deserialization) is irrelevant to PCS's runtime — PCS ships kotlin-stdlib as a transitive
> runtime jar but does not run the Kotlin compiler.

That is sound engineering with a ticket behind it. A suppression with nothing is a silent risk acceptance, and
telling the two apart is the difference between a figure that helps a team and one that only shames it — so
`documented_suppressions` and `undocumented_suppressions` are reported per repository.

yarn audit's suppression list has **no such field at all** — no `notes`, `justification`, `reason` or `comment` on
any node document in either database. So both figures are **absent** for a repository whose suppressions are all
node's, rather than reporting `0` documented, which would read as a team that never explains anything. Absent means
the question cannot be put here; it is the same absent-is-not-zero rule one level down.

**These suppressions are present vulnerabilities, not stale leftovers.** dependency-check reports
`suppressedVulnerabilities` only for what it found in that scan and then suppressed — a suppression-file entry
matching nothing produces no report entry. Verified structurally on `pcs-api`: all 262 suppressed entries carry a
CVSS block and a `vulnerableSoftware` CPE with `vulnerabilityIdMatched: "true"`, under a dependency with a `sha1`.
A rule matching nothing could not produce a CPE match against a real artefact.

```bash
export CVE_COSMOS_ACCOUNT=pipeline-metrics
export CVE_COSMOS_KEY=...                       # the read-only key; never a write key
yarn cli collect-cve --config metrics.yaml
```

The read is incremental. `MAX(reported_at)` per `source_database` is the watermark — derived from the rows rather
than stored beside them, so it cannot advance past a write that failed — and the predicate is `>=` rather than
`>`, because Cosmos `_ts` is second-granular and a strict comparison would skip a document written in the same
second for ever. Re-reading a second's documents is harmless: the write is keyed on the repository and its
language, and an older report cannot overwrite a newer one.

## Deployed credentials

The `dtsse-aat` Key Vault lives in
[`hmcts/dtsse-shared-infrastructure`](https://github.com/hmcts/dtsse-shared-infrastructure) and is managed
outside this repository.

**Three secrets are set by hand and are not in any Terraform.** A GitHub App private key is not a value
Terraform generates, and putting it in a public repository's state file is not an option — so if that vault is
ever rebuilt, these must be restored or the collector will have nothing to authenticate with:

```bash
az keyvault secret set --vault-name dtsse-aat --name github-app-id --value <app id>
az keyvault secret set --vault-name dtsse-aat --name github-app-installation-id --value <installation id>
az keyvault secret set --vault-name dtsse-aat --name github-app-private-key --file <the decrypted .pem>
```

`--file` for the key, so its newlines survive; the platform's secrets loader trims only the outer whitespace.

`github-token` is in the same vault but is **deliberately not mounted on the CronJob**. Credential resolution
prefers the App, so a PAT beside it would quietly take over if the App key were ever rotated badly — reporting
the whole estate's merge gates and alerts as unavailable instead of failing loudly.

`cve-cosmos-account` and `cve-cosmos-readonly-key` are mounted on **`collect-cve` and nowhere else** — not on the
web pod, which contacts no external service, and not on the two GitHub CronJobs, which do not need them. The key
is read-only. It is also account-wide, which is wider than this needs: a Cosmos data-plane RBAC role on the
`dtsse` workload identity would be tighter and remove the stored secret altogether, but it needs a role
assignment on a production account and so is a platform ask rather than a change here.

## Signing in

Readers sign in with their HMCTS account through Microsoft Entra ID. The flow is the OIDC authorization code
flow with PKCE, and the session is an encrypted cookie — there is no session store, so nothing to provision and
nothing to revoke, which is why a session lasts a working day rather than a month.

**Authentication fails closed.** It is required unless `AUTH_DISABLED=true` is set explicitly, so a deployment
that loses its Entra variables refuses readers rather than serving the estate's alert counts and merge-gate
posture to anybody who finds the hostname.

Two deployments run without a sign-in, both deliberately:

| | Why |
| --- | --- |
| preview | the hostname contains the pull request number, and Entra matches redirect URIs by whole string with no wildcard |
| the pipeline's temporary AAT `-staging` release | same reason, and every smoke and functional test would otherwise fail on a redirect to Microsoft |

So **the guard is not exercised by the pipeline**. What readers reach is the persistent AAT release flux deploys
from `charts/dtsse-github-metrics/values.yaml`, where it is on; `test/e2e/tests/auth.spec.ts` checks it against
that hostname.

`/health` and its children are served without a session. That is load-bearing rather than an oversight: the
chart's probes and the pipeline's `HealthChecker` both read `/health`, and a 302 to Microsoft is not `UP`.

Locally, `yarn dev` needs no Entra registration:

```bash
AUTH_DISABLED=true yarn dev
```

### The app registration

Created through [`hmcts/central-app-registration`](https://github.com/hmcts/central-app-registration) by adding
an entry to `apps.yaml`. It needs `signInAudience: AzureADMyOrg` and `redirectUris` containing exactly
`https://github-metrics.aat.platform.hmcts.net/auth/callback`. Nothing else — no Graph permissions, because
`openid`, `profile` and `email` are identity-platform scopes and this service calls no Graph API.

### Signing in IS the authorisation

There is no group or role check anywhere, deliberately. The dashboard is for the organisation, not for
engineers: many of the people who should read it — managers among them — hold no engineering group, so
restricting by group would have locked out part of the intended audience.

Two consequences, both decided rather than overlooked. The tenant holds around 5,600 guest accounts, some from
other government departments, and they can read it too. And should we ever want to narrow it, prefer **app
roles** over group claims: the only DTSSE group in the directory is a Microsoft 365 group rather than a security
group, so a `SecurityGroup` claim would never carry it, and past roughly 200 group memberships Entra replaces
the `groups` claim with a pointer to Graph — which would lock out the longest-serving staff first.

That repository writes the client id and secret to `central-app-reg-kv`, not to `dtsse-aat`. Like the GitHub App
key, they are then set by hand and are in no Terraform:

```bash
az keyvault secret set --vault-name dtsse-aat --name entra-client-id --value <application id>
az keyvault secret set --vault-name dtsse-aat --name entra-client-secret --value <client secret>
az keyvault secret set --vault-name dtsse-aat --name session-secret --value "$(openssl rand -base64 48)"
```

`session-secret` is ours rather than Microsoft's, and rotating it signs everybody out — which is the only
revocation a cookie-borne session has.

## Tests

```bash
yarn test                # unit
yarn test:integration    # needs `yarn deps:up`
yarn test:e2e            # needs a running server; TEST_URL selects it
```

Playwright is selected by tag: `@smoke` on a preview, `@regression` on AAT, `@nightly` for the accessibility
pass. A preview deploys with its CronJob disabled and an empty database, so `@smoke` asserts that pages render
and health is UP — never that any figure is non-zero.

## What is not ported

`render.py`, upstream's ASCII terminal renderer, was deliberately left out: it was presentation-only, and the
dashboard computes its own presentation figures. `evidence` therefore has one output — the machine-readable
contract — and takes no `--format`: a flag with a single legal value that changes nothing is a promise the CLI
cannot keep.

One layer is ported, complete and **reached by nothing**, and it says so at the head of its own module rather
than here: the CODEOWNERS and maintenance evidence (`src/evidence/domain/standards.ts`). The comment names
what would reach it. Whether to wire it up or drop it is an open decision; nothing in the configuration file
or the CLI advertises it in the meantime.

Two others were in that state until they were wired, and each left one thing unfinished:

- the trend report (`src/evidence/report/trend.ts`), wired by VIBE-592. `getTrend` builds one repository's
  series from `enablement:` and the cached facts, and the repository page draws it. There is still no `trend`
  CLI command — the series is a page, not a report anybody asked to print — and `alert_observations` holds no
  rows, so a series carries an empty alert history and says so.
- the SonarCloud resolution ladder and measures (`src/evidence/sonar/`, headed by `resolve.ts`), wired by
  VIBE-591. The four `sonar_*` fields on `RepositoryRow` are declared and not sent, so `/repositories` has no
  SonarCloud columns. The repository page has the figures; what is missing is carrying one repository's
  measures into the estate read. See the comment on `RepositoryRow` in `src/lib/types.ts`.
