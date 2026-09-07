# dtsse-github-metrics

Collects and grades evidence of software delivery practice from GitHub, and serves it as a dashboard.

A TypeScript rewrite of [`hmcts/github-metrics`](https://github.com/hmcts/github-metrics), whose Next.js UI is
carried over unchanged; what was rewritten is the Python collector and its read-only API.

## How it fits together

One Next.js application and one image, with two entry points:

| Entry point | Runs as | Does |
| --- | --- | --- |
| `node server.js` | the web pod | serves the dashboard, reading collected evidence from Postgres |
| `node dist/cli/run.js collect` | a weekly CronJob | contacts GitHub, caches facts, stamps the collection |
| `node dist/cli/run.js collect-org` | a second weekly CronJob | walks the organisation's teams, people and repository ownership |

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

Nothing renders until something has been collected. `metrics.yaml` is the estate this deployment reports on, and
is tracked here so that adding a team is a reviewed change; `metrics.example.yaml` documents every option beside
it. To collect against it:

```bash
export GH_TOKEN=...                                  # or the App variables below
yarn cli collect --config metrics.yaml --days 90
yarn cli evidence --config metrics.yaml --days 90    # the same figures as JSON
```

## Who owns what

`metrics.yaml`'s `teams:` block is the cohort the dashboard reports on, and it is hand-maintained so that
adding a team stays a reviewed change. `collect-org` is how that block stops being guesswork: it walks the
organisation's teams, their members and their repository access, and attributes every repository in the
organisation — not only the configured ones — to the teams or people that own it.

```bash
yarn cli collect-org --config metrics.yaml                     # walk it and store the graph
yarn cli collect-org --config metrics.yaml --propose-teams     # print a reviewable teams: block instead
```

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

Three filters keep a handle from being read as an owner, and each answers a question the others cannot:
`excluded_teams` by **identity** (`all-org-members` is the organisation wearing a team's clothes),
`maximum_team_share` by **breadth** (a team holding access across the estate holds it administratively), and
`maximum_team_members` by **size** (an "all developers" group is everyone, whatever it holds). Every team an
exclusion removes is named in the run's output beside the figure that removed it, because a filter quietly
turning a well-owned repository into an `unowned` row is the one thing here that should never be silent. The graph is change-versioned rather than overwritten, because GitHub serves
only the present — nobody can ask it who was in a team last June.

The walk is about 250 API calls and a few minutes, so it runs as its own CronJob at 01:00 Monday, two hours
ahead of `collect`, and a repository may have several owners.

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
to a GitHub App puts existing installations into pending approval and they silently lose it until an
organisation administrator accepts, so the two lists drift apart without anything failing loudly.

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
