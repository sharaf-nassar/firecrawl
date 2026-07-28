import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

import { afterEach, describe, expect, test } from "vitest";

const repository = resolve(import.meta.dirname, "../../../../");
const backupScript = join(repository, "scripts/local-firecrawl-backup");
const restoreScript = join(repository, "scripts/local-firecrawl-restore");
const lifecycleScript = join(repository, "scripts/local-firecrawl");
const profileId = "11111111-1111-4111-8111-111111111111";
const generationId = "22222222-2222-4222-8222-222222222222";
const alternateGenerationId = "33333333-3333-4333-8333-333333333333";
const temporaryRoots: string[] = [];

type Fixture = ReturnType<typeof createProductionCommandFixture>;

function writePrivate(path: string, contents: string): void {
  writeFileSync(path, contents, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function createStoreFixture(initialState: "running" | "stopped" = "running") {
  const root = mkdtempSync(join(tmpdir(), "firecrawl-backup-test-"));
  temporaryRoots.push(root);
  chmodSync(root, 0o700);
  const runtime = join(root, "runtime");
  const store = join(root, "store");
  const backups = join(root, "backups");
  const committed = join(
    store,
    "browser-state/profiles",
    profileId,
    "committed",
    generationId,
  );
  for (const path of [
    runtime,
    store,
    backups,
    join(store, "minio"),
    committed,
    join(store, "browser-state/profiles", profileId, "working"),
    join(store, "browser-state/profiles", profileId, "staging"),
  ]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    chmodSync(path, 0o700);
  }
  writePrivate(join(committed, "Cookies"), "cookie=original\n");
  writePrivate(
    join(store, "browser-state/profiles", profileId, "working", "scratch"),
    "never-back-up\n",
  );
  writePrivate(
    join(store, "browser-state/profiles", profileId, "staging", "scratch"),
    "never-back-up\n",
  );
  writePrivate(join(store, "minio", "artifact"), "artifact=original\n");
  writePrivate(
    join(store, "database.dump"),
    `fake-dump-v1\npointer ${profileId} ${generationId} profiles/${profileId}/committed/${generationId}\n`,
  );
  writePrivate(join(store, "writers.state"), `${initialState}\n`);
  writePrivate(
    join(store, "services.state"),
    [
      `api=${initialState}`,
      `browser-service=${initialState}`,
      `adapter=${initialState}`,
      `minio=${initialState}`,
      `app-postgres=${initialState}`,
      "",
    ].join("\n"),
  );
  return {
    root,
    runtime,
    store,
    backups,
    env: {
      ...process.env,
      LOCAL_FIRECRAWL_TESTING: "1",
      LOCAL_FIRECRAWL_BACKUP_TEST_STORE_ROOT: store,
      XDG_RUNTIME_DIR: runtime,
    },
  };
}

function pointerPaths(dump: string): string {
  return dump
    .split("\n")
    .filter(line => line.startsWith("pointer "))
    .map(line => line.split(/\s+/u)[3])
    .filter((path): path is string => path !== undefined)
    .sort()
    .join("\n");
}

function createProductionCommandFixture(
  initialState: "running" | "stopped" = "stopped",
) {
  const fixture = createStoreFixture(initialState);
  const bin = join(fixture.root, "bin");
  const trace = join(fixture.root, "production-trace.jsonl");
  const preflight = join(fixture.store, "preflight.dump");
  const hostRuntime = join(fixture.root, "host-runtime");
  const manifest = join(fixture.root, "manifest.json");
  const latestMigration = "0010_browser_stop_billing_claim.sql";
  const latestMigrationChecksum = createHash("sha256")
    .update(
      readFileSync(
        join(repository, "apps/api/src/db/migrations", latestMigration),
      ),
    )
    .digest("hex");
  mkdirSync(bin, { mode: 0o700 });
  mkdirSync(hostRuntime, { mode: 0o700 });
  writePrivate(join(hostRuntime, "clean-stop"), "version=1\n");
  writePrivate(
    manifest,
    `${JSON.stringify({
      codexAppServer: {
        sourceIdentity: {
          executablePath: "/fake/codex",
          resolvedPath: "/fake/codex",
          device: "1",
          inode: "2",
          version: "0.145.0",
        },
        artifactSha256: "a".repeat(64),
        protocolSha256: "b".repeat(64),
        featureSha256: "d".repeat(64),
        model: "gpt-5.6-terra",
        reasoningEffort: "medium",
      },
      brokerContractSha256: "c".repeat(64),
    })}\n`,
  );
  writeFileSync(
    join(bin, "systemctl"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const store = process.env.FAKE_PRODUCTION_STORE;
const adapter = path.join(store, "adapter.state");
if (args.includes("start") &&
    args.includes("firecrawl-execution-adapter.service")) {
  fs.writeFileSync(adapter, "active");
}
if (args.includes("stop") &&
    args.includes("firecrawl-execution-adapter.service")) {
  fs.writeFileSync(adapter, "inactive");
}
if (args.includes("is-active")) {
  if (!args.includes("firecrawl-execution-adapter.service")) process.exit(0);
  process.exit(fs.readFileSync(adapter, "utf8").trim() === "active" ? 0 : 3);
}
`,
    { mode: 0o700 },
  );
  writePrivate(
    join(fixture.store, "adapter.state"),
    initialState === "running" ? "active\n" : "inactive\n",
  );
  writeFileSync(
    join(bin, "builder"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
if (fs.existsSync(path.join(
  process.env.FAKE_PRODUCTION_STORE, "fail-health"
))) process.exit(96);
process.exit(0);
`,
    { mode: 0o700 },
  );
  writeFileSync(
    join(bin, "curl"),
    `#!/usr/bin/env node
const args = process.argv.slice(2);
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
    success: true, stdout: "", result: expected, stderr: "",
    exitCode: 0, killed: false,
  }));
}
`,
    { mode: 0o700 },
  );
  writeFileSync(
    join(bin, "docker"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const cp = require("node:child_process");
const crypto = require("node:crypto");
const path = require("node:path");
const args = process.argv.slice(2);
const store = process.env.FAKE_PRODUCTION_STORE;
const trace = process.env.FAKE_PRODUCTION_TRACE;
const writerState = path.join(store, "writers.state");
const servicesState = path.join(store, "services.state");
fs.appendFileSync(trace, JSON.stringify(args) + "\\n");
const has = value => args.includes(value);
const stdin = () => fs.readFileSync(0);
const normalized = value => value.replace(/\\s+/g, " ").trim();
const includesSequence = sequence => sequence.every(
  (value, index) => args[args.indexOf(sequence[0]) + index] === value,
);
const snapshot = root => {
  const result = [];
  const walk = (directory, relative = "") => {
    for (const name of fs.readdirSync(directory).sort()) {
      const full = path.join(directory, name);
      const child = relative ? relative + "/" + name : name;
      const stat = fs.lstatSync(full);
      if (stat.isDirectory()) {
        result.push(["d", child, stat.mode & 0o777]);
        walk(full, child);
      } else if (stat.isFile()) {
        result.push([
          "f", child, stat.mode & 0o777,
          crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex"),
        ]);
      } else {
        throw new Error("unexpected fixture member");
      }
    }
  };
  walk(root);
  return JSON.stringify(result);
};
const pointers = dump => dump.toString("utf8").split("\\n")
  .filter(line => line.startsWith("pointer "))
  .map(line => line.trim().split(/\\s+/)[3]).filter(Boolean).sort().join("\\n");
const mounts = new Map();
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--volume") {
    const [source, target] = args[i + 1].split(":");
    mounts.set(target, source);
  }
}
if (args[0] === "volume" && args[1] === "inspect") {
  const volume = args.at(-1);
  const logical = volume === "fake-minio" ? "minio-data" : "browser-state";
  process.stdout.write(JSON.stringify({
    "com.docker.compose.project":
      process.env.FAKE_BAD_VOLUME_LABEL ? "other" : "firecrawl",
    "com.docker.compose.volume":
      process.env.FAKE_BAD_VOLUME_LABEL ? "other" : logical,
  }) + "\\n");
  process.exit(0);
}
if (args[0] === "run") {
  const backup = mounts.get("/backup");
  const sourceVolume = mounts.get("/source");
  const targetVolume = mounts.get("/target");
  const fileIndex = args.indexOf("--file");
  const archiveArg = fileIndex >= 0 ? args[fileIndex + 1] : "";
  const archiveName = archiveArg ? path.basename(archiveArg) : args.at(-1);
  if (has("--compare")) {
    const target =
      targetVolume === "fake-minio"
        ? path.join(store, "minio")
        : path.join(store, "browser-state");
    const targetArgument =
      targetVolume === "fake-minio" ? "/target" : "/target/state";
    if (!includesSequence([
      "--compare", "--gzip", "--numeric-owner",
      "--file", "/backup/" + archiveName,
      "--directory", targetArgument,
    ])) process.exit(90);
    const expected = fs.mkdtempSync(path.join(store, ".compare-"));
    const extracted = cp.spawnSync("/usr/bin/tar", [
      "--extract", "--gzip", "--file", path.join(backup, archiveName),
      "--directory", expected,
    ]);
    if (extracted.status !== 0) process.exit(extracted.status ?? 1);
    const equal = snapshot(expected) === snapshot(target);
    fs.rmSync(expected, { recursive: true, force: true });
    process.exit(equal ? 0 : 1);
  }
  if (sourceVolume === "fake-minio") {
    if (!has("--owner=0") || !has("--group=0") ||
        !has("--mode=u=rwX,go=rX")) process.exit(91);
    const result = cp.spawnSync("/usr/bin/tar", [
      "--create", "--gzip", "--owner=0", "--group=0",
      "--mode=u=rwX,go=rX", "--file", path.join(backup, archiveName),
      "--directory", path.join(store, "minio"), ".",
    ]);
    process.exit(result.status ?? 1);
  }
  if (sourceVolume === "fake-browser") {
    const result = cp.spawnSync("/usr/bin/tar", [
      "--create", "--gzip", "--file", path.join(backup, archiveName),
      "--directory", path.join(store, "browser-state"),
      "--exclude=profiles/*/working", "--exclude=profiles/*/working/**",
      "--exclude=profiles/*/staging", "--exclude=profiles/*/staging/**",
      "profiles",
    ]);
    process.exit(result.status ?? 1);
  }
  if (targetVolume === "fake-minio" && has("--entrypoint") && has("sh")) {
    if (fs.existsSync(path.join(store, "fail-restore-minio"))) process.exit(92);
    fs.rmSync(path.join(store, "minio"), { recursive: true, force: true });
    fs.mkdirSync(path.join(store, "minio"), { recursive: true });
    const result = cp.spawnSync("/usr/bin/tar", [
      "--extract", "--gzip", "--file", path.join(backup, archiveName),
      "--directory", path.join(store, "minio"),
    ]);
    process.exit(result.status ?? 1);
  }
  if (targetVolume === "fake-browser" && has("-i")) {
    const expected = stdin().toString("utf8").trim();
    const actual = [];
    const profiles = path.join(store, "browser-state", "profiles");
    for (const profile of fs.readdirSync(profiles)) {
      const committed = path.join(profiles, profile, "committed");
      if (!fs.existsSync(committed)) continue;
      for (const generation of fs.readdirSync(committed)) {
        actual.push("profiles/" + profile + "/committed/" + generation);
      }
    }
    process.exit(expected === actual.sort().join("\\n") ? 0 : 1);
  }
  if (targetVolume === "fake-browser" && has("--entrypoint") && has("sh")) {
    if (fs.existsSync(path.join(store, "fail-restore-profiles"))) process.exit(93);
    fs.rmSync(path.join(store, "browser-state", "profiles"), {
      recursive: true, force: true,
    });
    const result = cp.spawnSync("/usr/bin/tar", [
      "--extract", "--gzip", "--file", path.join(backup, archiveName),
      "--directory", path.join(store, "browser-state"),
    ]);
    process.exit(result.status ?? 1);
  }
  process.exit(0);
}
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
          volumes: [{
            type: "volume",
            source: "fake-browser",
            target: "/var/lib/firecrawl-browser-volume",
          }],
        },
        minio: {
          volumes: [{
            type: "volume", source: "fake-minio", target: "/data",
          }],
        },
      },
    }) + "\\n");
  }
  process.exit(0);
}
if (has("ps") && has("-q")) {
  if (args.at(-1) === "api" &&
      fs.readFileSync(writerState, "utf8").trim() === "running") {
    process.stdout.write("api-container\\n");
  }
  process.exit(0);
}
if (has("ps") && has("json")) {
  process.stdout.write(JSON.stringify({
    Service: "api",
    Publishers: [{
      URL: "127.0.0.1", TargetPort: 3002,
      PublishedPort: 3002, Protocol: "tcp",
    }],
  }) + "\\n");
  process.exit(0);
}
if (has("ps") && has("--all")) {
  process.stdout.write("exited 0\\n");
  process.exit(0);
}
if (has("stop")) {
  fs.writeFileSync(writerState, "stopped\\n");
  fs.writeFileSync(servicesState,
    "api=stopped\\nbrowser-service=stopped\\nadapter=stopped\\n" +
    "minio=stopped\\napp-postgres=stopped\\n");
  process.exit(0);
}
if (has("up") && args.at(-1) === "api") {
  fs.writeFileSync(writerState, "running\\n");
  fs.writeFileSync(servicesState,
    "api=running\\nbrowser-service=running\\nadapter=running\\n" +
    "minio=running\\napp-postgres=running\\n");
  process.exit(0);
}
if (has("up") || has("build")) process.exit(0);
const health = {
  version: 1,
  status: "ok",
  codexCliVersion: "0.145.0",
  codexArtifactSha256: "a".repeat(64),
  codexProtocolSchemaSha256: "b".repeat(64),
  brokerProtocolSha256: "c".repeat(64),
  model: "gpt-5.6-terra",
  reasoningEffort: "medium",
};
const durable = {
  ...health,
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
if ((has("exec") || has("run")) && has("--health-only")) {
  if (fs.existsSync(path.join(store, "fail-health"))) process.exit(94);
  process.stdout.write(JSON.stringify(health) + "\\n");
  process.exit(0);
}
if ((has("exec") || has("run")) &&
    args.some(value => value.endsWith("browser-runtime-status.js"))) {
  process.stdout.write(JSON.stringify(durable) + "\\n");
  process.exit(0);
}
if ((has("exec") || has("run")) &&
    args.some(value => value.endsWith("browser-runtime-drain.js"))) {
  process.stdout.write('{"cancelledHostJobs":0}\\n');
  process.exit(0);
}
if (has("exec") && has("app-postgres")) {
  const command = args.join(" ");
  const shellIndex = args.indexOf("-ec");
  const script = shellIndex >= 0 ? normalized(args[shellIndex + 1]) : "";
  if (command.includes("pg_dump")) {
    if (script !==
      'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" ' +
      "--format=custom --no-owner") process.exit(97);
    process.stdout.write(fs.readFileSync(path.join(store, "database.dump")));
  } else if (command.includes("pg_restore") && command.includes("--clean")) {
    if (script !==
      'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean ' +
      "--if-exists --no-owner --exit-on-error --single-transaction") {
      process.exit(98);
    }
    if (fs.existsSync(path.join(store, "fail-restore-database"))) process.exit(95);
    fs.writeFileSync(path.join(store, "database.dump"), stdin());
  } else if (script ===
      'pg_restore -U "$POSTGRES_USER" -d "$1" --no-owner --exit-on-error') {
    if (!/^firecrawl_backup_check_[0-9a-f]{32}$/u.test(args.at(-1))) {
      process.exit(99);
    }
    fs.writeFileSync(process.env.FAKE_PRODUCTION_PREFLIGHT, stdin());
  } else if (script.includes("browser_profiles p")) {
    const required = [
      'psql -X -qAt -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$1"',
      "SELECT count(*)",
      "LEFT JOIN browser_profile_generations g",
      "g.id = p.latest_generation_id",
      "p.writer_session_id IS NOT NULL",
      "g.profile_id <> p.id",
      "g.file_deleted_at IS NOT NULL",
      "invalid.state_path IS DISTINCT FROM",
      "'profiles/'",
      "invalid.profile_id",
      "'/committed/'",
      "invalid.id",
      "SELECT state_path",
      "file_deleted_at IS NULL",
      "ORDER BY state_path",
    ];
    if (!required.every(fragment => script.includes(fragment)) ||
        !/^firecrawl_backup_check_[0-9a-f]{32}$/u.test(args.at(-1))) {
      process.exit(100);
    }
    process.stdout.write("0\\n" + pointers(
      fs.readFileSync(process.env.FAKE_PRODUCTION_PREFLIGHT),
    ) + "\\n");
  } else if (command.includes("SELECT g.state_path")) {
    const required = [
      'psql -X -qAt -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" ' +
        '-d "$POSTGRES_DB"',
      "SELECT g.state_path",
      "g.state_path IS NOT NULL",
      "g.file_deleted_at IS NULL",
      "ORDER BY g.state_path",
    ];
    if (!required.every(fragment => script.includes(fragment))) process.exit(101);
    process.stdout.write(pointers(
      fs.readFileSync(path.join(store, "database.dump")),
    ) + "\\n");
  } else if (command.includes("application_schema_migrations")) {
    process.stdout.write(
      process.env.FAKE_LATEST_MIGRATION + "|" +
      process.env.FAKE_LATEST_MIGRATION_CHECKSUM + "\\n",
    );
  } else if (command.includes("pg_restore") && has("--list")) {
    if (args.at(-2) !== "pg_restore" || args.at(-1) !== "--list") {
      process.exit(102);
    }
    if (stdin().length === 0) process.exit(1);
  } else if (script.includes("createdb")) {
    if (script !==
        'createdb -U "$POSTGRES_USER" --template=template0 "$1"' ||
        !/^firecrawl_backup_check_[0-9a-f]{32}$/u.test(args.at(-1))) {
      process.exit(103);
    }
  } else if (script.includes("dropdb")) {
    if (script !==
        'dropdb -U "$POSTGRES_USER" --if-exists "$1"' ||
        !/^firecrawl_backup_check_[0-9a-f]{32}$/u.test(args.at(-1))) {
      process.exit(104);
    }
  }
  process.exit(0);
}
if (has("exec") && has("redis") && has("redis-cli")) {
  process.stdout.write("PONG\\n");
}
if (args[0] === "inspect" && args.at(-1) === "api-container") {
  process.stdout.write(
    process.env.FAKE_REPO_ROOT + "/compose.yaml," +
    process.env.FAKE_REPO_ROOT + "/compose.local.yaml\\n",
  );
}
process.exit(0);
`,
    { mode: 0o700 },
  );
  return {
    ...fixture,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      LOCAL_FIRECRAWL_TESTING: "1",
      LOCAL_FIRECRAWL_HOST_MANIFEST: manifest,
      LOCAL_FIRECRAWL_HOST_RUNTIME_DIR: hostRuntime,
      LOCAL_FIRECRAWL_HOST_BUILDER: join(bin, "builder"),
      XDG_RUNTIME_DIR: fixture.runtime,
      FAKE_PRODUCTION_STORE: fixture.store,
      FAKE_PRODUCTION_TRACE: trace,
      FAKE_PRODUCTION_PREFLIGHT: preflight,
      FAKE_REPO_ROOT: repository,
      FAKE_LATEST_MIGRATION: latestMigration,
      FAKE_LATEST_MIGRATION_CHECKSUM: latestMigrationChecksum,
    },
    trace,
  };
}

function run(
  script: string,
  args: string[],
  fixture: Fixture,
): ReturnType<typeof spawnSync> {
  return spawnSync(script, args, {
    cwd: repository,
    env: fixture.env,
    encoding: "utf8",
  });
}

function expectSuccess(result: ReturnType<typeof spawnSync>): void {
  expect(result.status, result.stderr).toBe(0);
}

function generationDirectories(fixture: Fixture): string[] {
  return readdirSync(fixture.backups)
    .map(name => join(fixture.backups, name))
    .filter(path => lstatSync(path).isDirectory())
    .sort();
}

function createBackup(fixture: Fixture): string {
  expectSuccess(run(backupScript, ["--output", fixture.backups], fixture));
  const generations = generationDirectories(fixture);
  expect(generations).toHaveLength(1);
  return generations[0]!;
}

function generationFiles(directory: string) {
  const generation = basename(directory);
  return {
    generation,
    database: join(directory, `${generation}.app-postgres.dump`),
    minio: join(directory, `${generation}.minio-data.tar.gz`),
    profiles: join(directory, `${generation}.browser-profiles.tar.gz`),
    manifest: join(directory, `${generation}.manifest`),
    checksum: join(directory, `${generation}.sha256`),
  };
}

function rewriteChecksums(directory: string): void {
  const files = generationFiles(directory);
  const entries = [
    basename(files.database),
    basename(files.manifest),
    basename(files.minio),
    basename(files.profiles),
  ].sort();
  writePrivate(
    files.checksum,
    entries
      .map(name => {
        const digest = createHash("sha256")
          .update(readFileSync(join(directory, name)))
          .digest("hex");
        return `${digest}  ${name}\n`;
      })
      .join(""),
  );
}

function mutateLiveStore(fixture: Fixture): void {
  writePrivate(
    join(fixture.store, "database.dump"),
    readFileSync(join(fixture.store, "database.dump"), "utf8").replace(
      "fake-dump-v1",
      "fake-dump-v1-changed",
    ),
  );
  writePrivate(join(fixture.store, "minio", "artifact"), "artifact=changed\n");
  writePrivate(
    join(
      fixture.store,
      "browser-state/profiles",
      profileId,
      "committed",
      generationId,
      "Cookies",
    ),
    "cookie=changed\n",
  );
}

function expectAllStopped(fixture: Fixture): void {
  expect(readFileSync(join(fixture.store, "writers.state"), "utf8")).toBe(
    "stopped\n",
  );
  expect(readFileSync(join(fixture.store, "services.state"), "utf8")).toBe(
    [
      "api=stopped",
      "browser-service=stopped",
      "adapter=stopped",
      "minio=stopped",
      "app-postgres=stopped",
      "",
    ].join("\n"),
  );
}

function productionEvents(fixture: Fixture): string[][] {
  return readFileSync(fixture.trace, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(line => JSON.parse(line) as string[]);
}

function replaceProfilesArchive(directory: string, python: string): void {
  const files = generationFiles(directory);
  const result = spawnSync("python3", ["-c", python, files.profiles], {
    encoding: "utf8",
  });
  expectSuccess(result);
  chmodSync(files.profiles, 0o600);
  rewriteChecksums(directory);
}

function replaceMinioArchive(directory: string, python: string): void {
  const files = generationFiles(directory);
  const result = spawnSync("python3", ["-c", python, files.minio], {
    encoding: "utf8",
  });
  expectSuccess(result);
  chmodSync(files.minio, 0o600);
  rewriteChecksums(directory);
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("coordinated local Firecrawl backup and restore", () => {
  test("publishes one closed triplet and excludes working profile state", () => {
    const fixture = createProductionCommandFixture("running");
    const directory = createBackup(fixture);
    const files = generationFiles(directory);
    const names = readdirSync(directory).sort();

    expect(names).toEqual(
      [
        basename(files.checksum),
        basename(files.database),
        basename(files.manifest),
        basename(files.minio),
        basename(files.profiles),
      ].sort(),
    );
    expect(lstatSync(directory).mode & 0o777).toBe(0o700);
    for (const name of names) {
      expect(lstatSync(join(directory, name)).mode & 0o777).toBe(0o600);
    }
    expect(readFileSync(files.manifest, "utf8")).toBe(
      [
        `generation=${files.generation}`,
        `database=${basename(files.database)}`,
        `artifacts=${basename(files.minio)}`,
        `profiles=${basename(files.profiles)}`,
        "",
      ].join("\n"),
    );
    const listing = spawnSync("tar", ["-tzf", files.profiles], {
      encoding: "utf8",
    });
    expectSuccess(listing);
    expect(listing.stdout).toContain(`/committed/${generationId}/Cookies`);
    expect(listing.stdout).not.toContain("/working/");
    expect(listing.stdout).not.toContain("/staging/");
    expect(readFileSync(join(fixture.store, "writers.state"), "utf8")).toBe(
      "running\n",
    );
    const events = productionEvents(fixture);
    const stopInitializers = events.findIndex(
      args =>
        args.includes("stop") &&
        args.includes("browser-state-init") &&
        args.includes("minio-init"),
    );
    const verifyInitializers = events.findIndex(
      args =>
        args.includes("ps") &&
        args.includes("-q") &&
        args.includes("browser-state-init") &&
        args.includes("minio-init"),
    );
    const captureMinio = events.findIndex(
      args =>
        args[0] === "run" &&
        args.includes("fake-minio:/source:ro") &&
        args.includes("--owner=0") &&
        args.includes("--group=0") &&
        args.includes("--mode=u=rwX,go=rX"),
    );
    expect(stopInitializers).toBeGreaterThanOrEqual(0);
    expect(verifyInitializers).toBeGreaterThan(stopInitializers);
    expect(captureMinio).toBeGreaterThan(verifyInitializers);
  });

  test("keeps a previously stopped runtime stopped after backup and restore", () => {
    const fixture = createProductionCommandFixture("stopped");
    const directory = createBackup(fixture);
    expectAllStopped(fixture);
    mutateLiveStore(fixture);
    const restored = run(
      restoreScript,
      [directory, "--rollback-output", fixture.backups],
      fixture,
    );
    expectSuccess(restored);
    expectAllStopped(fixture);
  });

  test("restores all stores, preserves rollback, and restarts prior writers", () => {
    const fixture = createProductionCommandFixture("running");
    const directory = createBackup(fixture);
    const originalDatabase = readFileSync(join(fixture.store, "database.dump"));
    mutateLiveStore(fixture);

    expectSuccess(
      run(
        restoreScript,
        [directory, "--rollback-output", fixture.backups],
        fixture,
      ),
    );
    expect(readFileSync(join(fixture.store, "database.dump"))).toEqual(
      originalDatabase,
    );
    expect(readFileSync(join(fixture.store, "minio", "artifact"), "utf8")).toBe(
      "artifact=original\n",
    );
    expect(
      readFileSync(
        join(
          fixture.store,
          "browser-state/profiles",
          profileId,
          "committed",
          generationId,
          "Cookies",
        ),
        "utf8",
      ),
    ).toBe("cookie=original\n");
    expect(generationDirectories(fixture)).toHaveLength(2);
    const rollback = generationDirectories(fixture).find(
      candidate => candidate !== directory,
    );
    expect(rollback).toBeDefined();
    const rollbackFiles = generationFiles(rollback!);
    const rollbackMinio = spawnSync(
      "tar",
      ["-xOzf", rollbackFiles.minio, "./artifact"],
      { encoding: "utf8" },
    );
    const rollbackProfile = spawnSync(
      "tar",
      [
        "-xOzf",
        rollbackFiles.profiles,
        `profiles/${profileId}/committed/${generationId}/Cookies`,
      ],
      { encoding: "utf8" },
    );
    expectSuccess(rollbackMinio);
    expectSuccess(rollbackProfile);
    expect(readFileSync(rollbackFiles.database, "utf8")).toContain(
      "fake-dump-v1-changed",
    );
    expect(rollbackMinio.stdout).toBe("artifact=changed\n");
    expect(rollbackProfile.stdout).toBe("cookie=changed\n");
    expect(readFileSync(join(fixture.store, "writers.state"), "utf8")).toBe(
      "running\n",
    );
    const events = productionEvents(fixture);
    const rollbackDatabase = events.findLastIndex(args =>
      args.some(value => value.includes("pg_dump")),
    );
    const rollbackMinioCapture = events.findLastIndex(
      args => args[0] === "run" && args.includes("fake-minio:/source:ro"),
    );
    const rollbackProfileCapture = events.findLastIndex(
      args => args[0] === "run" && args.includes("fake-browser:/source:ro"),
    );
    const destructiveDatabase = events.findIndex(args =>
      args.some(value => value.includes("--single-transaction")),
    );
    const destructiveMinio = events.findIndex(
      args => args[0] === "run" && args.includes("fake-minio:/target"),
    );
    const destructiveProfiles = events.findIndex(
      args => args[0] === "run" && args.includes("fake-browser:/target"),
    );
    const destructiveOrder = [
      rollbackDatabase,
      rollbackMinioCapture,
      rollbackProfileCapture,
      destructiveDatabase,
      destructiveMinio,
      destructiveProfiles,
    ];
    expect(destructiveOrder.every(index => index >= 0)).toBe(true);
    expect(destructiveOrder).toEqual(
      [...new Set(destructiveOrder)].sort((left, right) => left - right),
    );
  });

  test.each([
    "fail-restore-database",
    "fail-restore-minio",
    "fail-restore-profiles",
    "fail-health",
  ])("leaves every writer stopped after %s", failure => {
    const fixture = createProductionCommandFixture(
      failure === "fail-health" ? "running" : "stopped",
    );
    const directory = createBackup(fixture);
    mutateLiveStore(fixture);
    writePrivate(join(fixture.store, failure), "fail\n");

    const result = run(
      restoreScript,
      [directory, "--rollback-output", fixture.backups],
      fixture,
    );
    expect(result.status).not.toBe(0);
    expectAllStopped(fixture);
    expect(generationDirectories(fixture)).toHaveLength(2);
  });

  test("rejects checksum mismatch and leaves writers stopped", () => {
    const fixture = createProductionCommandFixture();
    const directory = createBackup(fixture);
    const files = generationFiles(directory);
    writeFileSync(files.database, "tamper", { flag: "a" });

    const result = run(restoreScript, [directory], fixture);
    expect(result.status).not.toBe(0);
    expectAllStopped(fixture);
  });

  test("rejects a missing archive", () => {
    const fixture = createProductionCommandFixture();
    const directory = createBackup(fixture);
    rmSync(generationFiles(directory).minio);

    const result = run(restoreScript, [directory], fixture);
    expect(result.status).not.toBe(0);
    expectAllStopped(fixture);
  });

  test("rejects an extra generation member", () => {
    const fixture = createProductionCommandFixture();
    const directory = createBackup(fixture);
    writePrivate(join(directory, "unexpected"), "extra\n");

    const result = run(restoreScript, [directory], fixture);
    expect(result.status).not.toBe(0);
    expectAllStopped(fixture);
  });

  test("rejects generation mismatch even with fresh checksums", () => {
    const fixture = createProductionCommandFixture();
    const directory = createBackup(fixture);
    const files = generationFiles(directory);
    writePrivate(
      files.manifest,
      readFileSync(files.manifest, "utf8").replace(
        `generation=${files.generation}`,
        "generation=20000101T000000Z-00000000-0000-4000-8000-000000000000",
      ),
    );
    rewriteChecksums(directory);

    const result = run(restoreScript, [directory], fixture);
    expect(result.status).not.toBe(0);
  });

  test("rejects archive traversal", () => {
    const fixture = createProductionCommandFixture();
    const directory = createBackup(fixture);
    replaceProfilesArchive(
      directory,
      String.raw`
import io, sys, tarfile
with tarfile.open(sys.argv[1], "w:gz") as bundle:
    root = tarfile.TarInfo("profiles")
    root.type = tarfile.DIRTYPE
    root.mode = 0o700
    root.uid = root.gid = 1000
    bundle.addfile(root)
    item = tarfile.TarInfo("../escape")
    item.size = 1
    item.mode = 0o600
    item.uid = item.gid = 1000
    bundle.addfile(item, io.BytesIO(b"x"))
`,
    );

    const result = run(restoreScript, [directory], fixture);
    expect(result.status).not.toBe(0);
  });

  test("rejects absolute archive members", () => {
    const fixture = createProductionCommandFixture();
    const directory = createBackup(fixture);
    replaceProfilesArchive(
      directory,
      String.raw`
import io, sys, tarfile
with tarfile.open(sys.argv[1], "w:gz") as bundle:
    item = tarfile.TarInfo("/escape")
    item.size = 1
    item.mode = 0o600
    item.uid = item.gid = 1000
    bundle.addfile(item, io.BytesIO(b"x"))
`,
    );

    const result = run(restoreScript, [directory], fixture);
    expect(result.status).not.toBe(0);
    expectAllStopped(fixture);
  });

  test("rejects symlink archive members", () => {
    const fixture = createProductionCommandFixture();
    const directory = createBackup(fixture);
    replaceProfilesArchive(
      directory,
      String.raw`
import sys, tarfile
with tarfile.open(sys.argv[1], "w:gz") as bundle:
    root = tarfile.TarInfo("profiles")
    root.type = tarfile.DIRTYPE
    root.mode = 0o700
    root.uid = root.gid = 1000
    bundle.addfile(root)
    link = tarfile.TarInfo("profiles/link")
    link.type = tarfile.SYMTYPE
    link.linkname = "/etc/passwd"
    link.mode = 0o777
    link.uid = link.gid = 1000
    bundle.addfile(link)
`,
    );

    const result = run(restoreScript, [directory], fixture);
    expect(result.status).not.toBe(0);
  });

  test.each([
    [
      "hardlink",
      String.raw`
import sys, tarfile
with tarfile.open(sys.argv[1], "w:gz") as bundle:
    root = tarfile.TarInfo("profiles")
    root.type = tarfile.DIRTYPE
    root.mode = 0o700
    root.uid = root.gid = 1000
    bundle.addfile(root)
    link = tarfile.TarInfo("profiles/link")
    link.type = tarfile.LNKTYPE
    link.linkname = "profiles/target"
    link.mode = 0o600
    link.uid = link.gid = 1000
    bundle.addfile(link)
`,
    ],
    [
      "device",
      String.raw`
import sys, tarfile
with tarfile.open(sys.argv[1], "w:gz") as bundle:
    root = tarfile.TarInfo("profiles")
    root.type = tarfile.DIRTYPE
    root.mode = 0o700
    root.uid = root.gid = 1000
    bundle.addfile(root)
    device = tarfile.TarInfo("profiles/device")
    device.type = tarfile.CHRTYPE
    device.mode = 0o600
    device.uid = device.gid = 1000
    bundle.addfile(device)
`,
    ],
    [
      "profile ownership",
      String.raw`
import io, sys, tarfile
profile = "11111111-1111-4111-8111-111111111111"
generation = "22222222-2222-4222-8222-222222222222"
with tarfile.open(sys.argv[1], "w:gz") as bundle:
    for name in (
        "profiles",
        f"profiles/{profile}",
        f"profiles/{profile}/committed",
        f"profiles/{profile}/committed/{generation}",
    ):
        directory = tarfile.TarInfo(name)
        directory.type = tarfile.DIRTYPE
        directory.mode = 0o700
        directory.uid = directory.gid = 1000
        bundle.addfile(directory)
    item = tarfile.TarInfo(
        f"profiles/{profile}/committed/{generation}/Cookies"
    )
    item.size = 1
    item.mode = 0o666
    item.uid = item.gid = 0
    bundle.addfile(item, io.BytesIO(b"x"))
`,
    ],
  ])("rejects hostile %s archive members", (_label, archive) => {
    const fixture = createProductionCommandFixture();
    const directory = createBackup(fixture);
    replaceProfilesArchive(directory, archive);

    const result = run(restoreScript, [directory], fixture);
    expect(result.status).not.toBe(0);
    expectAllStopped(fixture);
  });

  test("rejects unsafe MinIO ownership and modes", () => {
    const fixture = createProductionCommandFixture();
    const directory = createBackup(fixture);
    replaceMinioArchive(
      directory,
      String.raw`
import io, sys, tarfile
with tarfile.open(sys.argv[1], "w:gz") as bundle:
    root = tarfile.TarInfo(".")
    root.type = tarfile.DIRTYPE
    root.mode = 0o755
    root.uid = root.gid = 0
    bundle.addfile(root)
    item = tarfile.TarInfo("./object")
    item.size = 1
    item.mode = 0o666
    item.uid = item.gid = 1000
    bundle.addfile(item, io.BytesIO(b"x"))
`,
    );

    const result = run(restoreScript, [directory], fixture);
    expect(result.status).not.toBe(0);
    expectAllStopped(fixture);
  });

  test("rejects an archive whose declared size exceeds the bound", () => {
    const fixture = createProductionCommandFixture();
    const directory = createBackup(fixture);
    replaceMinioArchive(
      directory,
      String.raw`
import sys, tarfile
with tarfile.open(sys.argv[1], "w:gz") as bundle:
    root = tarfile.TarInfo(".")
    root.type = tarfile.DIRTYPE
    root.mode = 0o755
    root.uid = root.gid = 0
    bundle.addfile(root)
    item = tarfile.TarInfo("./huge")
    item.size = (1 << 40) + 1
    item.mode = 0o644
    item.uid = item.gid = 0
    bundle.addfile(item)
`,
    );

    const result = run(restoreScript, [directory], fixture);
    expect(result.status).not.toBe(0);
    expectAllStopped(fixture);
  });

  test("rejects database and profile pointer disagreement", () => {
    const fixture = createProductionCommandFixture();
    const directory = createBackup(fixture);
    const files = generationFiles(directory);
    writePrivate(
      files.database,
      `fake-dump-v1\npointer ${profileId} ${alternateGenerationId} profiles/${profileId}/committed/${alternateGenerationId}\n`,
    );
    rewriteChecksums(directory);

    const result = run(restoreScript, [directory], fixture);
    expect(result.status).not.toBe(0);
    expectAllStopped(fixture);
    expect(generationDirectories(fixture)).toHaveLength(1);
  });

  test("rejects a symlink payload before opening it", () => {
    const fixture = createProductionCommandFixture();
    const directory = createBackup(fixture);
    const files = generationFiles(directory);
    renameSync(files.database, `${files.database}.real`);
    symlinkSync(`${basename(files.database)}.real`, files.database);

    const result = run(restoreScript, [directory], fixture);
    expect(result.status).not.toBe(0);
  });

  test("keeps direct lifecycle command dispatch unchanged", () => {
    const fixture = createProductionCommandFixture();
    const result = run(lifecycleScript, [], fixture);
    expect(result.status).toBe(64);
    expect(result.stderr).toContain("Usage: local-firecrawl");
  });

  test("leaves all writers stopped when backup capture fails", () => {
    const fixture = createProductionCommandFixture();
    renameSync(
      join(fixture.store, "database.dump"),
      join(fixture.store, "database.unavailable"),
    );

    const result = run(backupScript, ["--output", fixture.backups], fixture);
    expect(result.status).not.toBe(0);
    expectAllStopped(fixture);
    expect(generationDirectories(fixture)).toHaveLength(0);
  });

  test("rejects a Compose volume with foreign provenance", () => {
    const fixture = createProductionCommandFixture();
    fixture.env.FAKE_BAD_VOLUME_LABEL = "1";

    const result = run(backupScript, ["--output", fixture.backups], fixture);
    expect(result.status).not.toBe(0);
    expectAllStopped(fixture);
    expect(generationDirectories(fixture)).toHaveLength(0);
  });
});
