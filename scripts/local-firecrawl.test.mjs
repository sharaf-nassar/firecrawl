import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
const wrapper = join(repoRoot, "scripts", "local-firecrawl");
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
  const docker = join(root, "docker");
  await writeFile(writerState, "api-and-browser-running");
  await writeFile(candidateState, "unchanged");
  await writeFile(
    docker,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_DOCKER_TRACE, JSON.stringify(args) + "\\n");
const has = value => args.includes(value);
if (has("config")) process.exit(0);
if (has("stop")) {
  const stopsApi = has("api");
  const stopsBrowser = has("browser-service");
  if (stopsApi && stopsBrowser) {
    fs.writeFileSync(process.env.FAKE_WRITER_STATE, "stopped");
  } else if (stopsBrowser) {
    fs.writeFileSync(process.env.FAKE_WRITER_STATE, "api-running");
  } else if (stopsApi) {
    fs.writeFileSync(process.env.FAKE_WRITER_STATE, "browser-running");
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
if (args[0] === "inspect" && args.at(-1) === "browser-container") {
  process.stdout.write("sha256:" + "c".repeat(64) + "\\n");
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
    LOCAL_FIRECRAWL_LOCK_WAIT_SECONDS: "2",
    LOCAL_FIRECRAWL_ONE_SHOT_TIMEOUT_SECONDS: "5",
    ...options.env,
  };
  const start = (command = "start") =>
    spawn(wrapper, [command], {
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
  return { start, events, release, candidateStateValue };
}

function completion(child) {
  return new Promise((resolvePromise) => {
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.once("close", (code) => resolvePromise({ code, stderr }));
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
  const writerStop = events.findIndex(
    (args) =>
      args.includes("stop") &&
      args.includes("api") &&
      args.includes("browser-service"),
  );
  const stateInit = events.findIndex(
    (args) => args.includes("up") && args.at(-1) === "browser-state-init",
  );
  assert.ok(writerStop >= 0 && writerStop < stateInit);
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
    (args) => args.includes("exec") && args.includes("api"),
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
  const stop = events.findIndex(
    (args) =>
      args.includes("stop") &&
      args.includes("api") &&
      args.includes("browser-service"),
  );
  const checker = events.findIndex(
    (args) =>
      args[0] === "run" &&
      args.some((value) =>
        value.endsWith("check-atomic-publication-rollback.mjs"),
      ),
  );
  assert.ok(stop >= 0 && stop < checker);
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
  const stop = events.findIndex(
    (args) =>
      args.includes("stop") &&
      args.includes("api") &&
      args.includes("browser-service"),
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
    stop >= 0 &&
      stop < checker &&
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
    "false",
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
