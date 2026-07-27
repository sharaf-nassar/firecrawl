FROM docker.io/library/node:22.22.1-bookworm-slim@sha256:4f77a690f2f8946ab16fe1e791a3ac0667ae1c3575c3e4d0d4589e9ed5bfaf3d

COPY codex-app-server/package/ /opt/firecrawl/codex/package/
COPY codex-app-server/codex-launcher.mjs /opt/firecrawl/bin/codex
COPY protocol/ /opt/firecrawl/protocol/

RUN set -eu; \
    test "$(node --version)" = "v22.22.1"; \
    test -f /opt/firecrawl/codex/package/bin/codex.js; \
    find / -xdev \( ! -uid 0 -o ! -gid 0 \) -exec chown -h 0:0 '{}' +; \
    find /opt/firecrawl -xdev -type d -exec chmod 0555 '{}' +; \
    find /opt/firecrawl -xdev -type f -perm /111 -exec chmod 0555 '{}' +; \
    find /opt/firecrawl -xdev -type f ! -perm /111 -exec chmod 0444 '{}' +; \
    chmod 0555 /opt/firecrawl/bin/codex /opt/firecrawl/codex/package/bin/codex.js; \
    find / -xdev -type d -perm /022 -exec chmod go-w '{}' +; \
    find / -xdev -type f -perm /022 -exec chmod go-w '{}' +

USER 65532:65532
WORKDIR /run/firecrawl-work
ENTRYPOINT ["/opt/firecrawl/bin/codex"]
