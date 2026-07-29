FROM node:22.22.1-bookworm-slim AS base

WORKDIR /app

RUN install -d -o node -g node -m 0700 /var/lib/firecrawl-codex-auth-state \
    && install -d -o node -g node -m 0770 /run/firecrawl-interaction \
    && install -d -o node -g node -m 0700 /run/firecrawl-model-egress \
    && install -d -o root -g root -m 0555 /run/certs

ENV NODE_ENV=production
USER node

FROM base AS model-egress-proxy

COPY --chown=node:node package.json ./
COPY --chown=node:node src/egress-policy.mjs src/egress-proxy.mjs ./src/

CMD ["node", "src/egress-proxy.mjs"]

FROM base AS worker

COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src

CMD ["node", "src/index.mjs"]
