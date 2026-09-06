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
# The generated client is imported by `dist/`, whose modules were compiled rather than bundled.
COPY --from=build --chown=hmcts:hmcts /app/src/evidence/store/generated ./src/evidence/store/generated
# Read at runtime by `getPropertiesVolumeSecrets`, which parses the chart's own `keyVaults:` block.
COPY --chown=hmcts:hmcts charts ./charts
COPY --chown=hmcts:hmcts metrics.example.yaml ./

EXPOSE 3000

# The web pod's entry point. The CronJob overrides it with `node dist/cli/run.js collect`.
CMD ["node", "server.js"]
