FROM mcr.microsoft.com/devcontainers/typescript-node:24-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       curl \
       git \
       jq \
       ca-certificates \
       tmux \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g opencode-ai@1.18.30

USER node
