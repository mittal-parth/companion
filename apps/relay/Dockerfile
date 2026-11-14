# The relay: the public meeting point between the web server and the VMs.
# Built with the repo root as context (`-f apps/relay/Dockerfile .`). Linux
# arm64 on Fargate, like the rest of the fleet (ADR 0004). The image holds no
# secret: RELAY_SECRET arrives at run time from Secrets Manager.
FROM node:24.18.0-bookworm-slim
WORKDIR /app
RUN corepack enable
# Every workspace manifest is needed for the frozen lockfile to match.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/daemon/package.json apps/daemon/
COPY apps/relay/package.json apps/relay/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY infra/package.json infra/
RUN pnpm install --frozen-lockfile --prod --filter "@companion/relay..."
# The relay imports `.js` names that are `.ts` on disk, which Node alone does
# not map, so it runs under tsx (the version the repo tests with).
RUN npm install --prefix /opt/tsx --no-audit --no-fund tsx@4.23.15
COPY packages/shared packages/shared
COPY apps/relay apps/relay
ENV PATH=/opt/tsx/node_modules/.bin:$PATH PORT=8080
USER node
EXPOSE 8080
WORKDIR /app/apps/relay
CMD ["tsx", "src/main.ts"]
