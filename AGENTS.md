<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Two commands here can reach production

`yarn dev` and `yarn cli` both load the deployed secrets when they are allowed to, and the vault they resolve —
`dtsse-aat` — holds the **production** database credentials and the collector's GitHub App key. There is one
production estate and no non-production copy of it.

Reading the vault is therefore opt-in outside production: it happens when `NODE_ENV=production`, as the runtime
image sets, or when `USE_KEY_VAULT=true` is set on purpose. Every start-up prints the database it resolved:

```
database: localhost:5432/github_metrics
```

Read that line before believing a local run is local. With the opt-in set, `yarn cli collect` writes to the
production database and `yarn cli prune` deletes from it.
