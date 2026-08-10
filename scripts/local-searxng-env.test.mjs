import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  appendFile,
  chmod,
  copyFile,
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
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const initEnv = join(repoRoot, "scripts", "init-local-env.sh");
const searchKeyHelper = join(repoRoot, "scripts", "local-search-key.lib.sh");
const upgradeEnv = join(repoRoot, "scripts", "upgrade-local-env-phase1");
const fixtureBraveApiKey = "fixture-brave-api-key";

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
    SEARXNG_BRAVE_API_KEY_B64: Buffer.from(fixtureBraveApiKey).toString("base64"),
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

async function temporaryEnvironment(t, source = phaseEnvironment()) {
  const root = await mkdtemp(join(tmpdir(), "local-searxng-env-test-"));
  const envFile = join(root, ".env");
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(envFile, source, { mode: 0o600 });
  return { root, envFile };
}

async function waitForFile(path) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      await stat(path);
      return;
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
    await delay(10);
  }
  throw new Error(`Timed out waiting for ${path}`);
}

function assertSecretIsDistinct(values) {
  const otherSecretKeys = [
    "POSTGRES_PASSWORD",
    "APP_POSTGRES_PASSWORD",
    "BULL_AUTH_KEY",
    "BROWSER_SERVICE_API_KEY",
    "BROWSER_REPLAY_INGEST_API_KEY",
    "BROWSER_INTERACTION_WORKER_TOKEN",
    "MINIO_ROOT_PASSWORD",
    "ARTIFACT_MINIO_SECRET_KEY",
  ];
  assert.match(values.SEARXNG_SECRET, /^[0-9a-f]{64}$/);
  for (const key of otherSecretKeys) {
    if (values[key] !== undefined) {
      assert.notEqual(values.SEARXNG_SECRET, values[key]);
    }
  }
}

// @lat: [[testing/runtime-operations#Runtime and Operations Testing#Local wrapper suite#SearXNG environment migration]]
test("fresh local environment includes a private SearXNG origin and secret", async t => {
  const root = await mkdtemp(join(tmpdir(), "local-searxng-init-test-"));
  const scripts = join(root, "scripts");
  const copiedInit = join(scripts, "init-local-env.sh");
  const copiedSearchKeyHelper = join(scripts, "local-search-key.lib.sh");
  const envFile = join(root, ".env");
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(scripts);
  await copyFile(initEnv, copiedInit);
  await copyFile(searchKeyHelper, copiedSearchKeyHelper);
  await chmod(copiedInit, 0o755);

  const created = await run(copiedInit, [], {
    env: { FIRECRAWL_SEARXNG_BRAVE_API_KEY: fixtureBraveApiKey },
  });
  assert.equal(created.code, 0, created.stderr);
  const original = await readFile(envFile, "utf8");
  const values = parseEnvironment(original);
  assert.equal(values.SEARXNG_ENDPOINT, "http://searxng:8080");
  assert.equal(
    values.SEARXNG_BRAVE_API_KEY_B64,
    Buffer.from(fixtureBraveApiKey).toString("base64"),
  );
  assert.doesNotMatch(original, new RegExp(`=${fixtureBraveApiKey}$`, "m"));
  assertSecretIsDistinct(values);
  assert.equal((await stat(envFile)).mode & 0o777, 0o600);

  const repeated = await run(copiedInit, []);
  assert.equal(repeated.code, 1);
  assert.equal(await readFile(envFile, "utf8"), original);
});

test("upgrade fills missing and blank SearXNG values", async t => {
  for (const [name, overrides] of [
    [
      "missing",
      { SEARXNG_ENDPOINT: undefined, SEARXNG_SECRET: undefined },
    ],
    ["blank", { SEARXNG_ENDPOINT: "", SEARXNG_SECRET: "" }],
  ]) {
    await t.test(name, async t => {
      const { envFile } = await temporaryEnvironment(
        t,
        phaseEnvironment(overrides),
      );
      const upgraded = await run(upgradeEnv, ["--env-file", envFile]);
      assert.equal(upgraded.code, 0, upgraded.stderr);
      const values = parseEnvironment(await readFile(envFile, "utf8"));
      assert.equal(values.SEARXNG_ENDPOINT, "http://searxng:8080");
      assertSecretIsDistinct(values);
      assert.equal((await stat(envFile)).mode & 0o777, 0o600);
      const checked = await run(upgradeEnv, ["--check", "--env-file", envFile]);
      assert.equal(checked.code, 0, checked.stderr);
    });
  }
});

test("upgrade canonicalizes valid internal and external SearXNG origins", async t => {
  const cases = [
    ["HTTP://SEARXNG:8080/", "http://searxng:8080"],
    ["http://Example.COM:80/", "http://example.com"],
    ["HTTPS://BÜCHER.Example:443/", "https://xn--bcher-kva.example"],
    ["https://Search.Example:8443/", "https://search.example:8443"],
  ];

  for (const [input, expected] of cases) {
    await t.test(input, async t => {
      const { envFile } = await temporaryEnvironment(
        t,
        phaseEnvironment({ SEARXNG_ENDPOINT: input }),
      );
      const upgraded = await run(upgradeEnv, ["--env-file", envFile]);
      assert.equal(upgraded.code, 0, upgraded.stderr);
      const values = parseEnvironment(await readFile(envFile, "utf8"));
      assert.equal(values.SEARXNG_ENDPOINT, expected);
      assert.equal(values.SEARXNG_SECRET, "e".repeat(64));
    });
  }
});

test("upgrade rejects unsafe SearXNG endpoint variants atomically", async t => {
  const invalidEndpoints = [
    "ftp://search.example",
    "http:/search.example",
    "http://user@search.example",
    "http://@search.example",
    "http://search.example?query",
    "http://search.example?",
    "http://search.example#fragment",
    "http://search.example#",
    "http://search.example/path",
    "http://searxng",
    "http://searxng:80",
    "https://searxng:8080",
    "http://searxng.:8080",
  ];

  for (const endpoint of invalidEndpoints) {
    await t.test(endpoint, async t => {
      const original = phaseEnvironment({ SEARXNG_ENDPOINT: endpoint });
      const { envFile } = await temporaryEnvironment(t, original);
      const rejected = await run(upgradeEnv, ["--env-file", envFile]);
      assert.equal(rejected.code, 1);
      assert.match(rejected.stderr, /Invalid Phase 1 environment field: SEARXNG_ENDPOINT/);
      assert.equal(await readFile(envFile, "utf8"), original);
    });
  }
});

test("upgrade rejects invalid or reused SearXNG secrets", async t => {
  for (const secret of ["not-a-secret", "d".repeat(64)]) {
    await t.test(secret.length === 64 ? "reused" : "invalid", async t => {
      const original = phaseEnvironment({ SEARXNG_SECRET: secret });
      const { envFile } = await temporaryEnvironment(t, original);
      const rejected = await run(upgradeEnv, ["--env-file", envFile]);
      assert.equal(rejected.code, 1);
      assert.match(rejected.stderr, /Invalid Phase 1 environment field: SEARXNG_SECRET/);
      assert.equal(await readFile(envFile, "utf8"), original);
    });
  }
});

test("upgrade retries generated SearXNG secret collisions", async t => {
  const original = phaseEnvironment({ SEARXNG_SECRET: undefined });
  const { root, envFile } = await temporaryEnvironment(t, original);
  const bin = join(root, "bin");
  const counter = join(root, "openssl-count");
  await mkdir(bin);
  await writeFile(
    join(bin, "openssl"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ ! -e "\${SEARXNG_TEST_COUNTER}" ]]; then
  : > "\${SEARXNG_TEST_COUNTER}"
  printf '%s\\n' "${"d".repeat(64)}"
else
  printf '%s\\n' "${"f".repeat(64)}"
fi
`,
    { mode: 0o755 },
  );

  const upgraded = await run(upgradeEnv, ["--env-file", envFile], {
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      SEARXNG_TEST_COUNTER: counter,
    },
  });
  assert.equal(upgraded.code, 0, upgraded.stderr);
  const values = parseEnvironment(await readFile(envFile, "utf8"));
  assert.equal(values.SEARXNG_SECRET, "f".repeat(64));
  assertSecretIsDistinct(values);
});

test("upgrade preserves symlink, mode, duplicate-key, and lock safeguards", async t => {
  await t.test("environment symlink", async t => {
    const root = await mkdtemp(join(tmpdir(), "local-searxng-symlink-test-"));
    const target = join(root, "target.env");
    const envFile = join(root, ".env");
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(target, phaseEnvironment(), { mode: 0o600 });
    await symlink(target, envFile);
    const rejected = await run(upgradeEnv, ["--env-file", envFile]);
    assert.equal(rejected.code, 1);
    assert.match(rejected.stderr, /Refusing symbolic-link environment file/);
  });

  await t.test("environment mode", async t => {
    const { envFile } = await temporaryEnvironment(t);
    await chmod(envFile, 0o640);
    const rejected = await run(upgradeEnv, ["--env-file", envFile]);
    assert.equal(rejected.code, 1);
    assert.match(rejected.stderr, /without mode 0600/);
  });

  await t.test("duplicate key", async t => {
    const original = `${phaseEnvironment()}SEARXNG_ENDPOINT=http://searxng:8080\n`;
    const { envFile } = await temporaryEnvironment(t, original);
    const rejected = await run(upgradeEnv, ["--env-file", envFile]);
    assert.equal(rejected.code, 1);
    assert.match(rejected.stderr, /Invalid Phase 1 environment field: SEARXNG_ENDPOINT/);
    assert.equal(await readFile(envFile, "utf8"), original);
  });

  for (const [name, setup, message] of [
    [
      "lock symlink",
      async lockFile => symlink("lock-target", lockFile),
      /Refusing unsafe Phase 1 environment lock/,
    ],
    [
      "lock mode",
      async lockFile => writeFile(lockFile, "", { mode: 0o640 }),
      /lock without mode 0600/,
    ],
  ]) {
    await t.test(name, async t => {
      const original = phaseEnvironment({ SEARXNG_SECRET: undefined });
      const { envFile } = await temporaryEnvironment(t, original);
      await setup(`${envFile}.phase1.lock`);
      const rejected = await run(upgradeEnv, ["--env-file", envFile]);
      assert.equal(rejected.code, 1);
      assert.match(rejected.stderr, message);
      assert.equal(await readFile(envFile, "utf8"), original);
    });
  }
});

test("concurrent upgrades serialize and repeat without rewriting", async t => {
  const { envFile } = await temporaryEnvironment(
    t,
    phaseEnvironment({ SEARXNG_ENDPOINT: undefined, SEARXNG_SECRET: undefined }),
  );
  const results = await Promise.all([
    run(upgradeEnv, ["--env-file", envFile]),
    run(upgradeEnv, ["--env-file", envFile]),
  ]);
  for (const result of results) {
    assert.equal(result.code, 0, result.stderr);
  }
  const upgraded = await readFile(envFile, "utf8");
  const inode = (await stat(envFile)).ino;
  const values = parseEnvironment(upgraded);
  assert.equal(values.SEARXNG_ENDPOINT, "http://searxng:8080");
  assertSecretIsDistinct(values);

  const repeated = await run(upgradeEnv, ["--env-file", envFile]);
  assert.equal(repeated.code, 0, repeated.stderr);
  assert.match(repeated.stdout, /already configured/);
  assert.equal(await readFile(envFile, "utf8"), upgraded);
  assert.equal((await stat(envFile)).ino, inode);
});

test("upgrade detects a concurrent environment change before publication", async t => {
  const original = phaseEnvironment({ SEARXNG_SECRET: undefined });
  const { root, envFile } = await temporaryEnvironment(t, original);
  const bin = join(root, "bin");
  const ready = join(root, "ready");
  const proceed = join(root, "proceed");
  await mkdir(bin);
  await writeFile(
    join(bin, "openssl"),
    `#!/usr/bin/env bash
set -euo pipefail
: > "\${SEARXNG_TEST_READY}"
while [[ ! -e "\${SEARXNG_TEST_PROCEED}" ]]; do
  sleep 0.01
done
printf '%s\\n' "\${SEARXNG_TEST_SECRET}"
`,
    { mode: 0o755 },
  );

  const upgrade = run(upgradeEnv, ["--env-file", envFile], {
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      SEARXNG_TEST_PROCEED: proceed,
      SEARXNG_TEST_READY: ready,
      SEARXNG_TEST_SECRET: "f".repeat(64),
    },
  });
  await waitForFile(ready);
  await appendFile(envFile, "# concurrent update\n");
  await writeFile(proceed, "");
  const rejected = await upgrade;
  assert.equal(rejected.code, 1);
  assert.match(rejected.stderr, /changed during Phase 1 upgrade/);
  assert.equal(await readFile(envFile, "utf8"), `${original}# concurrent update\n`);
  assert.deepEqual(
    (await readdir(root)).filter(name => name.includes("firecrawl-secret-tmp")),
    [],
  );
});

test("failed atomic publication leaves the original environment intact", async t => {
  const original = phaseEnvironment({ SEARXNG_SECRET: undefined });
  const { root, envFile } = await temporaryEnvironment(t, original);
  const bin = join(root, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "mv"), "#!/usr/bin/env bash\nexit 74\n", {
    mode: 0o755,
  });

  const rejected = await run(upgradeEnv, ["--env-file", envFile], {
    env: { PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(rejected.code, 74);
  assert.equal(await readFile(envFile, "utf8"), original);
  assert.deepEqual(
    (await readdir(root)).filter(name => name.includes("firecrawl-secret-tmp")),
    [],
  );
});
