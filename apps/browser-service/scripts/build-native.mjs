import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  chmodSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const repositoryRoot = resolve(packageRoot, "../..");
const stage = "build/.atomic-directory-publication-stage";
const stageAbsolute = resolve(packageRoot, stage);
const buildAbsolute = resolve(packageRoot, "build");
const lockAbsolute = resolve(
  buildAbsolute,
  ".atomic-directory-publication-build.lock",
);
const nativeAbsolute = resolve(packageRoot, "native");
const exactEnvironment = Object.freeze({
  PATH: "/usr/bin:/bin",
  LC_ALL: "C",
  LANG: "C",
  TZ: "UTC",
  SOURCE_DATE_EPOCH: "1",
  ATOMIC_BUILD_LOCK_FD: "9",
});
const childStdio = (stdout = "pipe", stderr = "pipe") => [
  "ignore",
  stdout,
  stderr,
  "ignore",
  "ignore",
  "ignore",
  "ignore",
  "ignore",
  "ignore",
  9,
];

function fail(message) {
  throw new Error(`atomic native build: ${message}`);
}

export function createCompilerEnvironment() {
  return Object.assign(Object.create(null), exactEnvironment);
}

export function assertExactBuildEnvironment(environment = process.env) {
  if (
    JSON.stringify(Object.keys(environment).sort()) !==
      JSON.stringify(Object.keys(exactEnvironment).sort()) ||
    Object.entries(exactEnvironment).some(
      ([key, value]) => environment[key] !== value,
    )
  ) {
    fail("inherited build environment is not the exact closed set");
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function hashFile(path) {
  return sha256(readFileSync(path));
}

function rawPathCompare(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function exactKeys(value, expected, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value)) !== JSON.stringify(expected)
  ) {
    fail(`${label} allowlist keys are invalid`);
  }
}

function rejectDuplicateJsonKeys(text) {
  const stack = [];
  let index = 0;
  let expectingObjectKey = false;
  const skipWhitespace = () => {
    while (/\s/.test(text[index] ?? "")) index++;
  };
  const readString = () => {
    const start = index;
    index++;
    while (index < text.length) {
      if (text[index] === "\\") {
        index += 2;
      } else if (text[index] === '"') {
        index++;
        return JSON.parse(text.slice(start, index));
      } else {
        index++;
      }
    }
    fail("toolchain allowlist JSON string is unterminated");
  };
  while (index < text.length) {
    skipWhitespace();
    const byte = text[index];
    if (byte === "{") {
      stack.push({ kind: "object", keys: new Set() });
      expectingObjectKey = true;
      index++;
    } else if (byte === "[") {
      stack.push({ kind: "array" });
      expectingObjectKey = false;
      index++;
    } else if (byte === "}" || byte === "]") {
      stack.pop();
      expectingObjectKey = false;
      index++;
    } else if (byte === ",") {
      expectingObjectKey = stack.at(-1)?.kind === "object";
      index++;
    } else if (byte === ":") {
      expectingObjectKey = false;
      index++;
    } else if (byte === '"') {
      const value = readString();
      skipWhitespace();
      if (expectingObjectKey && text[index] === ":") {
        const frame = stack.at(-1);
        if (frame.keys.has(value)) {
          fail(`toolchain allowlist contains duplicate key ${value}`);
        }
        frame.keys.add(value);
      }
    } else {
      index++;
    }
  }
  if (stack.length !== 0) {
    fail("toolchain allowlist JSON nesting is malformed");
  }
}

export function validateToolchainAllowlist(bytes) {
  let value;
  try {
    const text = Buffer.from(bytes).toString("utf8");
    if (!text.endsWith("\n") || text.includes("\r")) {
      fail("toolchain allowlist is not canonical UTF-8");
    }
    rejectDuplicateJsonKeys(text);
    value = JSON.parse(text);
    if (text !== `${JSON.stringify(value)}\n`) {
      fail("toolchain allowlist bytes are not canonical");
    }
  } catch (error) {
    if (String(error?.message).includes("allowlist")) {
      throw error;
    }
    fail("toolchain allowlist JSON is malformed");
  }
  exactKeys(value, ["schemaVersion", "dockerInit"], "top-level");
  if (value.schemaVersion !== 1) {
    fail("toolchain allowlist schemaVersion is invalid");
  }
  exactKeys(value.dockerInit, ["amd64", "arm64"], "dockerInit");
  const tupleKeys = [
    "targetArch",
    "nodeBaseRepository",
    "nodeBaseIndexDigest",
    "nodeBasePlatformDigest",
    "osReleaseSha256",
    "dpkgArchitecture",
    "utilLinuxPackage",
    "utilLinuxVersion",
    "flockRealpath",
    "flockSha256",
  ];
  for (const architecture of ["amd64", "arm64"]) {
    const tuple = value.dockerInit[architecture];
    exactKeys(tuple, tupleKeys, architecture);
    for (const key of tupleKeys) {
      if (
        typeof tuple[key] !== "string" ||
        tuple[key].length === 0 ||
        /[{}*<>]/.test(tuple[key])
      ) {
        fail(`${architecture} allowlist value is mutable or empty`);
      }
    }
    if (
      tuple.targetArch !== architecture ||
      tuple.dpkgArchitecture !== architecture ||
      tuple.utilLinuxPackage !== "util-linux" ||
      tuple.flockRealpath !== "/usr/bin/flock" ||
      !/^sha256:[0-9a-f]{64}$/.test(tuple.nodeBaseIndexDigest) ||
      !/^sha256:[0-9a-f]{64}$/.test(tuple.nodeBasePlatformDigest) ||
      !/^[0-9a-f]{64}$/.test(tuple.osReleaseSha256) ||
      !/^[0-9a-f]{64}$/.test(tuple.flockSha256)
    ) {
      fail(`${architecture} toolchain allowlist tuple is invalid`);
    }
  }
  if (
    JSON.stringify(value.dockerInit.amd64) ===
    JSON.stringify(value.dockerInit.arm64)
  ) {
    fail("dockerInit tuples are duplicated");
  }
  return value;
}

export function assertSupportedBuildRuntime({
  platform = process.platform,
  arch = process.arch,
  version = process.version,
} = {}) {
  if (
    platform !== "linux" ||
    !["x64", "arm64"].includes(arch) ||
    version !== "v22.22.1"
  ) {
    fail("unsupported build runtime");
  }
}

function canonicalNativeSource(name) {
  const path = realpathSync(resolve(nativeAbsolute, name));
  if (!path.startsWith(`${nativeAbsolute}${sep}`)) {
    fail("native source escaped package root");
  }
  return path;
}

function compileGraph(compiler, nodeInclude) {
  const addonSource = canonicalNativeSource(
    "atomic-directory-publication-addon.c",
  );
  const errorsSource = canonicalNativeSource(
    "atomic-directory-publication-errors.c",
  );
  const testHooksSource = canonicalNativeSource(
    "atomic-directory-publication-test-hooks.c",
  );
  const errnoMainSource = canonicalNativeSource(
    "atomic-directory-publication-errors.test.c",
  );
  const productionAddon = [
    compiler,
    "-fPIC",
    "-std=c11",
    "-DNAPI_VERSION=8",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-O2",
    "-MD",
  ];
  const testAddon = [
    compiler,
    "-fPIC",
    "-std=c11",
    "-DNAPI_VERSION=8",
    "-DATOMIC_PUBLISH_TEST_HOOKS=1",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-O2",
    "-MD",
  ];
  const errno = [
    compiler,
    "-std=c11",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-O2",
    "-MD",
  ];
  const specs = [
    {
      kind: "production-addon",
      depfile: `${stage}/obj/production/addon.d`,
      output: `${stage}/obj/production/addon.o`,
      args: [
        ...productionAddon,
        "-I",
        nodeInclude,
        "-MF",
        `${stage}/obj/production/addon.d`,
        "-c",
        addonSource,
        "-o",
        `${stage}/obj/production/addon.o`,
      ],
    },
    {
      kind: "production-errors",
      depfile: `${stage}/obj/production/errors.d`,
      output: `${stage}/obj/production/errors.o`,
      args: [
        ...productionAddon,
        "-I",
        nodeInclude,
        "-MF",
        `${stage}/obj/production/errors.d`,
        "-c",
        errorsSource,
        "-o",
        `${stage}/obj/production/errors.o`,
      ],
    },
    {
      kind: "test-addon",
      depfile: `${stage}/obj/test/addon.d`,
      output: `${stage}/obj/test/addon.o`,
      args: [
        ...testAddon,
        "-I",
        nodeInclude,
        "-MF",
        `${stage}/obj/test/addon.d`,
        "-c",
        addonSource,
        "-o",
        `${stage}/obj/test/addon.o`,
      ],
    },
    {
      kind: "test-errors",
      depfile: `${stage}/obj/test/errors.d`,
      output: `${stage}/obj/test/errors.o`,
      args: [
        ...testAddon,
        "-I",
        nodeInclude,
        "-MF",
        `${stage}/obj/test/errors.d`,
        "-c",
        errorsSource,
        "-o",
        `${stage}/obj/test/errors.o`,
      ],
    },
    {
      kind: "test-hooks",
      depfile: `${stage}/obj/test/test-hooks.d`,
      output: `${stage}/obj/test/test-hooks.o`,
      args: [
        ...testAddon,
        "-I",
        nodeInclude,
        "-MF",
        `${stage}/obj/test/test-hooks.d`,
        "-c",
        testHooksSource,
        "-o",
        `${stage}/obj/test/test-hooks.o`,
      ],
    },
    {
      kind: "errno-main",
      depfile: `${stage}/obj/errno-test/main.d`,
      output: `${stage}/obj/errno-test/main.o`,
      args: [
        ...errno,
        "-MF",
        `${stage}/obj/errno-test/main.d`,
        "-c",
        errnoMainSource,
        "-o",
        `${stage}/obj/errno-test/main.o`,
      ],
    },
    {
      kind: "errno-alias",
      depfile: `${stage}/obj/errno-test/errors-alias.d`,
      output: `${stage}/obj/errno-test/errors-alias.o`,
      args: [
        ...errno,
        "-DATOMIC_PUBLISH_ERRNO_VARIANT_ALIAS=1",
        "-Datomic_publish_map_errno=atomic_publish_map_errno_alias",
        "-MF",
        `${stage}/obj/errno-test/errors-alias.d`,
        "-c",
        errorsSource,
        "-o",
        `${stage}/obj/errno-test/errors-alias.o`,
      ],
    },
    {
      kind: "errno-distinct",
      depfile: `${stage}/obj/errno-test/errors-distinct.d`,
      output: `${stage}/obj/errno-test/errors-distinct.o`,
      args: [
        ...errno,
        "-DATOMIC_PUBLISH_ERRNO_VARIANT_DISTINCT=1",
        "-Datomic_publish_map_errno=atomic_publish_map_errno_distinct",
        "-MF",
        `${stage}/obj/errno-test/errors-distinct.d`,
        "-c",
        errorsSource,
        "-o",
        `${stage}/obj/errno-test/errors-distinct.o`,
      ],
    },
  ];
  const links = [
    {
      kind: "production",
      output: `${stage}/Release/atomic_directory_publication.node`,
      map: `${stage}/Release/atomic_directory_publication.map`,
      trace: `${stage}/Release/atomic_directory_publication.trace`,
      args: [
        compiler,
        "-shared",
        `-Wl,-Map,${stage}/Release/atomic_directory_publication.map`,
        "-Wl,--trace",
        `${stage}/obj/production/addon.o`,
        `${stage}/obj/production/errors.o`,
        "-o",
        `${stage}/Release/atomic_directory_publication.node`,
      ],
    },
    {
      kind: "test-addon",
      output: `${stage}/Test/atomic_directory_publication_test.node`,
      map: `${stage}/Test/atomic_directory_publication_test.map`,
      trace: `${stage}/Test/atomic_directory_publication_test.trace`,
      args: [
        compiler,
        "-shared",
        `-Wl,-Map,${stage}/Test/atomic_directory_publication_test.map`,
        "-Wl,--trace",
        `${stage}/obj/test/addon.o`,
        `${stage}/obj/test/errors.o`,
        `${stage}/obj/test/test-hooks.o`,
        "-o",
        `${stage}/Test/atomic_directory_publication_test.node`,
      ],
    },
    {
      kind: "errno",
      output: `${stage}/Test/atomic-directory-publication-errors.test`,
      map: `${stage}/Test/atomic-directory-publication-errors.map`,
      trace: `${stage}/Test/atomic-directory-publication-errors.trace`,
      args: [
        compiler,
        `-Wl,-Map,${stage}/Test/atomic-directory-publication-errors.map`,
        "-Wl,--trace",
        `${stage}/obj/errno-test/main.o`,
        `${stage}/obj/errno-test/errors-alias.o`,
        `${stage}/obj/errno-test/errors-distinct.o`,
        "-o",
        `${stage}/Test/atomic-directory-publication-errors.test`,
      ],
    },
  ];
  return { compiles: specs, links };
}

function verifyLock() {
  if (process.env.ATOMIC_BUILD_LOCK_FD !== "9") {
    fail("direct invocation is forbidden");
  }
  let descriptor;
  let path;
  try {
    descriptor = fstatSync(9);
    path = lstatSync(lockAbsolute);
    lstatSync("/proc/self/fd/9");
  } catch {
    fail("inherited build lock is unavailable");
  }
  if (
    !descriptor.isFile() ||
    !path.isFile() ||
    descriptor.dev !== path.dev ||
    descriptor.ino !== path.ino ||
    descriptor.uid !== process.getuid() ||
    (descriptor.mode & 0o7777) !== 0o600 ||
    descriptor.nlink !== 1
  ) {
    fail("inherited build lock identity is invalid");
  }
}

function selectCompiler() {
  for (const variable of [
    "CC",
    "CFLAGS",
    "CPPFLAGS",
    "LDFLAGS",
    "npm_config_cc",
    "npm_config_cflags",
    "npm_config_cppflags",
    "npm_config_ldflags",
  ]) {
    if (process.env[variable] !== undefined) {
      fail(`caller compiler variable ${variable} is forbidden`);
    }
  }
  if (existsSync("/usr/bin/gcc")) {
    const status = statSync("/usr/bin/gcc");
    if (!status.isFile() || (status.mode & 0o111) === 0) {
      fail("/usr/bin/gcc is not an executable regular file");
    }
    return "/usr/bin/gcc";
  }
  const candidate = realpathSync("/usr/bin/cc");
  if (
    !candidate.startsWith("/usr/bin/") ||
    !statSync(candidate).isFile() ||
    (statSync(candidate).mode & 0o111) === 0
  ) {
    fail("canonical /usr/bin/cc fallback is invalid");
  }
  return candidate;
}

function deriveNodeInclude() {
  const executable = realpathSync(process.execPath);
  const prefix = dirname(dirname(executable));
  const include = realpathSync(resolve(prefix, "include/node"));
  for (const header of ["node_api.h", "node_api_types.h", "node_version.h"]) {
    const path = realpathSync(resolve(include, header));
    if (!path.startsWith(`${include}${sep}`) || !statSync(path).isFile()) {
      fail(`required Node header ${header} is invalid`);
    }
  }
  return { executable, include };
}

function verifyOwnedDirectory(path, mode = 0o700) {
  const status = lstatSync(path);
  if (
    !status.isDirectory() ||
    status.isSymbolicLink() ||
    status.uid !== process.getuid() ||
    (status.mode & 0o7777) !== mode ||
    status.nlink < 2
  ) {
    fail(`foreign directory ${relative(packageRoot, path)}`);
  }
}

function ensureDirectory(path) {
  try {
    mkdirSync(path, { mode: 0o700, recursive: false });
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw error;
    }
  }
  verifyOwnedDirectory(path);
}

function inspectStaleTree(
  path,
  allowedDirectories,
  allowedFiles,
  observed,
  root = stageAbsolute,
) {
  const status = lstatSync(path);
  const relativePath = relative(root, path);
  const actualMode = status.mode & 0o7777;
  const expectedFileModes = relativePath.endsWith(
    "atomic-directory-publication-errors.test",
  )
    ? [0o700]
    : relativePath.endsWith(".node")
      ? [0o600, 0o700]
      : [0o600];
  const knownDirectory =
    status.isDirectory() && allowedDirectories.has(relativePath);
  const knownFile = status.isFile() && allowedFiles.has(relativePath);
  if (
    status.isSymbolicLink() ||
    status.uid !== process.getuid() ||
    (!knownDirectory && !knownFile) ||
    (knownDirectory && (status.mode & 0o7777) !== 0o700) ||
    (knownFile &&
      (!expectedFileModes.includes(actualMode) || status.nlink !== 1))
  ) {
    fail("foreign stale staging state");
  }
  if (knownDirectory) {
    observed.directories.set(
      relativePath,
      Object.freeze({
        dev: status.dev,
        ino: status.ino,
        uid: status.uid,
        mode: status.mode,
        nlink: status.nlink,
      }),
    );
    for (const name of readdirSync(path)) {
      inspectStaleTree(
        join(path, name),
        allowedDirectories,
        allowedFiles,
        observed,
        root,
      );
    }
  } else {
    observed.files.set(
      relativePath,
      Object.freeze({
        dev: status.dev,
        ino: status.ino,
        uid: status.uid,
        mode: status.mode,
        nlink: status.nlink,
        size: status.size,
      }),
    );
  }
}

function removeVerifiedStaleTree(
  observed,
  root = stageAbsolute,
  afterRemoval,
) {
  for (const relativePath of [...observed.files.keys()].sort((left, right) => {
    const leftDepth = left === "" ? 0 : left.split("/").length;
    const rightDepth = right === "" ? 0 : right.split("/").length;
    const depth = rightDepth - leftDepth;
    return depth || rawPathCompare(left, right);
  })) {
    const absolute = resolve(root, relativePath);
    const expected = observed.files.get(relativePath);
    const fd = openSync(
      absolute,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      for (const status of [fstatSync(fd), lstatSync(absolute)]) {
        if (
          expected === undefined ||
          !status.isFile() ||
          status.isSymbolicLink() ||
          status.dev !== expected.dev ||
          status.ino !== expected.ino ||
          status.uid !== expected.uid ||
          status.mode !== expected.mode ||
          status.nlink !== expected.nlink ||
          status.size !== expected.size
        ) {
          fail("stale staging identity changed before cleanup");
        }
      }
      unlinkSync(absolute);
      try {
        lstatSync(absolute);
        fail("stale staging leaf remained after cleanup");
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      const held = fstatSync(fd);
      if (held.dev !== expected.dev || held.ino !== expected.ino) {
        fail("stale staging held identity changed during cleanup");
      }
    } finally {
      closeSync(fd);
    }
    fsyncDirectory(dirname(absolute));
    afterRemoval?.("file", relativePath);
  }
  for (const relativePath of [...observed.directories.keys()].sort((left, right) => {
    const leftDepth = left === "" ? 0 : left.split("/").length;
    const rightDepth = right === "" ? 0 : right.split("/").length;
    const depth = rightDepth - leftDepth;
    return depth || rawPathCompare(left, right);
  })) {
    const absolute =
      relativePath === "" ? root : resolve(root, relativePath);
    const expected = observed.directories.get(relativePath);
    const fd = openSync(
      absolute,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      for (const status of [fstatSync(fd), lstatSync(absolute)]) {
        if (
          expected === undefined ||
          !status.isDirectory() ||
          status.isSymbolicLink() ||
          status.dev !== expected.dev ||
          status.ino !== expected.ino ||
          status.uid !== expected.uid ||
          status.mode !== expected.mode ||
          status.nlink < 2
        ) {
          fail("stale staging directory identity changed before cleanup");
        }
      }
      if (readdirSync(absolute).length !== 0) {
        fail(
          `stale staging directory is not empty after verified cleanup: ${relativePath}`,
        );
      }
      rmdirSync(absolute);
      try {
        lstatSync(absolute);
        fail("stale staging directory remained after cleanup");
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      const held = fstatSync(fd);
      if (held.dev !== expected.dev || held.ino !== expected.ino) {
        fail("stale staging held directory changed during cleanup");
      }
    } finally {
      closeSync(fd);
    }
    fsyncDirectory(dirname(absolute));
    afterRemoval?.("directory", relativePath);
  }
}

function fsyncDirectory(path) {
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function captureDirectoryIdentity(path, mode) {
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const status = fstatSync(fd);
    if (
      !status.isDirectory() ||
      status.isSymbolicLink() ||
      status.uid !== process.getuid() ||
      (mode !== undefined && (status.mode & 0o7777) !== mode) ||
      status.nlink < 2
    ) {
      fail(`build directory ${relative(packageRoot, path)} is invalid`);
    }
    return Object.freeze({
      dev: status.dev,
      ino: status.ino,
      uid: status.uid,
      mode: status.mode,
      nlink: status.nlink,
    });
  } finally {
    closeSync(fd);
  }
}

function captureBuildDirectoryChain(paths) {
  return new Map(
    paths.map(({ path, mode }) => [
      path,
      captureDirectoryIdentity(path, mode),
    ]),
  );
}

function verifyBuildDirectoryChainAndSync(evidence) {
  const paths = [...evidence.keys()].sort((left, right) => {
    const depth =
      right.split(sep).length - left.split(sep).length;
    return depth || rawPathCompare(left, right);
  });
  for (const path of paths) {
    const fd = openSync(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const status = fstatSync(fd);
      const expected = evidence.get(path);
      if (
        expected === undefined ||
        !status.isDirectory() ||
        status.isSymbolicLink() ||
        status.dev !== expected.dev ||
        status.ino !== expected.ino ||
        status.uid !== expected.uid ||
        status.mode !== expected.mode ||
        status.nlink !== expected.nlink
      ) {
        fail(`build directory ${relative(packageRoot, path)} identity changed`);
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}

function precreate(path, mode = 0o600) {
  const absolute = resolve(packageRoot, path);
  const fd = openSync(
    absolute,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    mode,
  );
  const status = fstatSync(fd);
  if (
    !status.isFile() ||
    status.uid !== process.getuid() ||
    (status.mode & 0o7777) !== mode ||
    status.nlink !== 1
  ) {
    closeSync(fd);
    fail(`staging leaf ${path} failed validation`);
  }
  return fd;
}

function verifyGeneratedLeaf(path, mode = 0o600) {
  const absolute = resolve(packageRoot, path);
  const fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const status = fstatSync(fd);
    if (
      !status.isFile() ||
      status.uid !== process.getuid() ||
      (status.mode & 0o7777) !== mode ||
      status.nlink !== 1 ||
      status.size <= 0
    ) {
      fail(`generated leaf ${path} is invalid`);
    }
    fsyncSync(fd);
    return Object.freeze({
      dev: status.dev,
      ino: status.ino,
      uid: status.uid,
      mode: status.mode,
      nlink: status.nlink,
      size: status.size,
      sha256: sha256(readFileSync(fd)),
    });
  } finally {
    closeSync(fd);
  }
}

function validateCompileResult(entry, context) {
  const output = verifyGeneratedLeaf(entry.output);
  const depfile = verifyGeneratedLeaf(entry.depfile);
  const dependencies = parseDepfile(entry.depfile);
  const allowedRoots = [
    nativeAbsolute,
    context.node.include,
    "/usr/include",
    context.compilerInclude,
  ];
  const sourceIndex = entry.args.indexOf("-c") + 1;
  const expectedSource = entry.args[sourceIndex];
  if (
    sourceIndex === 0 ||
    !dependencies.includes(expectedSource) ||
    dependencies.some(
      (path) =>
        !allowedRoots.some(
          (root) => path === root || path.startsWith(`${root}${sep}`),
        ),
    )
  ) {
    fail(`compile dependency graph ${entry.kind} is invalid`);
  }
  return new Map([
    [entry.output, output],
    [entry.depfile, depfile],
  ]);
}

function verifyCompletedLeaves(evidence) {
  for (const [path, expected] of evidence) {
    const current = verifyGeneratedLeaf(path, expected.mode & 0o7777);
    if (
      current.dev !== expected.dev ||
      current.ino !== expected.ino ||
      current.uid !== expected.uid ||
      current.mode !== expected.mode ||
      current.nlink !== expected.nlink ||
      current.size !== expected.size ||
      current.sha256 !== expected.sha256
    ) {
      fail(`completed staging leaf ${path} identity changed`);
    }
  }
}

function spawnChecked(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: packageRoot,
    encoding: options.encoding ?? "utf8",
    env: options.env ?? createCompilerEnvironment(),
    maxBuffer: 4 * 1024 * 1024,
    stdio: options.stdio ?? childStdio(),
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    fail(
      `${command} failed (${String(result.status)}): ${String(
        result.stderr ?? "",
      ).slice(0, 4000)}`,
    );
  }
  return result;
}

function parseDepfile(path) {
  const text = readFileSync(resolve(packageRoot, path), "utf8")
    .replace(/\\\n/g, " ")
    .replace(/\\ /g, "\0");
  const separator = text.indexOf(":");
  if (separator < 0) {
    fail(`dependency file ${path} is malformed`);
  }
  const dependencies = text
    .slice(separator + 1)
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((entry) => entry.replaceAll("\0", " "));
  const canonical = dependencies.map((entry) =>
    realpathSync(resolve(packageRoot, entry)),
  );
  if (new Set(canonical).size !== canonical.length) {
    fail(`dependency file ${path} contains duplicates`);
  }
  return canonical;
}

function parseElfNeeded(path) {
  const bytes = readFileSync(path);
  if (
    bytes.length < 64 ||
    !bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
    bytes[4] !== 2 ||
    bytes[5] !== 1
  ) {
    fail("ELF64 little-endian artifact is required");
  }
  const programOffset = Number(bytes.readBigUInt64LE(32));
  const programEntrySize = bytes.readUInt16LE(54);
  const programCount = bytes.readUInt16LE(56);
  if (
    !Number.isSafeInteger(programOffset) ||
    programEntrySize < 56 ||
    programOffset + programEntrySize * programCount > bytes.length
  ) {
    fail("ELF program-header table is malformed");
  }
  const programs = [];
  for (let index = 0; index < programCount; index++) {
    const offset = programOffset + index * programEntrySize;
    programs.push({
      type: bytes.readUInt32LE(offset),
      fileOffset: Number(bytes.readBigUInt64LE(offset + 8)),
      virtualAddress: Number(bytes.readBigUInt64LE(offset + 16)),
      fileSize: Number(bytes.readBigUInt64LE(offset + 32)),
      memorySize: Number(bytes.readBigUInt64LE(offset + 40)),
    });
  }
  const dynamic = programs.find((entry) => entry.type === 2);
  if (
    dynamic === undefined ||
    !Number.isSafeInteger(dynamic.fileOffset) ||
    !Number.isSafeInteger(dynamic.fileSize) ||
    dynamic.fileOffset + dynamic.fileSize > bytes.length ||
    dynamic.fileSize % 16 !== 0
  ) {
    fail("ELF dynamic table is malformed");
  }
  let stringVirtualAddress;
  let stringSize;
  const neededOffsets = [];
  let terminated = false;
  for (
    let offset = dynamic.fileOffset;
    offset < dynamic.fileOffset + dynamic.fileSize;
    offset += 16
  ) {
    const tag = bytes.readBigInt64LE(offset);
    const value = bytes.readBigUInt64LE(offset + 8);
    if (tag === 0n) {
      terminated = true;
      break;
    }
    if (tag === 1n) neededOffsets.push(Number(value));
    if (tag === 5n) stringVirtualAddress = Number(value);
    if (tag === 10n) stringSize = Number(value);
  }
  if (
    !terminated ||
    !Number.isSafeInteger(stringVirtualAddress) ||
    !Number.isSafeInteger(stringSize)
  ) {
    fail("ELF dynamic string table is missing");
  }
  const segment = programs.find(
    (entry) =>
      entry.type === 1 &&
      stringVirtualAddress >= entry.virtualAddress &&
      stringVirtualAddress < entry.virtualAddress + entry.memorySize,
  );
  if (segment === undefined) fail("ELF dynamic string table is unmapped");
  const stringOffset =
    segment.fileOffset + stringVirtualAddress - segment.virtualAddress;
  if (stringOffset + stringSize > bytes.length) {
    fail("ELF dynamic string table exceeds artifact");
  }
  const names = neededOffsets.map((offset) => {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= stringSize) {
      fail("ELF DT_NEEDED offset is invalid");
    }
    const start = stringOffset + offset;
    const end = bytes.indexOf(0, start);
    if (end < start || end >= stringOffset + stringSize) {
      fail("ELF DT_NEEDED string is unterminated");
    }
    const name = bytes.subarray(start, end).toString("utf8");
    if (!/^[A-Za-z0-9][A-Za-z0-9.+_-]*\.so(?:\.[0-9]+)*$/.test(name)) {
      fail("ELF DT_NEEDED soname is malformed");
    }
    return name;
  });
  if (new Set(names).size !== names.length) {
    fail("ELF DT_NEEDED contains duplicates");
  }
  return names;
}

function inventoryFor(output, compileEntries, linkEntry, context) {
  const runChecked = (command, args, options) => {
    const result = spawnChecked(command, args, options);
    context.afterChild();
    return result;
  };
  const dependencyPaths = [
    ...new Set(compileEntries.flatMap((entry) => parseDepfile(entry.depfile))),
  ].sort(rawPathCompare);
  const allowedDependencyRoots = [
    nativeAbsolute,
    context.node.include,
    "/usr/include",
    context.compilerInclude,
  ];
  for (const path of dependencyPaths) {
    if (
      !allowedDependencyRoots.some(
        (root) => path === root || path.startsWith(`${root}${sep}`),
      )
    ) {
      fail(`dependency escaped allowlisted roots: ${path}`);
    }
  }
  const scriptPaths = [
    realpathSync(fileURLToPath(import.meta.url)),
    realpathSync(resolve(packageRoot, "scripts/run-native-build.mjs")),
  ].sort(rawPathCompare);
  const dependencies = dependencyPaths.map((path) => ({
    path,
    sha256: hashFile(path),
  }));
  const scripts = scriptPaths.map((path) => ({ path, sha256: hashFile(path) }));
  const compilerVersion = runChecked(context.compiler, ["--version"]).stdout;
  const dumpmachine = runChecked(context.compiler, ["-dumpmachine"]).stdout;
  const dumpfullversion = runChecked(context.compiler, [
    "-dumpfullversion",
  ]).stdout;
  const driverProbes = [
    "-dumpspecs",
    "-print-search-dirs",
    "-print-libgcc-file-name",
  ].map((flag) => {
    const bytes = runChecked(context.compiler, [flag]).stdout;
    return { flag, sha256: sha256(bytes) };
  });
  const subtools = ["cc1", "as", "collect2", "ld"].map((name) => {
    const raw = runChecked(context.compiler, [
      `-print-prog-name=${name}`,
    ]).stdout.trim();
    const path = realpathSync(raw.includes("/") ? raw : `/usr/bin/${raw}`);
    const versionBytes = runChecked(path, ["--version"]).stdout;
    return {
      name,
      path,
      sha256: hashFile(path),
      versionSha256: sha256(versionBytes),
    };
  });
  const traceLines = readFileSync(resolve(packageRoot, linkEntry.trace), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (traceLines.length === 0) {
    fail(`link trace ${linkEntry.trace} is empty`);
  }
  const resolvedTraceInputs = traceLines.map((line) => {
    const candidate = resolve(packageRoot, line);
    if (!existsSync(candidate)) {
      fail(`link trace input is unresolved: ${line}`);
    }
    return realpathSync(candidate);
  });
  const linkInputs = [...new Set(resolvedTraceInputs)]
    .sort(rawPathCompare)
    .map((path) => ({ path, sha256: hashFile(path) }));
  const needed = parseElfNeeded(resolve(packageRoot, output))
    .map((soname) => {
      const candidates = [
        ...new Set(
          resolvedTraceInputs.filter(
            (path) =>
              path.split(sep).at(-1) === soname ||
              realpathSync(path).split(sep).at(-1) === soname,
          ),
        ),
      ];
      if (candidates.length !== 1) {
        fail(`ELF DT_NEEDED soname did not resolve exactly once: ${soname}`);
      }
      const path = candidates[0];
      return { soname, path, sha256: hashFile(path) };
    })
    .sort((left, right) =>
      Buffer.compare(
        Buffer.from(`${left.path}\0${left.soname}`),
        Buffer.from(`${right.path}\0${right.soname}`),
      ),
    );
  return {
    schemaVersion: 1,
    output: {
      kind: linkEntry.kind,
      final: output.replace(`${stage}/`, "build/"),
      staging: output,
      sha256: hashFile(resolve(packageRoot, output)),
    },
    compileArgv: compileEntries.map((entry) => entry.args),
    linkArgv: linkEntry.args,
    dependencies,
    scripts,
    node: {
      path: context.node.executable,
      sha256: hashFile(context.node.executable),
      version: process.version,
      napi: process.versions.napi,
      headerRoot: context.node.include,
      headers: ["node_api.h", "node_api_types.h", "node_version.h"].map(
        (name) => ({
          name,
          sha256: hashFile(resolve(context.node.include, name)),
        }),
      ),
    },
    compiler: {
      path: context.compiler,
      sha256: hashFile(context.compiler),
      versionSha256: sha256(compilerVersion),
      dumpmachine: dumpmachine.trim(),
      dumpfullversion: dumpfullversion.trim(),
    },
    driverProbes,
    subtools,
    linkInputs,
    needed,
    toolchainAllowlistSha256: context.allowlistSha256,
  };
}

const heldModuleVerifier = String.raw`
const { closeSync, fstatSync, readFileSync } = require("node:fs");
const { constants: osConstants } = require("node:os");
const addonFd = 10;
const expectTestHooks = process.argv[1] === "test";
const identityKeys = [
  "dev", "ino", "size", "mode", "uid", "gid", "nlink", "mtimeNs", "ctimeNs",
];
const capture = () => {
  const status = fstatSync(addonFd, { bigint: true });
  if (
    !status.isFile() ||
    status.uid !== BigInt(process.getuid()) ||
    (status.mode & 0o7777n) !== 0o600n ||
    status.nlink !== 1n ||
    status.size <= 0n
  ) throw new Error("held addon identity is invalid");
  return Object.fromEntries(identityKeys.map((key) => [key, status[key]]));
};
const same = (expected) => {
  const current = fstatSync(addonFd, { bigint: true });
  return identityKeys.every((key) => current[key] === expected[key]);
};
const fdinfo = readFileSync("/proc/self/fdinfo/10", "utf8");
const flagsMatch = fdinfo.match(/^flags:\s+([0-7]+)$/m);
if (
  flagsMatch === null ||
  (Number.parseInt(flagsMatch[1], 8) & 3) !== 0
) throw new Error("held addon descriptor flags are invalid");
const before = capture();
const moduleRecord = { exports: Object.create(null) };
process.dlopen(
  moduleRecord,
  "/proc/self/fd/10",
  osConstants.dlopen.RTLD_NOW,
);
if (!same(before)) throw new Error("held addon identity drifted");
const native = moduleRecord.exports;
const expectedKeys = expectTestHooks
  ? ["interfaceVersion", "napiVersion", "renameNoReplace", "testHooks"]
  : ["interfaceVersion", "napiVersion", "renameNoReplace"];
const hookKeys = [
  "becomeChildSubreaperForTest",
  "claimAdoptedChildForTest",
  "prepareInheritedLockFdForTest",
  "reapClaimedChildForTest",
];
if (
  native === null ||
  typeof native !== "object" ||
  JSON.stringify(Object.keys(native).sort()) !==
    JSON.stringify(expectedKeys) ||
  native.interfaceVersion !== "1.0.0" ||
  native.napiVersion !== 8 ||
  typeof native.renameNoReplace !== "function" ||
  (expectTestHooks && (
    native.testHooks === null ||
    typeof native.testHooks !== "object" ||
    !Object.isFrozen(native.testHooks) ||
    JSON.stringify(Object.keys(native.testHooks).sort()) !==
      JSON.stringify(hookKeys) ||
    hookKeys.some((key) => typeof native.testHooks[key] !== "function")
  ))
) throw new Error("held native module has incompatible shape");
closeSync(addonFd);
try {
  fstatSync(addonFd);
  throw new Error("held addon descriptor remained open");
} catch (error) {
  if (error?.code !== "EBADF") throw error;
}
`;

function sameBigintIdentity(fd, expected) {
  const current = fstatSync(fd, { bigint: true });
  return [
    "dev",
    "ino",
    "size",
    "mode",
    "uid",
    "gid",
    "nlink",
    "mtimeNs",
    "ctimeNs",
  ].every((key) => current[key] === expected[key]);
}

function verifiedClose(fd, label) {
  closeSync(fd);
  try {
    fstatSync(fd);
    fail(`${label} close verification failed`);
  } catch (error) {
    if (error?.code !== "EBADF") throw error;
  }
}

function verifyModule(path, expectTestHooks = false) {
  const resolved = resolve(packageRoot, path);
  const fd = openSync(
    resolved,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  const identity = fstatSync(fd, { bigint: true });
  try {
    if (
      !identity.isFile() ||
      identity.uid !== BigInt(process.getuid()) ||
      (identity.mode & 0o7777n) !== 0o600n ||
      identity.nlink !== 1n ||
      identity.size <= 0n
    ) {
      fail(`native module ${path} has unsafe held identity`);
    }
    spawnChecked(
      process.execPath,
      [
        "--input-type=commonjs",
        "-e",
        heldModuleVerifier,
        expectTestHooks ? "test" : "production",
      ],
      {
        stdio: [...childStdio(), fd],
      },
    );
    if (!sameBigintIdentity(fd, identity)) {
      fail(`native module ${path} changed during held validation`);
    }
  } finally {
    verifiedClose(fd, `native module ${path}`);
  }
}

function finalFor(path) {
  return path.replace(`${stage}/`, "build/");
}

function publishNativeGeneration(paths, effects) {
  const state = {
    index: 0,
    phase: "verify",
    checksumPublished: false,
    complete: false,
  };
  while (!state.complete) {
    const path = paths[state.index];
    if (state.phase === "verify") {
      effects.verifyAndSync(path);
      state.phase = "rename";
    } else if (state.phase === "rename") {
      effects.rename(path);
      state.phase = "sync-source";
    } else if (state.phase === "sync-source") {
      effects.syncSource(path);
      state.phase = "sync-target";
    } else {
      effects.syncTarget(path);
      if (path.endsWith("atomic-directory-publication.node.sha256")) {
        state.checksumPublished = true;
      }
      state.index++;
      state.phase = "verify";
      state.complete = state.index === paths.length;
    }
  }
  return state;
}

function canonicalJsonFile(path, expectedKeys, label) {
  const bytes = readFileSync(path);
  const text = bytes.toString("utf8");
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail(`${label} JSON is malformed`);
  }
  if (
    !text.endsWith("\n") ||
    text.includes("\r") ||
    text !== `${JSON.stringify(value)}\n` ||
    JSON.stringify(Object.keys(value)) !== JSON.stringify(expectedKeys)
  ) {
    fail(`${label} JSON is not canonical`);
  }
  return { bytes, value };
}

function requireExactObject(value, keys, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value)) !== JSON.stringify(keys)
  ) {
    fail(`${label} shape is invalid`);
  }
}

function requireHash(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    fail(`${label} hash is invalid`);
  }
}

function inventoryPathForCurrentGeneration(path) {
  if (existsSync(path)) return path;
  const stagePrefix = `${stageAbsolute}${sep}`;
  if (path.startsWith(stagePrefix)) {
    const published = resolve(
      buildAbsolute,
      path.slice(stagePrefix.length),
    );
    if (existsSync(published)) return published;
  }
  fail(`inventory path is unavailable: ${path}`);
}

function validateInventorySchema(inventory, expectedInventory) {
  requireExactObject(
    inventory,
    [
      "schemaVersion",
      "output",
      "compileArgv",
      "linkArgv",
      "dependencies",
      "scripts",
      "node",
      "compiler",
      "driverProbes",
      "subtools",
      "linkInputs",
      "needed",
      "toolchainAllowlistSha256",
    ],
    "native input inventory",
  );
  if (inventory.schemaVersion !== 1) {
    fail("native input inventory schema version is invalid");
  }
  if (
    expectedInventory === undefined ||
    JSON.stringify(inventory) !== JSON.stringify(expectedInventory)
  ) {
    fail("native input inventory does not bind the selected build graph");
  }
  requireExactObject(
    inventory.output,
    ["kind", "final", "staging", "sha256"],
    "native inventory output",
  );
  if (
    !["production", "test-addon", "errno"].includes(inventory.output.kind) ||
    typeof inventory.output.final !== "string" ||
    typeof inventory.output.staging !== "string" ||
    !inventory.output.staging.startsWith(`${stage}/`) ||
    inventory.output.final !== finalFor(inventory.output.staging)
  ) {
    fail("native inventory output binding is invalid");
  }
  requireHash(inventory.output.sha256, "native inventory output");
  for (const [name, value] of [
    ["compileArgv", inventory.compileArgv],
    ["linkArgv", [inventory.linkArgv]],
  ]) {
    if (
      !Array.isArray(value) ||
      value.length === 0 ||
      value.some(
        (argv) =>
          !Array.isArray(argv) ||
          argv.length === 0 ||
          argv.some((item) => typeof item !== "string" || item.length === 0),
      )
    ) {
      fail(`native inventory ${name} is invalid`);
    }
  }
  const validatePathHashes = (entries, label, extraKeys = []) => {
    if (!Array.isArray(entries)) fail(`${label} is not an array`);
    const paths = [];
    for (const entry of entries) {
      requireExactObject(entry, [...extraKeys, "path", "sha256"], label);
      if (typeof entry.path !== "string" || entry.path.length === 0) {
        fail(`${label} path is invalid`);
      }
      requireHash(entry.sha256, label);
      const current = inventoryPathForCurrentGeneration(entry.path);
      if (hashFile(current) !== entry.sha256) {
        fail(`${label} path hash changed`);
      }
      paths.push(entry.path);
    }
    if (
      new Set(paths).size !== paths.length ||
      JSON.stringify(paths) !== JSON.stringify([...paths].sort(rawPathCompare))
    ) {
      fail(`${label} ordering is invalid`);
    }
  };
  validatePathHashes(inventory.dependencies, "inventory dependency");
  validatePathHashes(inventory.scripts, "inventory script");
  requireExactObject(
    inventory.node,
    ["path", "sha256", "version", "napi", "headerRoot", "headers"],
    "inventory node",
  );
  if (
    inventory.node.version !== "v22.22.1" ||
    Number(inventory.node.napi) < 8 ||
    typeof inventory.node.headerRoot !== "string"
  ) {
    fail("inventory Node identity is invalid");
  }
  requireHash(inventory.node.sha256, "inventory Node");
  if (hashFile(inventory.node.path) !== inventory.node.sha256) {
    fail("inventory Node hash changed");
  }
  if (
    !Array.isArray(inventory.node.headers) ||
    JSON.stringify(inventory.node.headers.map((entry) => entry.name)) !==
      JSON.stringify(["node_api.h", "node_api_types.h", "node_version.h"])
  ) {
    fail("inventory Node headers are invalid");
  }
  for (const header of inventory.node.headers) {
    requireExactObject(header, ["name", "sha256"], "inventory Node header");
    requireHash(header.sha256, "inventory Node header");
    if (
      hashFile(resolve(inventory.node.headerRoot, header.name)) !==
      header.sha256
    ) {
      fail("inventory Node header hash changed");
    }
  }
  requireExactObject(
    inventory.compiler,
    [
      "path",
      "sha256",
      "versionSha256",
      "dumpmachine",
      "dumpfullversion",
    ],
    "inventory compiler",
  );
  requireHash(inventory.compiler.sha256, "inventory compiler");
  requireHash(inventory.compiler.versionSha256, "inventory compiler version");
  if (
    hashFile(inventory.compiler.path) !== inventory.compiler.sha256 ||
    typeof inventory.compiler.dumpmachine !== "string" ||
    inventory.compiler.dumpmachine.length === 0 ||
    typeof inventory.compiler.dumpfullversion !== "string" ||
    inventory.compiler.dumpfullversion.length === 0
  ) {
    fail("inventory compiler identity changed");
  }
  if (
    !Array.isArray(inventory.driverProbes) ||
    JSON.stringify(inventory.driverProbes.map((entry) => entry.flag)) !==
      JSON.stringify([
        "-dumpspecs",
        "-print-search-dirs",
        "-print-libgcc-file-name",
      ])
  ) {
    fail("inventory driver probes are invalid");
  }
  for (const probe of inventory.driverProbes) {
    requireExactObject(probe, ["flag", "sha256"], "inventory driver probe");
    requireHash(probe.sha256, "inventory driver probe");
  }
  if (
    !Array.isArray(inventory.subtools) ||
    JSON.stringify(inventory.subtools.map((entry) => entry.name)) !==
      JSON.stringify(["cc1", "as", "collect2", "ld"])
  ) {
    fail("inventory subtools are invalid");
  }
  for (const subtool of inventory.subtools) {
    requireExactObject(
      subtool,
      ["name", "path", "sha256", "versionSha256"],
      "inventory subtool",
    );
    requireHash(subtool.sha256, "inventory subtool");
    requireHash(subtool.versionSha256, "inventory subtool version");
    if (hashFile(subtool.path) !== subtool.sha256) {
      fail("inventory subtool hash changed");
    }
  }
  validatePathHashes(inventory.linkInputs, "inventory link input");
  if (!Array.isArray(inventory.needed)) {
    fail("inventory needed list is invalid");
  }
  const neededOrder = [];
  for (const needed of inventory.needed) {
    requireExactObject(
      needed,
      ["soname", "path", "sha256"],
      "inventory needed library",
    );
    if (
      typeof needed.soname !== "string" ||
      typeof needed.path !== "string"
    ) {
      fail("inventory needed library binding is invalid");
    }
    requireHash(needed.sha256, "inventory needed library");
    if (hashFile(needed.path) !== needed.sha256) {
      fail("inventory needed library hash changed");
    }
    neededOrder.push(`${needed.path}\0${needed.soname}`);
  }
  if (
    new Set(neededOrder).size !== neededOrder.length ||
    JSON.stringify(neededOrder) !==
      JSON.stringify([...neededOrder].sort(rawPathCompare))
  ) {
    fail("inventory needed library ordering is invalid");
  }
  const currentNeeded = parseElfNeeded(
    inventoryPathForCurrentGeneration(
      resolve(packageRoot, inventory.output.staging),
    ),
  ).sort(rawPathCompare);
  if (
    JSON.stringify(currentNeeded) !==
    JSON.stringify(inventory.needed.map((entry) => entry.soname).sort(rawPathCompare))
  ) {
    fail("inventory needed libraries do not match the current output");
  }
  requireHash(
    inventory.toolchainAllowlistSha256,
    "inventory toolchain allowlist",
  );
  if (
    hashFile(resolve(nativeAbsolute, "toolchain-allowlist.json")) !==
    inventory.toolchainAllowlistSha256
  ) {
    fail("inventory toolchain allowlist hash changed");
  }
}

function expectedLeafMode(path) {
  return path.endsWith("atomic-directory-publication-errors.test") ? 0o700 : 0o600;
}

function verifyRegularLeafAndSync(absolute, mode, label) {
  const fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const status = fstatSync(fd);
    if (
      !status.isFile() ||
      status.uid !== process.getuid() ||
      (status.mode & 0o7777) !== mode ||
      status.nlink !== 1 ||
      status.size <= 0
    ) {
      fail(`${label} is invalid`);
    }
    fsyncSync(fd);
    return Object.freeze({
      dev: status.dev,
      ino: status.ino,
      uid: status.uid,
      mode: status.mode,
      nlink: status.nlink,
      size: status.size,
      sha256: sha256(readFileSync(fd)),
    });
  } finally {
    closeSync(fd);
  }
}

function verifyAndSyncPublicationLeaf(path, evidence, expectedInventories) {
  const absolute = resolve(packageRoot, path);
  const mode = expectedLeafMode(path);
  const bound = verifyRegularLeafAndSync(
    absolute,
    mode,
    `publication leaf ${path}`,
  );
  {
    const sourceParent = dirname(absolute);
    const targetParent = dirname(resolve(packageRoot, finalFor(path)));
    verifyOwnedDirectory(sourceParent);
    verifyOwnedDirectory(targetParent);
    if (path.endsWith(".inputs.sha256")) {
      const expectedKeys = [
        "schemaVersion",
        "output",
        "compileArgv",
        "linkArgv",
        "dependencies",
        "scripts",
        "node",
        "compiler",
        "driverProbes",
        "subtools",
        "linkInputs",
        "needed",
        "toolchainAllowlistSha256",
      ];
      const inventory = canonicalJsonFile(
        absolute,
        expectedKeys,
        "native input inventory",
      ).value;
      validateInventorySchema(inventory, expectedInventories.get(path));
      if (
        hashFile(resolve(packageRoot, inventory.output.staging)) !==
        inventory.output.sha256
      ) {
        fail("native input inventory output binding is invalid");
      }
    } else if (path.endsWith("atomic-directory-publication.node.sha256")) {
      const attestation = canonicalJsonFile(
        absolute,
        ["interfaceVersion", "napiVersion", "sha256"],
        "runtime native attestation",
      ).value;
      if (
        attestation.interfaceVersion !== "1.0.0" ||
        attestation.napiVersion !== 8 ||
        !/^[0-9a-f]{64}$/.test(attestation.sha256) ||
        hashFile(
          resolve(
            packageRoot,
            "build/Release/atomic_directory_publication.node",
          ),
        ) !== attestation.sha256
      ) {
        fail("runtime native attestation binding is invalid");
      }
    }
    evidence.set(path, bound);
  }
}

function verifyPublishedLeaf(path, expected) {
  const absolute = resolve(packageRoot, finalFor(path));
  const fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const status = fstatSync(fd);
    if (
      expected === undefined ||
      !status.isFile() ||
      status.dev !== expected.dev ||
      status.ino !== expected.ino ||
      status.uid !== expected.uid ||
      status.mode !== expected.mode ||
      status.nlink !== expected.nlink ||
      status.size !== expected.size ||
      hashFile(absolute) !== expected.sha256
    ) {
      fail(`published leaf ${path} identity changed`);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function executeNativePublication(paths, expectedInventories) {
  const evidence = new Map();
  return publishNativeGeneration(paths, {
    verifyAndSync(path) {
      verifyAndSyncPublicationLeaf(path, evidence, expectedInventories);
    },
    rename(path) {
      const expected = evidence.get(path);
      const current = lstatSync(resolve(packageRoot, path));
      if (
        expected === undefined ||
        current.dev !== expected.dev ||
        current.ino !== expected.ino ||
        current.uid !== expected.uid ||
        current.mode !== expected.mode ||
        current.nlink !== expected.nlink
      ) {
        fail(`publication leaf ${path} changed before rename`);
      }
      renameSync(
        resolve(packageRoot, path),
        resolve(packageRoot, finalFor(path)),
      );
    },
    syncSource(path) {
      fsyncDirectory(dirname(resolve(packageRoot, path)));
    },
    syncTarget(path) {
      fsyncDirectory(dirname(resolve(packageRoot, finalFor(path))));
      verifyPublishedLeaf(path, evidence.get(path));
    },
  });
}

function staleShapeKey(directories, files) {
  return JSON.stringify([
    [...directories].sort(rawPathCompare),
    [...files].sort(rawPathCompare),
  ]);
}

function matchesStaleTargetGrammar(observed, graph, candidateTarget) {
  const observedShape = staleShapeKey(
    observed.directories.keys(),
    observed.files.keys(),
  );
  const candidateCompiles =
    candidateTarget === "production"
      ? graph.compiles.slice(0, 2)
      : graph.compiles;
  const candidateLinks =
    candidateTarget === "production"
      ? graph.links.slice(0, 1)
      : graph.links;
  const directoryOrder = [
    "",
    "obj",
    "obj/production",
    "Release",
    ...(candidateTarget === "all"
      ? ["obj/test", "obj/errno-test", "Test"]
      : []),
  ];
  const selectedSidecars =
    candidateTarget === "production"
      ? [`${stage}/Release/atomic_directory_publication.inputs.sha256`]
      : [
          `${stage}/Release/atomic_directory_publication.inputs.sha256`,
          `${stage}/Test/atomic_directory_publication_test.inputs.sha256`,
          `${stage}/Test/atomic-directory-publication-errors.test.inputs.sha256`,
        ];
  const selectedChecksum =
    `${stage}/Release/atomic-directory-publication.node.sha256`;
  const precreateOrder = [
    ...candidateCompiles.flatMap((entry) => [entry.output, entry.depfile]),
    ...candidateLinks.flatMap((entry) => [entry.output, entry.map]),
    ...selectedSidecars,
    selectedChecksum,
  ].map((path) => path.slice(`${stage}/`.length));
  const traceOrder = candidateLinks.map((entry) =>
    entry.trace.slice(`${stage}/`.length),
  );
  const allFiles = [...precreateOrder, ...traceOrder];
  const publishOrder = [
    ...candidateCompiles.flatMap((entry) => [entry.output, entry.depfile]),
    ...candidateLinks.flatMap((entry) => [entry.map, entry.trace]),
    ...selectedSidecars,
    ...(candidateTarget === "all"
      ? [graph.links[2].output, graph.links[1].output]
      : []),
    graph.links[0].output,
    selectedChecksum,
  ].map((path) => path.slice(`${stage}/`.length));
  const lifecycleShapes = [];
  for (let index = 0; index < directoryOrder.length; index++) {
    lifecycleShapes.push({
      directories: directoryOrder.slice(0, index + 1),
      files: [],
    });
  }
  for (let index = 0; index < precreateOrder.length; index++) {
    lifecycleShapes.push({
      directories: directoryOrder,
      files: precreateOrder.slice(0, index + 1),
    });
  }
  for (let index = 0; index < traceOrder.length; index++) {
    lifecycleShapes.push({
      directories: directoryOrder,
      files: [...precreateOrder, ...traceOrder.slice(0, index + 1)],
    });
  }
  for (let index = 0; index < publishOrder.length; index++) {
    const published = new Set(publishOrder.slice(0, index + 1));
    lifecycleShapes.push({
      directories: directoryOrder,
      files: allFiles.filter((path) => !published.has(path)),
    });
  }
  const reachableShapes = new Set();
  for (const lifecycle of lifecycleShapes) {
    const remainingDirectories = new Set(lifecycle.directories);
    const remainingFiles = new Set(lifecycle.files);
    reachableShapes.add(
      staleShapeKey(remainingDirectories, remainingFiles),
    );
    for (const path of [...remainingFiles].sort((left, right) => {
      const depth = right.split("/").length - left.split("/").length;
      return depth || rawPathCompare(left, right);
    })) {
      remainingFiles.delete(path);
      reachableShapes.add(
        staleShapeKey(remainingDirectories, remainingFiles),
      );
    }
    for (const path of [...remainingDirectories].sort((left, right) => {
      const leftDepth = left === "" ? 0 : left.split("/").length;
      const rightDepth = right === "" ? 0 : right.split("/").length;
      const depth = rightDepth - leftDepth;
      return depth || rawPathCompare(left, right);
    })) {
      remainingDirectories.delete(path);
      reachableShapes.add(
        staleShapeKey(remainingDirectories, remainingFiles),
      );
    }
  }
  return reachableShapes.has(observedShape);
}

export function runBuildPublicationMatrixForTest() {
  const sanctionedTestRunner =
    process.env.VITEST === "true" ||
    process.env.NODE_TEST_CONTEXT === "child-v8";
  if (
    !sanctionedTestRunner ||
    resolve(process.argv[1] ?? "") !==
      resolve(packageRoot, "scripts/build-native.test.mjs")
  ) {
    fail("build publication matrix seam is unavailable");
  }
  const graph = compileGraph("/usr/bin/gcc", "/node/include");
  const sidecars = [
    `${stage}/Release/atomic_directory_publication.inputs.sha256`,
    `${stage}/Test/atomic_directory_publication_test.inputs.sha256`,
    `${stage}/Test/atomic-directory-publication-errors.test.inputs.sha256`,
  ];
  const checksum =
    `${stage}/Release/atomic-directory-publication.node.sha256`;
  const paths = [
    ...graph.compiles.flatMap((entry) => [entry.output, entry.depfile]),
    ...graph.links.flatMap((entry) => [entry.map, entry.trace]),
    ...sidecars,
    graph.links[2].output,
    graph.links[1].output,
    graph.links[0].output,
    checksum,
  ].map((path) => path.slice(`${stage}/`.length));
  if (new Set(paths).size !== paths.length) {
    fail("publication matrix graph contains duplicate leaves");
  }
  const relativeLeaf = (path) => path.slice(`${stage}/`.length);
  const directoryNames = [
    ...new Set(
      paths.flatMap((path) => {
        const names = [];
        let current = dirname(path);
        while (current !== ".") {
          names.push(current);
          current = dirname(current);
        }
        return names;
      }),
    ),
  ].sort((left, right) => {
    const depth = left.split("/").length - right.split("/").length;
    return depth || rawPathCompare(left, right);
  });
  const allowedDirectories = new Set(["", ...directoryNames]);
  const allowedFiles = new Set(paths);
  const inspectRecoverableSource = (root) => {
    const observed = { directories: new Map(), files: new Map() };
    inspectStaleTree(
      root,
      allowedDirectories,
      allowedFiles,
      observed,
      root,
    );
    if (
      !matchesStaleTargetGrammar(observed, graph, "production") &&
      !matchesStaleTargetGrammar(observed, graph, "all")
    ) {
      fail("matrix source does not match production stale grammar");
    }
    return observed;
  };
  const recoverStaleSource = (root, crashOrdinal) => {
    let observed = inspectRecoverableSource(root);
    let interrupted = false;
    if (crashOrdinal !== undefined) {
      const removalCount =
        observed.files.size + observed.directories.size;
      const stopAfter = crashOrdinal % removalCount;
      let removalIndex = 0;
      try {
        removeVerifiedStaleTree(observed, root, () => {
          if (removalIndex++ === stopAfter) {
            throw new Error("matrix stale recovery crash");
          }
        });
      } catch (error) {
        if (error?.message !== "matrix stale recovery crash") throw error;
        interrupted = true;
      }
      if (!existsSync(root)) {
        return interrupted;
      }
      observed = inspectRecoverableSource(root);
    }
    removeVerifiedStaleTree(observed, root);
    return interrupted;
  };
  const createTree = (root) => {
    const identities = new Map();
    for (const name of directoryNames) {
      const path = join(root, name);
      mkdirSync(path, { mode: 0o700 });
      identities.set(name, captureDirectoryIdentity(path, 0o700));
    }
    return identities;
  };
  const removeTree = (root, identities, leafIdentities = new Map()) => {
    for (const name of paths) {
      const path = join(root, name);
      if (!existsSync(path)) continue;
      const status = lstatSync(path);
      const expected = leafIdentities.get(name);
      if (
        !status.isFile() ||
        status.isSymbolicLink() ||
        status.uid !== process.getuid() ||
        status.nlink !== 1 ||
        (expected !== undefined &&
          (status.dev !== expected.dev ||
            status.ino !== expected.ino ||
            status.mode !== expected.mode))
      ) {
        fail("matrix recovery leaf identity changed");
      }
      unlinkSync(path);
      fsyncDirectory(dirname(path));
    }
    for (const name of [...directoryNames].reverse()) {
      const path = join(root, name);
      const status = lstatSync(path);
      const expected = identities.get(name);
      if (
        expected === undefined ||
        !status.isDirectory() ||
        status.isSymbolicLink() ||
        status.dev !== expected.dev ||
        status.ino !== expected.ino ||
        status.uid !== expected.uid ||
        status.mode !== expected.mode ||
        status.nlink < 2 ||
        readdirSync(path).length !== 0
      ) {
        fail("matrix recovery directory identity changed");
      }
      rmdirSync(path);
      fsyncDirectory(dirname(path));
    }
  };
  const syncTreeBottomUp = (root) => {
    for (const name of [...directoryNames].reverse()) {
      fsyncDirectory(join(root, name));
    }
    fsyncDirectory(root);
  };
  const assertExclusiveMatrixLeaf = (path, mode) => {
    assertMatrixLeaf(path, mode);
    try {
      const fd = openSync(
        path,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        mode,
      );
      closeSync(fd);
      fail("matrix O_EXCL accepted an existing leaf");
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  };
  const assertMatrixLeaf = (path, mode) => {
    const status = lstatSync(path);
    if (
      !status.isFile() ||
      status.isSymbolicLink() ||
      status.uid !== process.getuid() ||
      (status.mode & 0o7777) !== mode ||
      status.nlink !== 1
    ) {
      fail("matrix O_EXCL leaf shape is invalid");
    }
  };
  const writeMatrixLeaf = (path, bytes) => {
    const fd = openSync(
      path,
      constants.O_WRONLY | constants.O_NOFOLLOW,
    );
    try {
      writeFileSync(fd, bytes);
    } finally {
      closeSync(fd);
    }
  };
  const runCase = (failAt) => {
    const root = mkdtempSync(join(tmpdir(), "atomic-build-publication-"));
    const sourceRoot = join(root, "source");
    const targetRoot = join(root, "target");
    mkdirSync(sourceRoot, { mode: 0o700 });
    mkdirSync(targetRoot, { mode: 0o700 });
    createTree(sourceRoot);
    const targetDirectories = createTree(targetRoot);
    const sourceEvidence = new Map();
    const newHashes = new Map();
    const boundaryNames = [];
    let boundary = 0;
    let state;
    let crashed = false;
    const afterBoundary = (name) => {
      boundaryNames.push(name);
      if (boundary++ === failAt) throw new Error("publication matrix crash");
    };
    for (const path of paths) {
      const mode = expectedLeafMode(path);
      const sourceFd = openSync(
        join(sourceRoot, path),
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        mode,
      );
      closeSync(sourceFd);
      assertExclusiveMatrixLeaf(join(sourceRoot, path), mode);
      const status = lstatSync(join(sourceRoot, path));
      writeFileSync(join(targetRoot, path), `old-${path}\n`, {
        mode,
        flag: "wx",
      });
    }
    try {
      try {
        for (const entry of graph.compiles) {
          const output = relativeLeaf(entry.output);
          const depfile = relativeLeaf(entry.depfile);
          writeMatrixLeaf(
            join(sourceRoot, output),
            `object-${entry.kind}\n`,
          );
          writeMatrixLeaf(
            join(sourceRoot, depfile),
            `${output}: source-${entry.kind}.c\n`,
          );
          afterBoundary(`compile:${entry.kind}:spawn`);
          sourceEvidence.set(
            output,
            verifyRegularLeafAndSync(
              join(sourceRoot, output),
              0o600,
              `matrix compile output ${entry.kind}`,
            ),
          );
          sourceEvidence.set(
            depfile,
            verifyRegularLeafAndSync(
              join(sourceRoot, depfile),
              0o600,
              `matrix compile depfile ${entry.kind}`,
            ),
          );
          afterBoundary(`compile:${entry.kind}:validate`);
          syncTreeBottomUp(sourceRoot);
          afterBoundary(`compile:${entry.kind}:fsync`);
        }
        for (const entry of graph.links) {
          const output = relativeLeaf(entry.output);
          const map = relativeLeaf(entry.map);
          const trace = relativeLeaf(entry.trace);
          const traceFd = openSync(
            join(sourceRoot, trace),
            constants.O_WRONLY | constants.O_NOFOLLOW,
          );
          try {
            if (childStdio(traceFd, "pipe")[1] !== traceFd) {
              fail(`matrix link ${entry.kind} stdout is not the trace fd`);
            }
            writeFileSync(traceFd, `trace-${entry.kind}\n`);
          } finally {
            closeSync(traceFd);
          }
          for (const [path, bytes] of [
            [output, `elf-${entry.kind}\n`],
            [map, `map-${entry.kind}\n`],
          ]) {
            writeMatrixLeaf(join(sourceRoot, path), bytes);
          }
          chmodSync(join(sourceRoot, output), expectedLeafMode(output));
          afterBoundary(`link:${entry.kind}:spawn`);
          for (const path of [output, map, trace]) {
            sourceEvidence.set(
              path,
              verifyRegularLeafAndSync(
                join(sourceRoot, path),
                expectedLeafMode(path),
                `matrix link leaf ${entry.kind}`,
              ),
            );
          }
          afterBoundary(`link:${entry.kind}:validate`);
          syncTreeBottomUp(sourceRoot);
          afterBoundary(`link:${entry.kind}:fsync`);
        }
        for (const path of [...sidecars, checksum].map(relativeLeaf)) {
          writeMatrixLeaf(join(sourceRoot, path), `attestation-${path}\n`);
          afterBoundary(`attestation:${path}:write`);
          sourceEvidence.set(
            path,
            verifyRegularLeafAndSync(
              join(sourceRoot, path),
              0o600,
              `matrix attestation ${path}`,
            ),
          );
          afterBoundary(`attestation:${path}:validate`);
          syncTreeBottomUp(sourceRoot);
          afterBoundary(`attestation:${path}:fsync`);
        }
        for (const path of paths) {
          newHashes.set(path, hashFile(join(sourceRoot, path)));
        }
        state = publishNativeGeneration(paths, {
          verifyAndSync(path) {
            sourceEvidence.set(
              path,
              verifyRegularLeafAndSync(
                join(sourceRoot, path),
                expectedLeafMode(path),
                `matrix source ${path}`,
              ),
            );
            afterBoundary(`publish:${path}:verify`);
          },
          rename(path) {
            renameSync(join(sourceRoot, path), join(targetRoot, path));
            afterBoundary(`publish:${path}:rename`);
          },
          syncSource(path) {
            fsyncDirectory(dirname(join(sourceRoot, path)));
            afterBoundary(`publish:${path}:source-fsync`);
          },
          syncTarget(path) {
            fsyncDirectory(dirname(join(targetRoot, path)));
            const expected = sourceEvidence.get(path);
            const actual = verifyRegularLeafAndSync(
              join(targetRoot, path),
              expectedLeafMode(path),
              `matrix target ${path}`,
            );
            if (
              actual.dev !== expected.dev ||
              actual.ino !== expected.ino ||
              actual.sha256 !== expected.sha256
            ) {
              fail("matrix publication identity changed");
            }
            afterBoundary(`publish:${path}:target-fsync`);
          },
        });
      } catch (error) {
        if (error?.message !== "publication matrix crash") throw error;
        crashed = true;
      }
      const checksumIndex = paths.length - 1;
      const checksumIsNew =
        newHashes.get(paths[checksumIndex]) ===
        hashFile(join(targetRoot, paths[checksumIndex]));
      if (
        checksumIsNew &&
        paths.some(
          (path) =>
            newHashes.get(path) !== hashFile(join(targetRoot, path)),
        )
      ) {
        fail("publication matrix exposed checksum before the full generation");
      }
      const recoveryInterrupted = recoverStaleSource(
        sourceRoot,
        failAt === -1 ? paths.length + directoryNames.length - 1 : failAt,
      );
      return Object.freeze({
        failAt,
        crashed,
        complete: state?.complete ?? false,
        checksumPublished: state?.checksumPublished ?? false,
        checksumIsNew,
        recovered: !existsSync(sourceRoot),
        recoveryInterrupted,
        ...(failAt === -1
          ? { boundaries: Object.freeze(boundaryNames) }
          : {}),
        targetHashes: Object.freeze(
          paths.map((path) => hashFile(join(targetRoot, path))),
        ),
      });
    } finally {
      if (existsSync(sourceRoot)) {
        recoverStaleSource(sourceRoot);
      }
      removeTree(targetRoot, targetDirectories);
      rmdirSync(targetRoot);
      rmdirSync(root);
    }
  };
  const success = runCase(-1);
  const cases = [
    ...Array.from(
      { length: success.boundaries.length },
      (_, index) => runCase(index),
    ),
    success,
  ];
  return Object.freeze({
    compileArgv: Object.freeze(
      graph.compiles.map((entry) => Object.freeze([...entry.args])),
    ),
    compileStdio: Object.freeze(
      graph.compiles.map(() => Object.freeze(childStdio())),
    ),
    linkArgv: Object.freeze(
      graph.links.map((entry) => Object.freeze([...entry.args])),
    ),
    linkStdio: Object.freeze(
      graph.links.map((entry) =>
        Object.freeze(childStdio(entry.trace, "pipe")),
      ),
    ),
    traceStdout: Object.freeze(graph.links.map((entry) => entry.trace)),
    paths: Object.freeze(paths),
    cases: Object.freeze(cases),
  });
}

function build(target) {
  assertSupportedBuildRuntime();
  assertExactBuildEnvironment();
  verifyLock();
  if (process.argv.length !== 3 || !["production", "all"].includes(target)) {
    fail("expected exactly one production or all target");
  }
  const compiler = selectCompiler();
  const node = deriveNodeInclude();
  const allowlistPath = resolve(nativeAbsolute, "toolchain-allowlist.json");
  validateToolchainAllowlist(readFileSync(allowlistPath));
  const context = {
    compiler,
    node,
    compilerInclude: realpathSync(
      spawnChecked(compiler, ["-print-file-name=include"]).stdout.trim(),
    ),
    allowlistSha256: hashFile(allowlistPath),
  };
  const graph = compileGraph(compiler, node.include);
  const compiles =
    target === "production" ? graph.compiles.slice(0, 2) : graph.compiles;
  const links = target === "production" ? graph.links.slice(0, 1) : graph.links;

  const staleDirectories = new Set([
    "",
    "obj",
    "obj/production",
    "obj/test",
    "obj/errno-test",
    "Release",
    "Test",
  ]);
  const staleFiles = new Set(
    [
      ...graph.compiles.flatMap((entry) => [entry.output, entry.depfile]),
      ...graph.links.flatMap((entry) => [entry.output, entry.map, entry.trace]),
      `${stage}/Release/atomic_directory_publication.inputs.sha256`,
      `${stage}/Test/atomic_directory_publication_test.inputs.sha256`,
      `${stage}/Test/atomic-directory-publication-errors.test.inputs.sha256`,
      `${stage}/Release/atomic-directory-publication.node.sha256`,
    ].map((path) => path.slice(`${stage}/`.length)),
  );
  if (existsSync(stageAbsolute)) {
    const observed = { directories: new Map(), files: new Map() };
    inspectStaleTree(
      stageAbsolute,
      staleDirectories,
      staleFiles,
      observed,
    );
    if (
      !matchesStaleTargetGrammar(observed, graph, "production") &&
      !matchesStaleTargetGrammar(observed, graph, "all")
    ) {
      fail("stale staging does not match a selected crash prefix");
    }
    removeVerifiedStaleTree(observed);
    fsyncDirectory(buildAbsolute);
  }
  for (const directory of [
    buildAbsolute,
    resolve(buildAbsolute, "obj"),
    resolve(buildAbsolute, "obj/production"),
    resolve(buildAbsolute, "Release"),
    ...(target === "all"
      ? [
          resolve(buildAbsolute, "obj/test"),
          resolve(buildAbsolute, "obj/errno-test"),
          resolve(buildAbsolute, "Test"),
        ]
      : []),
  ]) {
    ensureDirectory(directory);
  }
  mkdirSync(stageAbsolute, { mode: 0o700 });
  for (const relativeDirectory of [
    "obj",
    "obj/production",
    "Release",
    ...(target === "all" ? ["obj/test", "obj/errno-test", "Test"] : []),
  ]) {
    mkdirSync(resolve(stageAbsolute, relativeDirectory), { mode: 0o700 });
  }

  const sidecars = links.map((entry) =>
    entry.kind === "production"
      ? `${stage}/Release/atomic_directory_publication.inputs.sha256`
      : entry.kind === "test-addon"
        ? `${stage}/Test/atomic_directory_publication_test.inputs.sha256`
        : `${stage}/Test/atomic-directory-publication-errors.test.inputs.sha256`,
  );
  const checksum = `${stage}/Release/atomic-directory-publication.node.sha256`;
  const precreated = new Set([
    ...compiles.flatMap((entry) => [entry.output, entry.depfile]),
    ...links.flatMap((entry) => [entry.output, entry.map]),
    ...sidecars,
    checksum,
  ]);
  const precreatedLeaves = new Map();
  for (const path of precreated) {
    const fd = precreate(
      path,
      path.endsWith(".test") && !path.endsWith(".inputs.sha256")
        ? 0o700
        : 0o600,
    );
    const status = fstatSync(fd);
    precreatedLeaves.set(
      path,
      Object.freeze({
        dev: status.dev,
        ino: status.ino,
        uid: status.uid,
        mode: status.mode,
        nlink: status.nlink,
      }),
    );
    closeSync(fd);
  }
  const traceFds = new Map();
  for (const entry of links) {
    const fd = precreate(entry.trace);
    const status = fstatSync(fd);
    precreatedLeaves.set(
      entry.trace,
      Object.freeze({
        dev: status.dev,
        ino: status.ino,
        uid: status.uid,
        mode: status.mode,
        nlink: status.nlink,
      }),
    );
    traceFds.set(entry.trace, fd);
  }
  const directoryEvidence = captureBuildDirectoryChain([
    { path: packageRoot },
    { path: buildAbsolute, mode: 0o700 },
    { path: stageAbsolute, mode: 0o700 },
    { path: resolve(stageAbsolute, "obj"), mode: 0o700 },
    { path: resolve(stageAbsolute, "obj/production"), mode: 0o700 },
    { path: resolve(stageAbsolute, "Release"), mode: 0o700 },
    ...(target === "all"
      ? [
          { path: resolve(stageAbsolute, "obj/test"), mode: 0o700 },
          { path: resolve(stageAbsolute, "obj/errno-test"), mode: 0o700 },
          { path: resolve(stageAbsolute, "Test"), mode: 0o700 },
        ]
      : []),
    { path: resolve(buildAbsolute, "obj"), mode: 0o700 },
    { path: resolve(buildAbsolute, "obj/production"), mode: 0o700 },
    { path: resolve(buildAbsolute, "Release"), mode: 0o700 },
    ...(target === "all"
      ? [
          { path: resolve(buildAbsolute, "obj/test"), mode: 0o700 },
          { path: resolve(buildAbsolute, "obj/errno-test"), mode: 0o700 },
          { path: resolve(buildAbsolute, "Test"), mode: 0o700 },
        ]
      : []),
  ]);
  const completedLeaves = new Map();
  const bindPrecreatedLeaf = (path, evidence) => {
    const expected = precreatedLeaves.get(path);
    if (
      expected === undefined ||
      evidence.dev !== expected.dev ||
      evidence.ino !== expected.ino ||
      evidence.uid !== expected.uid ||
      evidence.mode !== expected.mode ||
      evidence.nlink !== expected.nlink
    ) {
      fail(`generated leaf ${path} does not match its O_EXCL inode`);
    }
    return evidence;
  };
  const writePrecreatedLeaf = (path, bytes) => {
    const absolute = resolve(packageRoot, path);
    const fd = openSync(
      absolute,
      constants.O_WRONLY | constants.O_NOFOLLOW,
    );
    try {
      const status = fstatSync(fd);
      bindPrecreatedLeaf(path, status);
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  };
  const validateAfterChild = () => {
    verifyCompletedLeaves(completedLeaves);
    verifyBuildDirectoryChainAndSync(directoryEvidence);
  };
  validateAfterChild();

  for (const entry of compiles) {
    spawnChecked(entry.args[0], entry.args.slice(1));
    for (const [path, evidence] of validateCompileResult(entry, context)) {
      completedLeaves.set(path, bindPrecreatedLeaf(path, evidence));
    }
    validateAfterChild();
  }
  for (const entry of links) {
    const traceFd = traceFds.get(entry.trace);
    try {
      spawnChecked(entry.args[0], entry.args.slice(1), {
        stdio: childStdio(traceFd, "pipe"),
      });
      fsyncSync(traceFd);
    } finally {
      closeSync(traceFd);
      traceFds.delete(entry.trace);
    }
    if (entry.output.endsWith(".node")) {
      chmodSync(resolve(packageRoot, entry.output), 0o600);
    }
    completedLeaves.set(
      entry.output,
      bindPrecreatedLeaf(
        entry.output,
        verifyGeneratedLeaf(
          entry.output,
          entry.output.endsWith("atomic-directory-publication-errors.test")
            ? 0o700
            : 0o600,
        ),
      ),
    );
    completedLeaves.set(
      entry.map,
      bindPrecreatedLeaf(entry.map, verifyGeneratedLeaf(entry.map)),
    );
    completedLeaves.set(
      entry.trace,
      bindPrecreatedLeaf(entry.trace, verifyGeneratedLeaf(entry.trace)),
    );
    parseElfNeeded(resolve(packageRoot, entry.output));
    validateAfterChild();
  }
  for (const traceFd of traceFds.values()) {
    closeSync(traceFd);
  }

  if (target === "all") {
    spawnChecked(resolve(packageRoot, graph.links[2].output), []);
    validateAfterChild();
    verifyModule(graph.links[1].output, true);
    validateAfterChild();
  }
  verifyModule(graph.links[0].output);
  validateAfterChild();

  context.afterChild = validateAfterChild;
  const expectedInventories = new Map();
  for (let index = 0; index < links.length; index++) {
    const link = links[index];
    const related =
      link.kind === "production"
        ? compiles.slice(0, 2)
        : link.kind === "test-addon"
          ? compiles.slice(2, 5)
          : compiles.slice(5, 8);
    const inventory = inventoryFor(link.output, related, link, context);
    expectedInventories.set(sidecars[index], inventory);
    writePrecreatedLeaf(
      sidecars[index],
      `${JSON.stringify(inventory)}\n`,
    );
    completedLeaves.set(
      sidecars[index],
      bindPrecreatedLeaf(
        sidecars[index],
        verifyGeneratedLeaf(sidecars[index]),
      ),
    );
    validateAfterChild();
  }
  const productionBytes = readFileSync(
    resolve(packageRoot, graph.links[0].output),
  );
  writePrecreatedLeaf(
    checksum,
    `${JSON.stringify({
      interfaceVersion: "1.0.0",
      napiVersion: 8,
      sha256: sha256(productionBytes),
    })}\n`,
  );
  completedLeaves.set(
    checksum,
    bindPrecreatedLeaf(checksum, verifyGeneratedLeaf(checksum)),
  );
  validateAfterChild();

  const publishOrder = [
    ...compiles.flatMap((entry) => [entry.output, entry.depfile]),
    ...links.flatMap((entry) => [entry.map, entry.trace]),
    ...sidecars,
    ...(target === "all" ? [graph.links[2].output, graph.links[1].output] : []),
    graph.links[0].output,
    checksum,
  ];
  const uniquePublishOrder = [...new Set(publishOrder)];
  for (const path of uniquePublishOrder) {
    const fd = openSync(resolve(packageRoot, path), constants.O_RDONLY);
    fsyncSync(fd);
    closeSync(fd);
  }
  for (const directory of [
    resolve(stageAbsolute, "obj/production"),
    ...(target === "all"
      ? [
          resolve(stageAbsolute, "obj/test"),
          resolve(stageAbsolute, "obj/errno-test"),
          resolve(stageAbsolute, "Test"),
        ]
      : []),
    resolve(stageAbsolute, "obj"),
    resolve(stageAbsolute, "Release"),
    stageAbsolute,
  ]) {
    fsyncDirectory(directory);
  }
  executeNativePublication(uniquePublishOrder, expectedInventories);
  const remaining = { directories: new Map(), files: new Map() };
  inspectStaleTree(stageAbsolute, staleDirectories, staleFiles, remaining);
  if (remaining.files.size !== 0) {
    fail("published staging retained undeclared leaves");
  }
  removeVerifiedStaleTree(remaining);
  fsyncDirectory(buildAbsolute);

  if (target === "all") {
    spawnChecked(resolve(packageRoot, finalFor(graph.links[2].output)), []);
    verifyModule(finalFor(graph.links[1].output), true);
  }
  verifyModule(finalFor(graph.links[0].output));
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    build(process.argv[2]);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
