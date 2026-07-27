FROM docker.io/library/node:22.22.1-bookworm-slim@sha256:4f77a690f2f8946ab16fe1e791a3ac0667ae1c3575c3e4d0d4589e9ed5bfaf3d AS node-runtime

FROM mcr.microsoft.com/playwright:v1.61.1-noble@sha256:5b8f294aff9041b7191c34a4bab3ac270157a28774d4b0660e9743297b697e48

COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/lib/node_modules/npm/ /usr/local/lib/node_modules/npm/
RUN ln -sf ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && test "$(node --version)" = "v22.22.1" \
    && test "$(python3 --version)" = "Python 3.12.3" \
    && test "$(bash --version | head -n 1)" = "GNU bash, version 5.2.21(1)-release (x86_64-pc-linux-gnu)" \
    && rm -f /etc/apt/sources.list.d/nodesource.list \
    && apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends python3-pip \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /opt/firecrawl \
    && npm install --prefix /opt/firecrawl --omit=dev --ignore-scripts --no-audit --no-fund playwright@1.61.1 ws@8.21.1 \
    && python3 -m pip install --break-system-packages --no-cache-dir \
        playwright==1.61.0 greenlet==3.5.4 pyee==13.0.1 typing-extensions==4.16.0 \
    && node -e 'if(require("/opt/firecrawl/node_modules/playwright/package.json").version!=="1.61.1"||require("/opt/firecrawl/node_modules/ws/package.json").version!=="8.21.1")process.exit(1)' \
    && python3 -c 'import importlib.metadata as m; assert {n: m.version(n) for n in ("playwright","greenlet","pyee","typing-extensions")} == {"playwright":"1.61.0","greenlet":"3.5.4","pyee":"13.0.1","typing-extensions":"4.16.0"}' \
    && rm -rf /ms-playwright /usr/local/lib/node_modules/npm \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/bin/pip /usr/bin/pip3 /usr/bin/pip3.12

COPY job-init.py job-relay-supervisor.mjs run-node.mjs run-python.py run-bash.sh agent-browser.py cdp-relay.mjs /opt/firecrawl/bin/
RUN set -eu; \
    ln -s /opt/firecrawl/bin/agent-browser.py /opt/firecrawl/bin/agent-browser; \
    chmod 0555 /opt/firecrawl/bin/*; \
    find / -xdev \( ! -uid 0 -o ! -gid 0 \) -exec chown -h 0:0 '{}' +; \
    find /opt/firecrawl -xdev -type d -exec chmod go-w '{}' +; \
    find /opt/firecrawl -xdev -type f -exec chmod go-w '{}' +; \
    find / -xdev -type d -perm /022 -exec chmod go-w '{}' +; \
    find / -xdev -type f -perm /022 -exec chmod go-w '{}' +

USER 65532:65532
WORKDIR /run/firecrawl-work
ENTRYPOINT ["/opt/firecrawl/bin/job-init.py"]
