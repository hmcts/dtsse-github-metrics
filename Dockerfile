FROM hmctsprod.azurecr.io/base/node:22-alpine AS base

USER root
RUN corepack enable
USER hmcts

FROM base AS dependencies

WORKDIR /app
USER root
RUN chown -R hmcts:hmcts /app
USER hmcts

COPY --chown=hmcts:hmcts package.json yarn.lock .yarnrc.yml ./
COPY --chown=hmcts:hmcts .yarn ./.yarn

RUN yarn install --immutable

FROM dependencies AS build

WORKDIR /app

COPY --chown=hmcts:hmcts tsconfig.json tsconfig.cli.json next.config.mjs tailwind.config.ts postcss.config.mjs biome.json ./
COPY --chown=hmcts:hmcts prisma.config.ts ./
COPY --chown=hmcts:hmcts src ./src
COPY --chown=hmcts:hmcts config ./config
COPY --chown=hmcts:hmcts prisma ./prisma

RUN yarn db:generate
RUN yarn build:app
RUN yarn build:cli

FROM dependencies AS development

WORKDIR /app
USER root
RUN apk add --no-cache bash
USER hmcts

COPY --chown=hmcts:hmcts . .

ENV NODE_ENV=development

FROM base AS runtime

WORKDIR /app
USER root
RUN chown -R hmcts:hmcts /app
USER hmcts

ENV NODE_ENV=production

COPY --chown=hmcts:hmcts package.json yarn.lock .yarnrc.yml ./
COPY --chown=hmcts:hmcts .yarn ./.yarn
RUN yarn workspaces focus --production 2>/dev/null || yarn install --immutable

COPY --from=build --chown=hmcts:hmcts /app/.next/standalone ./
COPY --from=build --chown=hmcts:hmcts /app/.next/static ./.next/static
COPY --from=build --chown=hmcts:hmcts /app/dist ./dist
COPY --from=build --chown=hmcts:hmcts /app/config ./config
COPY --from=build --chown=hmcts:hmcts /app/prisma ./prisma
COPY --from=build --chown=hmcts:hmcts /app/src/evidence/store/generated ./src/evidence/store/generated
COPY --from=build --chown=hmcts:hmcts /app/src/evidence/store/generated ./dist/evidence/store/generated
COPY --chown=hmcts:hmcts charts ./charts
COPY --chown=hmcts:hmcts metrics.yaml metrics.example.yaml ./

EXPOSE 3000

CMD ["sh", "-c", "node dist/cli/run.js migrate && exec node server.js"]
