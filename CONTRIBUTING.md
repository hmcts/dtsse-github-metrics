# Contributing

The conventions this repository actually lives by. They existed only as comments beside the code that obeys
them, which meant a reviewer had to have read the right file to know a rule was being broken.

`AGENTS.md` and `CLAUDE.md` are **not** where these belong and are not tracked here — `next dev` writes
`AGENTS.md` on every run, so a tracked copy is a permanent diff where an untracked one is a clean tree. Leave
both to Next; this file is the one to edit.

## Absent and zero are different answers, everywhere

**The single most important rule in the codebase.** Every figure this service reports distinguishes *nobody
measured this* from *this was measured and the answer is none*:

- **absent** (`undefined`, dropped from the JSON by `stripAbsent`, rendered as a dash) means unmeasured — the
  walk was refused, no gate could be read, no SonarCloud project resolved, the repository was never collected.
- **zero** means measured, and the answer is nothing — a protected branch that requires no reviews really does
  require no reviews.

So: never default an unread value to `0`, never `?? 0` on the way to a renderer, and never sort or filter in a
way that quietly reads absence as the bottom of a range. `lib/format.ts`'s `quantity`/`percent` and
`lib/sort.ts`'s handling of absent keys exist to keep this honest — use them rather than `String(...)`, which
prints `undefined` for a figure nobody measured.

A field being optional on a contract can also mean *an older deployment did not send it*. Where that is the
case the field's own comment says so, with the version it appeared in, because the two absences take different
fallbacks.

## Layering

- **`src/evidence/**` is server-only.** It reaches Postgres and GitHub. Nothing under `src/app/` or
  `src/components/` may import it directly.
- **`src/lib/api.ts` is the single seam** between the UI and the evidence layer. It carries `import
  "server-only"` as its first line — enforced by a test — so a client component importing it fails at build
  time instead of at runtime. Every page gets its data through a function in this file.
- **`src/lib/**` otherwise holds presentation logic**: shaping rows, tones, formatting, sorting. It is
  importable from components.
- `src/lib/types.ts` is the contract between the two halves. Adding a field there is a contract change, and its
  comment should say which of the two kinds of field it is and what absence means.
- **The serving path writes exactly one table**, `repository_notes`, through
  `src/app/repositories/[repository]/notes.ts` — the only `"use server"` file in the tree. Everything else the
  pages reach is read-only to them. A server action is reachable by a direct POST rather than only through the
  form that renders it, so **every action calls `writingAuthor` in `src/auth/author.ts` first**; the middleware
  guard in `src/proxy.ts` is not a substitute for that check, and neither is the other way round. A second write
  path is a decision worth arguing for in the PR, not a file to add. Never put `"use server"` on
  `src/lib/api.ts`: it would publish every read as a POST endpoint.

## Structure

- **Feature folders, not type folders.** `evidence/org/`, `evidence/behaviour/`, `evidence/store/` — a folder
  is a subject, not a layer of the same subject spread thin.
- **No `utils/`, no `helpers/`, no `common/`.** There are none, and a new one is a sign the thing belongs next
  to the feature that needs it or in a named module of its own.
- **Functions, not classes.** The only classes in `src/` are `Error` subclasses; everything else is a function,
  usually pure. Pass state in rather than holding it in an instance.
- **ESM.** `module: esnext` with `moduleResolution: bundler`; relative imports carry their explicit file
  extension (`./database-url.ts`). No `require`, no CommonJS interop shims.

## Dependencies

**Pinned exact, with no range operators.** Every entry in `dependencies` and `devDependencies` is an exact
version — no `^`, no `~` — and `resolutions` likewise. Renovate raises the bumps; do not reintroduce a caret to
avoid a conflict.

Do not add a dependency to this repository without a reason that survives being written down in the PR.

## Never a bare `.sort()`

**Always pass a comparator.** `Array.prototype.sort` with no argument coerces every element to a string and
compares UTF-16 code units, so `[10, 9]` sorts to `[10, 9]` and a locale-sensitive reader cannot tell which
collation applied. SonarCloud raises it as a CRITICAL bug and it has pinned this repository's reliability
rating to D twice now, on separate pull requests — so it is cheaper to make it a habit than to keep re-fixing it.

- For strings, `byCodePoint` in [`src/evidence/org/graph.ts`](src/evidence/org/graph.ts) is the house comparator.
  It is deliberately **not** `localeCompare`: a locale collation reorders or ignores the hyphen, so `sscs-api` and
  `sscsapi` sort differently under the two rules — and code-point order is what makes two runs over unchanged
  evidence produce byte-identical output, which is what lets a stored digest say "nothing changed" rather than
  "the order changed".
- For numbers, `(left, right) => left - right`. Sorting numbers as strings is the failure this rule is named for.
- For anything reported to a reader, sort on the field you mean and say which. `report/rows/actors.ts` records
  what a bare `.sort()` did to readiness labels: it ordered them `amber, cannot_assess, green, red`, which is
  alphabetical and looks deliberate.

There are older bare calls still in the tree. They are not a precedent — fix one when you are already changing
the line, not as unrelated churn.

## Comments

The house style is long and explanatory, and that is deliberate. A comment should say **why**, and where a
decision rests on a measurement it should quote the measurement.

Two rules follow from that:

- **State the current rule, not the history.** "This is a count" — not "this became a count on such a date".
  A comment that narrates its own past decays into a claim about code that no longer exists, and the next
  reader believes it.
- **A wrong comment is worse than no comment.** These comments get followed instead of the code. When you
  change behaviour, the comments that justified the old behaviour are part of the change.

## Tests

- **`should <behaviour> when <condition>`** is the naming form: `it("should exclude a merge at the window's
  exclusive end")`. State the behaviour, not the function name, and put the condition in the name rather than
  leaving it in the fixture.
- Unit tests live in `__tests__/` beside what they test, or as `<name>.test.ts` next to it; integration tests
  that need Postgres live in `test/integration/`.
- `yarn test` is the unit suite, `yarn test:integration` needs the compose Postgres (`yarn deps:up`).

## Local development, and the way it reaches production

**`yarn dev` and `yarn cli` can both attach to the real AAT estate.** Secret loading is gated by
`keyVaultAllowed` in `src/platform/secrets.ts`:

```ts
return env.NODE_ENV === "production" || env[KEY_VAULT_OPT_IN] === "true";
```

- With neither set — the ordinary local case — nothing resolves a vault and the compose defaults are used.
- With `USE_KEY_VAULT=true`, a laptop with an `az login` session resolves the **`dtsse-aat`** vault and
  attaches to the **production** Postgres holding the whole estate. That is the point of the flag, and it is
  opt-in on purpose; it used to be unconditional.
- The runtime image sets `NODE_ENV=production`, so the web pod and both CronJobs always resolve it.

So `USE_KEY_VAULT=true yarn cli collect` is a production write, run from your machine. Treat any `yarn cli`
subcommand as production-touching unless you have checked which database it resolved — the startup log says.

## Gates

| Command | What it is |
| --- | --- |
| `yarn lint` | `biome check --error-on-warnings .` — a new warning fails the build |
| `yarn typecheck` | three passes: app, `tsconfig.cli.json`, `tsconfig.e2e.json` |
| `yarn test:coverage` | unit suite with coverage thresholds |
| `yarn test:integration` | needs Postgres; run in CI |
| `yarn build` | `next build` plus the CLI's `tsc` build |

**`yarn lint` is a no-op inside a worktree under `.claude/worktrees/`.** `biome.json` lists
`"!**/.claude/worktrees"` in `files.includes`, so running `biome check .` from inside one collects no files and
reports success having checked nothing. Name the directories instead:

```
yarn biome check src test
```

## Charts

`charts/dtsse-github-metrics/` is the deployed chart, mirrored into `hmcts-charts` by the pipeline on every
master build. **Any change to `values.yaml` needs `Chart.yaml`'s `version` bumped in the same commit** or Flux
will not pick it up. The full reasoning is at the top of `values.yaml`.
