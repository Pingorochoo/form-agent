FROM mcr.microsoft.com/devcontainers/typescript-node:24-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       curl \
       git \
       jq \
       ca-certificates \
    && rm -rf /var/lib/apt/lists/*

USER node
