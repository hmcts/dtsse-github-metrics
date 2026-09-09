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

The web pod holds **no GitHub credential**. It never contacts GitHub, which is what makes the serving path
read-only and the credential the collector's alone.

`src/lib/api.ts` is the seam between the two halves: the pages call it, and it calls the ported evidence code
in-process. Upstream reached a FastAPI service over loopback; there is no HTTP hop here.

## Running locally

```bash
yarn install
yarn deps:up                 # Postgres in Docker
yarn db:migrate:dev
yarn dev                     # http://localhost:3000
```

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
  visibilities: [public]     # narrow to what the credential can actually read
  include_archived: false    # nobody is working in an archived repository
  active_within_days: 90     # 1,872 repositories becomes roughly 1,210
excluded_repositories: []    # removed outright, whatever the graph says
```

`teams:` used to list the estate one repository at a time. It doesn't any more — at 1,872 repositories a
committed list is stale the day it lands, because a repository created on Tuesday stays invisible and one
archived on Wednesday keeps being collected. What `teams:` still does is **override ownership**, feeding the
`configured` rung below so a hand-set owner beats every inferred one.

The trade is deliberate: adding a team is no longer a reviewed change. A stale list is the worse failure, and
because the graph tables are change-versioned, "what joined the cohort this week" is a query rather than a
diff of a file nobody updated. **Review the policy, not the membership.**

One consequence worth knowing: **`collect` now depends on `collect-org` having run.** The chart sequences them
at 14:00 and 15:00, and on an empty database `collect` refuses and says no graph has been collected rather
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

| Rung | What it reads |
| --- | --- |
| `configured` | a reviewed `metrics.yaml` entry, which short-circuits everything below |
| `teams-api-admin` | the teams holding `admin` — the closest thing to a declared owner the API has |
| `codeowners-sole` | CODEOWNERS names exactly one team, so there is nothing to choose between |
| `teams-api-write` | several teams hold write-or-better: most permissive wins, ties to the smallest team |
| `codeowners-first` | CODEOWNERS names several teams: the one owning fewest wins, then alphabetically |
| `codeowners-person` | a bare `@login`, once no team rung has answered — the individual-owner outlier |
| `direct-collaborator-admin` | a direct collaborator holding admin, once CODEOWNERS names nobody |
| `name-prefix` | the name shares a family prefix with repositories the rungs above agreed on |
| `unowned` | nothing answered. A normal outcome, stored as a row rather than left as a silence |

A sole `admin` team outranks CODEOWNERS, but a sole CODEOWNERS team outranks any contested API claim: access
says who *can* merge and CODEOWNERS says who is *expected* to review, and where the two disagree the less
ambiguous is the better guess.

That precedence decides which repositories are worth paying for. CODEOWNERS costs up to three requests each, so
it is read only where **no rung above `codeowners-sole` has answered** — no reviewed override, and no `admin`
team. Scoping it to "no claim at all" instead, as it first did, made the rung unreachable for the 270
repositories that have several teams holding `push` and a CODEOWNERS naming exactly one: their file was never
read and `teams-api-write` decided them, against the order documented here.

Three filters keep a handle from being read as an owner, and each answers a question the others cannot:
`excluded_teams` by **identity** (`all-org-members` is the organisation wearing a team's clothes),
`maximum_team_share` by **breadth** (a team holding access across the estate holds it administratively), and
`maximum_team_members` by **size** (an "all developers" group is everyone, whatever it holds). Every team an
exclusion removes is named in the run's output beside the figure that removed it, because a filter quietly
turning a well-owned repository into an `unowned` row is the one thing here that should never be silent.

The graph is change-versioned rather than overwritten, because GitHub serves only the present — nobody can ask
it who was in a team last June. A run that sees a fact unchanged moves `last_observed_at` and writes no row.

The team, repository and people walks are about 250 GraphQL calls; the ownership ladder adds up to three
CODEOWNERS requests per unresolved repository and one collaborator listing after that, bounded by
`unresolved_repository_limit`. The whole run fits inside one hour of the installation's quota (15,000 core and
12,500 GraphQL), so it runs as its own CronJob at 14:00, an hour ahead of `collect`, and each day's figures are
read against the same day's ownership. A repository may have several owners.

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

It also counts the merged pull requests the credential can actually see, and fails if that is zero everywhere.
That check exists because of a fault it would otherwise have hidden: GitHub answers a request it will not serve
with an EMPTY RESULT rather than a refusal, so a credential that reads every repository and sees none of their
pull requests produces a report full of zeroes and a run that claims to have succeeded.

### Nothing here uses GitHub search

Collection walks `repository.pullRequests`, never `search`. A GitHub App installation token is served an empty
search over repositories it reads perfectly well — measured, the same query returns 1807 rows with a personal
access token and 0 with the App's — so every figure derived from search came back as zero while the run reported
success. The walk is ordered by `updatedAt` descending, which is what lets it stop: `mergedAt <= updatedAt`
always, so once `updatedAt` falls below the window start nothing later can be inside it.

### The installation must hold every permission the App declares

`hmcts/github-metrics` is refused today, and it is the only INTERNAL repository in `metrics.yaml`. That is the
tell: a public repository's pull requests are readable with `contents` and `metadata`, a private one's need
`pull_requests: read`, and installation 158738568 does not have it even though the App does. Adding a permission
to a GitHub App puts existing installations into pending approval and they lose it until an organisation
administrator accepts, so the two lists drift apart with nothing announcing it.

The refusal itself is loud, which is the second reason the walk beats search:

```
GitHub errors 403 (equivalent) POST https://api.github.com/graphql: FORBIDDEN: Resource not accessible by integration
github-metrics: merged pull requests were not collected: GitHub refused part of a GraphQL query
```

Search answered the same missing permission with an empty result and a 200, so the repository reported zero
merges and the run reported success. `repository.pullRequests` refuses outright, the repository is counted as a
failure, and only `--tolerate-partial` keeps the exit status at 0.

Compare them when a private repository reports no evidence:

```bash
# both lists, from a JWT signed with the App key — the difference is the pending request
curl -H "authorization: Bearer $JWT" https://api.github.com/app | jq .permissions
curl -H "authorization: Bearer $JWT" https://api.github.com/app/installations/$GH_APP_INSTALLATION_ID | jq .permissions
```

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

## Changing the Helm chart

**Bump `version:` in `charts/dtsse-github-metrics/Chart.yaml` in the same commit.** The chart is published to
ACR once per version and never overwritten, and the flux HelmRelease asks for `>=0.0.2` — so a values change
committed without a version bump builds green, promotes green, and deploys the *previous* chart. Nothing
reports an error; the environment simply keeps running the old values.

This is not the same as an application change, which needs no bump: the image tag is a commit SHA, and flux
image automation moves the HelmRelease onto the new tag on its own.

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
dashboard computes its own presentation figures. `--format report` is recognised and refused with a message
naming `--format json`, so its removal reads as a decision rather than a missing option.
