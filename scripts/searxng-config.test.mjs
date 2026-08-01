import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const settingsPath = join(repoRoot, "config", "searxng", "settings.yml");
const image =
  "ghcr.io/searxng/searxng:2026.7.31-6bfd82705@" +
  "sha256:79c2be18a18367484474bae9b18a8cd9085114ab3dcd49cac091cad8c548a0a9";
const expectedEngines = ["bing", "brave", "qwant", "startpage"];
const composeProject = `firecrawl-searxng-test-${process.pid}`;

const composeEnv = {
  ...process.env,
  APP_POSTGRES_DB: "firecrawl",
  APP_POSTGRES_PASSWORD: "a".repeat(64),
  APP_POSTGRES_USER: "firecrawl",
  ARTIFACT_MINIO_ACCESS_KEY: "firecrawl-app",
  ARTIFACT_MINIO_BUCKET: "firecrawl-artifacts",
  ARTIFACT_MINIO_ENDPOINT: "http://minio:9000",
  ARTIFACT_MINIO_REGION: "us-east-1",
  ARTIFACT_MINIO_SECRET_KEY: "b".repeat(64),
  ARTIFACT_STORE_PROVIDER: "minio",
  BROWSER_INTERACTION_WORKER_TOKEN: "C".repeat(43),
  BROWSER_REPLAY_INGEST_API_KEY: "d".repeat(64),
  BROWSER_SERVICE_API_KEY: "E".repeat(43),
  LOCAL_ARTIFACT_RETENTION_DAYS: "30",
  LOCAL_BROWSER_STATE_ROOT: "/var/lib/firecrawl-browser-volume/state",
  LOCAL_CODEX_AUTH_FILE: settingsPath,
  LOCAL_CODEX_CA_BUNDLE_FILE: settingsPath,
  LOCAL_CODEX_PACKAGE_DIR: repoRoot,
  LOCAL_OWNER_ID: "11111111-1111-4111-8111-111111111111",
  LOCAL_PERSISTENCE_ENABLED: "true",
  LOCAL_RECORD_RETENTION_DAYS: "30",
  MINIO_ROOT_PASSWORD: "f".repeat(64),
  MINIO_ROOT_USER: "firecrawl-root",
  POSTGRES_DB: "postgres",
  POSTGRES_USER: "firecrawl",
  SEARXNG_SECRET: "0".repeat(64),
};

function runDocker(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, {
      cwd: repoRoot,
      env: composeEnv,
      ...options,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => {
      stdout += chunk;
    });
    child.stderr.on("data", chunk => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", code => resolve({ code, stdout, stderr }));
  });
}

async function mustRunDocker(args, options) {
  const result = await runDocker(args, options);
  assert.equal(
    result.code,
    0,
    `docker ${args.join(" ")} failed:\n${result.stderr}${result.stdout}`,
  );
  return result.stdout;
}

function composeArgs(...args) {
  return [
    "compose",
    "--project-name",
    composeProject,
    "--project-directory",
    repoRoot,
    "-f",
    join(repoRoot, "compose.yaml"),
    ...args,
  ];
}

// @lat: [[testing/runtime-operations#Runtime and Operations Testing#SearXNG configuration suite#Static settings policy]]
test("tracked SearXNG settings enforce the private engine policy", async () => {
  const settingsSource = await readFile(settingsPath, "utf8");
  assert.doesNotMatch(settingsSource, /duckduckgo/i);

  const inspectSettings = `
import json
from searx.settings_loader import load_settings

settings, source = load_settings()
print(json.dumps({
    "source": source,
    "general": settings["general"],
    "search": settings["search"],
    "server": settings["server"],
    "categories": settings["categories_as_tabs"],
    "outgoing": settings["outgoing"],
    "valkey": settings["valkey"],
    "engines": settings["engines"],
}))
`;
  const stdout = await mustRunDocker([
    "run",
    "--rm",
    "--user",
    "977:977",
    "--read-only",
    "--mount",
    `type=bind,source=${settingsPath},target=/etc/searxng/settings.yml,readonly`,
    "--entrypoint",
    "/usr/local/searxng/.venv/bin/python",
    image,
    "-c",
    inspectSettings,
  ]);
  const settings = JSON.parse(stdout);
  const engines = settings.engines.toSorted((a, b) =>
    a.name.localeCompare(b.name),
  );

  assert.match(settings.source, /^merge the default settings/);
  assert.equal(settings.general.debug, false);
  assert.equal(settings.general.enable_metrics, false);
  assert.equal(settings.search.safe_search, 1);
  assert.equal(settings.search.autocomplete, "");
  assert.equal(settings.search.favicon_resolver, "");
  assert.equal(settings.search.default_lang, "en");
  assert.equal(settings.search.max_page, 5);
  assert.deepEqual(settings.search.formats, ["json"]);
  assert.equal(settings.server.limiter, false);
  assert.equal(settings.server.public_instance, false);
  assert.equal(settings.server.image_proxy, false);
  assert.equal(settings.server.method, "POST");
  assert.equal(settings.server.secret_key, "ultrasecretkey");
  assert.deepEqual(settings.categories, { general: null });
  assert.equal(settings.outgoing.request_timeout, 3);
  assert.equal(settings.outgoing.max_request_timeout, 4);
  assert.equal(settings.outgoing.retries, 0);
  assert.equal(settings.outgoing.pool_connections, 16);
  assert.equal(settings.outgoing.pool_maxsize, 8);
  assert.equal(settings.valkey.url, false);
  assert.deepEqual(
    engines.map(engine => engine.name),
    expectedEngines,
  );
  assert.ok(engines.every(engine => engine.disabled === false));
  assert.ok(
    engines.every(
      engine =>
        engine.categories.length === 1 && engine.categories[0] === "general",
    ),
  );
});

// @lat: [[testing/runtime-operations#Runtime and Operations Testing#SearXNG configuration suite#Rendered service hardening]]
test("rendered local Compose keeps SearXNG private and bounded", async () => {
  const stdout = await mustRunDocker(composeArgs("config", "--format", "json"));
  const rendered = JSON.parse(stdout);
  const service = rendered.services.searxng;
  const settingsMount = service.volumes.find(
    volume => volume.target === "/etc/searxng/settings.yml",
  );

  assert.equal(service.image, image);
  assert.equal(service.user, "977:977");
  assert.equal(service.read_only, true);
  assert.equal(service.init, true);
  assert.equal(service.restart, "unless-stopped");
  assert.deepEqual(Object.keys(service.networks), ["backend"]);
  assert.equal(service.ports, undefined);
  assert.equal(service.network_mode, undefined);
  assert.deepEqual(service.cap_drop, ["ALL"]);
  assert.deepEqual(service.security_opt, ["no-new-privileges:true"]);
  assert.equal(service.cpus, 1);
  assert.equal(service.mem_limit, String(512 * 1024 * 1024));
  assert.equal(service.memswap_limit, String(512 * 1024 * 1024));
  assert.equal(service.pids_limit, 128);
  assert.deepEqual(service.tmpfs, [
    "/tmp:noexec,nosuid,nodev,size=64m,mode=1777",
    "/var/cache/searxng:noexec,nosuid,nodev,size=128m,mode=0750,uid=977,gid=977",
  ]);
  assert.equal(settingsMount.type, "bind");
  assert.equal(settingsMount.source, settingsPath);
  assert.equal(settingsMount.read_only, true);
  assert.equal(settingsMount.bind.create_host_path, false);
  assert.equal(service.environment.FORCE_OWNERSHIP, "false");
  assert.equal(service.environment.SEARXNG_SECRET, "0".repeat(64));
  assert.equal(rendered.services.api.environment.SEARXNG_SECRET, undefined);
  assert.equal(service.logging.driver, "json-file");
  assert.deepEqual(service.logging.options, {
    compress: "true",
    "max-file": "3",
    "max-size": "10m",
  });
  assert.deepEqual(service.healthcheck, {
    test: [
      "CMD",
      "wget",
      "-q",
      "--spider",
      "--timeout=3",
      "http://127.0.0.1:8080/healthz",
    ],
    timeout: "3s",
    interval: "10s",
    retries: 12,
    start_period: "20s",
  });
});

// @lat: [[testing/runtime-operations#Runtime and Operations Testing#SearXNG configuration suite#Immutable image architectures]]
test("pinned SearXNG image supports amd64 and arm64", { timeout: 60_000 }, async () => {
  const manifest = JSON.parse(
    await mustRunDocker(["manifest", "inspect", image]),
  );
  const platforms = manifest.manifests.map(
    entry => `${entry.platform.os}/${entry.platform.architecture}`,
  );

  assert.equal(manifest.mediaType, "application/vnd.oci.image.index.v1+json");
  assert.ok(platforms.includes("linux/amd64"));
  assert.ok(platforms.includes("linux/arm64"));
});

// @lat: [[testing/runtime-operations#Runtime and Operations Testing#SearXNG configuration suite#Boot and effective settings]]
test(
  "SearXNG boots hardened with all selected engines enabled",
  { timeout: 120_000 },
  async t => {
    t.after(async () => {
      await runDocker(composeArgs("down", "--timeout", "10"));
    });

    await mustRunDocker(
      composeArgs(
        "up",
        "--detach",
        "--no-deps",
        "--wait",
        "--wait-timeout",
        "90",
        "searxng",
      ),
    );
    const health = await mustRunDocker(
      composeArgs(
        "exec",
        "--no-tty",
        "searxng",
        "wget",
        "-qO-",
        "http://127.0.0.1:8080/healthz",
      ),
    );
    const effective = JSON.parse(
      await mustRunDocker(
        composeArgs(
          "exec",
          "--no-tty",
          "searxng",
          "wget",
          "-qO-",
          "http://127.0.0.1:8080/config",
        ),
      ),
    );
    const engines = effective.engines.toSorted((a, b) =>
      a.name.localeCompare(b.name),
    );

    assert.equal(health, "OK");
    assert.deepEqual(effective.categories, ["general"]);
    assert.equal(effective.autocomplete, "");
    assert.equal(effective.safe_search, 1);
    assert.equal(effective.limiter.enabled, false);
    assert.equal(effective.public_instance, false);
    assert.deepEqual(
      engines.map(engine => engine.name),
      expectedEngines,
    );
    assert.ok(engines.every(engine => engine.enabled === true));
    assert.ok(
      engines.every(
        engine =>
          engine.categories.length === 1 && engine.categories[0] === "general",
      ),
    );
  },
);
