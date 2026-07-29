import { constants } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  realpath,
  unlink,
} from "node:fs/promises";
import { dirname } from "node:path";

const FIXED_SOCKET_PATH = "/run/firecrawl-interaction/worker.sock";
const FIXED_CODEX_BIN = "/opt/codex/bin/codex.js";
const FIXED_CODEX_HOME = "/tmp/codex-home";
const FIXED_CODEX_AUTH_SEED_FILE = "/run/secrets/codex-auth.json";
const FIXED_CODEX_AUTH_STATE_DIR = "/var/lib/firecrawl-codex-auth-state";
const FIXED_EGRESS_PROXY_SOCKET_PATH =
  "/run/firecrawl-model-egress/proxy.sock";
const FIXED_EGRESS_PROXY_URL = "http://127.0.0.1:3128";

function canonicalInteger(name, value, fallback, minimum, maximum) {
  const selected = value ?? String(fallback);
  if (!/^(?:0|[1-9]\d*)$/.test(selected)) {
    throw new TypeError(`${name} must be a canonical decimal integer`);
  }
  const parsed = Number(selected);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new RangeError(`${name} is outside its supported range`);
  }
  return parsed;
}

function fixedPath(name, value, expected) {
  const selected = value ?? expected;
  if (selected !== expected) {
    throw new TypeError(`${name} must be ${expected}`);
  }
  return selected;
}

export function readConfig(env = process.env) {
  const token = env.BROWSER_INTERACTION_WORKER_TOKEN;
  const tokenBytes =
    typeof token === "string" ? Buffer.byteLength(token, "utf8") : 0;
  if (tokenBytes < 32 || tokenBytes > 4_000) {
    throw new RangeError(
      "BROWSER_INTERACTION_WORKER_TOKEN must be 32..4000 UTF-8 bytes",
    );
  }
  for (const name of [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "http_proxy",
    "https_proxy",
  ]) {
    if (env[name] !== FIXED_EGRESS_PROXY_URL) {
      throw new TypeError(`${name} must be ${FIXED_EGRESS_PROXY_URL}`);
    }
  }
  for (const name of ["NO_PROXY", "no_proxy"]) {
    if (env[name] !== "") {
      throw new TypeError(`${name} must be empty`);
    }
  }
  return Object.freeze({
    socketPath: fixedPath(
      "BROWSER_INTERACTION_WORKER_SOCKET_PATH",
      env.BROWSER_INTERACTION_WORKER_SOCKET_PATH,
      FIXED_SOCKET_PATH,
    ),
    token,
    codexBin: fixedPath("CODEX_BIN", env.CODEX_BIN, FIXED_CODEX_BIN),
    codexHome: fixedPath("CODEX_HOME", env.CODEX_HOME, FIXED_CODEX_HOME),
    codexAuthSeedFile: fixedPath(
      "CODEX_AUTH_SEED_FILE",
      env.CODEX_AUTH_SEED_FILE,
      FIXED_CODEX_AUTH_SEED_FILE,
    ),
    codexAuthStateDir: fixedPath(
      "CODEX_AUTH_STATE_DIR",
      env.CODEX_AUTH_STATE_DIR,
      FIXED_CODEX_AUTH_STATE_DIR,
    ),
    egressProxySocketPath: fixedPath(
      "MODEL_EGRESS_PROXY_SOCKET_PATH",
      env.MODEL_EGRESS_PROXY_SOCKET_PATH,
      FIXED_EGRESS_PROXY_SOCKET_PATH,
    ),
    egressProxyHost: "127.0.0.1",
    egressProxyPort: 3128,
    decisionTimeoutMs: canonicalInteger(
      "BROWSER_INTERACTION_DECISION_TIMEOUT_MS",
      env.BROWSER_INTERACTION_DECISION_TIMEOUT_MS,
      120_000,
      5_000,
      300_000,
    ),
    maxConcurrentRuns: canonicalInteger(
      "BROWSER_INTERACTION_MAX_CONCURRENT_RUNS",
      env.BROWSER_INTERACTION_MAX_CONCURRENT_RUNS,
      4,
      1,
      32,
    ),
  });
}

export async function preflightConfig(config) {
  const codexStatus = await lstat(config.codexBin);
  if (!codexStatus.isFile() || codexStatus.isSymbolicLink()) {
    throw new Error("Codex entrypoint is not a regular file");
  }
  await access(config.codexBin, constants.R_OK);

  const authStatus = await lstat(config.codexAuthSeedFile);
  if (
    !authStatus.isFile() ||
    authStatus.isSymbolicLink() ||
    authStatus.size <= 0 ||
    authStatus.size > 1024 * 1024
  ) {
    throw new Error("Codex auth secret is not a bounded regular file");
  }
  await access(config.codexAuthSeedFile, constants.R_OK);

  await mkdir(config.codexHome, { mode: 0o700, recursive: true });
  const homePath = await realpath(config.codexHome);
  if (homePath !== config.codexHome) {
    throw new Error("CODEX_HOME must not traverse symbolic links");
  }
  const homeStatus = await lstat(homePath);
  if (!homeStatus.isDirectory() || homeStatus.isSymbolicLink()) {
    throw new Error("CODEX_HOME is not a directory");
  }
  await access(homePath, constants.R_OK | constants.W_OK | constants.X_OK);

  await mkdir(config.codexAuthStateDir, { mode: 0o700, recursive: true });
  const authStatePath = await realpath(config.codexAuthStateDir);
  if (authStatePath !== config.codexAuthStateDir) {
    throw new Error("CODEX_AUTH_STATE_DIR must not traverse symbolic links");
  }
  const authStateStatus = await lstat(authStatePath);
  if (!authStateStatus.isDirectory() || authStateStatus.isSymbolicLink()) {
    throw new Error("CODEX_AUTH_STATE_DIR is not a directory");
  }
  await access(
    authStatePath,
    constants.R_OK | constants.W_OK | constants.X_OK,
  );

  const socketDirectory = dirname(config.socketPath);
  await mkdir(socketDirectory, { mode: 0o770, recursive: true });
  const socketDirectoryPath = await realpath(socketDirectory);
  if (socketDirectoryPath !== socketDirectory) {
    throw new Error("interaction socket directory must not traverse symlinks");
  }
  const socketDirectoryStatus = await lstat(socketDirectoryPath);
  if (
    !socketDirectoryStatus.isDirectory() ||
    socketDirectoryStatus.isSymbolicLink() ||
    socketDirectoryStatus.uid !== process.getuid() ||
    socketDirectoryStatus.gid !== process.getgid()
  ) {
    throw new Error("interaction socket directory ownership is unsafe");
  }
  await chmod(socketDirectoryPath, 0o770);
  await access(
    socketDirectoryPath,
    constants.R_OK | constants.W_OK | constants.X_OK,
  );

  let staleSocket;
  try {
    staleSocket = await lstat(config.socketPath);
  } catch (cause) {
    if (cause?.code !== "ENOENT") throw cause;
  }
  if (staleSocket !== undefined) {
    if (
      !staleSocket.isSocket() ||
      staleSocket.isSymbolicLink() ||
      staleSocket.uid !== process.getuid() ||
      staleSocket.gid !== process.getgid()
    ) {
      throw new Error("existing interaction socket is unsafe");
    }
    await unlink(config.socketPath);
  }
}
