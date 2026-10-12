# dtsse-github-metrics

Collects evidence about teams' software delivery practices from GitHub, SonarCloud and the Jenkins CVE
reports, grades each repository's readiness, and serves the results as a dashboard.

## Quick start

`run-dev` serves the dashboard on http://localhost:3000 from a Docker container with sign-in disabled, so it
needs only Docker and an `az login`. Every start-up prints the database it connected to, for example
`database: localhost:5432/github_metrics`.

### Against AAT

```bash
./run-dev --aat
```

`--aat` reads the database credentials from the `dtsse-aat` Key Vault. AAT is the only environment, so it is
the database the live dashboard reads. Viewing it is harmless; `yarn cli` with `USE_KEY_VAULT=true` writes to
it (`collect`) or deletes from it (`prune`).

### Against a local database

```bash
yarn deps:up                                      # Postgres in Docker
./run-dev                                         # installs and migrates as it starts
```

A local database is empty until you collect into it:

```bash
yarn install
export GH_TOKEN=...                               # or the GitHub App variables below
yarn cli doctor --config metrics.yaml             # smoke test
yarn cli collect-org --config metrics.yaml        # teams, people and repository ownership
yarn cli collect --config metrics.yaml --days 90
yarn cli evidence --config metrics.yaml --days 90 # the figures as JSON
```

`yarn cli --help` lists every command and switch.

### Running on the host

```bash
yarn install
USE_KEY_VAULT=true AUTH_DISABLED=true yarn dev    # AAT
yarn db:migrate:dev && AUTH_DISABLED=true yarn dev  # or the local database
```

## How it fits together

One Next.js application and one image, with two entry points:

| Entry point | Runs as | Does |
| --- | --- | --- |
| `node server.js` | the web pod | serves the dashboard, reading collected evidence from Postgres |
| `node dist/cli/run.js collect` | a daily CronJob at 14:00 | contacts GitHub, caches facts, stamps the collection |
| `node dist/cli/run.js collect-org` | a daily CronJob at 13:30 | walks the organisation's teams, people and repository ownership |
| `node dist/cli/run.js collect-cve` | a daily CronJob at 13:00 | reads the CVE reports the Jenkins security stage publishes to Cosmos |
| `node dist/cli/run.js collect-alerts` | a daily CronJob at 11:00 | reads each alert family's organisation-wide endpoint for the individual alerts |
| `node dist/cli/run.js map-sonar` | a weekly CronJob, Mondays 09:00 | resolves each SonarCloud project to the repository it analyses |

The web pod holds no GitHub or Cosmos credential and talks only to Postgres. The one table it writes is
`repository_notes`, for the free-text notes signed-in readers add to a repository.

`collect`, `collect-org`, `map-sonar` and `collect-alerts` take a Postgres advisory lock, so only one collector
runs at a time across both AAT clusters. A run that doesn't get the lock exits 0.

## Configuration

`metrics.yaml` is the working configuration. [`metrics.example.yaml`](metrics.example.yaml) documents every
option. The database comes from `DATABASE_URL`, or the `POSTGRES_*` variables in a deployment.

The list of repositories comes from GitHub, via `collect-org`, so `collect` refuses to run until `collect-org`
has. `metrics.yaml` decides which of those repositories count and how they are graded:

```yaml
cohort:
  visibilities: [public]
  include_archived: false
  active_within_days: 90         # repositories collect walks for behaviour evidence
  unmaintained_after_days: 365   # past this, a repository is flagged "should be archived"
  excluded_authors: [renovate, dependabot]
  bot_accounts: [fluxcdbot, hmcts-platform-operations, claude]
excluded_repositories: []
```

- `active_within_days` limits which repositories `collect` walks for behaviour figures. Quiet repositories are
  still reported, with their merge gate, alerts and maintenance.
- `excluded_authors` removes dependency bots' pull requests from the figures. Agent-authored pull requests stay
  in.
- `bot_accounts` lists accounts that are not people, so their direct commits don't count as unreviewed changes.
  It lists exact logins because GitHub reports these accounts as users.
- `teams:` overrides the owner `collect-org` works out for a repository.
- `assessment` holds the green/amber/red thresholds.

Both cohort lists are applied when a report is built, so changing them takes effect on the next page load.

## Authentication

Commands that contact GitHub (`doctor`, `collect`, `collect-org`, `collect-alerts`, `map-sonar`) need a
credential. `evidence` and the dashboard read only the database.

- **GitHub App (preferred)**: set `GH_APP_ID`, `GH_APP_INSTALLATION_ID` and `GH_APP_PRIVATE_KEY_PATH` (or
  `GH_APP_PRIVATE_KEY` with the key inline). All three must be set.
- **Personal access token**: set `GH_TOKEN`. GitHub refuses a PAT on classic branch protection and on all three
  alert families, so those are reported as unavailable.

`doctor` checks the credential against a sample of about 30 repositories; `--all` checks every one.

If a private or internal repository reports no evidence, check the App installation holds every permission the
App declares. Adding a permission to an App leaves existing installations pending until an organisation admin
approves it, and private repositories need `pull_requests: read`.

SonarCloud is read anonymously; set `SONAR_TOKEN` to include private projects. `collect-cve` needs
`CVE_COSMOS_ACCOUNT` and `CVE_COSMOS_KEY` (the read-only key for `pipeline-metrics`).

## Collection

```bash
yarn cli collect-org --config metrics.yaml
yarn cli collect --config metrics.yaml --days 90
yarn cli map-sonar --config metrics.yaml
yarn cli collect-cve --config metrics.yaml
yarn cli collect-alerts --config metrics.yaml
```

`--days N` ends at the most recent UTC midnight; `--from`/`--to` give an explicit span. `--repository` limits a
run to one repository. Exit status is `0` when every repository was observed, `3` when some failed (or `0` with
`--tolerate-partial`), `1` when nothing usable came back and `2` for a bad command line.

Each run ends with a count of GitHub calls, broken down by endpoint and outcome. `exhausted` marks a request
that gave up after retrying.

- `collect-org --propose-teams` prints who owns each repository, and how that was decided, without storing it.
  Ownership is best effort: GitHub has no owner field, so it is inferred from team access, who authors the
  merges, CODEOWNERS and repository names, in the order set by `RungOrder` in `src/evidence/org/graph.ts`.
- `map-sonar` matches SonarCloud projects to repositories by the commit each analysis names. It uses GitHub's
  commit search, which is limited per minute, so it runs weekly on its own. Set `sonar_projects` in
  `metrics.yaml` to fix a project it can't resolve.
- `prune --days N` deletes cache intervals no collection has used for N days. It never touches the SonarCloud
  map.

Missing data is shown with its reason. A repository with no CVE report has not been scanned;
one with a report and no findings is clean.

## Deployment

The `dtsse-aat` Key Vault is managed in
[`hmcts/dtsse-shared-infrastructure`](https://github.com/hmcts/dtsse-shared-infrastructure). These secrets are
set by hand and are not in Terraform, so restore them if the vault is rebuilt:

```bash
az keyvault secret set --vault-name dtsse-aat --name github-app-id --value <app id>
az keyvault secret set --vault-name dtsse-aat --name github-app-installation-id --value <installation id>
az keyvault secret set --vault-name dtsse-aat --name github-app-private-key --file <the decrypted .pem>
az keyvault secret set --vault-name dtsse-aat --name entra-client-id --value <application id>
az keyvault secret set --vault-name dtsse-aat --name entra-client-secret --value <client secret>
az keyvault secret set --vault-name dtsse-aat --name session-secret --value "$(openssl rand -base64 48)"
```

Use `--file` for the private key so its newlines survive. Rotating `session-secret` signs everyone out.

Don't mount `github-token` from the same vault on the CronJobs. If the App key broke, the PAT would take over
and report merge gates and alerts as unavailable without failing.

### Signing in

Readers sign in with their HMCTS account through Microsoft Entra ID. Any account in the tenant can read the
dashboard. Sign-in is required unless `AUTH_DISABLED=true`, which previews and
the pipeline's `-staging` release set because Entra redirect URIs can't be wildcarded. `/health` needs no
sign-in.

The app registration is in [`hmcts/central-app-registration`](https://github.com/hmcts/central-app-registration)
(`apps.yaml`), with `signInAudience: AzureADMyOrg` and the redirect URI
`https://github-metrics.aat.platform.hmcts.net/auth/callback`. It writes the client id and secret to
`central-app-reg-kv`; copy them to `dtsse-aat` as above.

## Development

```bash
yarn lint
yarn test                # unit
yarn test:integration    # needs yarn deps:up
yarn test:e2e            # needs a running server; TEST_URL selects it
```

Playwright tests are tagged `@smoke` (previews), `@regression` (AAT) and `@nightly` (accessibility).

A pull request's preview loads a copy of the AAT database, with secret-scanning alert locations blanked, and
applies the branch's migrations on top, so a new migration is tested against real data before it merges. Add
the `enable_keep_helm` label before the deploy stage to keep the preview afterwards.
