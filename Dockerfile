# One image, two entry points: the Next.js server the web pod runs, and the collector the CronJob runs.
#
# node:22-alpine rather than cms-template's node:20, because package.json declares engines >=22.

# ---- Base image ----
FROM hmctsprod.azurecr.io/base/node:22-alpine AS base

USER root
RUN corepack enable
USER hmcts

# ---- Dependencies image ----
FROM base AS dependencies

WORKDIR /app
USER root
RUN chown -R hmcts:hmcts /app
USER hmcts

COPY --chown=hmcts:hmcts package.json yarn.lock .yarnrc.yml ./
COPY --chown=hmcts:hmcts .yarn ./.yarn

RUN yarn install --immutable

# ---- Build image ----
FROM dependencies AS build

WORKDIR /app

COPY --chown=hmcts:hmcts tsconfig.json tsconfig.cli.json next.config.mjs tailwind.config.ts postcss.config.mjs biome.json ./
COPY --chown=hmcts:hmcts prisma.config.ts ./
COPY --chown=hmcts:hmcts src ./src
COPY --chown=hmcts:hmcts config ./config
COPY --chown=hmcts:hmcts prisma ./prisma

# Generated before either build: the app and the CLI both import the Prisma client.
RUN yarn db:generate
RUN yarn build:app
RUN yarn build:cli

# ---- Development image ----
FROM dependencies AS development

WORKDIR /app
USER root
RUN apk add --no-cache bash
USER hmcts

COPY --chown=hmcts:hmcts . .

ENV NODE_ENV=development

# ---- Runtime image ----
FROM base AS runtime

WORKDIR /app
USER root
RUN chown -R hmcts:hmcts /app
USER hmcts

ENV NODE_ENV=production

# `.next/standalone` carries its own traced node_modules for the web path, but the CLI in `dist/` is compiled
# rather than bundled, so its runtime dependencies are installed here.
COPY --chown=hmcts:hmcts package.json yarn.lock .yarnrc.yml ./
COPY --chown=hmcts:hmcts .yarn ./.yarn
RUN yarn workspaces focus --production 2>/dev/null || yarn install --immutable

COPY --from=build --chown=hmcts:hmcts /app/.next/standalone ./
# Not traced into the standalone output, so copied explicitly, or every page 404s on its assets.
COPY --from=build --chown=hmcts:hmcts /app/.next/static ./.next/static
COPY --from=build --chown=hmcts:hmcts /app/dist ./dist
COPY --from=build --chown=hmcts:hmcts /app/config ./config
COPY --from=build --chown=hmcts:hmcts /app/prisma ./prisma
# The generated client, in BOTH places that resolve it, because the two entry points reach it differently.
#
# The web server's traced modules keep their source paths, so it looks under `src/`. The CLI was compiled by
# `tsc`, which rewrites nothing and copies no assets, so `dist/evidence/store/prisma.js` requires
# `./generated/client.js` beside itself. Copying only one of the two leaves the other entry point failing at its
# first import — and since the CronJob is the one that runs weekly, that failure would surface days later.
COPY --from=build --chown=hmcts:hmcts /app/src/evidence/store/generated ./src/evidence/store/generated
COPY --from=build --chown=hmcts:hmcts /app/src/evidence/store/generated ./dist/evidence/store/generated
# Read at runtime by `getPropertiesVolumeSecrets`, which parses the chart's own `keyVaults:` block.
COPY --chown=hmcts:hmcts charts ./charts
# The deployed estate, and the example beside it: AAT reads `metrics.yaml`, a preview reads the example, whose
# placeholder cohort is the right thing to report on when nothing has been collected anyway.
COPY --chown=hmcts:hmcts metrics.yaml metrics.example.yaml ./

EXPOSE 3000

# The web pod's entry point. The CronJob overrides it with `node dist/cli/run.js collect`.
#
# Migrating first, because a fresh environment has a database and no schema, and every page queries a table: a
# preview would otherwise deploy green probes over an app whose every route is an error. `migrate` is idempotent
# and takes a session advisory lock, so a restart costs one query and two pods cannot both apply.
#
# `exec` so the server, not the shell, is PID 1 and receives SIGTERM — without it a rolling update would wait
# out the grace period on every pod.
CMD ["sh", "-c", "node dist/cli/run.js migrate && exec node server.js"]
