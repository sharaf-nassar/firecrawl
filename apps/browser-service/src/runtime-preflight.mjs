import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readFileSync,
  realpathSync,
  statfsSync,
} from "node:fs";
import { constants as osConstants } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateToolchainAllowlist } from "../scripts/build-native.mjs";

const nativeDirectoryUrl = new URL(
  "../build/Release/",
  import.meta.url,
);
const nativeLeaf = "atomic_directory_publication.node";
const attestationLeaf = "atomic-directory-publication.node.sha256";
const fixedBuildInputs = [
  new URL("../scripts/run-native-build.mjs", import.meta.url),
  new URL("../scripts/build-native.mjs", import.meta.url),
  new URL("../native/atomic-directory-publication-addon.c", import.meta.url),
  new URL("../native/atomic-directory-publication-errors.c", import.meta.url),
  new URL("../native/atomic-directory-publication-errors.h", import.meta.url),
  new URL("../native/toolchain-allowlist.json", import.meta.url),
];

function nativeArtifactError(message, cause) {
  const error = new Error(`native artifact invalid: ${message}`);
  error.category = "native_artifact_invalid";
  if (cause !== undefined) error.cause = cause;
  return error;
}

export function assertBrowserServiceRuntime(
  version = process.version,
  platform = process.platform,
  arch = process.arch,
) {
  if (
    version !== "v22.22.1" ||
    platform !== "linux" ||
    !["x64", "arm64"].includes(arch)
  ) {
    const error = new Error(
      "browser_service_runtime_mismatch: expected Node v22.22.1 on " +
        `Linux x64|arm64, received ${version} ${platform}/${arch}`,
    );
    error.category = "browser_service_runtime_mismatch";
    throw error;
  }
}

export function validateRuntimeAttestation(attestationBytes, artifactBytes) {
  let value;
  try {
    const text = Buffer.from(attestationBytes).toString("utf8");
    if (!text.endsWith("\n") || text.includes("\r")) {
      throw nativeArtifactError("attestation encoding");
    }
    value = JSON.parse(text);
    if (
      JSON.stringify(Object.keys(value)) !==
        JSON.stringify(["interfaceVersion", "napiVersion", "sha256"]) ||
      value.interfaceVersion !== "1.0.0" ||
      value.napiVersion !== 8 ||
      !/^[0-9a-f]{64}$/.test(value.sha256) ||
      text !== `${JSON.stringify(value)}\n`
    ) {
      throw nativeArtifactError("attestation shape");
    }
  } catch (error) {
    if (error?.category === "native_artifact_invalid") {
      throw error;
    }
    throw nativeArtifactError("attestation JSON");
  }
  const actual = createHash("sha256")
    .update(Buffer.from(artifactBytes))
    .digest("hex");
  if (value.sha256 !== actual) {
    throw nativeArtifactError("attestation digest mismatch");
  }
  return Object.freeze(value);
}

export function assertTrustedBuildInputs() {
  let flockPath;
  let flockStatus;
  try {
    flockPath = realpathSync("/usr/bin/flock");
    flockStatus = lstatSync(flockPath);
  } catch {
    throw nativeArtifactError("canonical flock is unavailable");
  }
  if (
    flockPath !== "/usr/bin/flock" ||
    !flockStatus.isFile() ||
    flockStatus.uid !== 0 ||
    (flockStatus.mode & 0o111) === 0 ||
    (flockStatus.mode & 0o022) !== 0
  ) {
    throw nativeArtifactError("canonical flock identity is untrusted");
  }
  for (const url of fixedBuildInputs) {
    const path = fileURLToPath(url);
    let status;
    try {
      status = lstatSync(path);
    } catch {
      throw nativeArtifactError("fixed build input is missing");
    }
    if (
      !status.isFile() ||
      status.isSymbolicLink() ||
      status.uid !== process.getuid() ||
      status.nlink !== 1 ||
      (status.mode & 0o022) !== 0 ||
      realpathSync(path) !== path
    ) {
      throw nativeArtifactError("fixed build input identity is untrusted");
    }
  }
  validateToolchainAllowlist(
    readFileSync(
      new URL("../native/toolchain-allowlist.json", import.meta.url),
    ),
  );
}

export function validateAtomicNativeModuleShape(value) {
  let descriptors;
  let keys;
  if (value !== null && typeof value === "object") {
    descriptors = Object.getOwnPropertyDescriptors(value);
    keys = Reflect.ownKeys(value);
  }
  if (
    value === null ||
    typeof value !== "object" ||
    keys.some((key) => typeof key !== "string") ||
    JSON.stringify(keys.sort()) !==
      JSON.stringify(["interfaceVersion", "napiVersion", "renameNoReplace"]) ||
    !Object.values(descriptors).every(
      (descriptor) =>
        Object.hasOwn(descriptor, "value") && descriptor.enumerable,
    ) ||
    descriptors.interfaceVersion.value !== "1.0.0" ||
    descriptors.napiVersion.value !== 8 ||
    typeof descriptors.renameNoReplace.value !== "function"
  ) {
    throw nativeArtifactError("module ABI");
  }
  return Object.freeze({
    interfaceVersion: "1.0.0",
    napiVersion: 8,
    renameNoReplace: descriptors.renameNoReplace.value.bind(value),
  });
}

const fullIdentityKeys = [
  "dev",
  "ino",
  "size",
  "mode",
  "uid",
  "gid",
  "nlink",
  "mtimeNs",
  "ctimeNs",
];
const runtimeDirectoryIdentityKeys = [
  "dev",
  "ino",
  "mode",
  "uid",
  "gid",
  "nlink",
];
const maximumSafeLinkCount = BigInt(Number.MAX_SAFE_INTEGER);

function isLiveRuntimeDirectory(status, uid) {
  return (
    status.isDirectory() &&
    status.uid === uid &&
    (status.mode & 0o7777n) === 0o700n &&
    status.nlink >= 1n &&
    status.nlink <= maximumSafeLinkCount
  );
}

function captureRuntimeDirectoryIdentity(fd) {
  const status = fstatSync(fd, { bigint: true });
  const uid = process.getuid?.();
  if (
    uid === undefined ||
    !isLiveRuntimeDirectory(status, BigInt(uid))
  ) {
    throw nativeArtifactError("native directory identity");
  }
  return Object.freeze(
    Object.fromEntries(
      runtimeDirectoryIdentityKeys.map((key) => [key, status[key]]),
    ),
  );
}

function sameRuntimeDirectoryIdentity(fd, expected) {
  const status = fstatSync(fd, { bigint: true });
  return (
    isLiveRuntimeDirectory(status, expected.uid) &&
    runtimeDirectoryIdentityKeys.every(
      (key) => status[key] === expected[key],
    )
  );
}

function assertRuntimeDirectoryTestSeamAvailable() {
  const testEntry = fileURLToPath(
    new URL("./runtime-preflight.test.mjs", import.meta.url),
  );
  if (
    process.env.NODE_TEST_CONTEXT !== "child-v8" ||
    resolve(process.argv[1] ?? "") !== testEntry
  ) {
    throw nativeArtifactError("runtime directory test seam unavailable");
  }
}

export function evaluateRuntimeDirectoryIdentityForTest(candidate, expected) {
  assertRuntimeDirectoryTestSeamAvailable();
  const status = {
    isDirectory: () => candidate.type === "directory",
    dev: candidate.dev,
    ino: candidate.ino,
    size: candidate.size,
    mode: candidate.mode,
    uid: candidate.uid,
    gid: candidate.gid,
    nlink: candidate.nlink,
    mtimeNs: candidate.mtimeNs,
    ctimeNs: candidate.ctimeNs,
  };
  return {
    live: isLiveRuntimeDirectory(status, expected.uid),
    stable:
      isLiveRuntimeDirectory(status, expected.uid) &&
      runtimeDirectoryIdentityKeys.every(
        (key) => status[key] === expected[key],
      ),
  };
}

function captureIdentity(fd, expectedMode, label) {
  const status = fstatSync(fd, { bigint: true });
  const uid = process.getuid?.();
  if (
    uid === undefined ||
    !status.isFile() ||
    status.uid !== BigInt(uid) ||
    (status.mode & 0o7777n) !== BigInt(expectedMode) ||
    status.nlink !== 1n ||
    status.size <= 0n
  ) {
    throw nativeArtifactError(`${label} identity`);
  }
  return Object.freeze(
    Object.fromEntries(fullIdentityKeys.map((key) => [key, status[key]])),
  );
}

function sameIdentity(fd, expected, keys = fullIdentityKeys) {
  const status = fstatSync(fd, { bigint: true });
  return keys.every((key) => status[key] === expected[key]);
}

function readHeldFile(fd, identity, bound, label) {
  if (identity.size > BigInt(bound)) {
    throw nativeArtifactError(`${label} exceeds bound`);
  }
  const bytes = Buffer.alloc(Number(identity.size));
  let offset = 0;
  while (offset < bytes.length) {
    const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
    if (count <= 0) throw nativeArtifactError(`${label} positioned read`);
    offset += count;
  }
  if (!sameIdentity(fd, identity)) {
    throw nativeArtifactError(`${label} identity drift`);
  }
  return bytes;
}

function assertProcfs() {
  const status = statfsSync("/proc", { bigint: true });
  if (status.type !== 0x9fa0n) {
    throw nativeArtifactError("procfs identity");
  }
  const descriptorDirectory = openSync(
    "/proc/self/fd",
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const directoryStatus = fstatSync(descriptorDirectory, { bigint: true });
    if (!directoryStatus.isDirectory()) {
      throw nativeArtifactError("procfd directory identity");
    }
  } finally {
    closeVerified(descriptorDirectory, "procfd directory");
  }
}

function probeProcfd(
  fd,
  expected,
  label,
) {
  assertProcfs();
  const procfd = `/proc/self/fd/${fd}`;
  const fdinfo = readFileSync(`/proc/self/fdinfo/${fd}`, "utf8");
  const flagsMatch = fdinfo.match(/^flags:\s+([0-7]+)$/m);
  const openFlags =
    flagsMatch === null ? undefined : Number.parseInt(flagsMatch[1], 8);
  if (
    openFlags === undefined ||
    (openFlags & constants.O_ACCMODE) !== constants.O_RDONLY ||
    (openFlags & constants.O_NOFOLLOW) !== constants.O_NOFOLLOW ||
    (openFlags & (constants.O_APPEND | constants.O_TRUNC)) !== 0
  ) {
    throw nativeArtifactError(`${label} fdinfo`);
  }
  const probe = openSync(procfd, constants.O_RDONLY);
  try {
    if (!sameIdentity(probe, expected) || !sameIdentity(fd, expected)) {
      throw nativeArtifactError(`${label} procfd identity`);
    }
  } finally {
    closeVerified(probe, `${label} procfd probe`);
  }
}

function linuxDeviceIdentity(device) {
  return Object.freeze({
    major: ((device >> 8n) & 0xfffn) | ((device >> 32n) & 0xfffff000n),
    minor: (device & 0xffn) | ((device >> 12n) & 0xffffff00n),
  });
}

function assertMappedAddon(identity) {
  const device = linuxDeviceIdentity(identity.dev);
  const mappings = [];
  for (const line of readFileSync("/proc/self/maps", "utf8").split("\n")) {
    const match = line.match(
      /^[0-9a-f]+-[0-9a-f]+\s+([-rwxps]{4})\s+[0-9a-f]+\s+([0-9a-f]+):([0-9a-f]+)\s+([0-9]+)(?:\s|$)/,
    );
    if (
      match !== null &&
      BigInt(`0x${match[2]}`) === device.major &&
      BigInt(`0x${match[3]}`) === device.minor &&
      BigInt(match[4]) === identity.ino
    ) {
      mappings.push(match[1]);
    }
  }
  if (
    mappings.length === 0 ||
    !mappings.some((permissions) => permissions.startsWith("r-x")) ||
    mappings.some(
      (permissions) =>
        permissions.includes("w") && permissions.includes("x"),
    )
  ) {
    throw nativeArtifactError("native addon process maps");
  }
}

function closeVerified(fd, label) {
  try {
    closeSync(fd);
  } catch (error) {
    throw nativeArtifactError(`${label} close`, error);
  }
  try {
    fstatSync(fd);
    throw nativeArtifactError(`${label} close verification`);
  } catch (error) {
    if (error?.code !== "EBADF") throw error;
  }
}

let nativeLoaderState = "uninitialized";
let nativeLoaderValue;
let nativeLoaderFailure;

function freezeLoaderFailure(error) {
  const failure = nativeArtifactError(
    error?.category === "native_artifact_invalid"
      ? error.message.slice("native artifact invalid: ".length)
      : "held native load failed",
  );
  return Object.freeze(failure);
}

export function loadAtomicDirectoryPublicationNativeHeld() {
  if (nativeLoaderState === "loaded") return nativeLoaderValue;
  if (nativeLoaderState === "failed") throw nativeLoaderFailure;
  if (nativeLoaderState === "loading") {
    const failure = Object.freeze(
      nativeArtifactError("reentrant held native load"),
    );
    nativeLoaderFailure = failure;
    nativeLoaderState = "failed";
    throw failure;
  }
  nativeLoaderState = "loading";
  const owned = [];
  try {
    if (
      process.platform !== "linux" ||
      !["x64", "arm64"].includes(process.arch) ||
      process.version !== "v22.22.1" ||
      Number(process.versions.napi) < 8
    ) {
      throw nativeArtifactError("unsupported held native runtime");
    }
    assertProcfs();
    const directoryFd = openSync(
      fileURLToPath(nativeDirectoryUrl),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    owned.push([directoryFd, "native directory"]);
    const directoryIdentity =
      captureRuntimeDirectoryIdentity(directoryFd);
    const directoryProcfd = `/proc/self/fd/${directoryFd}`;
    const addonFd = openSync(
      `${directoryProcfd}/${nativeLeaf}`,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    owned.push([addonFd, "native addon"]);
    const addonIdentity = captureIdentity(addonFd, 0o600, "native addon");
    const checksumFd = openSync(
      `${directoryProcfd}/${attestationLeaf}`,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    owned.push([checksumFd, "native checksum"]);
    const checksumIdentity = captureIdentity(
      checksumFd,
      0o600,
      "native checksum",
    );
    const addonBytes = readHeldFile(
      addonFd,
      addonIdentity,
      16 * 1024 * 1024,
      "native addon",
    );
    if (
      addonBytes.length < 64 ||
      !addonBytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
    ) {
      throw nativeArtifactError("native addon ELF");
    }
    const checksumBytes = readHeldFile(
      checksumFd,
      checksumIdentity,
      4096,
      "native checksum",
    );
    validateRuntimeAttestation(checksumBytes, addonBytes);
    probeProcfd(addonFd, addonIdentity, "native addon");
    const moduleRecord = { exports: Object.create(null) };
    process.dlopen(
      moduleRecord,
      `/proc/self/fd/${addonFd}`,
      osConstants.dlopen.RTLD_NOW,
    );
    if (nativeLoaderState !== "loading") {
      throw nativeLoaderFailure;
    }
    probeProcfd(addonFd, addonIdentity, "native addon post-load");
    assertMappedAddon(addonIdentity);
    const postLoadBytes = Buffer.alloc(addonBytes.length);
    let postLoadOffset = 0;
    while (postLoadOffset < postLoadBytes.length) {
      const count = readSync(
        addonFd,
        postLoadBytes,
        postLoadOffset,
        postLoadBytes.length - postLoadOffset,
        postLoadOffset,
      );
      if (count <= 0) {
        throw nativeArtifactError("native addon post-load positioned read");
      }
      postLoadOffset += count;
    }
    if (!postLoadBytes.equals(addonBytes)) {
      throw nativeArtifactError("native addon post-load bytes changed");
    }
    if (!sameIdentity(addonFd, addonIdentity)) {
      throw nativeArtifactError("native addon post-load identity drift");
    }
    if (!sameRuntimeDirectoryIdentity(directoryFd, directoryIdentity)) {
      throw nativeArtifactError("native directory identity drift");
    }
    const wrapper = validateAtomicNativeModuleShape(moduleRecord.exports);
    while (owned.length > 0) {
      const [fd, label] = owned.pop();
      closeVerified(fd, label);
    }
    nativeLoaderValue = wrapper;
    nativeLoaderState = "loaded";
    return nativeLoaderValue;
  } catch (error) {
    let closeFailure;
    while (owned.length > 0) {
      const [fd, label] = owned.pop();
      try {
        closeVerified(fd, label);
      } catch (candidate) {
        closeFailure ??= candidate;
      }
    }
    if (nativeLoaderState !== "failed" || nativeLoaderFailure === undefined) {
      nativeLoaderFailure = freezeLoaderFailure(closeFailure ?? error);
      nativeLoaderState = "failed";
    }
    throw nativeLoaderFailure;
  }
}

export function assertNativeRuntimeArtifact() {
  loadAtomicDirectoryPublicationNativeHeld();
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  assertBrowserServiceRuntime();
  const phase = process.argv[2] ?? "--phase=preinstall";
  if (!["--phase=preinstall", "--phase=prestart"].includes(phase)) {
    throw new Error(`browser_service_preflight_phase_invalid: ${phase}`);
  }
  if (phase === "--phase=prestart") {
    assertNativeRuntimeArtifact();
  } else {
    assertTrustedBuildInputs();
  }
}
