# The companion daemon with everything a bot's computer needs: OpenCode, a
# virtual screen, Chrome and the desktop tools. Linux x86_64 only (ADR 0005).
# It runs as a container in CI, and as the root filesystem of a user's microVM.
#
# The image holds no secret and no per-user state. Keys arrive at run time and
# everything the daemon keeps lives on the volume mounted at /data.

# --- Dependencies, installed where the daemon's native binaries are chosen ---
FROM node:24.18.0-bookworm-slim AS deps
WORKDIR /app
RUN corepack enable
# Every workspace manifest is needed for the frozen lockfile to match.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/daemon/package.json apps/daemon/
COPY apps/relay/package.json apps/relay/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY infra/package.json infra/
# The workspace layout is kept (no `pnpm deploy`): Node will not strip types
# from TypeScript under node_modules, and the daemon runs from source.
RUN pnpm install --frozen-lockfile --prod --filter "@companion/daemon..."
# The daemon's imports name `.js` files that are `.ts` on disk, which Node
# alone does not map, so it runs under tsx (the version the repo tests with).
RUN npm install --prefix /opt/tsx --no-audit --no-fund tsx@4.23.15
COPY packages/shared packages/shared
COPY apps/daemon apps/daemon

# --- Dependencies for the live tests only, never in the shipped image ---
FROM deps AS deps-dev
RUN CI=true pnpm install --frozen-lockfile

# --- The runtime image ---
FROM ubuntu:24.04 AS runtime
ARG OPENCODE_VERSION=2.2.6
ARG OPENCODE_SHA256=08bb21d6326ce740d91cce7ebe88a6536933f6e1e30353b91a06b01f25da306c
ENV DEBIAN_FRONTEND=noninteractive

RUN test "$(dpkg --print-architecture)" = "amd64" \
 || { echo "This image is x86_64 only (see docs/adr/0005-microvms-on-shared-hosts.md)"; exit 1; }

# What the daemon starts on first use: Xvfb, Openbox, the session and
# accessibility buses, and the apps a bot may launch. Fonts so pages render.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git ripgrep \
      xvfb openbox dbus at-spi2-core mousepad galculator \
      fonts-liberation fonts-noto-core fonts-noto-color-emoji \
 && curl -fsSLo /tmp/chrome.deb \
      https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
 && apt-get install -y --no-install-recommends /tmp/chrome.deb \
 && rm -rf /tmp/chrome.deb /var/lib/apt/lists/*

# OpenCode comes from its GitHub release, pinned by checksum.
RUN curl -fsSLo /tmp/opencode.tar.gz \
      "https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}/opencode-linux-x64.tar.gz" \
 && echo "${OPENCODE_SHA256}  /tmp/opencode.tar.gz" | sha256sum -c - \
 && tar -xzf /tmp/opencode.tar.gz -C /usr/local/bin opencode \
 && rm /tmp/opencode.tar.gz

COPY --from=deps /usr/local/bin/node /usr/local/bin/node
COPY --from=deps /app /app
COPY --from=deps /opt/tsx /opt/tsx
ENV PATH=/opt/tsx/node_modules/.bin:$PATH

# A user other than root: Chrome keeps its sandbox, and a bot cannot touch the
# image. Ubuntu's own uid 1000 user is replaced.
RUN userdel -r ubuntu \
 && useradd --uid 1000 --create-home --shell /bin/bash companion \
 && mkdir /data && chown companion:companion /data

# A microVM's root filesystem is read only, so the tools' binaries must already
# be executable: agent-browser would otherwise try to make itself so on first run.
RUN find /app/node_modules/.pnpm \( -path '*/agent-browser/bin/agent-browser-linux-*' -o -path '*/agent-desktop/bin/*linux*' \) -type f -exec chmod 755 {} +

# Fails the build if any tool we ship is not a working x86_64 binary.
RUN node --version && opencode --version && google-chrome --version \
 && node /app/apps/daemon/node_modules/agent-browser/bin/agent-browser.js --version \
 && /app/apps/daemon/node_modules/.bin/agent-desktop --version

USER companion
# Chrome's sandbox cannot start under Docker's default seccomp profile, and we
# do not loosen that profile (no --privileged, no SYS_ADMIN). See docs/phase-4-2.md.
ENV COMPANION_DATA_DIR=/data \
    COMPANION_HOST=0.0.0.0 \
    COMPANION_CHROME_SANDBOX=off \
    PORT=3010
VOLUME /data
EXPOSE 3010
WORKDIR /app/apps/daemon
CMD ["tsx", "src/main.ts"]

# --- The runtime image plus the test runner, to run the live tests inside it ---
FROM runtime AS live-test
USER root
COPY --from=deps-dev /app/node_modules /app/node_modules
COPY --from=deps-dev /app/apps/daemon/node_modules /app/apps/daemon/node_modules
# The vision test paints a code into a PNG with ffmpeg.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-croscore \
 && rm -rf /var/lib/apt/lists/*
COPY vitest.config.ts /app/
RUN chown -R companion:companion /app
USER companion
WORKDIR /app
CMD ["sleep", "infinity"]
