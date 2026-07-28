import assert from "node:assert/strict";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
const wrapper = join(repoRoot, "scripts", "local-firecrawl");
const hostBuilder = join(repoRoot, "scripts", "build-firecrawl-host");
const immutableImagePattern =
  /^[a-z0-9][a-z0-9._/-]*(?::[a-z0-9._-]+)?@sha256:[a-f0-9]{64}$/;
const fullLifecycle = process.argv.includes("--full-lifecycle");

function requireImmutableImage(value, name) {
  if (typeof value !== "string" || !immutableImagePattern.test(value)) {
    throw new Error(`${name} must be an immutable @sha256 image reference`);
  }
  return value;
}

const lifecycleImages = (() => {
  if (!fullLifecycle) return null;
  const candidate = requireImmutableImage(
    process.env.FIRECRAWL_ACCEPTANCE_CANDIDATE_IMAGE,
    "FIRECRAWL_ACCEPTANCE_CANDIDATE_IMAGE",
  );
  const rollback = requireImmutableImage(
    process.env.FIRECRAWL_ACCEPTANCE_ROLLBACK_IMAGE,
    "FIRECRAWL_ACCEPTANCE_ROLLBACK_IMAGE",
  );
  if (candidate === rollback) {
    throw new Error("acceptance candidate and rollback images must differ");
  }
  return Object.freeze({ candidate, rollback });
})();

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "local-firecrawl-test-"));
  const trace = join(root, "trace.jsonl");
  const release = join(root, "release-api");
  const writerState = join(root, "writer-state");
  const candidateState = join(root, "candidate-state");
  const adapterState = join(root, "adapter-state");
  const xdgRuntime = join(root, "xdg-runtime");
  const docker = join(root, "docker");
  const curl = join(root, "curl");
  const systemctl = join(root, "systemctl");
  const sudo = join(root, "sudo");
  const builder = join(root, "builder");
  const gate = join(root, "gate.mjs");
  const manifest = join(root, "manifest.json");
  const runtime = join(root, "runtime");
  const published = join(root, "published");
  const latestMigration = "0010_browser_stop_billing_claim.sql";
  const latestMigrationChecksum = createHash("sha256")
    .update(
      await readFile(
        join(repoRoot, "apps/api/src/db/migrations", latestMigration),
      ),
    )
    .digest("hex");
  const shaA = "a".repeat(64);
  const shaB = "b".repeat(64);
  const shaC = "c".repeat(64);
  const shaD = "d".repeat(64);
  const adapterHealth = {
    version: 1,
    status: "ok",
    codexCliVersion: "0.145.0",
    codexArtifactSha256: shaA,
    codexProtocolSchemaSha256: shaB,
    brokerProtocolSha256: shaC,
    model: "gpt-5.6-terra",
    reasoningEffort: "medium",
  };
  const durableStatus = {
    ...adapterHealth,
    activePromptJobs: 0,
    activeCodeJobs: 0,
    preparedHostJobs: 0,
    startingHostJobs: 0,
    runningHostJobs: 0,
    unsettledHostJobs: 0,
    orphanProcesses: 0,
    activeBrowserSessions: 0,
    activeCapabilities: 0,
    activeProxyGrants: 0,
    activeWriterLeases: 0,
    unknownActionOutcomes: 0,
    firecrawlCloudFallbackAttempts: 0,
  };
  const diagnostic = {
    version: 1,
    correlationId: "10000000-0000-4000-8000-000000000001",
    jobId: "10000000-0000-4000-8000-000000000002",
    phase: "running",
    hostInitPid: 42,
    pidfdLive: true,
    pidfdPidMatches: true,
    controlLeaseConnected: true,
    inertRelayFdPresent: false,
    relayListenerPresent: true,
    cdpRelayOpened: true,
    payloadStartedCount: 1,
    payloadMarkerPresent: true,
    callbackCount: 1,
    browserEffectCount: 0,
    runcState: "running",
    cgroupPresent: true,
    jobDirectoryPresent: true,
    childCount: 1,
    cleanupFailure: false,
  };
  await writeFile(
    manifest,
    `${JSON.stringify({
      codexAppServer: {
        sourceIdentity: {
          executablePath: "/home/mamba/.local/bin/codex",
          resolvedPath: "/opt/codex/bin/codex",
          device: "1",
          inode: "2",
          version: "0.145.0",
        },
        artifactSha256: shaA,
        protocolSha256: shaB,
        featureSha256: shaD,
        model: "gpt-5.6-terra",
        reasoningEffort: "medium",
      },
      brokerContractSha256: shaC,
    })}\n`,
  );
  await writeFile(writerState, "api-and-browser-running");
  await writeFile(candidateState, "unchanged");
  await writeFile(adapterState, "active");
  await mkdir(xdgRuntime, { mode: 0o700 });
  await writeFile(
    docker,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_DOCKER_TRACE, JSON.stringify(args) + "\\n");
const has = value => args.includes(value);
if (has("config")) {
  if (has("--format")) {
    process.stdout.write(JSON.stringify({
      services: {
        api: {
          environment: {
            LOCAL_BROWSER_SERVICE_ENABLED: "true",
            BROWSER_SERVICE_API_KEY: "A".repeat(43),
            BROWSER_EXECUTION_ADAPTER_SOCKET:
              "/run/firecrawl-adapter/adapter.sock",
            BROWSER_ADAPTER_TOKEN_FILE:
              "/run/firecrawl-adapter/adapter.token",
          },
          volumes: [{
            type: "bind",
            source: process.env.LOCAL_FIRECRAWL_HOST_RUNTIME_DIR,
            target: "/run/firecrawl-adapter",
            read_only: true,
          }],
          ports: [{ target: 3002 }],
        },
        "browser-service": {
          environment: {
            LOCAL_BROWSER_SERVICE_ENABLED: "true",
            MAX_BROWSER_SESSIONS: "4",
          },
        },
      },
    }) + "\\n");
  }
  process.exit(0);
}
if (has("stop")) {
  const stopsApi = has("api");
  const stopsBrowser = has("browser-service");
  const current = fs.readFileSync(process.env.FAKE_WRITER_STATE, "utf8");
  if (stopsApi && stopsBrowser) {
    fs.writeFileSync(process.env.FAKE_WRITER_STATE, "stopped");
  } else if (stopsBrowser) {
    fs.writeFileSync(
      process.env.FAKE_WRITER_STATE,
      current === "browser-running" ? "stopped" : "api-running"
    );
  } else if (stopsApi) {
    fs.writeFileSync(
      process.env.FAKE_WRITER_STATE,
      current === "api-running" ? "stopped" : "browser-running"
    );
  }
}
if (has("up") && args.at(-1) === "browser-state-init" && process.env.FAKE_INIT_FAILURE) {
  process.stderr.write(process.env.FAKE_INIT_FAILURE + "\\n");
  process.exit(41);
}
if (has("up") && args.at(-1) === "browser-service" && process.env.FAKE_BROWSER_FAILURE === "true") {
  process.stderr.write("atomic_publish_preflight_failed\\n");
  process.exit(43);
}
if (has("up") && args.at(-1) === "api") {
  if (process.env.FAKE_API_FAILURE === "true") {
    process.stderr.write("browser_startup_migration_failed\\n");
    process.exit(42);
  }
  if (process.env.FAKE_BLOCK_API === "true") {
    while (!fs.existsSync(process.env.FAKE_API_RELEASE)) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
}
if (has("ps") && (args.at(-1) === "minio-init" || args.at(-1) === "browser-state-init")) {
  process.stdout.write("exited 0\\n");
}
if (has("ps") && has("-q") && args.at(-1) === "browser-service") {
  process.stdout.write("browser-container\\n");
}
if (has("ps") && has("-q") && args.at(-1) === "api") {
  if (process.env.FAKE_API_STOPPED !== "true") {
    process.stdout.write("api-container\\n");
  }
}
if (has("run") && has("--health-only")) {
  if (process.env.FAKE_HEALTH_FAILURE === "true") process.exit(1);
  process.stdout.write(${JSON.stringify(JSON.stringify(adapterHealth))} + "\\n");
}
if (has("exec") && has("--diagnose-host-job")) {
  process.stdout.write(${JSON.stringify(JSON.stringify(diagnostic))} + "\\n");
} else if (
  (has("exec") || has("run")) &&
  !has("--health-only") &&
  args.some(value => value.endsWith("browser-runtime-status.js"))
) {
  if (process.env.FAKE_STATUS_EOF === "true") process.exit(0);
  const status = ${JSON.stringify(durableStatus)};
  if (process.env.FAKE_STATUS_EXTRA === "true") status.secret = "leak";
  if (process.env.FAKE_STATUS_ORPHANS) {
    status.orphanProcesses = Number(process.env.FAKE_STATUS_ORPHANS);
  }
  if (process.env.FAKE_STATUS_UNSETTLED) {
    status.unsettledHostJobs = Number(process.env.FAKE_STATUS_UNSETTLED);
  }
  process.stdout.write(JSON.stringify(status) + "\\n");
}
if (has("exec") && args.some(value => value.endsWith("browser-runtime-drain.js"))) {
  if (process.env.FAKE_GRACEFUL_DRAIN_FAILURE === "true") process.exit(44);
  process.stdout.write('{"cancelledHostJobs":0}\\n');
}
if (
  has("run") &&
  has("--force-after-api-stop") &&
  args.some(value => value.endsWith("browser-runtime-drain.js"))
) {
  if (process.env.FAKE_FORCE_DRAIN_FAILURE === "true") process.exit(45);
  process.stdout.write('{"cancelledHostJobs":0}\\n');
}
if (args[0] === "inspect" && args.at(-1) === "browser-container") {
  process.stdout.write("sha256:" + "c".repeat(64) + "\\n");
}
if (args[0] === "inspect" && args.at(-1) === "api-container") {
  process.stdout.write(
    process.env.FAKE_REPO_ROOT + "/compose.yaml," +
    process.env.FAKE_REPO_ROOT + "/compose.local.yaml\\n"
  );
}
if (has("exec") && has("redis") && has("redis-cli")) {
  process.stdout.write("PONG\\n");
}
if (
  has("exec") &&
  has("app-postgres") &&
  args.some(value => value.includes("application_schema_migrations"))
) {
  process.stdout.write(
    process.env.FAKE_LATEST_MIGRATION + "|" +
    process.env.FAKE_LATEST_MIGRATION_CHECKSUM + "\\n"
  );
}
if (args[0] === "run" && args.some(value => value.endsWith("check-atomic-publication-rollback.mjs"))) {
  if (fs.readFileSync(process.env.FAKE_WRITER_STATE, "utf8") !== "stopped") {
    fs.writeFileSync(process.env.FAKE_CANDIDATE_STATE, "mutated-by-live-writer");
    process.stderr.write("rollback_writer_not_quiesced\\n");
    process.exit(21);
  }
  if (process.env.FAKE_ROLLBACK_REJECT === "true") {
    process.stderr.write("rollback_state_unresolved\\n");
    process.exit(20);
  }
  process.stderr.write("rollback_safe\\n");
}
if (has("ps") && has("json")) {
  process.stdout.write(JSON.stringify({
    Service: "api",
    Publishers: [{
      URL: "127.0.0.1",
      TargetPort: 3002,
      PublishedPort: 3002,
      Protocol: "tcp"
    }]
  }) + "\\n");
}
if (has("logs")) {
  for (let index = 0; index < 250; index += 1) {
    process.stdout.write(
      "10000000-0000-4000-8000-000000000001 token=super-secret line=" +
      index + "\\n"
    );
  }
  process.stdout.write(
    '10000000-0000-4000-8000-000000000001 ' +
    '{"token":"json-secret","pageValue":"page-secret",' +
    '"prompt":"prompt-secret","safe":"visible"}\\n'
  );
  process.stdout.write(
    "10000000-0000-4000-8000-000000000001 " +
    "Authorization: Bearer bearer-secret\\n"
  );
}
`,
    { mode: 0o700 },
  );
  await writeFile(
    systemctl,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(
  process.env.FAKE_DOCKER_TRACE,
  JSON.stringify(["systemctl", ...args]) + "\\n",
);
if (
  process.env.FAKE_SYSTEMCTL_FAILURE &&
  args.join(" ").includes(process.env.FAKE_SYSTEMCTL_FAILURE)
) process.exit(1);
const adapterUnit = args.includes("firecrawl-execution-adapter.service");
if (adapterUnit && args.includes("stop")) {
  fs.writeFileSync(process.env.FAKE_ADAPTER_STATE, "inactive");
}
if (adapterUnit && args.includes("start")) {
  fs.writeFileSync(process.env.FAKE_ADAPTER_STATE, "active");
}
if (adapterUnit && args.includes("is-active")) {
  if (process.env.FAKE_ADAPTER_ALWAYS_ACTIVE === "true") process.exit(0);
  process.exit(
    fs.readFileSync(process.env.FAKE_ADAPTER_STATE, "utf8") === "active"
      ? 0
      : 3,
  );
}
`,
    { mode: 0o700 },
  );
  await writeFile(
    curl,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(
  process.env.FAKE_DOCKER_TRACE,
  JSON.stringify(["curl", ...args]) + "\\n",
);
const url = args.at(-1);
if (url.endsWith("/v2/browser")) {
  process.stdout.write(JSON.stringify({
    success: true,
    id: "10000000-0000-4000-8000-000000000099",
    cdpUrl: "ws://fixture",
    liveViewUrl: "http://fixture/view",
    interactiveLiveViewUrl: "http://fixture/interactive",
    expiresAt: new Date(Date.now() + 30000).toISOString(),
  }));
} else if (url.endsWith("/execute")) {
  const data = args[args.indexOf("--data") + 1];
  const expected = JSON.parse(data).code.includes("return 2") ? "2" : "1";
  process.stdout.write(JSON.stringify({
    success: true,
    stdout: "",
    result: expected,
    stderr: "",
    exitCode: 0,
    killed: false,
  }));
}
`,
    { mode: 0o700 },
  );
  await writeFile(
    sudo,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(
  process.env.FAKE_DOCKER_TRACE,
  JSON.stringify(["sudo", ...args]) + "\\n",
);
if (process.env.FAKE_SUDO_FAILURE === "true") process.exit(1);
fs.writeFileSync(process.env.FAKE_HOST_PUBLISHED, "published");
`,
    { mode: 0o700 },
  );
  await writeFile(
    builder,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(
  process.env.FAKE_DOCKER_TRACE,
  JSON.stringify(["builder", ...args]) + "\\n",
);
if (args[0] === "--capture-active-identity" && args[1] === "--output") {
  const manifest = JSON.parse(
    fs.readFileSync(process.env.LOCAL_FIRECRAWL_HOST_MANIFEST, "utf8"),
  );
  fs.writeFileSync(
    args[2],
    JSON.stringify(manifest.codexAppServer.sourceIdentity) + "\\n",
    { flag: "wx", mode: 0o600 },
  );
  process.exit(0);
}
if (args[0] === "--verify-installed-identity") {
  if (
    process.env.FAKE_HOST_DRIFT === "true" &&
    !fs.existsSync(process.env.FAKE_HOST_PUBLISHED)
  ) process.exit(1);
  process.exit(0);
}
if (args[0] === "--staging-only" && args[1] === "--output") {
  if (process.env.FAKE_ACTIVE_IDENTITY_DRIFT_DURING_BUILD === "true") {
    process.exit(78);
  }
  fs.mkdirSync(args[2], { recursive: true });
  const identityPath = args[args.indexOf("--expected-identity") + 1];
  const identity = JSON.parse(fs.readFileSync(identityPath, "utf8"));
  fs.writeFileSync(
    args[2] + "/manifest.json",
    JSON.stringify({ codexAppServer: { sourceIdentity: identity } }) + "\\n",
  );
  process.exit(0);
}
process.exit(64);
`,
    { mode: 0o700 },
  );
  await writeFile(
    gate,
    `import fs from "node:fs";
const args = process.argv.slice(2);
fs.appendFileSync(
  process.env.FAKE_DOCKER_TRACE,
  JSON.stringify(["gate", ...args, process.env.PATH]) + "\\n",
);
if (process.env.FAKE_GATE_FAILURE === "true") process.exit(1);
const manifest = JSON.parse(
  fs.readFileSync(process.env.LOCAL_FIRECRAWL_HOST_MANIFEST, "utf8"),
);
const output = args[args.indexOf("--attestation-out") + 1];
const source = manifest.codexAppServer;
const attestation = {
  formatVersion: 1,
  codexIdentity: source.sourceIdentity,
  runCount: 3,
  model: source.model,
  reasoningEffort: source.reasoningEffort,
  turns: 6,
  actions: 3,
  writes: 3,
  tools: 0,
  approvals: 0,
  schemaSha256: source.protocolSha256,
  featureSha256: source.featureSha256,
};
if (process.env.FAKE_GATE_BAD_ATTESTATION === "true") {
  attestation.schemaSha256 = "e".repeat(64);
}
fs.writeFileSync(output, JSON.stringify(attestation) + "\\n", {
  flag: "wx",
  mode: 0o600,
});
`,
    { mode: 0o700 },
  );
  t.after(async () => rm(root, { recursive: true, force: true }));
  const env = {
    ...process.env,
    PATH: `${root}:${process.env.PATH}`,
    FAKE_DOCKER_TRACE: trace,
    FAKE_API_RELEASE: release,
    FAKE_WRITER_STATE: writerState,
    FAKE_CANDIDATE_STATE: candidateState,
    FAKE_ADAPTER_STATE: adapterState,
    FAKE_HOST_PUBLISHED: published,
    FAKE_REPO_ROOT: repoRoot,
    FAKE_LATEST_MIGRATION: latestMigration,
    FAKE_LATEST_MIGRATION_CHECKSUM: latestMigrationChecksum,
    LOCAL_FIRECRAWL_TESTING: "1",
    LOCAL_FIRECRAWL_HOST_MANIFEST: manifest,
    LOCAL_FIRECRAWL_HOST_RUNTIME_DIR: runtime,
    LOCAL_FIRECRAWL_HOST_BUILDER: builder,
    LOCAL_FIRECRAWL_GATE_SCRIPT: gate,
    LOCAL_FIRECRAWL_LOCK_WAIT_SECONDS: "2",
    LOCAL_FIRECRAWL_ONE_SHOT_TIMEOUT_SECONDS: "5",
    XDG_RUNTIME_DIR: xdgRuntime,
    ...options.env,
  };
  const start = (command = "start", args = []) =>
    spawn(wrapper, [command, ...args], {
      cwd: repoRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  const events = async () => {
    try {
      return (await readFile(trace, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  };
  const candidateStateValue = () => readFile(candidateState, "utf8");
  return {
    start,
    events,
    release,
    manifest,
    root,
    adapterState,
    xdgRuntime,
    runtime,
    candidateStateValue,
  };
}

function completion(child) {
  return new Promise((resolvePromise) => {
    let stderr = "";
    let stdout = "";
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.once("close", (code) => resolvePromise({ code, stderr, stdout }));
  });
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  throw new Error("condition timed out");
}

test("start orders Browser Service, MinIO bootstrap, API, then health", async (t) => {
  const run = await fixture(t);
  const result = await completion(run.start());
  assert.equal(result.code, 0, result.stderr);
  const events = await run.events();
  const apiStop = events.findIndex(
    (args) => args.includes("stop") && args.includes("api"),
  );
  const browserStop = events.findIndex(
    (args) => args.includes("stop") && args.includes("browser-service"),
  );
  const stateInit = events.findIndex(
    (args) => args.includes("up") && args.at(-1) === "browser-state-init",
  );
  assert.ok(apiStop >= 0 && apiStop < browserStop && browserStop < stateInit);
  const up = events.filter((args) => args.includes("up"));
  assert.deepEqual(
    up.map((args) => ({
      noDeps: args.includes("--no-deps"),
      services: args
        .slice(args.indexOf("up") + 1)
        .filter((x) => !x.startsWith("-")),
    })),
    [
      { noDeps: true, services: ["browser-state-init", "browser-state-init"] },
      { noDeps: true, services: ["browser-service"] },
      {
        noDeps: false,
        services: [
          "playwright-service",
          "nuq-postgres",
          "redis",
          "rabbitmq",
          "app-postgres",
          "minio",
        ],
      },
      { noDeps: true, services: ["minio-init", "minio-init"] },
      { noDeps: true, services: ["api"] },
    ],
  );
  assert.equal(
    events.some((args) =>
      [
        "app-db-migrate",
        "browser-reconciliation",
        "browser-retention",
        "local-retention",
      ].some((owner) => args.includes(owner)),
    ),
    false,
  );
  const apiUp = events.findIndex(
    (args) => args.includes("up") && args.at(-1) === "api",
  );
  const health = events.findIndex(
    (args) =>
      args.includes("exec") &&
      args.includes("api") &&
      args.some((value) => value.endsWith("browser-runtime-status.js")) &&
      events.indexOf(args) > apiUp,
  );
  const ports = events.findIndex(
    (args) => args.includes("ps") && args.includes("json"),
  );
  assert.ok(apiUp < health && health < ports);
});

test("start stays blocked until API readiness returns", async (t) => {
  const run = await fixture(t, { env: { FAKE_BLOCK_API: "true" } });
  const child = run.start();
  const done = completion(child);
  await waitFor(async () =>
    (await run.events()).some(
      (args) => args.includes("up") && args.at(-1) === "api",
    ),
  );
  const before = await Promise.race([
    done.then(() => "done"),
    new Promise((resolvePromise) =>
      setTimeout(() => resolvePromise("blocked"), 100),
    ),
  ]);
  assert.equal(before, "blocked");
  await writeFile(run.release, "release");
  assert.equal((await done).code, 0);
});

test("typed post-handoff API failure returns nonzero", async (t) => {
  const run = await fixture(t, { env: { FAKE_API_FAILURE: "true" } });
  const result = await completion(run.start());
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /browser_startup_migration_failed/);
  assert.equal(
    (await run.events()).some((args) => args.includes("app-db-migrate")),
    false,
  );
});

for (const category of [
  "invalid-marker",
  "invalid-owner",
  "invalid-mode",
  "invalid-mount",
]) {
  test(`${category} init failure starts neither Browser nor API`, async (t) => {
    const run = await fixture(t, { env: { FAKE_INIT_FAILURE: category } });
    const result = await completion(run.start());
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, new RegExp(category));
    const events = await run.events();
    assert.equal(
      events.some(
        (args) =>
          args.includes("up") &&
          ["browser-service", "api"].includes(args.at(-1)),
      ),
      false,
    );
  });
}

test("Browser preflight failure prevents dependency and API startup", async (t) => {
  const run = await fixture(t, { env: { FAKE_BROWSER_FAILURE: "true" } });
  const result = await completion(run.start());
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /atomic_publish_preflight_failed/);
  const up = (await run.events()).filter((args) => args.includes("up"));
  assert.equal(
    up.some((args) =>
      ["playwright-service", "api", "minio-init"].includes(args.at(-1)),
    ),
    false,
  );
});

test("mutable downgrade target fails before writers or containers change", async (t) => {
  const run = await fixture(t, {
    env: {
      LOCAL_FIRECRAWL_BROWSER_DOWNGRADE: "true",
      FIRECRAWL_BROWSER_SERVICE_IMAGE: "registry.example/browser:latest",
    },
  });
  const result = await completion(run.start("restart"));
  assert.equal(result.code, 64);
  assert.match(result.stderr, /requires an immutable/);
  const events = await run.events();
  assert.equal(
    events.some((args) =>
      ["stop", "create", "run", "start", "up"].some((command) =>
        args.includes(command),
      ),
    ),
    false,
  );
  assert.equal(await run.candidateStateValue(), "unchanged");
});

test("downgrade rejection quiesces all writers before offline check", async (t) => {
  const image = `registry.example/browser@sha256:${"a".repeat(64)}`;
  const run = await fixture(t, {
    env: {
      LOCAL_FIRECRAWL_BROWSER_DOWNGRADE: "true",
      FIRECRAWL_BROWSER_SERVICE_IMAGE: image,
      FAKE_ROLLBACK_REJECT: "true",
    },
  });
  const result = await completion(run.start("restart"));
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /rollback_state_unresolved/);
  const events = await run.events();
  const apiStop = events.findIndex(
    (args) => args.includes("stop") && args.includes("api"),
  );
  const browserStop = events.findIndex(
    (args) => args.includes("stop") && args.includes("browser-service"),
  );
  const checker = events.findIndex(
    (args) =>
      args[0] === "run" &&
      args.some((value) =>
        value.endsWith("check-atomic-publication-rollback.mjs"),
      ),
  );
  assert.ok(apiStop >= 0 && apiStop < browserStop && browserStop < checker);
  assert.deepEqual(
    events[checker].filter((value) =>
      [
        "--read-only",
        "--network",
        "none",
        "--user",
        "1000:1000",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--volumes-from",
        "browser-container:ro",
      ].includes(value),
    ),
    [
      "--read-only",
      "--network",
      "none",
      "--user",
      "1000:1000",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--volumes-from",
      "browser-container:ro",
    ],
  );
  assert.equal(events[checker].includes(`sha256:${"c".repeat(64)}`), true);
  assert.equal(events[checker].includes(image), false);
  assert.equal(
    events
      .slice(checker + 1)
      .some((args) =>
        ["create", "run", "start", "up"].some((command) =>
          args.includes(command),
        ),
      ),
    false,
  );
  assert.equal(await run.candidateStateValue(), "unchanged");
});

test("safe immutable downgrade starts target only after offline approval", async (t) => {
  const image = `registry.example/browser@sha256:${"b".repeat(64)}`;
  const run = await fixture(t, {
    env: {
      LOCAL_FIRECRAWL_BROWSER_DOWNGRADE: "true",
      FIRECRAWL_BROWSER_SERVICE_IMAGE: image,
    },
  });
  const result = await completion(run.start("restart"));
  assert.equal(result.code, 0, result.stderr);
  const events = await run.events();
  const apiStop = events.findIndex(
    (args) => args.includes("stop") && args.includes("api"),
  );
  const browserStop = events.findIndex(
    (args) => args.includes("stop") && args.includes("browser-service"),
  );
  const checker = events.findIndex(
    (args) =>
      args[0] === "run" &&
      args.some((value) =>
        value.endsWith("check-atomic-publication-rollback.mjs"),
      ),
  );
  const stateInit = events.findIndex(
    (args) => args.includes("up") && args.at(-1) === "browser-state-init",
  );
  const browserStart = events.findIndex(
    (args) => args.includes("up") && args.at(-1) === "browser-service",
  );
  assert.ok(
    apiStop >= 0 &&
      apiStop < browserStop &&
      browserStop < checker &&
      checker < stateInit &&
      stateInit < browserStart,
  );
  assert.doesNotMatch(result.stderr, /rollback_writer_not_quiesced/);
  assert.equal(await run.candidateStateValue(), "unchanged");
});

test("rendered Compose keeps migration sidecar maintenance-only", async (t) => {
  const render = async (profiles) => {
    const child = spawn(
      "docker",
      [
        "compose",
        "--project-name",
        "firecrawl-task14-test",
        "--project-directory",
        repoRoot,
        "-f",
        join(repoRoot, "compose.yaml"),
        "-f",
        join(repoRoot, "compose.local.yaml"),
        "--env-file",
        join(repoRoot, ".env.example.local"),
        ...profiles.flatMap((profile) => ["--profile", profile]),
        "config",
        "--format",
        "json",
      ],
      {
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    const result = await new Promise((resolvePromise) =>
      child.once("close", (code) => resolvePromise(code)),
    );
    assert.equal(result, 0, stderr);
    return JSON.parse(stdout);
  };
  const config = await render([]);
  assert.equal(config.services.api.depends_on["app-db-migrate"], undefined);
  assert.equal(config.services["app-db-migrate"], undefined);
  assert.equal(
    (config.services.api.volumes ?? []).some(
      (volume) =>
        volume.source === "browser-state" ||
        volume.target.startsWith("/var/lib/firecrawl-browser"),
    ),
    false,
  );
  assert.equal(config.services["browser-service"].ports, undefined);
  assert.equal(config.services["browser-service"].user, "1000:1000");
  assert.equal(
    config.services["browser-service"].environment.LOCAL_BROWSER_STATE_ROOT,
    "/var/lib/firecrawl-browser-volume/state",
  );
  assert.equal(
    config.services["browser-service"].volumes[0].target,
    "/var/lib/firecrawl-browser-volume",
  );
  assert.equal(
    config.services["browser-state-init"].volumes[0].target,
    "/var/lib/firecrawl-browser-volume",
  );
  assert.equal(
    config.services["browser-service"].depends_on["browser-state-init"]
      .condition,
    "service_completed_successfully",
  );
  assert.equal(
    config.services["browser-service"].environment
      .LOCAL_BROWSER_SERVICE_ENABLED,
    "true",
  );
  assert.equal(
    config.services.api.environment.BROWSER_EXECUTION_ADAPTER_SOCKET,
    "/run/firecrawl-adapter/adapter.sock",
  );
  assert.equal(
    config.services.api.environment.BROWSER_ADAPTER_TOKEN_FILE,
    "/run/firecrawl-adapter/adapter.token",
  );
  assert.deepEqual(
    config.services.api.volumes.filter(
      (volume) => volume.target === "/run/firecrawl-adapter",
    ),
    [
      {
        type: "bind",
        source: "/run/user/1000/firecrawl",
        target: "/run/firecrawl-adapter",
        read_only: true,
      },
    ],
  );
  assert.deepEqual(config.services.api.ports, [
    {
      mode: "ingress",
      target: 3002,
      published: "3002",
      protocol: "tcp",
      host_ip: "127.0.0.1",
    },
  ]);
  const maintenance = await render(["maintenance"]);
  assert.deepEqual(maintenance.services["app-db-migrate"].profiles, [
    "maintenance",
  ]);
});

test("acceptance image validation rejects mutable and equal refs", () => {
  for (const value of [
    "",
    "browser:latest",
    "browser@sha256:short",
    "Browser@sha256:" + "a".repeat(64),
  ]) {
    assert.throws(
      () => requireImmutableImage(value, "candidate"),
      /immutable @sha256 image reference/,
    );
  }
  const immutable = `registry.example/firecrawl/browser@sha256:${"a".repeat(64)}`;
  assert.equal(requireImmutableImage(immutable, "candidate"), immutable);
});

test("host builder seals exact canonical active Codex identity", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "host-identity-test-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  const codex = join(bin, "codex");
  const output = join(root, "identity.json");
  await mkdir(bin, { mode: 0o700 });
  await writeFile(codex, "#!/bin/sh\nprintf 'codex-cli 9.8.7\\n'\n", {
    mode: 0o700,
  });

  const result = await completion(
    spawn(hostBuilder, ["--capture-active-identity", "--output", output], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  assert.equal(result.code, 0, result.stderr);
  const metadata = await lstat(output);
  assert.equal(metadata.mode & 0o777, 0o600);
  assert.equal(metadata.nlink, 1);
  assert.equal(metadata.uid, process.getuid());
  const identity = JSON.parse(await readFile(output, "utf8"));
  assert.deepEqual(Object.keys(identity).sort(), [
    "device",
    "executablePath",
    "inode",
    "resolvedPath",
    "version",
  ]);
  assert.equal(identity.executablePath, codex);
  assert.equal(identity.resolvedPath, codex);
  assert.equal(identity.version, "9.8.7");

  const alias = join(root, "alias");
  await symlink(root, alias);
  const rejected = await completion(
    spawn(
      hostBuilder,
      [
        "--capture-active-identity",
        "--output",
        join(alias, "other-identity.json"),
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    ),
  );
  assert.notEqual(rejected.code, 0);
});

test("identity drift performs one build and one direct refresh publication", async (t) => {
  const run = await fixture(t, { env: { FAKE_HOST_DRIFT: "true" } });
  const result = await completion(run.start("restart"));
  assert.equal(result.code, 0, result.stderr);
  const events = await run.events();
  const builds = events.filter(
    (args) => args[0] === "builder" && args[1] === "--staging-only",
  );
  const publications = events.filter(
    (args) => args[0] === "sudo" && args[1] === "-n",
  );
  assert.equal(builds.length, 1);
  assert.equal(publications.length, 1);
  assert.equal(
    events.some((args) => args.includes("install-host")),
    false,
  );
  const apiStop = events.findIndex(
    (args) => args.includes("stop") && args.includes("api"),
  );
  const browserStop = events.findIndex(
    (args) => args.includes("stop") && args.includes("browser-service"),
  );
  const adapterStop = events.findIndex(
    (args) =>
      args[0] === "systemctl" &&
      args.includes("stop") &&
      args.includes("firecrawl-execution-adapter.service"),
  );
  const dependencyStop = events.findIndex(
    (args) => args.includes("stop") && args.includes("playwright-service"),
  );
  const brokerVerify = events.findIndex(
    (args) =>
      args[0] === "systemctl" &&
      args.includes("is-active") &&
      args.includes("firecrawl-sandbox-broker.socket"),
  );
  const adapterStart = events.findIndex(
    (args) =>
      args[0] === "systemctl" &&
      args.includes("start") &&
      args.includes("firecrawl-execution-adapter.service"),
  );
  assert.ok(
    apiStop < browserStop &&
      browserStop < adapterStop &&
      adapterStop < dependencyStop,
  );
  assert.ok(
    dependencyStop < events.indexOf(builds[0]) &&
      events.indexOf(builds[0]) < events.indexOf(publications[0]) &&
      events.indexOf(publications[0]) < brokerVerify &&
      brokerVerify < adapterStart,
  );
});

test("captured identity drift during rebuild exits 78 without restart", async (t) => {
  const run = await fixture(t, {
    env: {
      FAKE_HOST_DRIFT: "true",
      FAKE_ACTIVE_IDENTITY_DRIFT_DURING_BUILD: "true",
    },
  });
  const result = await completion(run.start("restart"));
  assert.equal(result.code, 78, result.stderr);
  const events = await run.events();
  const failedBuild = events.findIndex(
    (args) => args[0] === "builder" && args[1] === "--staging-only",
  );
  assert.ok(failedBuild >= 0);
  assert.equal(
    events
      .slice(failedBuild + 1)
      .some(
        (args) =>
          (args[0] === "systemctl" && args.includes("start")) ||
          args.includes("up"),
      ),
    false,
  );
});

test("converged identity performs no build or root publication", async (t) => {
  const run = await fixture(t);
  const result = await completion(run.start());
  assert.equal(result.code, 0, result.stderr);
  const events = await run.events();
  assert.equal(
    events.some(
      (args) => args[0] === "builder" && args[1] === "--staging-only",
    ),
    false,
  );
  assert.equal(
    events.some((args) => args[0] === "sudo"),
    false,
  );
});

test("refresh elevation failure stops before host services restart", async (t) => {
  const run = await fixture(t, {
    env: {
      FAKE_HOST_DRIFT: "true",
      FAKE_SUDO_FAILURE: "true",
    },
  });
  const result = await completion(run.start("restart"));
  assert.notEqual(result.code, 0);
  const events = await run.events();
  const publication = events.findIndex((args) => args[0] === "sudo");
  assert.ok(publication >= 0);
  assert.equal(
    events
      .slice(publication + 1)
      .some((args) => args[0] === "systemctl" && args.includes("start")),
    false,
  );
  assert.equal(
    events.slice(publication + 1).some((args) => args.includes("up")),
    false,
  );
});

test("one lifecycle lock rejects a concurrent restart", async (t) => {
  const run = await fixture(t, { env: { FAKE_BLOCK_API: "true" } });
  const first = run.start();
  const firstDone = completion(first);
  await waitFor(async () =>
    (await run.events()).some(
      (args) => args.includes("up") && args.at(-1) === "api",
    ),
  );
  const second = await completion(run.start("restart"));
  assert.equal(second.code, 75, second.stderr);
  await writeFile(run.release, "release");
  assert.equal((await firstDone).code, 0);
});

test("lifecycle lock rejects symlink, wrong mode, and hardlink", async (t) => {
  for (const variant of ["symlink", "wrong-mode", "hardlink"]) {
    const run = await fixture(t);
    const control = join(run.xdgRuntime, "firecrawl-control");
    const lock = join(control, "lifecycle.lock");
    const target = join(run.root, `${variant}-target`);
    await mkdir(control, { mode: 0o700 });
    await writeFile(target, "must-not-change\n", { mode: 0o600 });
    if (variant === "symlink") {
      await symlink(target, lock);
    } else if (variant === "wrong-mode") {
      await writeFile(lock, "", { mode: 0o644 });
    } else {
      await link(target, lock);
    }

    const result = await completion(run.start("stop"));
    assert.equal(result.code, 70, `${variant}: ${result.stderr}`);
    assert.equal(await readFile(target, "utf8"), "must-not-change\n");
    assert.deepEqual(await run.events(), []);
  }
});

test("lifecycle lock rejects path replacement after descriptor open", async (t) => {
  const run = await fixture(t);
  const control = join(run.xdgRuntime, "firecrawl-control");
  const lock = join(control, "lifecycle.lock");
  await mkdir(control, { mode: 0o700 });
  await writeFile(lock, "", { mode: 0o600 });
  const original = await stat(lock);
  const holder = spawn(
    "flock",
    ["--exclusive", "--no-fork", lock, "/bin/sleep", "60"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const holderDone = completion(holder);
  await waitFor(async () => {
    const probe = await completion(
      spawn("flock", ["--exclusive", "--nonblock", lock, "/bin/true"], {
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    return probe.code === 1;
  });

  const child = run.start("stop");
  const done = completion(child);
  await waitFor(async () => {
    try {
      const descriptors = await readdir(`/proc/${child.pid}/fd`);
      for (const descriptor of descriptors) {
        const metadata = await stat(`/proc/${child.pid}/fd/${descriptor}`);
        if (metadata.dev === original.dev && metadata.ino === original.ino) {
          return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  });
  await rm(lock);
  await writeFile(lock, "", { mode: 0o600 });
  holder.kill("SIGTERM");
  await holderDone;
  const result = await done;
  assert.equal(result.code, 70, result.stderr);
  assert.deepEqual(await run.events(), []);
});

test("stop disables active adapter even when host manifest is missing", async (t) => {
  const run = await fixture(t);
  await rm(run.manifest);
  const result = await completion(run.start("stop"));
  assert.notEqual(result.code, 0);
  assert.equal(await readFile(run.adapterState, "utf8"), "inactive");
  await assert.rejects(lstat(join(run.runtime, "clean-stop")));
});

test("clean stop requires zero authoritative host status", async (t) => {
  for (const env of [
    { FAKE_STATUS_ORPHANS: "1" },
    { FAKE_STATUS_UNSETTLED: "1" },
    { FAKE_STATUS_EOF: "true" },
  ]) {
    const run = await fixture(t, { env });
    const result = await completion(run.start("stop"));
    assert.notEqual(result.code, 0);
    assert.equal(await readFile(run.adapterState, "utf8"), "inactive");
    await assert.rejects(lstat(join(run.runtime, "clean-stop")));
  }
});

test("failed forced drain still stops adapter and dependencies without proof", async (t) => {
  for (const env of [
    {
      FAKE_GRACEFUL_DRAIN_FAILURE: "true",
      FAKE_FORCE_DRAIN_FAILURE: "true",
    },
    {
      FAKE_API_STOPPED: "true",
      FAKE_FORCE_DRAIN_FAILURE: "true",
    },
  ]) {
    const run = await fixture(t, { env });
    const result = await completion(run.start("stop"));
    assert.notEqual(result.code, 0);
    assert.equal(await readFile(run.adapterState, "utf8"), "inactive");
    await assert.rejects(lstat(join(run.runtime, "clean-stop")));
    assert.equal(
      (await run.events()).some(
        (args) => args.includes("stop") && args.includes("redis"),
      ),
      true,
    );
  }
});

test("already stopped runtime without clean proof remains unproven", async (t) => {
  const run = await fixture(t, { env: { FAKE_API_STOPPED: "true" } });
  await writeFile(run.adapterState, "inactive");
  const result = await completion(run.start("stop"));
  assert.notEqual(result.code, 0);
  await assert.rejects(lstat(join(run.runtime, "clean-stop")));
  assert.equal(
    (await run.events()).some(
      (args) => args.includes("stop") && args.includes("redis"),
    ),
    true,
  );
});

test("status JSON is closed and rejects adapter extras", async (t) => {
  const run = await fixture(t);
  const status = await completion(run.start("status", ["--json"]));
  assert.equal(status.code, 0, status.stderr);
  assert.deepEqual(Object.keys(JSON.parse(status.stdout)).sort(), [
    "activeBrowserSessions",
    "activeCapabilities",
    "activeCodeJobs",
    "activePromptJobs",
    "activeProxyGrants",
    "activeWriterLeases",
    "brokerProtocolSha256",
    "codexArtifactSha256",
    "codexCliVersion",
    "codexDevice",
    "codexExecutablePath",
    "codexInode",
    "codexProtocolSchemaSha256",
    "codexResolvedPath",
    "firecrawlCloudFallbackAttempts",
    "orphanProcesses",
    "preparedHostJobs",
    "runningHostJobs",
    "startingHostJobs",
    "unknownActionOutcomes",
  ]);

  const hostile = await fixture(t, {
    env: { FAKE_STATUS_EXTRA: "true" },
  });
  const rejected = await completion(hostile.start("status", ["--json"]));
  assert.notEqual(rejected.code, 0);
});

test("logs cap output, filter correlation, and redact secrets", async (t) => {
  const run = await fixture(t);
  const result = await completion(
    run.start("logs", ["api", "10000000-0000-4000-8000-000000000001"]),
  );
  assert.equal(result.code, 0, result.stderr);
  const lines = result.stdout.trim().split("\n").filter(Boolean);
  assert.equal(lines.length, 200);
  assert.doesNotMatch(
    result.stdout,
    /super-secret|json-secret|page-secret|prompt-secret|bearer-secret/u,
  );
  assert.match(result.stdout, /"safe":"visible"/u);
  assert.match(result.stdout, /\[REDACTED\]/u);
});

test("diagnostics require an exact pair and return one closed record", async (t) => {
  const run = await fixture(t);
  const result = await completion(
    run.start("diagnose-host-job", [
      "--correlation-id",
      "10000000-0000-4000-8000-000000000001",
      "--job-id",
      "10000000-0000-4000-8000-000000000002",
      "--json",
    ]),
  );
  assert.equal(result.code, 0, result.stderr);
  const diagnostic = JSON.parse(result.stdout);
  assert.equal(diagnostic.phase, "running");
  assert.equal(diagnostic.hostInitPid, 42);
  assert.equal("path" in diagnostic, false);

  const invalid = await completion(
    run.start("diagnose-host-job", [
      "--correlation-id",
      "invalid",
      "--job-id",
      "10000000-0000-4000-8000-000000000002",
      "--json",
    ]),
  );
  assert.equal(invalid.code, 64);
});

test("missing host install and unknown flags fail before mutation", async (t) => {
  const run = await fixture(t, {
    env: {
      LOCAL_FIRECRAWL_HOST_MANIFEST: join(tmpdir(), randomUUID()),
    },
  });
  const missing = await completion(run.start());
  assert.notEqual(missing.code, 0);
  assert.match(missing.stderr, /install-host/u);
  assert.equal(
    (await run.events()).some((args) => args.includes("up")),
    false,
  );

  const invalid = await completion(run.start("status", ["--wat"]));
  assert.equal(invalid.code, 64);
});

test("deep health is closed, API-only, and runs two disposable code turns", async (t) => {
  const run = await fixture(t);
  const result = await completion(run.start("health", ["--json"]));
  assert.equal(result.code, 0, result.stderr);
  const health = JSON.parse(result.stdout);
  assert.equal(health.status, "ok");
  assert.equal(health.firecrawlCloudFallbackAttempts, 0);
  assert.equal("unsettledHostJobs" in health, false);
  const events = await run.events();
  const disposableTurns = events.filter(
    (args) => args[0] === "curl" && args.at(-1).endsWith("/execute"),
  );
  assert.equal(disposableTurns.length, 2);
  const published = events
    .filter((args) => args.includes("ps") && args.includes("json"))
    .flatMap(() => ["api"]);
  assert.deepEqual(published, ["api"]);
  assert.equal(
    events.some((args) => args[0] === "gate"),
    false,
  );
});

test("live health runs one three-run Gate with latest PATH identity", async (t) => {
  const run = await fixture(t);
  const result = await completion(
    run.start("health", ["--live-codex", "--json"]),
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, "ok");
  const gates = (await run.events()).filter((args) => args[0] === "gate");
  assert.equal(gates.length, 1);
  assert.equal(gates[0][gates[0].indexOf("--runs") + 1], "3");
  assert.ok(gates[0].at(-1).startsWith(`${run.root}:`));

  const duplicate = await completion(
    run.start("health", ["--live-codex", "--live-codex"]),
  );
  assert.equal(duplicate.code, 64);
});

test("live health fails closed on Gate or attestation failure", async (t) => {
  for (const env of [
    { FAKE_GATE_FAILURE: "true" },
    { FAKE_GATE_BAD_ATTESTATION: "true" },
  ]) {
    const run = await fixture(t, { env });
    const result = await completion(
      run.start("health", ["--json", "--live-codex"]),
    );
    assert.notEqual(result.code, 0);
  }
});

test("health fails closed on stale service, auth, or extra status fields", async (t) => {
  for (const env of [
    { FAKE_SYSTEMCTL_FAILURE: "firecrawl-sandbox-broker.socket" },
    { FAKE_HEALTH_FAILURE: "true" },
    { FAKE_STATUS_EXTRA: "true" },
    { FAKE_STATUS_ORPHANS: "1" },
  ]) {
    const run = await fixture(t, { env });
    const result = await completion(run.start("health", ["--json"]));
    assert.notEqual(result.code, 0);
  }
});

test("initializer writes exact browser runtime keys and a private base64url secret", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "firecrawl-init-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scripts = join(root, "scripts");
  await mkdir(scripts);
  const copied = join(scripts, "init-local-env.sh");
  await writeFile(
    copied,
    await readFile(join(repoRoot, "scripts/init-local-env.sh")),
    { mode: 0o700 },
  );
  const result = await execute("bash", [copied], {
    cwd: root,
    allowFailure: true,
  });
  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /BROWSER_SERVICE_API_KEY=/u);
  const envPath = join(root, ".env");
  const contents = await readFile(envPath, "utf8");
  const metadata = await stat(envPath);
  assert.equal(metadata.mode & 0o777, 0o600);
  assert.match(contents, /^LOCAL_BROWSER_SERVICE_ENABLED=true$/mu);
  assert.match(contents, /^MAX_BROWSER_SESSIONS=4$/mu);
  assert.match(
    contents,
    new RegExp(
      `^LOCAL_FIRECRAWL_HOST_RUNTIME_DIR=/run/user/${process.getuid()}/firecrawl$`,
      "mu",
    ),
  );
  assert.match(
    contents,
    /^BROWSER_EXECUTION_ADAPTER_SOCKET=\/run\/firecrawl-adapter\/adapter\.sock$/mu,
  );
  assert.match(
    contents,
    /^BROWSER_ADAPTER_TOKEN_FILE=\/run\/firecrawl-adapter\/adapter\.token$/mu,
  );
  assert.match(contents, /^BROWSER_SERVICE_API_KEY=[A-Za-z0-9_-]{43}$/mu);
});

test("env upgrader preserves secrets and rejects hostile inputs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "firecrawl-upgrade-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const upgrader = join(repoRoot, "scripts/upgrade-local-env-browser-runtime");
  const secret = "A".repeat(43);
  const makeEnv = async (name, contents, mode = 0o600) => {
    const path = join(root, name);
    await writeFile(path, contents, { mode });
    return path;
  };
  const valid = await makeEnv(
    "valid.env",
    `BROWSER_SERVICE_API_KEY=${secret}\n`,
  );
  const before = await stat(valid);
  const upgraded = await execute(upgrader, [], {
    env: { ...process.env, LOCAL_FIRECRAWL_ENV_FILE: valid },
    allowFailure: true,
  });
  assert.equal(upgraded.code, 0, upgraded.stderr);
  const after = await stat(valid);
  assert.notEqual(after.ino, before.ino);
  const contents = await readFile(valid, "utf8");
  assert.match(contents, new RegExp(`BROWSER_SERVICE_API_KEY=${secret}`));
  assert.match(contents, /LOCAL_BROWSER_SERVICE_ENABLED=true/u);

  const missingSecret = await makeEnv("missing-secret.env", "PORT=3002\n");
  const generated = await execute(upgrader, [], {
    env: {
      ...process.env,
      LOCAL_FIRECRAWL_ENV_FILE: missingSecret,
    },
    allowFailure: true,
  });
  assert.equal(generated.code, 0, generated.stderr);
  assert.match(
    await readFile(missingSecret, "utf8"),
    /^BROWSER_SERVICE_API_KEY=[A-Za-z0-9_-]{43}$/mu,
  );

  const hostile = [
    await makeEnv(
      "duplicate.env",
      `BROWSER_SERVICE_API_KEY=${secret}\nBROWSER_SERVICE_API_KEY=${secret}\n`,
    ),
    await makeEnv("invalid-secret.env", "BROWSER_SERVICE_API_KEY=short\n"),
    await makeEnv(
      "conflict.env",
      `BROWSER_SERVICE_API_KEY=${secret}\nLOCAL_BROWSER_SERVICE_ENABLED=false\n`,
    ),
    await makeEnv(
      "unsafe-mode.env",
      `BROWSER_SERVICE_API_KEY=${secret}\n`,
      0o644,
    ),
  ];
  const target = await makeEnv(
    "symlink-target.env",
    `BROWSER_SERVICE_API_KEY=${secret}\n`,
  );
  const linked = join(root, "linked.env");
  await symlink(target, linked);
  hostile.push(linked);
  const lockHostile = await makeEnv(
    "lock-hostile.env",
    `BROWSER_SERVICE_API_KEY=${secret}\n`,
  );
  const lockTarget = await makeEnv("lock-target", "must-not-change\n");
  await symlink(lockTarget, `${lockHostile}.browser-runtime-upgrade.lock`);
  hostile.push(lockHostile);
  for (const path of hostile) {
    const rejected = await execute(upgrader, [], {
      env: { ...process.env, LOCAL_FIRECRAWL_ENV_FILE: path },
      allowFailure: true,
    });
    assert.notEqual(rejected.code, 0, path);
  }
  assert.equal(await readFile(lockTarget, "utf8"), "must-not-change\n");
  assert.match(await readFile(upgrader, "utf8"), /stat -c '%u'.*"\$env_file"/u);
});

function execute(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.once("error", rejectPromise);
    child.once("close", (code) => {
      const result = { code, stdout, stderr };
      if (code === 0 || options.allowFailure) {
        resolvePromise(result);
      } else {
        rejectPromise(
          new Error(`${command} ${args.join(" ")} failed (${code}): ${stderr}`),
        );
      }
    });
  });
}

async function imageId(image) {
  const result = await execute("docker", [
    "image",
    "inspect",
    image,
    "--format",
    "{{.Id}}",
  ]);
  return result.stdout.trim();
}

async function containerIdentity(containerId) {
  const result = await execute("docker", [
    "container",
    "inspect",
    containerId,
    "--format",
    "{{json .}}",
  ]);
  const inspected = JSON.parse(result.stdout);
  const configuredImage = inspected.Config.Image;
  const digest =
    /@(?<digest>sha256:[a-f0-9]{64})$/u.exec(configuredImage)?.groups?.digest ??
    null;
  return {
    id: inspected.Id,
    configuredImage,
    digest,
    imageId: inspected.Image,
    running: inspected.State.Running,
    startedAt: inspected.State.StartedAt,
    restartCount: inspected.RestartCount,
  };
}

async function composeBrowserIdentity(project, override, env) {
  const result = await execute(
    "docker",
    composeArguments(project, override, "ps", "--quiet", "browser-service"),
    { env },
  );
  const id = result.stdout.trim();
  assert.notEqual(id, "");
  const identity = await containerIdentity(id);
  assert.equal(typeof identity.digest, "string");
  return identity;
}

async function projectContainerIdentities(project) {
  const listed = await execute("docker", [
    "ps",
    "--all",
    "--quiet",
    "--filter",
    `label=com.docker.compose.project=${project}`,
  ]);
  const ids = listed.stdout.trim().split("\n").filter(Boolean);
  return Promise.all(ids.map((id) => containerIdentity(id)));
}

async function freeLoopbackPort() {
  const { createServer } = await import("node:net");
  return await new Promise((resolvePromise, rejectPromise) => {
    const server = createServer();
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        rejectPromise(new Error("unable to allocate acceptance port"));
        return;
      }
      server.close((error) =>
        error ? rejectPromise(error) : resolvePromise(address.port),
      );
    });
  });
}

function composeArguments(project, override, ...command) {
  return [
    "compose",
    "--project-name",
    project,
    "--project-directory",
    repoRoot,
    "-f",
    join(repoRoot, "compose.yaml"),
    "-f",
    join(repoRoot, "compose.local.yaml"),
    "-f",
    override,
    ...command,
  ];
}

async function waitForHttp(url, options = {}, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(3_000),
      });
      if (response.ok) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw Object.assign(new Error(`timed out waiting for ${url}`), {
    cause: lastError,
  });
}

async function createAndCloseProfile(port, name) {
  const created = await waitForHttp(`http://127.0.0.1:${port}/v2/browser`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ttl: 60,
      activityTtl: 30,
      streamWebView: false,
      profile: { name, saveChanges: true },
    }),
  });
  const body = await created.json();
  assert.equal(body.success, true);
  assert.equal(typeof body.id, "string");
  const closed = await fetch(
    `http://127.0.0.1:${port}/v2/browser/${encodeURIComponent(body.id)}`,
    { method: "DELETE", signal: AbortSignal.timeout(30_000) },
  );
  if (!closed.ok) {
    throw new Error(
      `profile close failed (${closed.status}): ${await closed.text()}`,
    );
  }
}

async function createRetainedBrowserFixture(port, name) {
  const created = await waitForHttp(`http://127.0.0.1:${port}/v2/browser`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ttl: 300,
      activityTtl: 300,
      streamWebView: true,
      profile: { name, saveChanges: true },
    }),
  });
  const body = await created.json();
  assert.equal(body.success, true);
  assert.equal(typeof body.id, "string");
  assert.match(body.cdpUrl, /\/v2\/browser\/proxy\//);
  assert.match(body.liveViewUrl, /\/v2\/browser\/proxy\//);
  assert.match(body.interactiveLiveViewUrl, /\/v2\/browser\/proxy\//);
  return body;
}

async function profileDigest(image, volume) {
  const source = String.raw`
import {createHash} from "node:crypto";
import {readdirSync,readFileSync,statSync} from "node:fs";
import {join,relative} from "node:path";
const root="/var/lib/firecrawl-browser-volume/state/profiles";
const files=[];
const walk=p=>{for(const leaf of readdirSync(p).sort()){const q=join(p,leaf),s=statSync(q);if(s.isDirectory())walk(q);else if(s.isFile())files.push(q);else process.exit(2)}};
walk(root);
const hash=createHash("sha256");
for(const file of files){hash.update(relative(root,file));hash.update("\0");hash.update(readFileSync(file));}
process.stdout.write(JSON.stringify({count:files.length,digest:hash.digest("hex")}));
`;
  const result = await execute("docker", [
    "run",
    "--rm",
    "--read-only",
    "--entrypoint",
    "/usr/local/bin/node",
    "--volume",
    `${volume}:/var/lib/firecrawl-browser-volume:ro`,
    image,
    "--input-type=module",
    "-e",
    source,
  ]);
  return JSON.parse(result.stdout);
}

async function seedRecoverableReservedState(image, volume, binding) {
  const operationId = randomUUID();
  const transitionId = randomUUID();
  const script = String.raw`
import {mkdirSync,statSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {encodeAtomicPublishIntent} from "/app/apps/browser-service/dist/atomic-publication-manifest.js";
const [operationId,transitionId,processNonce,generation,snapshotDigest]=process.argv.slice(1);
const root="/var/lib/firecrawl-browser-volume/state";
const staging=join(root,".profile-publish-staging");
const bundles=join(staging,"bundles");
const intents=join(staging,"intents");
const wrapper=join(bundles,operationId);
mkdirSync(wrapper,{mode:0o700});
const parent=statSync(join(root,"profiles"),{bigint:true});
const wrapperStat=statSync(wrapper,{bigint:true});
const intent={
 version:1,operationId,kind:"canary",phase:"building",
 binding:{processNonce,controlGenerationNonce:generation,snapshotDigest},
 target:{
  kind:"canary_parent",parentLocator:{kind:"profiles"},
  parent:{dev:String(parent.dev),ino:String(parent.ino),mode:0o700}
 },
 wrapper:{dev:String(wrapperStat.dev),ino:String(wrapperStat.ino),mode:0o700},
 privateSource:null,publicSource:null,classification:null,
 sourceDeletion:null,adoption:null,cleanup:null,
 canaryProof:{
  attempt:0,sourceLeaf:"proof-"+operationId+"-0",
  targetLeaf:"canary-"+operationId+"-0",
  deletionLeaf:"deletion-"+operationId+"-0",
  phase:"planned",dev:null,ino:null,mode:null,evidenceDigest:null
 },
 prepublicationAbort:null,identityManifest:null
};
const encoded=encodeAtomicPublishIntent(intent).bytes;
writeFileSync(join(intents,operationId+".building."+transitionId+".tmp"),encoded,{
 flag:"wx",mode:0o600
});
writeFileSync(join(intents,operationId+".json"),encoded,{flag:"wx",mode:0o600});
process.stdout.write(JSON.stringify({
 operationId,stableBytes:encoded.byteLength,tempBytes:encoded.byteLength,
 wrapperEntries:0
}));
`;
  const result = await execute("docker", [
    "run",
    "--rm",
    "--read-only",
    "--user",
    "1000:1000",
    "--entrypoint",
    "/usr/local/bin/node",
    "--volume",
    `${volume}:/var/lib/firecrawl-browser-volume`,
    image,
    "--input-type=module",
    "-e",
    script,
    "--",
    operationId,
    transitionId,
    binding.processNonce,
    binding.generation,
    binding.snapshotDigest,
  ]);
  return JSON.parse(result.stdout);
}

async function reservedStateInventory(image, volume, operationId) {
  const script = String.raw`
import {existsSync,readFileSync} from "node:fs";
const [operationId]=process.argv.slice(1);
const root="/var/lib/firecrawl-browser-volume/state/.profile-publish-staging";
const stable=root+"/intents/"+operationId+".json";
const tempPrefix=root+"/intents/"+operationId+".building.";
const {readdirSync}=await import("node:fs");
const temps=readdirSync(root+"/intents").filter(x=>x.startsWith(tempPrefix.split("/").at(-1)));
process.stdout.write(JSON.stringify({
 stable:existsSync(stable),
 stableBytes:existsSync(stable)?readFileSync(stable).byteLength:0,
 tempCount:temps.length,
 tempBytes:temps.reduce((n,x)=>n+readFileSync(root+"/intents/"+x).byteLength,0),
 wrapper:existsSync(root+"/bundles/"+operationId)
}));
`;
  const result = await execute("docker", [
    "run",
    "--rm",
    "--read-only",
    "--user",
    "1000:1000",
    "--entrypoint",
    "/usr/local/bin/node",
    "--volume",
    `${volume}:/var/lib/firecrawl-browser-volume:ro`,
    image,
    "--input-type=module",
    "-e",
    script,
    "--",
    operationId,
  ]);
  return JSON.parse(result.stdout);
}

async function browserLive(project, override, env) {
  const script = String.raw`
const headers={
 authorization:"Bearer "+process.env.BROWSER_SERVICE_API_KEY,
 "x-firecrawl-correlation-id":"lifecycle-live",
 "x-firecrawl-deadline":new Date(Date.now()+10000).toISOString()
};
const response=await fetch("http://127.0.0.1:3010/health/live",{headers});
if(!response.ok)process.exit(2);
process.stdout.write(JSON.stringify(await response.json()));
`;
  const result = await execute(
    "docker",
    composeArguments(
      project,
      override,
      "exec",
      "-T",
      "browser-service",
      "node",
      "--input-type=module",
      "-e",
      script,
    ),
    { env },
  );
  return JSON.parse(result.stdout);
}

async function latestApiStartupLifecycle(project, override, env) {
  const result = await execute(
    "docker",
    composeArguments(project, override, "logs", "--no-color", "api"),
    { env },
  );
  const marker = '{"version":1,"event":"api_startup_lifecycle"';
  const events = result.stdout.split("\n").flatMap((line) => {
    const start = line.indexOf(marker);
    if (start < 0) return [];
    return [JSON.parse(line.slice(start).trim())];
  });
  const latestStart = events.findLastIndex((event) => event.sequence === 1);
  assert.notEqual(latestStart, -1);
  const latest = events.slice(latestStart);
  assert.deepEqual(
    latest.map((event) => event.sequence),
    latest.map((_, index) => index + 1),
  );
  assert.equal(
    latest.every((event) => event.owner === "api"),
    true,
  );
  return latest;
}

async function controlBinding(project, override, env) {
  const query =
    "SELECT concat_ws('|', process_nonce, control_generation_nonce, database_control_epoch) " +
    "FROM browser_control_generation WHERE singleton_id=1";
  const result = await execute(
    "docker",
    composeArguments(
      project,
      override,
      "exec",
      "-T",
      "app-postgres",
      "sh",
      "-ec",
      `psql -X -qAt -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "${query}"`,
    ),
    { env },
  );
  const [processNonce, generation, epoch] = result.stdout.trim().split("|");
  return { processNonce, generation, epoch: Number(epoch) };
}

async function databaseJson(project, override, env, query) {
  const result = await execute(
    "docker",
    composeArguments(
      project,
      override,
      "exec",
      "-T",
      "app-postgres",
      "sh",
      "-ec",
      `psql -X -qAt -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "${query}"`,
    ),
    { env },
  );
  return JSON.parse(result.stdout.trim());
}

async function databaseExecute(project, override, env, query) {
  await execute(
    "docker",
    composeArguments(
      project,
      override,
      "exec",
      "-T",
      "app-postgres",
      "sh",
      "-ec",
      `psql -X -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "${query}"`,
    ),
    { env },
  );
}

function sqlUuid(value, label) {
  assert.match(
    value,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    label,
  );
  return `'${value}'::uuid`;
}

async function retainedFixtureState(project, override, env, sessionId) {
  const id = sqlUuid(sessionId, "retained session id");
  return databaseJson(
    project,
    override,
    env,
    `SELECT row_to_json(fixture) FROM (
       SELECT session.id, session.request_id, session.owner_id,
              session.context_id, session.browser_id, session.state,
              session.status, session.stream_web_view,
              profile.id AS profile_id,
              profile.writer_session_id,
              count(proxy_grant.id)::int AS grant_count,
              count(proxy_grant.id) FILTER
                (WHERE proxy_grant.revoked_at IS NULL)::int
                AS active_grant_count
         FROM browser_sessions AS session
         JOIN browser_profiles AS profile
           ON profile.id = session.profile_id
         LEFT JOIN browser_proxy_grants AS proxy_grant
           ON proxy_grant.session_id = session.id
        WHERE session.id = ${id}
        GROUP BY session.id, profile.id
     ) AS fixture`,
  );
}

async function persistReplayCheckpoint(
  port,
  replayIngestKey,
  retained,
  scrapeId,
) {
  const body = {
    version: 1,
    requestId: retained.request_id,
    scrapeId,
    ownerId: retained.owner_id,
    url: "https://acceptance.invalid/replay",
    options: {},
    callerOrigin: "api",
    replayCheckpoint: {
      version: 1,
      storageState: {
        cookies: [],
        origins: [
          {
            origin: "https://acceptance.invalid",
            localStorage: [{ name: "acceptance", value: "retained" }],
          },
        ],
      },
      finalUrl: "https://acceptance.invalid/replay",
      fingerprint: {
        finalUrl: "https://acceptance.invalid/replay",
        titleSha256: "a".repeat(64),
        bodyTextSha256: "b".repeat(64),
      },
      browserSettings: {
        headers: {},
        cookies: [],
        viewport: {
          width: 1280,
          height: 800,
          deviceScaleFactor: 1,
          isMobile: false,
          hasTouch: false,
        },
        userAgent: "Firecrawl acceptance",
        locale: "en-US",
        location: { country: "us-generic", languages: ["en-US"] },
        proxy: { kind: "auto" },
        skipTlsVerification: false,
        blockAds: false,
        lockdown: true,
      },
    },
  };
  const encoded = JSON.stringify(body);
  const response = await fetch(
    `http://127.0.0.1:${port}/internal/v1/browser/replay-checkpoints`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${replayIngestKey}`,
        "content-type": "application/json",
        "x-firecrawl-idempotency-key": createHash("sha256")
          .update(encoded)
          .digest("hex"),
        "x-firecrawl-correlation-id": retained.request_id,
        "x-firecrawl-deadline-ms": String(Date.now() + 60_000),
      },
      body: encoded,
      signal: AbortSignal.timeout(60_000),
    },
  );
  if (!response.ok) {
    throw new Error(
      `replay checkpoint persistence failed (${response.status}): ${await response.text()}`,
    );
  }
  assert.deepEqual(await response.json(), { persisted: true });
}

async function replayCheckpointState(project, override, env, scrapeId) {
  const id = sqlUuid(scrapeId, "replay scrape id");
  return databaseJson(
    project,
    override,
    env,
    `SELECT row_to_json(checkpoint) FROM (
       SELECT id, scrape_id, request_id, owner_id, state_path, checksum,
              byte_size, file_deleted_at
         FROM browser_replay_checkpoints
        WHERE scrape_id = ${id}
     ) AS checkpoint`,
  );
}

async function waitForBinding(project, override, env, predicate) {
  const deadline = Date.now() + 120_000;
  let binding;
  while (Date.now() < deadline) {
    binding = await controlBinding(project, override, env);
    if (predicate(binding)) return binding;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error(
    `control binding did not advance: ${JSON.stringify(binding)}`,
  );
}

async function staleBindingStatus(project, override, env, binding) {
  const script = String.raw`
const [processNonce,generation]=process.argv.slice(1);
const headers={
 authorization:"Bearer "+process.env.BROWSER_SERVICE_API_KEY,
 "x-firecrawl-correlation-id":"lifecycle-stale",
 "x-firecrawl-deadline":new Date(Date.now()+10000).toISOString(),
 "x-firecrawl-process-nonce":processNonce,
 "x-firecrawl-control-generation-nonce":generation
};
const response=await fetch("http://127.0.0.1:3010/health/ready",{headers});
process.stdout.write(JSON.stringify({status:response.status,body:await response.text()}));
`;
  const result = await execute(
    "docker",
    composeArguments(
      project,
      override,
      "exec",
      "-T",
      "browser-service",
      "node",
      "--input-type=module",
      "-e",
      script,
      "--",
      binding.processNonce,
      binding.generation,
    ),
    { env },
  );
  return JSON.parse(result.stdout);
}

async function readyBinding(project, override, env, binding) {
  const deadline = Date.now() + 120_000;
  let lastResult;
  while (Date.now() < deadline) {
    const result = await staleBindingStatus(project, override, env, binding);
    lastResult = result;
    if (result.status === 200) {
      return JSON.parse(result.body);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error(
    `Browser Service did not become ready for control binding: ${JSON.stringify(lastResult)}`,
  );
}

async function directBrowserCanary(project, override, env, binding) {
  const script = String.raw`
import {randomUUID} from "node:crypto";
const [processNonce,generation]=process.argv.slice(1);
const headers={
 authorization:"Bearer "+process.env.BROWSER_SERVICE_API_KEY,
 "content-type":"application/json",
 "x-firecrawl-correlation-id":randomUUID(),
 "x-firecrawl-deadline":new Date(Date.now()+60000).toISOString(),
 "x-firecrawl-process-nonce":processNonce,
 "x-firecrawl-control-generation-nonce":generation
};
const sessionId=randomUUID();
const input={
 version:1,sessionId,initialUrl:"about:blank",allowedDomains:[],
 ttlSeconds:60,activityTtlSeconds:30,
 profile:{profileId:randomUUID(),mode:"writer",generationId:null,statePath:null,checksum:null},
 replay:null,
 settings:{
  headers:{},cookies:[],
  viewport:{width:1280,height:800,deviceScaleFactor:1,isMobile:false,hasTouch:false},
  userAgent:"Firecrawl",locale:"en-US",
  location:{country:"us-generic",languages:["en-US"]},
  proxy:{kind:"auto"},skipTlsVerification:false,blockAds:false,lockdown:true
 }
};
const response=await fetch("http://browser-service:3010/v1/sessions",{
 method:"POST",headers,body:JSON.stringify(input)
});
const text=await response.text();
if(response.status!==201){
 process.stderr.write(JSON.stringify({status:response.status,body:text}));
 process.exit(2);
}

const created=JSON.parse(text);
headers["x-firecrawl-correlation-id"]=randomUUID();
const closed=await fetch(
 "http://browser-service:3010/v1/sessions/"+encodeURIComponent(created.runtimeSessionId),
 {method:"DELETE",headers,body:JSON.stringify({
  version:1,reason:"error",expectedSessionVersion:created.sessionVersion
 })}
);
if(!closed.ok){
 process.stderr.write(JSON.stringify({status:closed.status,body:await closed.text()}));
 process.exit(3);
}
process.stdout.write(JSON.stringify({created:true,closed:true}));
`;
  const result = await execute(
    "docker",
    composeArguments(
      project,
      override,
      "exec",
      "-T",
      "api",
      "node",
      "--input-type=module",
      "-e",
      script,
      "--",
      binding.processNonce,
      binding.generation,
    ),
    { env },
  );
  return JSON.parse(result.stdout);
}

async function staleMutationCanary(
  project,
  override,
  env,
  staleBinding,
  freshBinding,
) {
  const script = String.raw`
import {randomUUID} from "node:crypto";
const [staleProcess,staleGeneration,freshProcess,freshGeneration]=process.argv.slice(1);
const sessionId=randomUUID();
const input={
 version:1,sessionId,initialUrl:"about:blank",allowedDomains:[],
 ttlSeconds:60,activityTtlSeconds:30,
 profile:{profileId:randomUUID(),mode:"writer",generationId:null,statePath:null,checksum:null},
 replay:null,
 settings:{
  headers:{},cookies:[],
  viewport:{width:1280,height:800,deviceScaleFactor:1,isMobile:false,hasTouch:false},
  userAgent:"Firecrawl",locale:"en-US",
  location:{country:"us-generic",languages:["en-US"]},
  proxy:{kind:"auto"},skipTlsVerification:false,blockAds:false,lockdown:true
 }
};
const headers=(processNonce,generation)=>({
 authorization:"Bearer "+process.env.BROWSER_SERVICE_API_KEY,
 "content-type":"application/json",
 "x-firecrawl-correlation-id":randomUUID(),
 "x-firecrawl-deadline":new Date(Date.now()+60000).toISOString(),
 "x-firecrawl-process-nonce":processNonce,
 "x-firecrawl-control-generation-nonce":generation
});
const stale=await fetch("http://browser-service:3010/v1/sessions",{
 method:"POST",headers:headers(staleProcess,staleGeneration),
 body:JSON.stringify(input)
});
const staleBody=await stale.text();
if(stale.status!==409||!staleBody.includes("control_generation_mismatch")){
 process.stderr.write(JSON.stringify({phase:"stale",status:stale.status,body:staleBody}));
 process.exit(2);
}
const freshHeaders=headers(freshProcess,freshGeneration);
const fresh=await fetch("http://browser-service:3010/v1/sessions",{
 method:"POST",headers:freshHeaders,body:JSON.stringify(input)
});
const freshBody=await fresh.text();
if(fresh.status!==201){
 process.stderr.write(JSON.stringify({phase:"fresh",status:fresh.status,body:freshBody}));
 process.exit(3);
}
const created=JSON.parse(freshBody);
freshHeaders["x-firecrawl-correlation-id"]=randomUUID();
const closed=await fetch(
 "http://browser-service:3010/v1/sessions/"+encodeURIComponent(created.runtimeSessionId),
 {method:"DELETE",headers:freshHeaders,body:JSON.stringify({
  version:1,reason:"error",expectedSessionVersion:created.sessionVersion
 })}
);
if(!closed.ok){
 process.stderr.write(JSON.stringify({phase:"close",status:closed.status,body:await closed.text()}));
 process.exit(4);
}
process.stdout.write(JSON.stringify({
 staleStatus:stale.status,freshCreated:true,closed:true,sessionId
}));
`;
  const result = await execute(
    "docker",
    composeArguments(
      project,
      override,
      "exec",
      "-T",
      "api",
      "node",
      "--input-type=module",
      "-e",
      script,
      "--",
      staleBinding.processNonce,
      staleBinding.generation,
      freshBinding.processNonce,
      freshBinding.generation,
    ),
    { env },
  );
  return JSON.parse(result.stdout);
}

async function assertNoProjectResources(project) {
  for (const [kind, args] of [
    [
      "containers",
      ["ps", "-aq", "--filter", `label=com.docker.compose.project=${project}`],
    ],
    [
      "networks",
      [
        "network",
        "ls",
        "-q",
        "--filter",
        `label=com.docker.compose.project=${project}`,
      ],
    ],
    [
      "volumes",
      [
        "volume",
        "ls",
        "-q",
        "--filter",
        `label=com.docker.compose.project=${project}`,
      ],
    ],
  ]) {
    const result = await execute("docker", args);
    assert.equal(result.stdout.trim(), "", `${kind} remain for ${project}`);
  }
}

if (fullLifecycle) {
  test(
    "full immutable local Firecrawl lifecycle",
    { timeout: 20 * 60_000 },
    async (t) => {
      const { candidate, rollback } = lifecycleImages;
      const root = await mkdtemp(join(tmpdir(), "firecrawl-lifecycle-"));
      const suffix = (Date.now().toString(36) + process.pid.toString(36)).slice(
        -16,
      );
      const primary = `fc-accept-${suffix}`;
      const rejection = `fc-reject-${suffix}`;
      const primaryPort = await freeLoopbackPort();
      const rejectionPort = await freeLoopbackPort();
      const browserServiceKey = randomBytes(32).toString("base64url");
      const replayIngestKey = randomBytes(32).toString("base64url");
      const override = join(root, "acceptance.compose.yaml");
      await writeFile(
        override,
        `services:
  api:
    environment:
      LOCAL_BROWSER_SERVICE_ENABLED: "true"
      BROWSER_PUBLIC_API_ORIGIN: "http://127.0.0.1:\${PORT}"
  browser-service:
    image: "\${FIRECRAWL_BROWSER_SERVICE_IMAGE}"
    environment:
      LOCAL_BROWSER_SERVICE_ENABLED: "true"
`,
        { mode: 0o600 },
      );
      const environment = (project, port, image, extra = {}) => ({
        ...process.env,
        LOCAL_FIRECRAWL_PROJECT_NAME: project,
        LOCAL_FIRECRAWL_COMPOSE_OVERRIDE: override,
        FIRECRAWL_BROWSER_SERVICE_IMAGE: image,
        PORT: String(port),
        INTERNAL_PORT: "3002",
        BROWSER_PUBLIC_API_ORIGIN: `http://127.0.0.1:${port}`,
        LOCAL_BROWSER_STATE_ROOT: "/var/lib/firecrawl-browser-volume/state",
        BROWSER_SERVICE_API_KEY: browserServiceKey,
        BROWSER_REPLAY_INGEST_API_KEY: replayIngestKey,
        ...extra,
      });
      const projects = [primary, rejection];
      t.after(async () => {
        const failures = [];
        for (const project of projects.reverse()) {
          const port = project === primary ? primaryPort : rejectionPort;
          const result = await execute(
            "docker",
            composeArguments(
              project,
              override,
              "down",
              "--volumes",
              "--remove-orphans",
            ),
            {
              env: environment(project, port, candidate),
              allowFailure: true,
            },
          );
          if (result.code !== 0) failures.push(result.stderr);
        }
        await rm(root, { recursive: true, force: true });
        for (const project of [primary, rejection]) {
          await assertNoProjectResources(project);
        }
        assert.deepEqual(failures, []);
      });

      const rendered = JSON.parse(
        (
          await execute(
            "docker",
            composeArguments(primary, override, "config", "--format", "json"),
            { env: environment(primary, primaryPort, candidate) },
          )
        ).stdout,
      );
      assert.equal(
        (rendered.services.api.volumes ?? []).some(
          (volume) =>
            volume.source === "browser-state" ||
            volume.target.startsWith("/var/lib/firecrawl-browser"),
        ),
        false,
      );
      for (const service of ["browser-state-init", "browser-service"]) {
        assert.equal(
          rendered.services[service].volumes[0].target,
          "/var/lib/firecrawl-browser-volume",
        );
      }
      assert.equal(
        rendered.services["browser-service"].environment
          .LOCAL_BROWSER_STATE_ROOT,
        "/var/lib/firecrawl-browser-volume/state",
      );

      await execute(wrapper, ["start"], {
        env: environment(primary, primaryPort, candidate),
      });
      await waitForHttp(`http://127.0.0.1:${primaryPort}/`);
      const candidateEnvironment = environment(primary, primaryPort, candidate);
      const liveBeforeApiRestart = await browserLive(
        primary,
        override,
        candidateEnvironment,
      );
      const bindingBeforeApiRestart = await controlBinding(
        primary,
        override,
        candidateEnvironment,
      );
      const readyBeforeApiRestart = await readyBinding(
        primary,
        override,
        candidateEnvironment,
        bindingBeforeApiRestart,
      );
      const initialApiLifecycle = await latestApiStartupLifecycle(
        primary,
        override,
        candidateEnvironment,
      );
      assert.deepEqual(
        initialApiLifecycle.map(({ stage, status }) => ({ stage, status })),
        [
          { stage: "browser_control", status: "completed" },
          { stage: "migrations", status: "completed" },
          { stage: "operational_retention", status: "completed" },
          { stage: "browser_reconciliation", status: "started" },
          { stage: "browser_reconciliation", status: "completed" },
          { stage: "browser_retention", status: "started" },
          { stage: "server_listen", status: "completed" },
        ],
      );
      assert.equal(
        initialApiLifecycle.filter(
          ({ stage, status }) =>
            stage === "operational_retention" && status === "completed",
        ).length,
        1,
      );
      assert.equal(
        initialApiLifecycle.filter(
          ({ stage, status }) =>
            stage === "browser_retention" && status === "started",
        ).length,
        1,
      );
      assert.equal(
        initialApiLifecycle.some(
          ({ stage }) =>
            stage === "parent_migrations" ||
            stage === "parent_recovery" ||
            stage === "parent_retention",
        ),
        false,
      );
      assert.deepEqual(
        await directBrowserCanary(
          primary,
          override,
          candidateEnvironment,
          bindingBeforeApiRestart,
        ),
        { created: true, closed: true },
      );
      await createAndCloseProfile(primaryPort, `acceptance-${suffix}`);
      const retainedBrowser = await createRetainedBrowserFixture(
        primaryPort,
        `retained-${suffix}`,
      );
      const retainedBeforeRestart = await retainedFixtureState(
        primary,
        override,
        candidateEnvironment,
        retainedBrowser.id,
      );
      assert.equal(retainedBeforeRestart.state, "ready");
      assert.equal(retainedBeforeRestart.status, "active");
      assert.equal(retainedBeforeRestart.stream_web_view, true);
      assert.equal(retainedBeforeRestart.writer_session_id, retainedBrowser.id);
      assert.equal(typeof retainedBeforeRestart.context_id, "string");
      assert.equal(retainedBeforeRestart.context_id.length > 0, true);
      assert.equal(retainedBeforeRestart.grant_count >= 3, true);
      assert.equal(
        retainedBeforeRestart.active_grant_count,
        retainedBeforeRestart.grant_count,
      );
      const replayScrapeId = randomUUID();
      await databaseExecute(
        primary,
        override,
        candidateEnvironment,
        `INSERT INTO scrapes
           (id, request_id, url, is_successful, time_taken, team_id,
            options, credits_cost)
         VALUES
           (${sqlUuid(replayScrapeId, "replay scrape id")},
            ${sqlUuid(retainedBeforeRestart.request_id, "retained request id")},
            'https://acceptance.invalid/replay', true, 0,
            ${sqlUuid(retainedBeforeRestart.owner_id, "retained owner id")},
            '{}'::jsonb, 0)`,
      );
      await persistReplayCheckpoint(
        primaryPort,
        replayIngestKey,
        retainedBeforeRestart,
        replayScrapeId,
      );
      const checkpointBeforeRestart = await replayCheckpointState(
        primary,
        override,
        candidateEnvironment,
        replayScrapeId,
      );
      assert.equal(typeof checkpointBeforeRestart.state_path, "string");
      assert.match(checkpointBeforeRestart.checksum, /^[a-f0-9]{64}$/);
      assert.equal(checkpointBeforeRestart.file_deleted_at, null);
      const primaryVolume = `${primary}_browser-state`;
      let expected = await profileDigest(candidate, primaryVolume);
      assert.ok(expected.count > 0);

      await execute(
        "docker",
        composeArguments(primary, override, "restart", "api"),
        { env: candidateEnvironment },
      );
      await waitForHttp(`http://127.0.0.1:${primaryPort}/`);
      const bindingAfterApiRestart = await waitForBinding(
        primary,
        override,
        candidateEnvironment,
        (binding) => binding.generation !== bindingBeforeApiRestart.generation,
      );
      const liveAfterApiRestart = await browserLive(
        primary,
        override,
        candidateEnvironment,
      );
      const readyAfterApiRestart = await readyBinding(
        primary,
        override,
        candidateEnvironment,
        bindingAfterApiRestart,
      );
      assert.equal(
        liveAfterApiRestart.processNonce,
        liveBeforeApiRestart.processNonce,
      );
      assert.equal(
        bindingAfterApiRestart.processNonce,
        bindingBeforeApiRestart.processNonce,
      );
      assert.notEqual(
        readyAfterApiRestart.snapshotDigest,
        readyBeforeApiRestart.snapshotDigest,
      );
      assert.equal(
        bindingAfterApiRestart.epoch,
        bindingBeforeApiRestart.epoch + 1,
      );
      const retainedAfterApiRestart = await retainedFixtureState(
        primary,
        override,
        candidateEnvironment,
        retainedBrowser.id,
      );
      assert.equal(retainedAfterApiRestart.state, "interrupted");
      assert.equal(retainedAfterApiRestart.status, "error");
      assert.equal(retainedAfterApiRestart.stream_web_view, true);
      assert.equal(retainedAfterApiRestart.writer_session_id, null);
      assert.equal(
        retainedAfterApiRestart.grant_count,
        retainedBeforeRestart.grant_count,
      );
      assert.equal(retainedAfterApiRestart.active_grant_count, 0);
      assert.deepEqual(
        await replayCheckpointState(
          primary,
          override,
          candidateEnvironment,
          replayScrapeId,
        ),
        checkpointBeforeRestart,
      );
      const fencedMutation = await staleMutationCanary(
        primary,
        override,
        candidateEnvironment,
        bindingBeforeApiRestart,
        bindingAfterApiRestart,
      );
      assert.equal(fencedMutation.staleStatus, 409);
      assert.equal(fencedMutation.freshCreated, true);
      assert.equal(fencedMutation.closed, true);
      sqlUuid(fencedMutation.sessionId, "fenced mutation session id");

      const bytesBeforeBrowserRestart = await profileDigest(
        candidate,
        primaryVolume,
      );
      await execute(
        "docker",
        composeArguments(primary, override, "stop", "browser-service"),
        { env: environment(primary, primaryPort, candidate) },
      );
      const reservedFixture = await seedRecoverableReservedState(
        candidate,
        primaryVolume,
        {
          ...bindingAfterApiRestart,
          snapshotDigest: readyAfterApiRestart.snapshotDigest,
        },
      );
      assert.equal(reservedFixture.stableBytes > 0, true);
      assert.equal(reservedFixture.tempBytes, reservedFixture.stableBytes);
      assert.deepEqual(
        await reservedStateInventory(
          candidate,
          primaryVolume,
          reservedFixture.operationId,
        ),
        {
          stable: true,
          stableBytes: reservedFixture.stableBytes,
          tempCount: 1,
          tempBytes: reservedFixture.tempBytes,
          wrapper: true,
        },
      );
      await execute(
        "docker",
        composeArguments(
          primary,
          override,
          "up",
          "--detach",
          "--no-deps",
          "browser-service",
        ),
        { env: environment(primary, primaryPort, candidate) },
      );
      const bindingAfterBrowserRestart = await waitForBinding(
        primary,
        override,
        candidateEnvironment,
        (binding) =>
          binding.processNonce !== bindingAfterApiRestart.processNonce,
      );
      assert.notEqual(
        bindingAfterBrowserRestart.generation,
        bindingAfterApiRestart.generation,
      );
      assert.equal(
        bindingAfterBrowserRestart.epoch,
        bindingAfterApiRestart.epoch + 1,
      );
      await readyBinding(
        primary,
        override,
        candidateEnvironment,
        bindingAfterBrowserRestart,
      );
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 3_000));
      assert.deepEqual(
        await controlBinding(primary, override, candidateEnvironment),
        bindingAfterBrowserRestart,
      );
      assert.deepEqual(
        await profileDigest(candidate, primaryVolume),
        bytesBeforeBrowserRestart,
      );
      assert.deepEqual(
        await reservedStateInventory(
          candidate,
          primaryVolume,
          reservedFixture.operationId,
        ),
        {
          stable: false,
          stableBytes: 0,
          tempCount: 0,
          tempBytes: 0,
          wrapper: false,
        },
      );
      await createAndCloseProfile(primaryPort, `restart-${suffix}`);
      const afterBrowserRestart = await profileDigest(candidate, primaryVolume);
      assert.equal(afterBrowserRestart.count >= expected.count, true);

      await execute(wrapper, ["stop"], {
        env: environment(primary, primaryPort, candidate),
      });
      await execute(wrapper, ["start"], {
        env: environment(primary, primaryPort, candidate),
      });
      await waitForHttp(`http://127.0.0.1:${primaryPort}/`);
      const afterFullRestart = await profileDigest(candidate, primaryVolume);
      assert.deepEqual(afterFullRestart, afterBrowserRestart);
      expected = afterFullRestart;
      const bindingAfterFullRestart = await controlBinding(
        primary,
        override,
        candidateEnvironment,
      );
      await readyBinding(
        primary,
        override,
        candidateEnvironment,
        bindingAfterFullRestart,
      );
      assert.deepEqual(
        await directBrowserCanary(
          primary,
          override,
          candidateEnvironment,
          bindingAfterFullRestart,
        ),
        { created: true, closed: true },
      );
      expected = await profileDigest(candidate, primaryVolume);

      await execute(
        "docker",
        composeArguments(rejection, override, "create", "browser-state-init"),
        { env: environment(rejection, rejectionPort, candidate) },
      );
      await execute(
        "docker",
        composeArguments(
          rejection,
          override,
          "rm",
          "--force",
          "browser-state-init",
        ),
        { env: environment(rejection, rejectionPort, candidate) },
      );
      const rejectionVolume = `${rejection}_browser-state`;
      await execute(wrapper, ["stop"], {
        env: environment(primary, primaryPort, candidate),
      });
      await execute("docker", [
        "run",
        "--rm",
        "--user",
        "0:0",
        "--entrypoint",
        "/bin/sh",
        "--volume",
        `${primaryVolume}:/source:ro`,
        "--volume",
        `${rejectionVolume}:/destination`,
        "firecrawl-local-browser-volume-init:local",
        "-ec",
        'test -z "$(ls -A /destination)" && cd /source && tar cf - . | tar xpf - -C /destination',
      ]);
      await execute(wrapper, ["start"], {
        env: environment(primary, primaryPort, candidate),
      });
      await waitForHttp(`http://127.0.0.1:${primaryPort}/`);
      await execute(wrapper, ["start"], {
        env: environment(rejection, rejectionPort, candidate),
      });
      await waitForHttp(`http://127.0.0.1:${rejectionPort}/`);
      const rejectionEnvironment = environment(
        rejection,
        rejectionPort,
        candidate,
      );
      const rejectionBinding = await controlBinding(
        rejection,
        override,
        rejectionEnvironment,
      );
      const rejectionReady = await readyBinding(
        rejection,
        override,
        rejectionEnvironment,
        rejectionBinding,
      );
      const rejectionFixture = await seedRecoverableReservedState(
        candidate,
        rejectionVolume,
        {
          ...rejectionBinding,
          snapshotDigest: rejectionReady.snapshotDigest,
        },
      );
      const rejectionInventory = {
        stable: true,
        stableBytes: rejectionFixture.stableBytes,
        tempCount: 1,
        tempBytes: rejectionFixture.tempBytes,
        wrapper: true,
      };
      assert.equal(rejectionFixture.stableBytes > 0, true);
      assert.equal(rejectionFixture.tempBytes, rejectionFixture.stableBytes);
      assert.deepEqual(
        await reservedStateInventory(
          candidate,
          rejectionVolume,
          rejectionFixture.operationId,
        ),
        rejectionInventory,
      );
      const candidateImageId = await imageId(candidate);
      const rollbackImageId = await imageId(rollback);
      assert.notEqual(candidateImageId, rollbackImageId);
      const candidateBeforeRejection = await composeBrowserIdentity(
        rejection,
        override,
        rejectionEnvironment,
      );
      assert.equal(candidateBeforeRejection.configuredImage, candidate);
      assert.equal(candidateBeforeRejection.imageId, candidateImageId);
      assert.equal(candidateBeforeRejection.running, true);
      const projectBeforeRejection = (
        await projectContainerIdentities(rejection)
      ).sort((left, right) => left.id.localeCompare(right.id));
      assert.equal(
        projectBeforeRejection.some(
          (container) =>
            container.configuredImage === rollback ||
            container.imageId === rollbackImageId,
        ),
        false,
      );
      const rejected = await execute(wrapper, ["restart"], {
        env: environment(rejection, rejectionPort, rollback, {
          LOCAL_FIRECRAWL_BROWSER_DOWNGRADE: "true",
        }),
        allowFailure: true,
      });
      assert.notEqual(rejected.code, 0);
      assert.match(
        rejected.stderr,
        /rollback_state_unresolved|rollback_layout_invalid/,
      );
      const candidateAfterRejection = await containerIdentity(
        candidateBeforeRejection.id,
      );
      assert.deepEqual(candidateAfterRejection, {
        ...candidateBeforeRejection,
        running: false,
      });
      for (const service of ["api", "browser-service"]) {
        const runningWriter = await execute(
          "docker",
          composeArguments(
            rejection,
            override,
            "ps",
            "--status",
            "running",
            "--quiet",
            service,
          ),
          { env: rejectionEnvironment },
        );
        assert.equal(runningWriter.stdout.trim(), "");
      }
      const projectAfterRejection = (
        await projectContainerIdentities(rejection)
      ).sort((left, right) => left.id.localeCompare(right.id));
      assert.deepEqual(
        projectAfterRejection.map(
          ({ running: _running, ...identity }) => identity,
        ),
        projectBeforeRejection.map(
          ({ running: _running, ...identity }) => identity,
        ),
      );
      assert.equal(
        projectAfterRejection.some(
          (container) =>
            container.configuredImage === rollback ||
            container.imageId === rollbackImageId,
        ),
        false,
      );
      assert.deepEqual(
        await reservedStateInventory(
          candidate,
          rejectionVolume,
          rejectionFixture.operationId,
        ),
        rejectionInventory,
      );

      await execute(
        "docker",
        composeArguments(
          rejection,
          override,
          "down",
          "--volumes",
          "--remove-orphans",
        ),
        { env: environment(rejection, rejectionPort, candidate) },
      );
      await execute(wrapper, ["restart"], {
        env: environment(primary, primaryPort, rollback, {
          LOCAL_FIRECRAWL_BROWSER_DOWNGRADE: "true",
        }),
      });
      await waitForHttp(`http://127.0.0.1:${primaryPort}/`);
      assert.deepEqual(await profileDigest(rollback, primaryVolume), expected);
      await createAndCloseProfile(primaryPort, `rollback-${suffix}`);
    },
  );
}
