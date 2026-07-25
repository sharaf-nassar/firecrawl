# syntax=docker/dockerfile:1

FROM docker.io/library/node:22.22.1-bookworm-slim@sha256:4f77a690f2f8946ab16fe1e791a3ac0667ae1c3575c3e4d0d4589e9ed5bfaf3d AS browser-service-pnpm-tool
RUN set -eu; \
    mkdir -p /opt/pnpm/10.33.0; \
    node --input-type=module -e 'import {createHash} from "node:crypto";import {writeFile} from "node:fs/promises";const url="https://registry.npmjs.org/pnpm/-/pnpm-10.33.0.tgz";const expected="sha512-EFaLtKavtYyes2MNqQzJUWQXq+vT+rvmc58K55VyjaFJHp21pUTHatjrdXD1xLs9bGN7LLQb/c20f6gjyGSTGQ==";const response=await fetch(url,{redirect:"error"});if(!response.ok)process.exit(1);const bytes=Buffer.from(await response.arrayBuffer());const actual=`sha512-${createHash("sha512").update(bytes).digest("base64")}`;if(actual!==expected)process.exit(1);await writeFile("/tmp/pnpm-10.33.0.tgz",bytes,{flag:"wx",mode:0o600})'; \
    tar --extract --gzip --file /tmp/pnpm-10.33.0.tgz --directory /opt/pnpm/10.33.0 --strip-components=1; \
    test "$(node -p 'require("/opt/pnpm/10.33.0/package.json").version')" = 10.33.0; \
    ln -s /opt/pnpm/10.33.0/bin/pnpm.cjs /usr/local/bin/pnpm; \
    test "$(realpath /usr/local/bin/pnpm)" = /opt/pnpm/10.33.0/bin/pnpm.cjs; \
    test "$(/usr/local/bin/pnpm --version)" = 10.33.0; \
    rm /tmp/pnpm-10.33.0.tgz

FROM docker.io/library/node:22.22.1-bookworm-slim@sha256:4f77a690f2f8946ab16fe1e791a3ac0667ae1c3575c3e4d0d4589e9ed5bfaf3d AS browser-service-node-toolchain
ARG TARGETARCH
WORKDIR /app/apps/browser-service
COPY apps/browser-service/native/toolchain-allowlist.json native/toolchain-allowlist.json
RUN set -eu; \
    tuple="$(node --input-type=module -e 'const fs=await import("node:fs/promises");const arch=process.argv[1];const x=JSON.parse(await fs.readFile("native/toolchain-allowlist.json","utf8"));const keys=["targetArch","nodeBaseRepository","nodeBaseIndexDigest","nodeBasePlatformDigest","osReleaseSha256","dpkgArchitecture","utilLinuxPackage","utilLinuxVersion","flockRealpath","flockSha256"];if(x.schemaVersion!==1||Object.keys(x).join(",")!=="schemaVersion,dockerInit"||Object.keys(x.dockerInit).join(",")!=="amd64,arm64"||!Object.hasOwn(x.dockerInit,arch)||!Object.hasOwn({amd64:1,arm64:1},arch))process.exit(1);const t=x.dockerInit[arch];if(Object.keys(t).join(",")!==keys.join(",")||t.targetArch!==arch)process.exit(1);process.stdout.write(JSON.stringify(t))' "$TARGETARCH")"; \
    node_base_repository="$(printf '%s' "$tuple" | node --input-type=module -e 'let s="";for await(const c of process.stdin)s+=c;process.stdout.write(JSON.parse(s).nodeBaseRepository)')"; \
    node_base_index_digest="$(printf '%s' "$tuple" | node --input-type=module -e 'let s="";for await(const c of process.stdin)s+=c;const x=JSON.parse(s);if(!/^sha256:[a-f0-9]{64}$/.test(x.nodeBaseIndexDigest))process.exit(1);process.stdout.write(x.nodeBaseIndexDigest)')"; \
    node_base_platform_digest="$(printf '%s' "$tuple" | node --input-type=module -e 'let s="";for await(const c of process.stdin)s+=c;const x=JSON.parse(s);if(!/^sha256:[a-f0-9]{64}$/.test(x.nodeBasePlatformDigest))process.exit(1);process.stdout.write(x.nodeBasePlatformDigest)')"; \
    util_linux_version="$(printf '%s' "$tuple" | node --input-type=module -e 'let s="";for await(const c of process.stdin)s+=c;const x=JSON.parse(s);if(x.utilLinuxPackage!=="util-linux"||typeof x.utilLinuxVersion!=="string"||x.utilLinuxVersion.length===0)process.exit(1);process.stdout.write(x.utilLinuxVersion)')"; \
    expected_dpkg_arch="$(printf '%s' "$tuple" | node --input-type=module -e 'let s="";for await(const c of process.stdin)s+=c;const x=JSON.parse(s);process.stdout.write(x.dpkgArchitecture)')"; \
    expected_os_release_sha="$(printf '%s' "$tuple" | node --input-type=module -e 'let s="";for await(const c of process.stdin)s+=c;const x=JSON.parse(s);if(!/^[a-f0-9]{64}$/.test(x.osReleaseSha256))process.exit(1);process.stdout.write(x.osReleaseSha256)')"; \
    expected_flock_realpath="$(printf '%s' "$tuple" | node --input-type=module -e 'let s="";for await(const c of process.stdin)s+=c;const x=JSON.parse(s);process.stdout.write(x.flockRealpath)')"; \
    expected_flock_sha="$(printf '%s' "$tuple" | node --input-type=module -e 'let s="";for await(const c of process.stdin)s+=c;const x=JSON.parse(s);if(!/^[a-f0-9]{64}$/.test(x.flockSha256))process.exit(1);process.stdout.write(x.flockSha256)')"; \
    test "$node_base_repository" = docker.io/library/node:22.22.1-bookworm-slim; \
    test "$node_base_index_digest" = sha256:4f77a690f2f8946ab16fe1e791a3ac0667ae1c3575c3e4d0d4589e9ed5bfaf3d; \
    case "$TARGETARCH" in amd64) test "$node_base_platform_digest" = sha256:af5818e10f6294a719b4314f34ec03d8e8ad8f571a8d23742418790e6ebb5c90 ;; arm64) test "$node_base_platform_digest" = sha256:3162cb197078fe74b5a5cb7e3f6a25150f5e0437d5b990fb13e2a4fb85f79bea ;; *) exit 1 ;; esac; \
    test "$(node --version)" = v22.22.1; \
    test "$(sha256sum /etc/os-release | cut -d' ' -f1)" = "$expected_os_release_sha"; \
    apt-get update; \
    apt-get install -y --no-install-recommends "util-linux=${util_linux_version}"; \
    test "$(dpkg --print-architecture)" = "$expected_dpkg_arch"; \
    test "$(dpkg-query -W -f='${Version}' util-linux)" = "$util_linux_version"; \
    test "$(realpath /usr/bin/flock)" = "$expected_flock_realpath"; \
    test "$(sha256sum /usr/bin/flock | cut -d' ' -f1)" = "$expected_flock_sha"; \
    /usr/bin/flock --help >/dev/null; \
    apt-get install -y --no-install-recommends binutils gcc g++ make; \
    test "$(dpkg --print-architecture)" = "$expected_dpkg_arch"; \
    test "$(dpkg-query -W -f='${Version}' util-linux)" = "$util_linux_version"; \
    test "$(realpath /usr/bin/flock)" = "$expected_flock_realpath"; \
    test "$(sha256sum /usr/bin/flock | cut -d' ' -f1)" = "$expected_flock_sha"; \
    rm -rf /var/lib/apt/lists/*

FROM docker.io/library/node:22.22.1-bookworm-slim@sha256:4f77a690f2f8946ab16fe1e791a3ac0667ae1c3575c3e4d0d4589e9ed5bfaf3d AS browser-service-production-dependencies
COPY --from=browser-service-pnpm-tool /opt/pnpm/10.33.0 /opt/pnpm/10.33.0
RUN ln -s /opt/pnpm/10.33.0/bin/pnpm.cjs /usr/local/bin/pnpm \
    && test "$(realpath /usr/local/bin/pnpm)" = /opt/pnpm/10.33.0/bin/pnpm.cjs \
    && test "$(/usr/local/bin/pnpm --version)" = 10.33.0
WORKDIR /app/apps/browser-service
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY apps/browser-service/package.json apps/browser-service/pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile --ignore-scripts

FROM browser-service-node-toolchain AS browser-service-build
ARG TARGETARCH
COPY --from=browser-service-pnpm-tool /opt/pnpm/10.33.0 /opt/pnpm/10.33.0
RUN ln -s /opt/pnpm/10.33.0/bin/pnpm.cjs /usr/local/bin/pnpm \
    && test "$(realpath /usr/local/bin/pnpm)" = /opt/pnpm/10.33.0/bin/pnpm.cjs \
    && test "$(/usr/local/bin/pnpm --version)" = 10.33.0
WORKDIR /app/apps/browser-service
RUN set -eu; \
    tuple="$(node --input-type=module -e 'const fs=await import("node:fs/promises");const arch=process.argv[1];const x=JSON.parse(await fs.readFile("native/toolchain-allowlist.json","utf8"));const keys=["targetArch","nodeBaseRepository","nodeBaseIndexDigest","nodeBasePlatformDigest","osReleaseSha256","dpkgArchitecture","utilLinuxPackage","utilLinuxVersion","flockRealpath","flockSha256"];if(x.schemaVersion!==1||Object.keys(x).join(",")!=="schemaVersion,dockerInit"||Object.keys(x.dockerInit).join(",")!=="amd64,arm64"||!Object.hasOwn(x.dockerInit,arch)||!Object.hasOwn({amd64:1,arm64:1},arch))process.exit(1);const t=x.dockerInit[arch];if(Object.keys(t).join(",")!==keys.join(",")||t.targetArch!==arch)process.exit(1);process.stdout.write(JSON.stringify(t))' "$TARGETARCH")"; \
    node_base_repository="$(printf '%s' "$tuple" | node --input-type=module -e 'let s="";for await(const c of process.stdin)s+=c;process.stdout.write(JSON.parse(s).nodeBaseRepository)')"; \
    node_base_index_digest="$(printf '%s' "$tuple" | node --input-type=module -e 'let s="";for await(const c of process.stdin)s+=c;const x=JSON.parse(s);if(!/^sha256:[a-f0-9]{64}$/.test(x.nodeBaseIndexDigest))process.exit(1);process.stdout.write(x.nodeBaseIndexDigest)')"; \
    node_base_platform_digest="$(printf '%s' "$tuple" | node --input-type=module -e 'let s="";for await(const c of process.stdin)s+=c;const x=JSON.parse(s);if(!/^sha256:[a-f0-9]{64}$/.test(x.nodeBasePlatformDigest))process.exit(1);process.stdout.write(x.nodeBasePlatformDigest)')"; \
    expected_os_release_sha="$(printf '%s' "$tuple" | node --input-type=module -e 'let s="";for await(const c of process.stdin)s+=c;const x=JSON.parse(s);if(!/^[a-f0-9]{64}$/.test(x.osReleaseSha256))process.exit(1);process.stdout.write(x.osReleaseSha256)')"; \
    expected_dpkg_arch="$(printf '%s' "$tuple" | node --input-type=module -e 'let s="";for await(const c of process.stdin)s+=c;process.stdout.write(JSON.parse(s).dpkgArchitecture)')"; \
    util_linux_version="$(printf '%s' "$tuple" | node --input-type=module -e 'let s="";for await(const c of process.stdin)s+=c;const x=JSON.parse(s);if(x.utilLinuxPackage!=="util-linux"||typeof x.utilLinuxVersion!=="string"||x.utilLinuxVersion.length===0)process.exit(1);process.stdout.write(x.utilLinuxVersion)')"; \
    expected_flock_realpath="$(printf '%s' "$tuple" | node --input-type=module -e 'let s="";for await(const c of process.stdin)s+=c;process.stdout.write(JSON.parse(s).flockRealpath)')"; \
    expected_flock_sha="$(printf '%s' "$tuple" | node --input-type=module -e 'let s="";for await(const c of process.stdin)s+=c;const x=JSON.parse(s);if(!/^[a-f0-9]{64}$/.test(x.flockSha256))process.exit(1);process.stdout.write(x.flockSha256)')"; \
    test "$node_base_repository" = docker.io/library/node:22.22.1-bookworm-slim; \
    test "$node_base_index_digest" = sha256:4f77a690f2f8946ab16fe1e791a3ac0667ae1c3575c3e4d0d4589e9ed5bfaf3d; \
    case "$TARGETARCH" in amd64) test "$node_base_platform_digest" = sha256:af5818e10f6294a719b4314f34ec03d8e8ad8f571a8d23742418790e6ebb5c90 ;; arm64) test "$node_base_platform_digest" = sha256:3162cb197078fe74b5a5cb7e3f6a25150f5e0437d5b990fb13e2a4fb85f79bea ;; *) exit 1 ;; esac; \
    test "$(node --version)" = v22.22.1; \
    test "$(sha256sum /etc/os-release | cut -d' ' -f1)" = "$expected_os_release_sha"; \
    test "$(dpkg --print-architecture)" = "$expected_dpkg_arch"; \
    test "$(dpkg-query -W -f='${Version}' util-linux)" = "$util_linux_version"; \
    test "$(realpath /usr/bin/flock)" = "$expected_flock_realpath"; \
    test "$(sha256sum /usr/bin/flock | cut -d' ' -f1)" = "$expected_flock_sha"
COPY apps/browser-service/package.json apps/browser-service/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY apps/browser-service/contracts contracts
COPY apps/browser-service/native native
COPY apps/browser-service/scripts scripts
COPY apps/browser-service/src src
COPY apps/browser-service/tsconfig.json apps/browser-service/vitest.config.mjs ./
RUN test "$PWD" = /app/apps/browser-service \
    && test "$NODE_VERSION" = 22.22.1 \
    && test "$YARN_VERSION" = 1.22.22 \
    && /usr/bin/env -i \
      HOME=/root \
      PATH=/usr/local/bin:/usr/bin:/bin \
      LANG=C.UTF-8 \
      USER=root \
      LOGNAME=root \
      SHELL=/bin/sh \
      PWD=/app/apps/browser-service \
      /usr/local/bin/node \
      /app/apps/browser-service/scripts/run-native-build.mjs production \
    && pnpm exec tsc -p tsconfig.json

FROM browser-service-node-toolchain AS browser-service-test-build
ARG TARGETARCH
COPY --from=browser-service-pnpm-tool /opt/pnpm/10.33.0 /opt/pnpm/10.33.0
RUN ln -s /opt/pnpm/10.33.0/bin/pnpm.cjs /usr/local/bin/pnpm \
    && test "$(realpath /usr/local/bin/pnpm)" = /opt/pnpm/10.33.0/bin/pnpm.cjs \
    && test "$(/usr/local/bin/pnpm --version)" = 10.33.0
WORKDIR /app/apps/browser-service
RUN set -eu; \
    tuple="$(node --input-type=module -e 'const fs=await import("node:fs/promises");const arch=process.argv[1];const x=JSON.parse(await fs.readFile("native/toolchain-allowlist.json","utf8"));const keys=["targetArch","nodeBaseRepository","nodeBaseIndexDigest","nodeBasePlatformDigest","osReleaseSha256","dpkgArchitecture","utilLinuxPackage","utilLinuxVersion","flockRealpath","flockSha256"];if(x.schemaVersion!==1||Object.keys(x).join(",")!=="schemaVersion,dockerInit"||Object.keys(x.dockerInit).join(",")!=="amd64,arm64"||!Object.hasOwn(x.dockerInit,arch)||!Object.hasOwn({amd64:1,arm64:1},arch))process.exit(1);const t=x.dockerInit[arch];if(Object.keys(t).join(",")!==keys.join(",")||t.targetArch!==arch)process.exit(1);process.stdout.write(JSON.stringify(t))' "$TARGETARCH")"; \
    node_base_repository="$(printf '%s' "$tuple" | node --input-type=module -e 'let s="";for await(const c of process.stdin)s+=c;process.stdout.write(JSON.parse(s).nodeBaseRepository)')"; \
    node_base_index_digest="$(printf '%s' "$tuple" | node --input-type=module -e 'let s="";for await(const c of process.stdin)s+=c;const x=JSON.parse(s);if(!/^sha256:[a-f0-9]{64}$/.test(x.nodeBaseIndexDigest))process.exit(1);process.stdout.write(x.nodeBaseIndexDigest)')"; \
    node_base_platform_digest="$(printf '%s' "$tuple" | node --input-type=module -e 'let s="";for await(const c of process.stdin)s+=c;const x=JSON.parse(s);if(!/^sha256:[a-f0-9]{64}$/.test(x.nodeBasePlatformDigest))process.exit(1);process.stdout.write(x.nodeBasePlatformDigest)')"; \
    expected_os_release_sha="$(printf '%s' "$tuple" | node --input-type=module -e 'let s="";for await(const c of process.stdin)s+=c;const x=JSON.parse(s);if(!/^[a-f0-9]{64}$/.test(x.osReleaseSha256))process.exit(1);process.stdout.write(x.osReleaseSha256)')"; \
    expected_dpkg_arch="$(printf '%s' "$tuple" | node --input-type=module -e 'let s="";for await(const c of process.stdin)s+=c;process.stdout.write(JSON.parse(s).dpkgArchitecture)')"; \
    util_linux_version="$(printf '%s' "$tuple" | node --input-type=module -e 'let s="";for await(const c of process.stdin)s+=c;const x=JSON.parse(s);if(x.utilLinuxPackage!=="util-linux"||typeof x.utilLinuxVersion!=="string"||x.utilLinuxVersion.length===0)process.exit(1);process.stdout.write(x.utilLinuxVersion)')"; \
    expected_flock_realpath="$(printf '%s' "$tuple" | node --input-type=module -e 'let s="";for await(const c of process.stdin)s+=c;process.stdout.write(JSON.parse(s).flockRealpath)')"; \
    expected_flock_sha="$(printf '%s' "$tuple" | node --input-type=module -e 'let s="";for await(const c of process.stdin)s+=c;const x=JSON.parse(s);if(!/^[a-f0-9]{64}$/.test(x.flockSha256))process.exit(1);process.stdout.write(x.flockSha256)')"; \
    test "$node_base_repository" = docker.io/library/node:22.22.1-bookworm-slim; \
    test "$node_base_index_digest" = sha256:4f77a690f2f8946ab16fe1e791a3ac0667ae1c3575c3e4d0d4589e9ed5bfaf3d; \
    case "$TARGETARCH" in amd64) test "$node_base_platform_digest" = sha256:af5818e10f6294a719b4314f34ec03d8e8ad8f571a8d23742418790e6ebb5c90 ;; arm64) test "$node_base_platform_digest" = sha256:3162cb197078fe74b5a5cb7e3f6a25150f5e0437d5b990fb13e2a4fb85f79bea ;; *) exit 1 ;; esac; \
    test "$(node --version)" = v22.22.1; \
    test "$(sha256sum /etc/os-release | cut -d' ' -f1)" = "$expected_os_release_sha"; \
    test "$(dpkg --print-architecture)" = "$expected_dpkg_arch"; \
    test "$(dpkg-query -W -f='${Version}' util-linux)" = "$util_linux_version"; \
    test "$(realpath /usr/bin/flock)" = "$expected_flock_realpath"; \
    test "$(sha256sum /usr/bin/flock | cut -d' ' -f1)" = "$expected_flock_sha"
COPY apps/browser-service/package.json apps/browser-service/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY apps/browser-service/contracts contracts
COPY apps/browser-service/native native
COPY apps/browser-service/scripts scripts
COPY apps/browser-service/src src
COPY apps/browser-service/tsconfig.json apps/browser-service/vitest.config.mjs ./
RUN test "$PWD" = /app/apps/browser-service \
    && test "$NODE_VERSION" = 22.22.1 \
    && test "$YARN_VERSION" = 1.22.22 \
    && /usr/bin/env -i \
      HOME=/root \
      PATH=/usr/local/bin:/usr/bin:/bin \
      LANG=C.UTF-8 \
      USER=root \
      LOGNAME=root \
      SHELL=/bin/sh \
      PWD=/app/apps/browser-service \
      /usr/local/bin/node \
      /app/apps/browser-service/scripts/run-native-build.mjs all \
    && pnpm exec tsc -p tsconfig.json \
    && cp src/runtime-preflight.mjs dist/runtime-preflight.mjs \
    && cmp -s src/runtime-preflight.mjs dist/runtime-preflight.mjs \
    && test -x node_modules/.bin/vitest \
    && chown -R 1000:1000 /app/apps/browser-service

FROM mcr.microsoft.com/playwright:v1.61.1-noble@sha256:5b8f294aff9041b7191c34a4bab3ac270157a28774d4b0660e9743297b697e48 AS browser-test
RUN rm -rf /opt/pnpm /usr/local/lib/node_modules /usr/lib/node_modules \
    && rm -f /usr/bin/node /usr/bin/npm /usr/bin/npx /usr/bin/corepack /usr/bin/pnpm \
      /usr/local/bin/node /usr/local/bin/npm /usr/local/bin/npx \
      /usr/local/bin/corepack /usr/local/bin/pnpm
COPY --from=browser-service-pnpm-tool /usr/local/bin/node /usr/local/bin/node
COPY --from=browser-service-pnpm-tool /opt/pnpm/10.33.0 /opt/pnpm/10.33.0
RUN ln -s /opt/pnpm/10.33.0/bin/pnpm.cjs /usr/local/bin/pnpm \
    && test "$(realpath /usr/local/bin/pnpm)" = /opt/pnpm/10.33.0/bin/pnpm.cjs \
    && test "$(/usr/local/bin/pnpm --version)" = 10.33.0
WORKDIR /app/apps/browser-service
COPY --from=browser-service-test-build --chown=1000:1000 /app/apps/browser-service /app/apps/browser-service
RUN test "$PWD" = /app/apps/browser-service \
    && test "$(node --version)" = v22.22.1 \
    && test "$(realpath /usr/local/bin/pnpm)" = /opt/pnpm/10.33.0/bin/pnpm.cjs \
    && test "$(/usr/local/bin/pnpm --version)" = 10.33.0 \
    && test -f dist/runtime-preflight.mjs \
    && cmp -s src/runtime-preflight.mjs dist/runtime-preflight.mjs \
    && test -x node_modules/.bin/vitest
USER 1000:1000

FROM docker.io/library/node:22.22.1-bookworm-slim@sha256:4f77a690f2f8946ab16fe1e791a3ac0667ae1c3575c3e4d0d4589e9ed5bfaf3d AS browser-volume-init
ARG TARGETARCH
WORKDIR /app/apps/browser-service
COPY apps/browser-service/native/toolchain-allowlist.json native/toolchain-allowlist.json
RUN set -eu; \
    tuple="$(node --input-type=module -e 'const fs=await import("node:fs/promises");const arch=process.argv[1];const x=JSON.parse(await fs.readFile("native/toolchain-allowlist.json","utf8"));const keys=["targetArch","nodeBaseRepository","nodeBaseIndexDigest","nodeBasePlatformDigest","osReleaseSha256","dpkgArchitecture","utilLinuxPackage","utilLinuxVersion","flockRealpath","flockSha256"];if(x.schemaVersion!==1||Object.keys(x).join(",")!=="schemaVersion,dockerInit"||Object.keys(x.dockerInit).join(",")!=="amd64,arm64"||!Object.hasOwn(x.dockerInit,arch)||!Object.hasOwn({amd64:1,arm64:1},arch))process.exit(1);const t=x.dockerInit[arch];if(Object.keys(t).join(",")!==keys.join(",")||t.targetArch!==arch)process.exit(1);process.stdout.write(JSON.stringify(t))' "$TARGETARCH")"; \
    node_base_repository="$(printf '%s' "$tuple" | node --input-type=module -e 'let s="";for await(const c of process.stdin)s+=c;process.stdout.write(JSON.parse(s).nodeBaseRepository)')"; \
    node_base_index_digest="$(printf '%s' "$tuple" | node --input-type=module -e 'let s="";for await(const c of process.stdin)s+=c;const x=JSON.parse(s);if(!/^sha256:[a-f0-9]{64}$/.test(x.nodeBaseIndexDigest))process.exit(1);process.stdout.write(x.nodeBaseIndexDigest)')"; \
    node_base_platform_digest="$(printf '%s' "$tuple" | node --input-type=module -e 'let s="";for await(const c of process.stdin)s+=c;const x=JSON.parse(s);if(!/^sha256:[a-f0-9]{64}$/.test(x.nodeBasePlatformDigest))process.exit(1);process.stdout.write(x.nodeBasePlatformDigest)')"; \
    util_linux_version="$(printf '%s' "$tuple" | node --input-type=module -e 'let s="";for await(const c of process.stdin)s+=c;const x=JSON.parse(s);if(x.utilLinuxPackage!=="util-linux"||typeof x.utilLinuxVersion!=="string"||x.utilLinuxVersion.length===0)process.exit(1);process.stdout.write(x.utilLinuxVersion)')"; \
    expected_dpkg_arch="$(printf '%s' "$tuple" | node --input-type=module -e 'let s="";for await(const c of process.stdin)s+=c;const x=JSON.parse(s);process.stdout.write(x.dpkgArchitecture)')"; \
    expected_os_release_sha="$(printf '%s' "$tuple" | node --input-type=module -e 'let s="";for await(const c of process.stdin)s+=c;const x=JSON.parse(s);if(!/^[a-f0-9]{64}$/.test(x.osReleaseSha256))process.exit(1);process.stdout.write(x.osReleaseSha256)')"; \
    expected_flock_realpath="$(printf '%s' "$tuple" | node --input-type=module -e 'let s="";for await(const c of process.stdin)s+=c;const x=JSON.parse(s);process.stdout.write(x.flockRealpath)')"; \
    expected_flock_sha="$(printf '%s' "$tuple" | node --input-type=module -e 'let s="";for await(const c of process.stdin)s+=c;const x=JSON.parse(s);if(!/^[a-f0-9]{64}$/.test(x.flockSha256))process.exit(1);process.stdout.write(x.flockSha256)')"; \
    test "$node_base_repository" = docker.io/library/node:22.22.1-bookworm-slim; \
    test "$node_base_index_digest" = sha256:4f77a690f2f8946ab16fe1e791a3ac0667ae1c3575c3e4d0d4589e9ed5bfaf3d; \
    case "$TARGETARCH" in amd64) test "$node_base_platform_digest" = sha256:af5818e10f6294a719b4314f34ec03d8e8ad8f571a8d23742418790e6ebb5c90 ;; arm64) test "$node_base_platform_digest" = sha256:3162cb197078fe74b5a5cb7e3f6a25150f5e0437d5b990fb13e2a4fb85f79bea ;; *) exit 1 ;; esac; \
    test "$(node --version)" = v22.22.1; \
    test "$(sha256sum /etc/os-release | cut -d' ' -f1)" = "$expected_os_release_sha"; \
    apt-get update; \
    apt-get install -y --no-install-recommends "util-linux=${util_linux_version}"; \
    test "$(dpkg --print-architecture)" = "$expected_dpkg_arch"; \
    test "$(dpkg-query -W -f='${Version}' util-linux)" = "$util_linux_version"; \
    test "$(realpath /usr/bin/flock)" = "$expected_flock_realpath"; \
    test "$(sha256sum /usr/bin/flock | cut -d' ' -f1)" = "$expected_flock_sha"; \
    /usr/bin/flock --help >/dev/null; \
    rm -rf /var/lib/apt/lists/*
COPY apps/browser-service/scripts/init-state-volume.mjs scripts/init-state-volume.mjs
USER 0:0
ENTRYPOINT ["/usr/bin/flock","--exclusive","--timeout","60","/var/lib/firecrawl-browser-volume","/usr/local/bin/node","scripts/init-state-volume.mjs"]

FROM mcr.microsoft.com/playwright:v1.61.1-noble@sha256:5b8f294aff9041b7191c34a4bab3ac270157a28774d4b0660e9743297b697e48 AS browser-service-runtime
RUN rm -rf /opt/pnpm /root/.local/share/pnpm /home/pwuser/.local/share/pnpm \
      /usr/local/lib/node_modules /usr/lib/node_modules \
      /usr/include/node /usr/local/include/node \
    && rm -f /usr/bin/node /usr/bin/npm /usr/bin/npx /usr/bin/corepack /usr/bin/pnpm \
      /usr/local/bin/node /usr/local/bin/npm /usr/local/bin/npx \
      /usr/local/bin/corepack /usr/local/bin/pnpm /usr/bin/flock /bin/flock
COPY --from=browser-service-pnpm-tool /usr/local/bin/node /usr/local/bin/node
WORKDIR /app/apps/browser-service
COPY --from=browser-service-production-dependencies --chown=1000:1000 /app/apps/browser-service/node_modules node_modules
COPY --from=browser-service-build --chown=1000:1000 /app/apps/browser-service/package.json package.json
COPY --from=browser-service-build --chown=1000:1000 /app/apps/browser-service/dist dist
COPY --from=browser-service-build --chown=1000:1000 /app/apps/browser-service/build/Release/atomic_directory_publication.node build/Release/atomic_directory_publication.node
COPY --from=browser-service-build --chown=1000:1000 /app/apps/browser-service/build/Release/atomic-directory-publication.node.sha256 build/Release/atomic-directory-publication.node.sha256
COPY --from=browser-service-build --chown=1000:1000 /app/apps/browser-service/src/runtime-preflight.mjs src/runtime-preflight.mjs
COPY --from=browser-service-build --chown=1000:1000 /app/apps/browser-service/src/runtime-preflight.mjs dist/runtime-preflight.mjs
COPY --from=browser-service-build --chown=1000:1000 /app/apps/browser-service/scripts/check-atomic-publication-rollback.mjs scripts/check-atomic-publication-rollback.mjs
RUN printf '%s\n' \
      'export function validateToolchainAllowlist(bytes) {' \
      '  const text = Buffer.from(bytes).toString("utf8");' \
      '  const value = JSON.parse(text);' \
      '  if (text !== `${JSON.stringify(value)}\n`) throw new Error("toolchain allowlist is not canonical");' \
      '  return value;' \
      '}' > scripts/build-native.mjs \
    && chown 1000:1000 scripts/build-native.mjs \
    && chmod 0644 scripts/build-native.mjs \
    && chown 1000:1000 build/Release \
    && chmod 0700 build/Release \
    && chmod 0600 build/Release/atomic_directory_publication.node \
      build/Release/atomic-directory-publication.node.sha256 \
    && find /app/apps/browser-service/node_modules -xdev -depth \
      \( -path '*/test' -o -path '*/test/*' \
      -o -path '*/tests' -o -path '*/tests/*' \
      -o -path '*/__tests__' -o -path '*/__tests__/*' \
      -o -path '*/fixture' -o -path '*/fixture/*' \
      -o -path '*/fixtures' -o -path '*/fixtures/*' \
      -o -type f \( -name 'test.*' -o -name 'test-*' -o -name 'test_*' \
        -o -name 'spec.*' -o -name 'spec-*' -o -name 'spec_*' \
        -o -name 'fixture.*' -o -name 'fixture-*' -o -name 'fixture_*' \
        -o -name 'fixtures.*' -o -name 'fixtures-*' -o -name 'fixtures_*' \
        -o -name '*.test' -o -name '*.test.*' -o -name '*-test' \
        -o -name '*-test.*' -o -name '*_test' -o -name '*_test.*' \
        -o -name '*.spec' -o -name '*.spec.*' -o -name '*-spec' \
        -o -name '*-spec.*' -o -name '*_spec' -o -name '*_spec.*' \
        -o -name '*.fixture' -o -name '*.fixture.*' -o -name '*-fixture' \
        -o -name '*-fixture.*' -o -name '*_fixture' -o -name '*_fixture.*' \
        -o -name '*.fixtures' -o -name '*.fixtures.*' -o -name '*-fixtures' \
        -o -name '*-fixtures.*' -o -name '*_fixtures' \
        -o -name '*_fixtures.*' \) \) -delete \
    && find dist build src scripts \( -type p -o \( -type f \( \
      -name '*test*' -o -name '*fixture*' \
      -o -name '*.fifo' -o -name '*.o' -o -name '*.d' -o -name '*.map' \
      -o -name '*.trace' -o -name '*.inputs.sha256' -o -name 'pnpm.cjs' \
      -o -name 'pnpmrc' \) \) \) -delete \
    && test ! -e /opt/pnpm \
    && test ! -e /usr/local/bin/pnpm \
    && test ! -e /usr/bin/flock \
    && test ! -e /usr/include/node \
    && test ! -e /usr/local/include/node \
    && test ! -e build/Test \
    && test -z "$(find . -type p -print -quit)" \
    && test -z "$(find build -type f \( -name '*.o' -o -name '*.d' -o -name '*.map' -o -name '*.trace' -o -name '*.inputs.sha256' \) -print -quit)" \
    && ! grep -aR -m1 -E 'testHooks|becomeChildSubreaperForTest|prepareInheritedLockFdForTest|claimAdoptedChildForTest|reapClaimedChildForTest|orphan-ready-v1' . \
    && ! command -v gcc \
    && ! command -v cc \
    && ! command -v pnpm \
    && ! command -v corepack \
    && test "$(node --version)" = v22.22.1
ENV HOME=/tmp
USER 1000:1000
CMD ["node","dist/index.js"]
