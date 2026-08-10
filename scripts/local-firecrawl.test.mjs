import assert from "node:assert/strict";
import {
  chmod,
  appendFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const wrapper = join(repoRoot, "scripts", "local-firecrawl");
const composeLocal = join(repoRoot, "compose.local.yaml");
const envExample = join(repoRoot, ".env.example.local");
const initEnv = join(repoRoot, "scripts", "init-local-env.sh");
const upgradeEnv = join(repoRoot, "scripts", "upgrade-local-env-phase1");
const apiId = "a".repeat(64);
const browserId = "b".repeat(64);
const oneShotId = "c".repeat(64);
const searxngId = "d".repeat(64);

function phaseEnvironment(overrides = {}) {
  const values = {
    APP_POSTGRES_USER: "firecrawl",
    APP_POSTGRES_PASSWORD: "a".repeat(64),
    APP_POSTGRES_DB: "firecrawl",
    LOCAL_PERSISTENCE_ENABLED: "true",
    LOCAL_BROWSER_SERVICE_ENABLED: "true",
    LOCAL_BROWSER_STATE_ROOT: "/var/lib/firecrawl-browser-volume/state",
    BROWSER_SERVICE_API_KEY: "S".repeat(43),
    BROWSER_REPLAY_INGEST_API_KEY: "b".repeat(64),
    BROWSER_INTERACTION_WORKER_TOKEN: "W".repeat(43),
    APPLICATION_DATABASE_URL:
      `postgresql://firecrawl:${"a".repeat(64)}` +
      "@app-postgres:5432/firecrawl",
    LOCAL_OWNER_ID: "11111111-1111-4111-8111-111111111111",
    LOCAL_RECORD_RETENTION_DAYS: "30",
    LOCAL_ARTIFACT_RETENTION_DAYS: "30",
    MINIO_ROOT_USER: "firecrawl-root",
    MINIO_ROOT_PASSWORD: "c".repeat(64),
    ARTIFACT_STORE_PROVIDER: "minio",
    ARTIFACT_MINIO_ENDPOINT: "http://minio:9000",
    ARTIFACT_MINIO_ACCESS_KEY: "firecrawl-app",
    ARTIFACT_MINIO_SECRET_KEY: "d".repeat(64),
    ARTIFACT_MINIO_BUCKET: "firecrawl-artifacts",
    ARTIFACT_MINIO_REGION: "us-east-1",
    SEARXNG_ENDPOINT: "http://searxng:8080",
    SEARXNG_BRAVE_API_KEY_B64: "ZmFrZQ==",
    SEARXNG_ENGINES: "braveapi,bing",
    SEARXNG_SECRET: "e".repeat(64),
    ...overrides,
  };
  return (
    Object.entries(values)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n") + "\n"
  );
}

function parseEnvironment(source) {
  return Object.fromEntries(
    source
      .trim()
      .split("\n")
      .map((line) => line.split(/=(.*)/s).slice(0, 2)),
  );
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      ...options,
      env: { ...process.env, ...options.env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function makeFakeRuntime({
  provenance = "current",
  providerMode = "internal",
  staleSearxng = false,
  searchHealth = "healthy",
  codexConfig = `model = "gpt-test"
model_provider = "local-proxy"

[model_providers.local-proxy]
name = "Local proxy"
base_url = "http://127.0.0.1:8317/v1"
env_key = "TEST_PROVIDER_API_KEY"
env_http_headers = { "X-Optional" = "OPTIONAL_PROVIDER_HEADER", "X-Empty" = "EMPTY_PROVIDER_HEADER" }
websocket_connect_timeout_ms = 12000
wire_api = "responses"
`,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "local-firecrawl-docker-test-"));
  const bin = join(root, "bin");
  const runtime = join(root, "runtime");
  const home = join(root, "home");
  const codexPackage = join(root, "codex-package");
  const caBundle = join(root, "ca-certificates.crt");
  const log = join(root, "events.jsonl");
  const state = join(root, "provenance");
  const migrationDirectory = join(
    repoRoot,
    "apps",
    "api",
    "src",
    "db",
    "migrations",
  );
  const latestMigration = (await readdir(migrationDirectory))
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .sort()
    .at(-1);
  assert.ok(latestMigration);
  const migrationChecksum = createHash("sha256")
    .update(await readFile(join(migrationDirectory, latestMigration)))
    .digest("hex");
  await run("mkdir", ["-m", "700", bin, runtime]);
  await mkdir(join(home, ".codex"), { recursive: true, mode: 0o700 });
  await mkdir(join(codexPackage, "bin"), { recursive: true, mode: 0o755 });
  await writeFile(
    join(codexPackage, "package.json"),
    JSON.stringify({
      name: "@openai/codex",
      version: "current",
      bin: { codex: "bin/codex.js" },
    }),
  );
  await writeFile(
    join(codexPackage, "bin", "codex.js"),
    "#!/usr/bin/env node\n",
    {
      mode: 0o755,
    },
  );
  await writeFile(join(home, ".codex", "auth.json"), "{}\n", { mode: 0o600 });
  await writeFile(join(home, ".codex", "config.toml"), codexConfig, {
    mode: 0o600,
  });
  await writeFile(
    caBundle,
    "-----BEGIN CERTIFICATE-----\nfake-fixture\n-----END CERTIFICATE-----\n",
    { mode: 0o644 },
  );
  await symlink(join(codexPackage, "bin", "codex.js"), join(bin, "codex"));
  await symlink(process.execPath, join(bin, "node"));
  await writeFile(state, provenance);

  const docker = join(bin, "docker");
  await writeFile(
    docker,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(args) + "\\n");
const repo = process.env.FAKE_REPO;
const statePath = process.env.FAKE_PROVENANCE_STATE;
const current = () => fs.readFileSync(statePath, "utf8").trim();
const has = value => args.includes(value);
const last = args.at(-1);
const configSources = current() === "legacy"
  ? repo + "/compose.yaml," + repo + "/compose.local.yaml"
  : repo + "/compose.yaml";

if (args[0] === "inspect") {
  const formatIndex = args.indexOf("--format");
  const format = formatIndex >= 0 ? args[formatIndex + 1] : "";
  const id = args.at(-1);
  if (format.includes("project.config_files")) {
    process.stdout.write(configSources + "\\n");
  } else if (format.includes("project.working_dir")) {
    process.stdout.write(repo + "\\n");
  } else if (format.includes("com.docker.compose.project")) {
    process.stdout.write("firecrawl\\n");
  } else if (format.includes("com.docker.compose.service")) {
    process.stdout.write(
      id === ${JSON.stringify(apiId)}
        ? "api\\n"
        : "browser-interaction-worker\\n",
    );
  } else if (format.includes(".Config.Env")) {
    process.stdout.write(
      "PORT=3002\\nLOCAL_BROWSER_SERVICE_ENABLED=true\\n",
    );
  } else if (format.includes(".Mounts") &&
      id !== ${JSON.stringify(apiId)}) {
    process.stdout.write(
      "bind | /opt/codex | false\\n" +
      "bind | /run/certs/host-ca-certificates.crt | false\\n" +
      "bind | /run/secrets/codex-auth.json | false\\n" +
      (current() === "current"
        ? "bind | /run/secrets/codex-config.toml | false\\n" +
          "bind | /run/secrets/codex-provider-environment.json | false\\n"
        : "") +
      "volume | /run/firecrawl-interaction | true\\n" +
      (["legacy", "pre-egress"].includes(current())
        ? ""
        : "volume | /run/firecrawl-model-egress | true\\n") +
      "volume | /var/lib/firecrawl-codex-auth-state | true\\n",
    );
  } else if (format.includes(".Mounts")) {
    process.stdout.write(
      "/run/firecrawl-interaction\\n/var/fdb\\n",
    );
  } else if (format.includes(".State.Status")) {
    process.stdout.write("exited|false|false|0\\n");
  } else if (format === "{{.Image}}" && id === ${JSON.stringify(browserId)}) {
    process.stdout.write("sha256:" + "d".repeat(64) + "\\n");
  } else {
    process.exit(2);
  }
  process.exit(0);
}

if (args[0] === "wait") {
  process.stdout.write("0\\n");
  process.exit(0);
}
if (args[0] === "rm" || args[0] === "stop" || args[0] === "run") {
  process.exit(0);
}
if (args[0] !== "compose") process.exit(2);

if (has("config")) {
  if (has("--format")) {
    const maintenanceProfileEnabled = args.some(
      (value, index) =>
        value === "--profile" && args[index + 1] === "maintenance",
    );
    const rendered = {
      services: {
        api: {
          environment: {
            LOCAL_BROWSER_SERVICE_ENABLED: "true",
            LOCAL_SEARCH_WEB_ONLY: "true",
            SEARXNG_ENDPOINT: process.env.FAKE_SEARCH_PROVIDER_MODE === "external"
              ? "https://search.example.test"
              : process.env.FAKE_SEARCH_PROVIDER_MODE === "unnormalized"
                ? "https://SEARCH.example.test/"
                : "http://searxng:8080",
            SEARCH_PROVIDER_TIMEOUT_MS: "10000",
            SEARCH_PROVIDER_MAX_RESULTS: "100",
            SEARCH_PROVIDER_MAX_CONCURRENCY: "4",
            SEARXNG_ENGINES: "braveapi,bing",
            BROWSER_SERVICE_API_KEY: "A".repeat(43),
            BROWSER_INTERACTION_WORKER_SOCKET_PATH:
              "/run/firecrawl-interaction/worker.sock",
            BROWSER_INTERACTION_WORKER_TOKEN: "B".repeat(43),
          },
          networks: { backend: null },
          group_add: ["1000"],
          volumes: [
            {
              type: "volume",
              source: "fdb-cluster-file",
              target: "/var/fdb",
              read_only: true,
            },
            {
              type: "volume",
              source: "browser-interaction-socket",
              target: "/run/firecrawl-interaction",
              read_only: true,
            },
          ],
          ports: [{ published: "3002" }],
        },
        "browser-service": {
          environment: {
            LOCAL_BROWSER_SERVICE_ENABLED: "true",
            MAX_BROWSER_SESSIONS: "4",
          },
        },
        "browser-interaction-worker": {
          user: "1000:1000",
          read_only: true,
          cap_drop: ["ALL"],
          security_opt: ["no-new-privileges:true"],
          pids_limit: 512,
          environment: {
            BROWSER_INTERACTION_WORKER_SOCKET_PATH:
              "/run/firecrawl-interaction/worker.sock",
            BROWSER_INTERACTION_WORKER_TOKEN: "B".repeat(43),
            CODEX_CA_CERTIFICATE:
              "/run/certs/host-ca-certificates.crt",
            CODEX_CONFIG_SEED_FILE: "/run/secrets/codex-config.toml",
            CODEX_PROVIDER_ENVIRONMENT_FILE:
              "/run/secrets/codex-provider-environment.json",
            SSL_CERT_FILE: "/run/certs/host-ca-certificates.crt",
            NODE_EXTRA_CA_CERTS: "/run/certs/host-ca-certificates.crt",
            MODEL_EGRESS_PROXY_SOCKET_PATH:
              "/run/firecrawl-model-egress/proxy.sock",
            HTTP_PROXY: "http://127.0.0.1:3128",
            HTTPS_PROXY: "http://127.0.0.1:3128",
            NO_PROXY: "",
            http_proxy: "http://127.0.0.1:3128",
            https_proxy: "http://127.0.0.1:3128",
            no_proxy: "",
          },
          network_mode: "none",
          volumes: [
            {
              type: "bind",
              source: process.env.LOCAL_CODEX_PACKAGE_DIR,
              target: "/opt/codex",
              read_only: true,
              bind: { create_host_path: false },
            },
            {
              type: "bind",
              source: process.env.LOCAL_CODEX_AUTH_FILE,
              target: "/run/secrets/codex-auth.json",
              read_only: true,
              bind: { create_host_path: false },
            },
            {
              type: "bind",
              source: process.env.LOCAL_CODEX_CA_BUNDLE_FILE,
              target: "/run/certs/host-ca-certificates.crt",
              read_only: true,
              bind: { create_host_path: false },
            },
            {
              type: "bind",
              source: process.env.LOCAL_CODEX_WORKER_CONFIG_FILE,
              target: "/run/secrets/codex-config.toml",
              read_only: true,
              bind: { create_host_path: false },
            },
            {
              type: "bind",
              source: process.env.LOCAL_CODEX_PROVIDER_ENVIRONMENT_FILE,
              target: "/run/secrets/codex-provider-environment.json",
              read_only: true,
              bind: { create_host_path: false },
            },
            {
              type: "volume",
              source: "codex-auth-state",
              target: "/var/lib/firecrawl-codex-auth-state",
              read_only: false,
            },
            {
              type: "volume",
              source: "browser-interaction-socket",
              target: "/run/firecrawl-interaction",
              read_only: false,
            },
            {
              type: "volume",
              source: "browser-interaction-egress-socket",
              target: "/run/firecrawl-model-egress",
              read_only: false,
            },
          ],
        },
        "browser-interaction-egress-proxy": {
          user: "1000:1000",
          read_only: true,
          cap_drop: ["ALL"],
          security_opt: ["no-new-privileges:true"],
          pids_limit: 64,
          environment: {
            MODEL_EGRESS_PROXY_SOCKET_PATH:
              "/run/firecrawl-model-egress/proxy.sock",
            MODEL_EGRESS_PROVIDER_POLICY_FILE:
              "/run/secrets/codex-egress-policy.json",
          },
          networks: { "model-uplink": null },
          extra_hosts: ["host.docker.internal=host-gateway"],
          volumes: [
            {
              type: "bind",
              source: process.env.LOCAL_CODEX_EGRESS_POLICY_FILE,
              target: "/run/secrets/codex-egress-policy.json",
              read_only: true,
              bind: { create_host_path: false },
            },
            {
              type: "volume",
              source: "browser-interaction-egress-socket",
              target: "/run/firecrawl-model-egress",
              read_only: false,
            },
          ],
        },
        "app-db-migrate": { networks: { backend: null } },
        searxng: {
          environment: {
            FORCE_OWNERSHIP: "true",
            SEARXNG_BRAVE_API_KEY_B64: "fixture",
            SEARXNG_SECRET: "fixture",
          },
          networks: { backend: null },
        },
      },
    };
    if (!maintenanceProfileEnabled) {
      delete rendered.services["app-db-migrate"];
    }
    if (process.env.FAKE_COMPOSE_INVALID === "browser_service_key") {
      rendered.services.api.environment.BROWSER_SERVICE_API_KEY =
        process.env.FAKE_COMPOSE_SECRET;
    }
    if (process.env.FAKE_COMPOSE_INVALID === "searxng_key_missing") {
      rendered.services.searxng.environment.SEARXNG_BRAVE_API_KEY_B64 = "";
    } else if (
      process.env.FAKE_COMPOSE_INVALID === "searxng_wrong_engines"
    ) {
      rendered.services.api.environment.SEARXNG_ENGINES = "bing";
    } else if (
      process.env.FAKE_COMPOSE_INVALID === "searxng_credential_leak"
    ) {
      rendered.services.api.environment.SEARXNG_BRAVE_API_KEY_B64 =
        process.env.FAKE_COMPOSE_SECRET;
    }
    const workerVolumes =
      rendered.services["browser-interaction-worker"].volumes;
    const caMount = workerVolumes.find(
      volume => volume.target === "/run/certs/host-ca-certificates.crt",
    );
    if (process.env.FAKE_COMPOSE_INVALID === "worker_ca_mount_missing") {
      rendered.services["browser-interaction-worker"].volumes =
        workerVolumes.filter(volume => volume !== caMount);
    } else if (
      process.env.FAKE_COMPOSE_INVALID === "worker_ca_mount_writeable"
    ) {
      caMount.read_only = false;
    } else if (
      process.env.FAKE_COMPOSE_INVALID === "worker_ca_mount_source"
    ) {
      caMount.source = "/unexpected-ca-bundle.pem";
    } else if (
      process.env.FAKE_COMPOSE_INVALID === "worker_network_enabled"
    ) {
      rendered.services["browser-interaction-worker"].network_mode = null;
      rendered.services["browser-interaction-worker"].networks = {
        "model-uplink": null,
      };
    } else if (
      process.env.FAKE_COMPOSE_INVALID === "egress_proxy_backend"
    ) {
      rendered.services["browser-interaction-egress-proxy"].networks.backend =
        null;
    } else if (
      process.env.FAKE_COMPOSE_INVALID === "egress_proxy_host_remap"
    ) {
      rendered.services["browser-interaction-egress-proxy"].extra_hosts = [
        "host.docker.internal=203.0.113.10",
      ];
    } else if (
      process.env.FAKE_COMPOSE_INVALID === "egress_proxy_secret"
    ) {
      rendered.services[
        "browser-interaction-egress-proxy"
      ].environment.APPLICATION_DATABASE_URL = "secret";
    }
    process.stdout.write(JSON.stringify(rendered) + "\\n");
  }
  process.exit(0);
}
if (has("logs")) {
  if (process.env.FAKE_SENSITIVE_LOGS === "true") {
    process.stdout.write(
      '{"query":"SearXNG metasearch","endpoint":' +
      '"https://search.example.test","secret":"provider-secret"}' +
      "\\nurl=https://search.example.test/search?q=private\\n",
    );
  }
  process.exit(0);
}
if (has("build") || has("stop") || has("rm")) process.exit(0);
if (has("up")) {
  if (has("api")) fs.writeFileSync(statePath, "current");
  process.exit(0);
}
if (has("exec")) {
  const execIndex = args.indexOf("exec");
  const execService = args[execIndex + 2];
  const migrationProbe = args.join(" ").includes("SELECT concat_ws");
  if (process.env.FAKE_HEALTH_FAILURE === execService) {
    process.stderr.write("raw probe failure: " + execService + "\\n");
    process.exit(23);
  }
  if (process.env.FAKE_HEALTH_CHATTER === "true" && !migrationProbe) {
    process.stdout.write("raw probe stdout: " + execService + "\\n");
    process.stderr.write("raw probe stderr: " + execService + "\\n");
  }
  if (has("redis-cli")) process.stdout.write("PONG\\n");
  if (args.join(" ").includes("SELECT concat_ws")) {
    process.stdout.write(process.env.FAKE_MIGRATION_LEDGER + "\\n");
  }
  if (args.join(" ").includes("SearXNG metasearch") &&
      process.env.FAKE_SEARCH_HEALTH === "unavailable") {
    process.stderr.write(
      "SearXNG metasearch https://search.example.test provider-secret\\n",
    );
    process.exit(1);
  }
  process.exit(0);
}
if (has("ps")) {
  if (has("--format") && args[args.indexOf("--format") + 1] === "json") {
    process.stdout.write(JSON.stringify({
      Service: "api",
      Publishers: [{
        URL: "127.0.0.1",
        TargetPort: 3002,
        PublishedPort: 3002,
        Protocol: "tcp",
      }],
    }) + "\\n");
    if (has("searxng")) {
      process.stdout.write(JSON.stringify({
        Service: "searxng",
        Publishers: [],
      }) + "\\n");
    }
    process.exit(0);
  }
  if (has("--format") &&
      args[args.indexOf("--format") + 1] === "{{.State}} {{.ExitCode}}") {
    process.stdout.write("exited 0\\n");
    process.exit(0);
  }
  if (has("-q") || has("--all")) {
    if (last === "api") process.stdout.write(${JSON.stringify(apiId)} + "\\n");
    else if (last === "browser-service") {
      process.stdout.write(${JSON.stringify(browserId)} + "\\n");
    } else if (last === "browser-interaction-worker") {
      process.stdout.write("e".repeat(64) + "\\n");
    } else if (last === "searxng" && process.env.FAKE_STALE_SEARXNG === "true") {
      process.stdout.write(${JSON.stringify(searxngId)} + "\\n");
    } else if (["browser-state-init", "app-db-migrate", "minio-init"].includes(last)) {
      process.stdout.write(${JSON.stringify(oneShotId)} + "\\n");
    }
    process.exit(0);
  }
  process.exit(0);
}
process.exit(2);
`,
    { mode: 0o755 },
  );
  await chmod(docker, 0o755);
  const curl = join(bin, "curl");
  await writeFile(curl, "#!/usr/bin/env sh\nexit 0\n", { mode: 0o755 });

  return {
    root,
    log,
    authPath: join(home, ".codex", "auth.json"),
    codexPath: join(bin, "codex"),
    env: {
      FAKE_DOCKER_LOG: log,
      FAKE_PROVENANCE_STATE: state,
      FAKE_REPO: repoRoot,
      FAKE_MIGRATION_LEDGER: `${latestMigration}|${migrationChecksum}`,
      FAKE_SEARCH_PROVIDER_MODE: providerMode,
      FAKE_STALE_SEARXNG: staleSearxng ? "true" : "false",
      FAKE_SEARCH_HEALTH: searchHealth,
      LOCAL_FIRECRAWL_ONE_SHOT_TIMEOUT_SECONDS: "10",
      LOCAL_FIRECRAWL_CA_BUNDLE_FILE: caBundle,
      TEST_PROVIDER_API_KEY: "provider-secret-must-not-leak",
      XDG_RUNTIME_DIR: runtime,
      HOME: home,
      PATH: `${bin}:/usr/bin:/bin`,
    },
    async events() {
      const data = await readFile(log, "utf8").catch(() => "");
      return data
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    },
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("local compose keeps Docker browser state", async () => {
  const source = await readFile(composeLocal, "utf8");
  const apiBlock =
    source.match(/\n  api:\n[\s\S]*?\n  browser-interaction-worker:/)?.[0] ??
    "";
  assert.match(source, /LOCAL_BROWSER_SERVICE_ENABLED: "true"/);
  assert.match(apiBlock, /LOCAL_SEARCH_WEB_ONLY: "true"/);
  assert.match(
    apiBlock,
    /SEARXNG_ENDPOINT: \$\{SEARXNG_ENDPOINT:-http:\/\/searxng:8080\}/,
  );
  assert.match(apiBlock, /SEARCH_PROVIDER_TIMEOUT_MS: "10000"/);
  assert.match(apiBlock, /SEARCH_PROVIDER_MAX_RESULTS: "100"/);
  assert.match(apiBlock, /SEARCH_PROVIDER_MAX_CONCURRENCY: "4"/);
  assert.doesNotMatch(apiBlock, /SEARXNG_SECRET/);
  assert.doesNotMatch(apiBlock, /searxng:\s*\n\s*condition:/);
  assert.match(
    source,
    /BROWSER_SERVICE_REQUEST_TIMEOUT_MS: \$\{BROWSER_SERVICE_REQUEST_TIMEOUT_MS:-60000\}/,
  );
  assert.match(source, /MAX_BROWSER_SESSIONS: \$\{MAX_BROWSER_SESSIONS:-4\}/);
  assert.match(source, /BROWSER_PUBLIC_API_ORIGIN:/);
  assert.match(
    source,
    /BROWSER_INTERACTION_WORKER_SOCKET_PATH: \/run\/firecrawl-interaction\/worker\.sock/,
  );
  assert.match(source, /browser-interaction-worker:[\s\S]*?read_only: true/);
  assert.match(source, /source: \$\{LOCAL_CODEX_PACKAGE_DIR:/);
  assert.match(source, /target: \/opt\/codex/);
  assert.match(source, /target: \/run\/secrets\/codex-auth\.json/);
  assert.match(source, /target: \/run\/secrets\/codex-config\.toml/);
  assert.match(
    source,
    /target: \/run\/secrets\/codex-provider-environment\.json/,
  );
  assert.match(source, /target: \/run\/secrets\/codex-egress-policy\.json/);
  assert.match(source, /source: \$\{LOCAL_CODEX_CA_BUNDLE_FILE:/);
  assert.match(source, /target: \/run\/certs\/host-ca-certificates\.crt/);
  assert.match(
    source,
    /CODEX_CA_CERTIFICATE: \/run\/certs\/host-ca-certificates\.crt/,
  );
  assert.match(
    source,
    /NODE_EXTRA_CA_CERTS: \/run\/certs\/host-ca-certificates\.crt/,
  );
  assert.match(source, /source: codex-auth-state/);
  assert.match(source, /target: \/var\/lib\/firecrawl-codex-auth-state/);
  assert.match(source, /CODEX_HOME: \/var\/lib\/firecrawl-codex-runs/);
  assert.doesNotMatch(source, /CODEX_HOME: \/tmp\/codex-home/);
  assert.match(source, /source: browser-interaction-socket/);
  assert.match(source, /target: \/run\/firecrawl-interaction/);
  assert.match(source, /browser-interaction-worker:[\s\S]*?network_mode: none/);
  assert.match(
    source,
    /browser-interaction-egress-proxy:[\s\S]*?networks:\n      - model-uplink/,
  );
  assert.match(source, /HTTP_PROXY: http:\/\/127\.0\.0\.1:3128/);
  assert.match(
    source,
    /MODEL_EGRESS_PROXY_SOCKET_PATH: \/run\/firecrawl-model-egress\/proxy\.sock/,
  );
  assert.match(source, /source: browser-interaction-egress-socket/);
  assert.match(source, /target: \/run\/firecrawl-model-egress/);
  assert.match(apiBlock, /networks:\n      - backend/);
  assert.doesNotMatch(apiBlock, /model-uplink/);
  assert.match(source, /create_host_path: false/);
  assert.match(source, /browser-state:\/var\/lib\/firecrawl-browser-volume/);
  assert.match(source, /app-db-migrate:[\s\S]*?networks:\n      - backend/);
  assert.doesNotMatch(source, /browser-interaction-worker:[\s\S]*?ports:/);
  assert.doesNotMatch(source, /browser-interaction-worker:[\s\S]*?expose:/);
  assert.doesNotMatch(
    source,
    /browser-interaction-egress-proxy:[\s\S]*?ports:/,
  );
  assert.doesNotMatch(
    source,
    /browser-interaction-egress-proxy:[\s\S]*?expose:/,
  );
});

// @lat: [[runtime-operations#Local wrapper suite#Codex provider snapshot]]
test("start snapshots only the selected Codex provider routing", async (t) => {
  const fake = await makeFakeRuntime();
  t.after(() => fake.cleanup());

  const result = await run(wrapper, ["start"], { env: fake.env });
  assert.equal(result.code, 0, result.stderr);
  const snapshotDirectory = join(fake.env.XDG_RUNTIME_DIR, "firecrawl-control");
  const configPath = join(
    snapshotDirectory,
    "codex-worker-config.firecrawl.toml",
  );
  const environmentPath = join(
    snapshotDirectory,
    "codex-provider-environment.firecrawl.json",
  );
  const egressPath = join(
    snapshotDirectory,
    "codex-egress-policy.firecrawl.json",
  );
  const config = await readFile(configPath, "utf8");
  assert.match(config, /^model = "gpt-test"$/m);
  assert.match(config, /^model_provider = "local-proxy"$/m);
  assert.match(
    config,
    /"base_url" = "http:\/\/host\.docker\.internal:8317\/v1"/,
  );
  assert.match(config, /"websocket_connect_timeout_ms" = 12000/);
  assert.doesNotMatch(config, /mcp_servers|hooks|approval_policy|sandbox_mode/);
  assert.deepEqual(JSON.parse(await readFile(environmentPath, "utf8")), {
    TEST_PROVIDER_API_KEY: "provider-secret-must-not-leak",
  });
  assert.deepEqual(JSON.parse(await readFile(egressPath, "utf8")), {
    httpHost: "host.docker.internal",
    httpPort: 8317,
  });
  assert.equal((await stat(configPath)).mode & 0o777, 0o600);
  assert.equal((await stat(environmentPath)).mode & 0o777, 0o600);
  assert.equal((await stat(egressPath)).mode & 0o777, 0o600);
  assert.doesNotMatch(
    result.stdout + result.stderr,
    /provider-secret-must-not-leak/,
  );

  const restarted = await run(wrapper, ["restart"], { env: fake.env });
  assert.equal(restarted.code, 0, restarted.stderr);
  const forcedUpEvents = (await fake.events()).filter(
    (event) => event.includes("up") && event.includes("--force-recreate"),
  );
  assert.equal(forcedUpEvents.length, 4);
  assert.deepEqual(
    forcedUpEvents.map((event) => event.at(-1)),
    [
      "browser-interaction-egress-proxy",
      "browser-interaction-worker",
      "browser-interaction-egress-proxy",
      "browser-interaction-worker",
    ],
  );

  const stopped = await run(wrapper, ["stop"], { env: fake.env });
  assert.equal(stopped.code, 0, stopped.stderr);
  for (const path of [configPath, environmentPath, egressPath]) {
    await assert.rejects(readFile(path), { code: "ENOENT" });
  }

  const startedAgain = await run(wrapper, ["start"], {
    env: {
      ...fake.env,
      TEST_PROVIDER_API_KEY: "rotated-provider-secret",
    },
  });
  assert.equal(startedAgain.code, 0, startedAgain.stderr);
  assert.deepEqual(JSON.parse(await readFile(environmentPath, "utf8")), {
    TEST_PROVIDER_API_KEY: "rotated-provider-secret",
  });
});

test("provider snapshot includes only nonempty optional header values", async (t) => {
  const fake = await makeFakeRuntime();
  t.after(() => fake.cleanup());
  const secret = "optional-header-secret-must-not-leak";

  const result = await run(wrapper, ["start"], {
    env: {
      ...fake.env,
      OPTIONAL_PROVIDER_HEADER: secret,
      EMPTY_PROVIDER_HEADER: "",
    },
  });
  assert.equal(result.code, 0, result.stderr);
  const environmentPath = join(
    fake.env.XDG_RUNTIME_DIR,
    "firecrawl-control",
    "codex-provider-environment.firecrawl.json",
  );
  assert.deepEqual(JSON.parse(await readFile(environmentPath, "utf8")), {
    TEST_PROVIDER_API_KEY: "provider-secret-must-not-leak",
    OPTIONAL_PROVIDER_HEADER: secret,
  });
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(secret));
});

test("selected provider env_key remains required", async (t) => {
  const fake = await makeFakeRuntime();
  t.after(() => fake.cleanup());
  const env = { ...fake.env };
  delete env.TEST_PROVIDER_API_KEY;

  const result = await run(wrapper, ["start"], { env });
  assert.equal(result.code, 1);
  assert.match(
    result.stderr,
    /requires environment variable TEST_PROVIDER_API_KEY/,
  );
  assert.deepEqual(await fake.events(), []);
});

test("unsafe selected provider fields fail before Docker mutation", async (t) => {
  const cases = [
    [
      'auth = { command = "/bin/unsafe", args = ["auth-secret"] }',
      /unsupported field auth/,
      /auth-secret/,
    ],
    [
      'aws = { profile = "aws-secret", region = "us-east-1" }',
      /unsupported field aws/,
      /aws-secret/,
    ],
    [
      'websocket_connect_timeout_ms = "12000"',
      /invalid websocket_connect_timeout_ms/,
      null,
    ],
  ];
  for (const [field, error, secret] of cases) {
    await t.test(field.split(" = ")[0], async () => {
      const fake = await makeFakeRuntime({
        codexConfig: [
          'model = "gpt-test"',
          'model_provider = "unsafe"',
          "",
          "[model_providers.unsafe]",
          'base_url = "https://proxy.example/v1"',
          field,
          "",
        ].join("\n"),
      });
      try {
        const result = await run(wrapper, ["start"], { env: fake.env });
        assert.equal(result.code, 1);
        assert.match(result.stderr, error);
        if (secret !== null) {
          assert.doesNotMatch(result.stderr + result.stdout, secret);
        }
        assert.deepEqual(await fake.events(), []);
      } finally {
        await fake.cleanup();
      }
    });
  }
});

test("local environment templates generate Docker browser settings", async () => {
  const sources = await Promise.all([
    readFile(envExample, "utf8"),
    readFile(initEnv, "utf8"),
  ]);
  const combined = sources.join("\n");
  assert.match(combined, /LOCAL_BROWSER_SERVICE_ENABLED=true/);
  assert.match(combined, /MAX_BROWSER_SESSIONS=4/);
  assert.match(combined, /BROWSER_INTERACTION_WORKER_TOKEN=/);
  assert.match(combined, /SEARXNG_ENDPOINT=http:\/\/searxng:8080/);
  assert.match(combined, /SEARXNG_SECRET=/);
  assert.match(combined, /Extract is disabled by default/);
  assert.match(combined, /scripts\/local-firecrawl shim-start/);
  assert.match(combined, /OPENAI_API_KEY=local-codex-shim/);
  assert.match(
    combined,
    /OPENAI_BASE_URL=http:\/\/host\.docker\.internal:3030\/v1/,
  );
});

test("configure-search recovery command updates an isolated environment", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "local-search-recovery-test-"));
  const envFile = join(root, ".env");
  const key = "wrapper-recovery-fixture-key";
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    envFile,
    phaseEnvironment({
      SEARXNG_ENDPOINT: "https://search.example",
      SEARXNG_ENGINES: "bing",
      SEARXNG_BRAVE_API_KEY_B64: undefined,
    }),
    { mode: 0o600 },
  );

  const configured = await run(wrapper, ["configure-search"], {
    env: {
      FIRECRAWL_SEARXNG_BRAVE_API_KEY: key,
      LOCAL_FIRECRAWL_ENV_FILE: envFile,
    },
  });
  assert.equal(configured.code, 0, configured.stderr);
  assert.match(configured.stdout, /local-firecrawl restart/);
  const values = parseEnvironment(await readFile(envFile, "utf8"));
  assert.equal(
    values.SEARXNG_BRAVE_API_KEY_B64,
    Buffer.from(key).toString("base64"),
  );
  assert.equal(values.SEARXNG_ENDPOINT, "https://search.example");
  assert.equal(values.SEARXNG_ENGINES, "bing");
});

test("environment upgrade rotates legacy browser settings", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "local-firecrawl-env-test-"));
  const envFile = join(root, ".env");
  t.after(() => rm(root, { recursive: true, force: true }));
  const legacyKey = "e".repeat(64);
  await writeFile(
    envFile,
    phaseEnvironment({
      LOCAL_BROWSER_SERVICE_ENABLED: "false",
      BROWSER_SERVICE_API_KEY: legacyKey,
    }),
    { mode: 0o600 },
  );

  const rejected = await run(upgradeEnv, ["--check", "--env-file", envFile]);
  assert.equal(rejected.code, 1);
  const upgraded = await run(upgradeEnv, ["--env-file", envFile]);
  assert.equal(upgraded.code, 0, upgraded.stderr);
  const values = parseEnvironment(await readFile(envFile, "utf8"));
  assert.equal(values.LOCAL_BROWSER_SERVICE_ENABLED, "true");
  assert.match(values.BROWSER_SERVICE_API_KEY, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(values.BROWSER_SERVICE_API_KEY, legacyKey);
  assert.equal(values.BROWSER_REPLAY_INGEST_API_KEY, "b".repeat(64));
  assert.equal(values.BROWSER_INTERACTION_WORKER_TOKEN, "W".repeat(43));
  const checked = await run(upgradeEnv, ["--check", "--env-file", envFile]);
  assert.equal(checked.code, 0, checked.stderr);
});

test("environment upgrade preserves current browser secrets", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "local-firecrawl-env-test-"));
  const envFile = join(root, ".env");
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = phaseEnvironment();
  await writeFile(envFile, original, { mode: 0o600 });

  const upgraded = await run(upgradeEnv, ["--env-file", envFile]);
  assert.equal(upgraded.code, 0, upgraded.stderr);
  assert.equal(await readFile(envFile, "utf8"), original);
});

test("invalid immutable downgrade request fails before Docker", async (t) => {
  const fake = await makeFakeRuntime();
  t.after(() => fake.cleanup());
  const result = await run(wrapper, ["start"], {
    env: {
      ...fake.env,
      LOCAL_FIRECRAWL_BROWSER_DOWNGRADE: "true",
      FIRECRAWL_BROWSER_SERVICE_IMAGE: "mutable:latest",
    },
  });
  assert.equal(result.code, 64);
  assert.match(result.stderr, /immutable FIRECRAWL_BROWSER_SERVICE_IMAGE/);
  assert.deepEqual(await fake.events(), [
    expectCompose("--profile", "maintenance", "config", "--quiet"),
    expectCompose("--profile", "maintenance", "config", "--format", "json"),
  ]);
});

test("compose validation names failures without exposing secrets", async (t) => {
  const fake = await makeFakeRuntime();
  t.after(() => fake.cleanup());
  const secret = "compose-secret-must-not-leak";
  const result = await run(wrapper, ["start"], {
    env: {
      ...fake.env,
      FAKE_COMPOSE_INVALID: "browser_service_key",
      FAKE_COMPOSE_SECRET: secret,
    },
  });
  assert.equal(result.code, 1);
  assert.match(
    result.stderr,
    /invariant failed: api_browser_service_key_format/,
  );
  assert.doesNotMatch(result.stderr, new RegExp(secret));
  assert.doesNotMatch(result.stdout, new RegExp(secret));
});

test("bundled search fails closed with a recovery command", async (t) => {
  for (const [invalid, message] of [
    ["searxng_key_missing", /Brave Search API key is required/],
    ["searxng_wrong_engines", /requires SEARXNG_ENGINES=braveapi,bing/],
  ]) {
    await t.test(invalid, async () => {
      const fake = await makeFakeRuntime();
      try {
        const result = await run(wrapper, ["start"], {
          env: { ...fake.env, FAKE_COMPOSE_INVALID: invalid },
        });
        assert.equal(result.code, 1);
        assert.match(result.stderr, message);
        assert.match(result.stderr, /local-firecrawl configure-search/);
        assert.ok(
          (await fake.events()).every((event) => event.includes("config")),
        );
      } finally {
        await fake.cleanup();
      }
    });
  }
});

test("compose validation rejects a leaked SearXNG credential", async (t) => {
  const fake = await makeFakeRuntime();
  const secret = "searxng-credential-must-not-leak";
  t.after(() => fake.cleanup());
  const result = await run(wrapper, ["start"], {
    env: {
      ...fake.env,
      FAKE_COMPOSE_INVALID: "searxng_credential_leak",
      FAKE_COMPOSE_SECRET: secret,
    },
  });
  assert.equal(result.code, 1);
  assert.match(
    result.stderr,
    /invariant failed: searxng_brave_credential_isolation/,
  );
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(secret));
  assert.ok((await fake.events()).every((event) => event.includes("config")));
});

test("compose validation rejects unsafe CA mount shapes", async (t) => {
  const cases = [
    "worker_ca_mount_missing",
    "worker_ca_mount_writeable",
    "worker_ca_mount_source",
  ];
  for (const invalid of cases) {
    await t.test(invalid, async () => {
      const fake = await makeFakeRuntime();
      try {
        const result = await run(wrapper, ["start"], {
          env: { ...fake.env, FAKE_COMPOSE_INVALID: invalid },
        });
        assert.equal(result.code, 1);
        assert.match(result.stderr, /invariant failed: worker_mounts/);
      } finally {
        await fake.cleanup();
      }
    });
  }
});

test("compose validation rejects worker and proxy egress escapes", async (t) => {
  const cases = [
    ["worker_network_enabled", "worker_network_disabled"],
    ["egress_proxy_backend", "egress_proxy_networks"],
    ["egress_proxy_secret", "egress_proxy_secret_minimization"],
  ];
  for (const [invalid, invariant] of cases) {
    await t.test(invalid, async () => {
      const fake = await makeFakeRuntime();
      try {
        const result = await run(wrapper, ["start"], {
          env: { ...fake.env, FAKE_COMPOSE_INVALID: invalid },
        });
        assert.equal(result.code, 1);
        assert.match(
          result.stderr,
          new RegExp(`invariant failed: ${invariant}`),
        );
      } finally {
        await fake.cleanup();
      }
    });
  }
});

test("compose validation rejects an unsafe host gateway override", async (t) => {
  const fake = await makeFakeRuntime();
  t.after(() => fake.cleanup());
  const override = join(fake.root, "unsafe-override.yaml");
  await writeFile(
    override,
    "services:\n  browser-interaction-egress-proxy:\n" +
      "    extra_hosts:\n      - host.docker.internal:203.0.113.10\n",
    { mode: 0o600 },
  );

  const result = await run(wrapper, ["start"], {
    env: {
      ...fake.env,
      LOCAL_FIRECRAWL_COMPOSE_OVERRIDE: override,
      FAKE_COMPOSE_INVALID: "egress_proxy_host_remap",
    },
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /invariant failed: egress_proxy_host_gateway/);
  const events = await fake.events();
  assert.equal(events.length, 2);
  assert.ok(events.every((event) => event.includes("config")));
  assert.ok(events.every((event) => event.includes(override)));

  const snapshotDirectory = join(fake.env.XDG_RUNTIME_DIR, "firecrawl-control");
  for (const name of [
    "codex-worker-config.firecrawl.toml",
    "codex-provider-environment.firecrawl.json",
    "codex-egress-policy.firecrawl.json",
  ]) {
    await assert.rejects(readFile(join(snapshotDirectory, name)), {
      code: "ENOENT",
    });
  }
});

test("start builds images, runs migrations, and publishes API last", async (t) => {
  const fake = await makeFakeRuntime();
  t.after(() => fake.cleanup());
  const result = await run(wrapper, ["start"], { env: fake.env });
  assert.equal(result.code, 0, result.stderr);
  const events = await fake.events();
  const runtimeUpEvents = events.filter((event) => event.includes("up"));
  assert.ok(runtimeUpEvents.length > 0);
  assert.ok(
    runtimeUpEvents.every((event) => !event.includes("--profile")),
    "runtime up commands must not enable maintenance profile",
  );
  assert.ok(events.some((event) => event.includes("build")));
  assert.ok(
    events.some(
      (event) =>
        event.includes("build") &&
        event.includes("browser-interaction-worker") &&
        event.includes("browser-interaction-egress-proxy") &&
        event.includes("playwright-service"),
    ),
  );
  const migrationUp = events.findIndex(
    (event) => event.includes("up") && event.includes("app-db-migrate"),
  );
  const apiUp = events.findIndex(
    (event) => event.includes("up") && event.includes("api"),
  );
  const searxngUp = events.findIndex(
    (event) => event.includes("up") && event.at(-1) === "searxng",
  );
  const interactionWorkerUp = events.findIndex(
    (event) =>
      event.includes("up") && event.includes("browser-interaction-worker"),
  );
  assert.ok(migrationUp >= 0 && apiUp > migrationUp);
  assert.ok(interactionWorkerUp >= 0 && apiUp > interactionWorkerUp);
  assert.ok(searxngUp >= 0 && apiUp > searxngUp);
  assert.ok(events[searxngUp].includes("--no-deps"));
  assert.ok(events[searxngUp].includes("--wait"));
  assert.ok(
    events.every((event) => !event.join(" ").includes("SearXNG metasearch")),
    "startup readiness must not issue an upstream search",
  );
  assert.ok(events.some((event) => event.includes("browser-state-init")));
  assert.ok(events.some((event) => event.includes("minio-init")));
});

// @lat: [[runtime-operations#Local wrapper suite#Provider-aware lifecycle]]
test("external failover removes stale bundled search without data loss", async (t) => {
  const fake = await makeFakeRuntime({
    providerMode: "external",
    staleSearxng: true,
  });
  t.after(() => fake.cleanup());

  const failedOver = await run(wrapper, ["restart"], { env: fake.env });
  assert.equal(failedOver.code, 0, failedOver.stderr);
  const failoverEvents = await fake.events();
  const staleStop = failoverEvents.findIndex(
    (event) => event.includes("stop") && event.at(-1) === "searxng",
  );
  const staleRemove = failoverEvents.findIndex(
    (event) => event.includes("rm") && event.at(-1) === "searxng",
  );
  const apiUp = failoverEvents.findIndex(
    (event) => event.includes("up") && event.includes("api"),
  );
  assert.ok(staleStop >= 0 && staleRemove > staleStop && apiUp > staleRemove);
  assert.ok(
    failoverEvents.every(
      (event) => !(event.includes("up") && event.at(-1) === "searxng"),
    ),
  );
  assert.ok(failoverEvents.every((event) => !event.includes("--volumes")));
  assert.ok(failoverEvents.every((event) => !event.includes("-v")));
  assert.ok(failoverEvents.every((event) => !event.includes("down")));

  const rolledBack = await run(wrapper, ["status", "--json"], {
    env: fake.env,
  });
  assert.equal(rolledBack.code, 0, rolledBack.stderr);
  assert.equal(JSON.parse(rolledBack.stdout).searchProviderMode, "external");

  const reUpgraded = await run(wrapper, ["restart"], {
    env: {
      ...fake.env,
      FAKE_SEARCH_PROVIDER_MODE: "internal",
      FAKE_STALE_SEARXNG: "false",
    },
  });
  assert.equal(reUpgraded.code, 0, reUpgraded.stderr);
  const allEvents = await fake.events();
  assert.ok(
    allEvents.some(
      (event) => event.includes("up") && event.at(-1) === "searxng",
    ),
  );
  assert.ok(allEvents.every((event) => !event.includes("--volumes")));
});

test("unnormalized provider mode fails before lifecycle mutation", async (t) => {
  const fake = await makeFakeRuntime({ providerMode: "unnormalized" });
  t.after(() => fake.cleanup());
  const result = await run(wrapper, ["start"], { env: fake.env });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /endpoint must be normalized/);
  assert.ok(
    (await fake.events()).every(
      (event) =>
        !event.includes("build") &&
        !event.includes("up") &&
        !event.includes("stop") &&
        !event.includes("rm"),
    ),
  );
});

test("restart migrates a recognized legacy API container", async (t) => {
  const fake = await makeFakeRuntime({ provenance: "legacy" });
  t.after(() => fake.cleanup());
  const result = await run(wrapper, ["restart"], { env: fake.env });
  assert.equal(result.code, 0, result.stderr);
  const events = await fake.events();
  assert.ok(
    events.some(
      (event) =>
        event.includes("build") && event.includes("playwright-service"),
    ),
  );
  const apiStop = events.findIndex(
    (event) => event.includes("stop") && event.includes("api"),
  );
  const apiUp = events.findIndex(
    (event) => event.includes("up") && event.includes("api"),
  );
  assert.ok(apiStop >= 0 && apiUp > apiStop);
});

test("restart upgrades the immediately-prior worker mount shape", async (t) => {
  const fake = await makeFakeRuntime({ provenance: "pre-provider" });
  t.after(() => fake.cleanup());
  const result = await run(wrapper, ["restart"], { env: fake.env });
  assert.equal(result.code, 0, result.stderr);
  const events = await fake.events();
  assert.ok(
    events.some(
      (event) =>
        event.includes("stop") && event.includes("browser-interaction-worker"),
    ),
  );
  assert.ok(
    events.some(
      (event) =>
        event.includes("up") &&
        event.includes("browser-interaction-egress-proxy"),
    ),
  );
});

test("stop remains Docker-only and preserves dependency ordering", async (t) => {
  const fake = await makeFakeRuntime();
  t.after(() => fake.cleanup());
  await rm(fake.codexPath);
  await rm(fake.authPath);
  const result = await run(wrapper, ["stop"], { env: fake.env });
  assert.equal(result.code, 0, result.stderr);
  const events = await fake.events();
  const browserStop = events.findIndex(
    (event) =>
      event.includes("stop") &&
      event.includes("api") &&
      event.includes("browser-service") &&
      event.includes("browser-interaction-worker"),
  );
  const dependencyStop = events.findIndex(
    (event) => event.includes("stop") && event.includes("app-postgres"),
  );
  const searxngStop = events.findIndex(
    (event) => event.includes("stop") && event.at(-1) === "searxng",
  );
  assert.ok(
    browserStop >= 0 &&
      searxngStop > browserStop &&
      dependencyStop > searxngStop,
  );
});

test("status JSON reports internal provider inventory without secrets", async (t) => {
  const fake = await makeFakeRuntime();
  t.after(() => fake.cleanup());
  await rm(fake.codexPath);
  await rm(fake.authPath);
  const result = await run(wrapper, ["status", "--json"], { env: fake.env });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    searchProviderMode: "internal",
    extractCapability: {
      enabled: false,
      reason: "OPENAI_BASE_URL unset",
    },
    services: [
      {
        Service: "api",
        Publishers: [
          {
            URL: "127.0.0.1",
            TargetPort: 3002,
            PublishedPort: 3002,
            Protocol: "tcp",
          },
        ],
      },
      { Service: "searxng", Publishers: [] },
    ],
  });
  assert.doesNotMatch(result.stdout, /http:\/\/searxng|SEARXNG_SECRET/);
});

test("status and logs suppress bundled inventory in external mode", async (t) => {
  const fake = await makeFakeRuntime({ providerMode: "external" });
  t.after(() => fake.cleanup());
  const status = await run(wrapper, ["status", "--json"], { env: fake.env });
  assert.equal(status.code, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout), {
    searchProviderMode: "external",
    extractCapability: {
      enabled: false,
      reason: "OPENAI_BASE_URL unset",
    },
    services: [
      {
        Service: "api",
        Publishers: [
          {
            URL: "127.0.0.1",
            TargetPort: 3002,
            PublishedPort: 3002,
            Protocol: "tcp",
          },
        ],
      },
    ],
  });
  const logs = await run(wrapper, ["logs"], { env: fake.env });
  assert.equal(logs.code, 0, logs.stderr);
  const logEvent = (await fake.events()).find((event) =>
    event.includes("logs"),
  );
  assert.ok(logEvent);
  assert.ok(!logEvent.includes("searxng"));
  const rejected = await run(wrapper, ["logs", "searxng"], { env: fake.env });
  assert.equal(rejected.code, 64);
});

// @lat: [[runtime-operations#Local wrapper suite#Bounded search smoke]]
test("health makes one bounded redacted search smoke", async (t) => {
  const fake = await makeFakeRuntime();
  t.after(() => fake.cleanup());
  const healthy = await run(wrapper, ["health", "--json"], { env: fake.env });
  assert.equal(healthy.code, 0, healthy.stderr);
  assert.equal(JSON.parse(healthy.stdout).searchProviderMode, "internal");
  assert.equal(JSON.parse(healthy.stdout).searchProvider, "healthy");
  let smokeEvents = (await fake.events()).filter((event) =>
    event.join(" ").includes("SearXNG metasearch"),
  );
  assert.equal(smokeEvents.length, 1);
  const smoke = smokeEvents[0].join(" ");
  assert.match(smoke, /method: 'POST'/);
  assert.match(smoke, /sources: \['web'\]/);
  assert.match(smoke, /limit: 1/);
  assert.match(smoke, /AbortSignal\.timeout\(10000\)/);
  const wrapperSource = await readFile(wrapper, "utf8");
  assert.match(
    wrapperSource,
    /timeout --signal=TERM --kill-after=2s 15s[\s\\]+[\s\S]*SearXNG metasearch/,
  );

  const unavailable = await run(wrapper, ["health"], {
    env: { ...fake.env, FAKE_SEARCH_HEALTH: "unavailable" },
  });
  assert.equal(unavailable.code, 1);
  assert.match(unavailable.stderr, /search provider functional smoke/);
  assert.doesNotMatch(
    unavailable.stderr + unavailable.stdout,
    /SearXNG metasearch|search\.example\.test|provider-secret/,
  );
  smokeEvents = (await fake.events()).filter((event) =>
    event.join(" ").includes("SearXNG metasearch"),
  );
  assert.equal(smokeEvents.length, 2);
  const postOutageEvents = await fake.events();
  assert.ok(postOutageEvents.every((event) => !event.includes("stop")));

  const status = await run(wrapper, ["status", "--json"], { env: fake.env });
  assert.equal(status.code, 0, status.stderr);
  assert.ok(
    JSON.parse(status.stdout).services.some(
      (service) => service.Service === "api",
    ),
  );
});

// @lat: [[runtime-operations#Local wrapper suite#Structured health output]]
test("health structures success and labels probe failures", async (t) => {
  const fake = await makeFakeRuntime();
  t.after(() => fake.cleanup());
  const env = { ...fake.env, FAKE_HEALTH_CHATTER: "true" };

  const healthy = await run(wrapper, ["health"], { env });
  assert.equal(healthy.code, 0, healthy.stderr);
  assert.match(healthy.stdout, /^Local Firecrawl health: PASS$/m);
  assert.match(healthy.stdout, /^Dependencies$/m);
  assert.match(healthy.stdout, /PostgreSQL \(application\)\s+PASS/);
  assert.match(healthy.stdout, /PostgreSQL \(NuQ\)\s+PASS/);
  assert.match(healthy.stdout, /^Application$/m);
  assert.match(healthy.stdout, /^Browser runtime$/m);
  assert.doesNotMatch(healthy.stdout + healthy.stderr, /raw probe/);

  const json = await run(wrapper, ["health", "--json"], { env });
  assert.equal(json.code, 0, json.stderr);
  assert.equal(JSON.parse(json.stdout).status, "healthy");
  assert.doesNotMatch(json.stdout + json.stderr, /raw probe/);

  const failed = await run(wrapper, ["health"], {
    env: { ...env, FAKE_HEALTH_FAILURE: "nuq-postgres" },
  });
  assert.equal(failed.code, 23);
  assert.match(failed.stderr, /Health check failed: PostgreSQL \(NuQ\)/);
  assert.match(failed.stderr, /raw probe failure: nuq-postgres/);
  assert.doesNotMatch(failed.stdout, /Local Firecrawl health: PASS/);
});

test("logs remain available without current Codex or auth", async (t) => {
  const fake = await makeFakeRuntime();
  t.after(() => fake.cleanup());
  await rm(fake.codexPath);
  await rm(fake.authPath);
  const result = await run(wrapper, ["logs", "searxng"], {
    env: { ...fake.env, FAKE_SENSITIVE_LOGS: "true" },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /\[REDACTED\]/);
  assert.doesNotMatch(
    result.stdout,
    /SearXNG metasearch|search\.example\.test|provider-secret|private/,
  );
  assert.ok((await fake.events()).some((event) => event.includes("logs")));
});

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

// @lat: [[runtime-operations#Local wrapper suite#Codex Shim lifecycle]]
test("wrapper owns the bounded Codex Shim lifecycle", async (t) => {
  const fake = await makeFakeRuntime();
  t.after(() => fake.cleanup());
  const port = await reservePort();
  const stateHome = join(fake.root, "state");
  const logDirectory = join(stateHome, "firecrawl");
  const logPath = join(logDirectory, "codex-shim.log");
  const envFile = join(fake.root, ".env");
  await mkdir(logDirectory, { recursive: true, mode: 0o700 });
  await writeFile(logPath, "x".repeat(1_048_577), { mode: 0o600 });
  await writeFile(
    envFile,
    `OPENAI_BASE_URL=http://host.docker.internal:${port}/v1\n` +
      "OPENAI_API_KEY=AUTH_SECRET_MUST_NOT_ESCAPE\n",
    { mode: 0o600 },
  );
  const env = {
    ...fake.env,
    CODEX_SHIM_HOST: "127.0.0.1",
    CODEX_SHIM_PORT: String(port),
    LOCAL_FIRECRAWL_ENV_FILE: envFile,
    XDG_STATE_HOME: stateHome,
  };
  const started = await run(wrapper, ["shim-start"], { env });
  assert.equal(
    started.code,
    0,
    `${started.stderr}\n${await readFile(logPath, "utf8")}`,
  );
  const pidPath = join(
    env.XDG_RUNTIME_DIR,
    "firecrawl-control",
    "codex-shim.pid",
  );
  const firstPid = Number((await readFile(pidPath, "utf8")).trim());
  assert.ok(firstPid > 0);
  assert.ok(
    (await stat(join(logDirectory, "codex-shim.log.1"))).size <= 1_048_576,
  );

  const duplicate = await run(wrapper, ["shim-start"], { env });
  assert.equal(duplicate.code, 1);
  assert.match(duplicate.stderr, /already running/);

  const status = await run(wrapper, ["status", "--json"], { env });
  assert.equal(status.code, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout).extractCapability, {
    enabled: true,
    provider: "codex-shim",
    models: { small: "gpt-5.6-luna", main: "gpt-5.6-terra" },
  });
  assert.doesNotMatch(status.stdout + status.stderr, /AUTH_SECRET/);

  await appendFile(
    logPath,
    '\n{"authorization":"Bearer AUTH_SECRET_MUST_NOT_ESCAPE"}\n',
  );
  const logs = await run(wrapper, ["logs", "shim"], { env });
  assert.equal(logs.code, 0, logs.stderr);
  assert.match(logs.stdout, /\[REDACTED\]/);
  assert.doesNotMatch(logs.stdout, /AUTH_SECRET/);

  const restarted = await run(wrapper, ["restart"], { env });
  assert.equal(restarted.code, 0, restarted.stderr);
  const secondPid = Number((await readFile(pidPath, "utf8")).trim());
  assert.notEqual(secondPid, firstPid);
  assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);

  const stoppedRuntime = await run(wrapper, ["stop"], { env });
  assert.equal(stoppedRuntime.code, 0, stoppedRuntime.stderr);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/health`));

  const startedAgain = await run(wrapper, ["shim-start"], { env });
  assert.equal(startedAgain.code, 0, startedAgain.stderr);
  const stopped = await run(wrapper, ["shim-stop"], { env });
  assert.equal(stopped.code, 0, stopped.stderr);
  const disabled = await run(wrapper, ["status", "--json"], { env });
  assert.equal(disabled.code, 0, disabled.stderr);
  assert.deepEqual(JSON.parse(disabled.stdout).extractCapability, {
    enabled: false,
    reason: "codex-shim unreachable",
  });
});

test("shim health and PID ownership failures are fail-closed", async (t) => {
  const fake = await makeFakeRuntime();
  t.after(() => fake.cleanup());
  const port = await reservePort();
  const blocker = createServer((_request, response) => {
    response.writeHead(503, { "content-type": "application/json" });
    response.end('{"status":"unavailable"}');
  });
  await new Promise((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(port, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => blocker.close(resolve)));
  const env = {
    ...fake.env,
    CODEX_SHIM_HOST: "127.0.0.1",
    CODEX_SHIM_PORT: String(port),
    XDG_STATE_HOME: join(fake.root, "state"),
  };
  const failed = await run(wrapper, ["shim-start"], { env });
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /post-start health check/);

  const control = join(env.XDG_RUNTIME_DIR, "firecrawl-control");
  const pidPath = join(control, "codex-shim.pid");
  await writeFile(pidPath, `${process.pid}\n`, { mode: 0o600 });
  const refused = await run(wrapper, ["shim-stop"], { env });
  assert.equal(refused.code, 70);
  assert.match(refused.stderr, /not the managed Codex Shim/);
});

function expectCompose(...suffix) {
  return [
    "compose",
    "--project-name",
    "firecrawl",
    "--project-directory",
    repoRoot,
    "-f",
    join(repoRoot, "compose.yaml"),
    ...suffix,
  ];
}
