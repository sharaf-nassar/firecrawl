import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
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
    SEARXNG_SECRET: "e".repeat(64),
    ...overrides,
  };
  return Object.entries(values)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n") + "\n";
}

function parseEnvironment(source) {
  return Object.fromEntries(
    source
      .trim()
      .split("\n")
      .map(line => line.split(/=(.*)/s).slice(0, 2)),
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
    child.stdout?.on("data", chunk => {
      stdout += chunk;
    });
    child.stderr?.on("data", chunk => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", code => resolve({ code, stdout, stderr }));
  });
}

async function makeFakeRuntime({ provenance = "current" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "local-firecrawl-docker-test-"));
  const bin = join(root, "bin");
  const runtime = join(root, "runtime");
  const home = join(root, "home");
  const codexPackage = join(root, "codex-package");
  const caBundle = join(root, "ca-certificates.crt");
  const log = join(root, "events.jsonl");
  const state = join(root, "provenance");
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
  await writeFile(join(codexPackage, "bin", "codex.js"), "#!/usr/bin/env node\n", {
    mode: 0o755,
  });
  await writeFile(join(home, ".codex", "auth.json"), "{}\n", { mode: 0o600 });
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
          },
          networks: { "model-uplink": null },
          volumes: [
            {
              type: "volume",
              source: "browser-interaction-egress-socket",
              target: "/run/firecrawl-model-egress",
              read_only: false,
            },
          ],
        },
        "app-db-migrate": { networks: { backend: null } },
      },
    };
    if (!maintenanceProfileEnabled) {
      delete rendered.services["app-db-migrate"];
    }
    if (process.env.FAKE_COMPOSE_INVALID === "browser_service_key") {
      rendered.services.api.environment.BROWSER_SERVICE_API_KEY =
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
if (has("build") || has("stop") || has("logs")) process.exit(0);
if (has("up")) {
  if (has("api")) fs.writeFileSync(statePath, "current");
  process.exit(0);
}
if (has("exec")) {
  if (has("redis-cli")) process.stdout.write("PONG\\n");
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

  return {
    root,
    log,
    authPath: join(home, ".codex", "auth.json"),
    codexPath: join(bin, "codex"),
    env: {
      FAKE_DOCKER_LOG: log,
      FAKE_PROVENANCE_STATE: state,
      FAKE_REPO: repoRoot,
      LOCAL_FIRECRAWL_ONE_SHOT_TIMEOUT_SECONDS: "10",
      LOCAL_FIRECRAWL_CA_BUNDLE_FILE: caBundle,
      XDG_RUNTIME_DIR: runtime,
      HOME: home,
      PATH: `${bin}:/usr/bin:/bin`,
    },
    async events() {
      const data = await readFile(log, "utf8").catch(() => "");
      return data
        .split("\n")
        .filter(Boolean)
        .map(line => JSON.parse(line));
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
});

test("environment upgrade rotates legacy browser settings", async t => {
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

test("environment upgrade preserves current browser secrets", async t => {
  const root = await mkdtemp(join(tmpdir(), "local-firecrawl-env-test-"));
  const envFile = join(root, ".env");
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = phaseEnvironment();
  await writeFile(envFile, original, { mode: 0o600 });

  const upgraded = await run(upgradeEnv, ["--env-file", envFile]);
  assert.equal(upgraded.code, 0, upgraded.stderr);
  assert.equal(await readFile(envFile, "utf8"), original);
});

test("invalid immutable downgrade request fails before Docker", async t => {
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

test("compose validation names failures without exposing secrets", async t => {
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

test("compose validation rejects unsafe CA mount shapes", async t => {
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

test("compose validation rejects worker and proxy egress escapes", async t => {
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

test("start builds images, runs migrations, and publishes API last", async t => {
  const fake = await makeFakeRuntime();
  t.after(() => fake.cleanup());
  const result = await run(wrapper, ["start"], { env: fake.env });
  assert.equal(result.code, 0, result.stderr);
  const events = await fake.events();
  const runtimeUpEvents = events.filter(event => event.includes("up"));
  assert.ok(runtimeUpEvents.length > 0);
  assert.ok(
    runtimeUpEvents.every(event => !event.includes("--profile")),
    "runtime up commands must not enable maintenance profile",
  );
  assert.ok(events.some(event => event.includes("build")));
  assert.ok(
    events.some(
      event =>
        event.includes("build") &&
        event.includes("browser-interaction-worker") &&
        event.includes("browser-interaction-egress-proxy") &&
        event.includes("playwright-service"),
    ),
  );
  const migrationUp = events.findIndex(
    event => event.includes("up") && event.includes("app-db-migrate"),
  );
  const apiUp = events.findIndex(
    event => event.includes("up") && event.includes("api"),
  );
  const interactionWorkerUp = events.findIndex(
    event =>
      event.includes("up") && event.includes("browser-interaction-worker"),
  );
  assert.ok(migrationUp >= 0 && apiUp > migrationUp);
  assert.ok(interactionWorkerUp >= 0 && apiUp > interactionWorkerUp);
  assert.ok(events.some(event => event.includes("browser-state-init")));
  assert.ok(events.some(event => event.includes("minio-init")));
});

test("restart migrates a recognized legacy API container", async t => {
  const fake = await makeFakeRuntime({ provenance: "legacy" });
  t.after(() => fake.cleanup());
  const result = await run(wrapper, ["restart"], { env: fake.env });
  assert.equal(result.code, 0, result.stderr);
  const events = await fake.events();
  assert.ok(
    events.some(
      event => event.includes("build") && event.includes("playwright-service"),
    ),
  );
  const apiStop = events.findIndex(
    event => event.includes("stop") && event.includes("api"),
  );
  const apiUp = events.findIndex(
    event => event.includes("up") && event.includes("api"),
  );
  assert.ok(apiStop >= 0 && apiUp > apiStop);
});

test("restart upgrades the immediately-prior worker mount shape", async t => {
  const fake = await makeFakeRuntime({ provenance: "pre-egress" });
  t.after(() => fake.cleanup());
  const result = await run(wrapper, ["restart"], { env: fake.env });
  assert.equal(result.code, 0, result.stderr);
  const events = await fake.events();
  assert.ok(
    events.some(
      event =>
        event.includes("stop") && event.includes("browser-interaction-worker"),
    ),
  );
  assert.ok(
    events.some(
      event =>
        event.includes("up") &&
        event.includes("browser-interaction-egress-proxy"),
    ),
  );
});

test("stop remains Docker-only and preserves dependency ordering", async t => {
  const fake = await makeFakeRuntime();
  t.after(() => fake.cleanup());
  await rm(fake.codexPath);
  await rm(fake.authPath);
  const result = await run(wrapper, ["stop"], { env: fake.env });
  assert.equal(result.code, 0, result.stderr);
  const events = await fake.events();
  const browserStop = events.findIndex(
    event =>
      event.includes("stop") &&
      event.includes("api") &&
      event.includes("browser-service") &&
      event.includes("browser-interaction-worker"),
  );
  const dependencyStop = events.findIndex(
    event => event.includes("stop") && event.includes("app-postgres"),
  );
  assert.ok(browserStop >= 0 && dependencyStop > browserStop);
});

test("status JSON is derived only from Compose state", async t => {
  const fake = await makeFakeRuntime();
  t.after(() => fake.cleanup());
  await rm(fake.codexPath);
  await rm(fake.authPath);
  const result = await run(wrapper, ["status", "--json"], { env: fake.env });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [
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
  ]);
});

test("logs remain available without current Codex or auth", async t => {
  const fake = await makeFakeRuntime();
  t.after(() => fake.cleanup());
  await rm(fake.codexPath);
  await rm(fake.authPath);
  const result = await run(wrapper, ["logs"], { env: fake.env });
  assert.equal(result.code, 0, result.stderr);
  assert.ok((await fake.events()).some(event => event.includes("logs")));
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
