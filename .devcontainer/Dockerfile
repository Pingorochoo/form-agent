FROM mcr.microsoft.com/devcontainers/typescript-node:24-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       curl \
       git \
       jq \
       ca-certificates \
       tmux \
    && rm -rf /var/lib/apt/lists/*

# Phase 5 reproducible browser provisioning: install the Debian/Chromium system
# dependencies required by Playwright 1.63.0 (pinned to the lockfile version) at
# image-build time, as root. The browser binary itself is installed at container
# start (see devcontainer.json postCreateCommand) into the `node` user's cache.
RUN npx --yes playwright@1.63.0 install-deps chromium

RUN npm install -g opencode-ai@1.18.30

USER node
