import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertExactBuildEnvironment,
  assertSupportedBuildRuntime,
  createCompilerEnvironment,
  runBuildPublicationMatrixForTest,
  validateToolchainAllowlist,
} from "./build-native.mjs";

test("uses only the exact compiler environment", () => {
  const environment = createCompilerEnvironment();
  assert.equal(Object.getPrototypeOf(environment), null);
  assert.deepEqual(
    { ...environment },
    {
      PATH: "/usr/bin:/bin",
      LC_ALL: "C",
      LANG: "C",
      TZ: "UTC",
      SOURCE_DATE_EPOCH: "1",
      ATOMIC_BUILD_LOCK_FD: "9",
    },
  );
  assert.doesNotThrow(() => assertExactBuildEnvironment(environment));
  for (const key of ["TMPDIR", "NODE_OPTIONS", "CC", "EXTRA"]) {
    assert.throws(
      () => assertExactBuildEnvironment({ ...environment, [key]: "x" }),
      /exact closed set/,
    );
  }
});

test("accepts only Linux x64 and arm64 on Node 22.22.1", () => {
  assert.doesNotThrow(() =>
    assertSupportedBuildRuntime({
      platform: "linux",
      arch: "x64",
      version: "v22.22.1",
    }),
  );
  assert.doesNotThrow(() =>
    assertSupportedBuildRuntime({
      platform: "linux",
      arch: "arm64",
      version: "v22.22.1",
    }),
  );
  for (const candidate of [
    { platform: "darwin", arch: "x64", version: "v22.22.1" },
    { platform: "win32", arch: "x64", version: "v22.22.1" },
    { platform: "linux", arch: "ia32", version: "v22.22.1" },
    { platform: "linux", arch: "riscv64", version: "v22.22.1" },
    { platform: "linux", arch: "x64", version: "v22.22.0" },
  ]) {
    assert.throws(() => assertSupportedBuildRuntime(candidate), /unsupported/i);
  }
});

test("exports only closed build test seams", async () => {
  const module = await import("./build-native.mjs");
  assert.deepEqual(Object.keys(module), [
    "assertExactBuildEnvironment",
    "assertSupportedBuildRuntime",
    "createCompilerEnvironment",
    "runBuildPublicationMatrixForTest",
    "validateToolchainAllowlist",
  ]);
  assert.equal(Object.hasOwn(module, "compileGraph"), false);
  assert.equal(Object.hasOwn(module, "parseElfNeeded"), false);
});

test("proves concrete amd64 and arm64 dockerInit tuples", async () => {
  const bytes = await readFile(
    new URL("../native/toolchain-allowlist.json", import.meta.url),
  );
  const allowlist = validateToolchainAllowlist(bytes);
  assert.deepEqual(Object.keys(allowlist), ["schemaVersion", "dockerInit"]);
  assert.deepEqual(Object.keys(allowlist.dockerInit), ["amd64", "arm64"]);
  const inspection = spawnSync(
    "docker",
    [
      "buildx",
      "imagetools",
      "inspect",
      allowlist.dockerInit.amd64.nodeBaseRepository,
    ],
    { encoding: "utf8" },
  );
  assert.equal(inspection.error, undefined, inspection.error?.message);
  assert.equal(inspection.status, 0, inspection.stderr);
  assert.match(
    inspection.stdout,
    new RegExp(`Digest:\\s+${allowlist.dockerInit.amd64.nodeBaseIndexDigest}`),
  );
  const probe = String.raw`
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { readFileSync, realpathSync } = require("node:fs");
const hash = path => createHash("sha256").update(readFileSync(path)).digest("hex");
process.stdout.write(JSON.stringify({
  osReleaseSha256: hash("/etc/os-release"),
  dpkgArchitecture: execFileSync("dpkg", ["--print-architecture"], { encoding: "utf8" }).trim(),
  utilLinuxVersion: execFileSync("dpkg-query", ["-W", "-f=" + "$" + "{Version}", "util-linux"], { encoding: "utf8" }).trim(),
  flockRealpath: realpathSync("/usr/bin/flock"),
  flockSha256: hash("/usr/bin/flock"),
}));
`;
  for (const [arch, tuple] of Object.entries(allowlist.dockerInit)) {
    assert.equal(tuple.targetArch, arch);
    assert.equal(tuple.dpkgArchitecture, arch);
    assert.match(tuple.nodeBaseIndexDigest, /^sha256:[0-9a-f]{64}$/);
    assert.match(tuple.nodeBasePlatformDigest, /^sha256:[0-9a-f]{64}$/);
    assert.match(tuple.osReleaseSha256, /^[0-9a-f]{64}$/);
    assert.equal(tuple.utilLinuxPackage, "util-linux");
    assert.match(tuple.utilLinuxVersion, /^[^*{}<>]+$/);
    assert.equal(tuple.flockRealpath, "/usr/bin/flock");
    assert.match(tuple.flockSha256, /^[0-9a-f]{64}$/);
    assert.match(inspection.stdout, new RegExp(tuple.nodeBasePlatformDigest));
    const result = spawnSync(
      "docker",
      [
        "run",
        "--rm",
        "--platform",
        `linux/${arch}`,
        `${tuple.nodeBaseRepository}@${tuple.nodeBasePlatformDigest}`,
        "node",
        "-e",
        probe,
      ],
      { encoding: "utf8", maxBuffer: 1024 * 1024 },
    );
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      osReleaseSha256: tuple.osReleaseSha256,
      dpkgArchitecture: tuple.dpkgArchitecture,
      utilLinuxVersion: tuple.utilLinuxVersion,
      flockRealpath: tuple.flockRealpath,
      flockSha256: tuple.flockSha256,
    });
  }
});

test("rejects malformed and mutable allowlists", () => {
  for (const value of [
    Buffer.from("{}\n"),
    Buffer.from('{"schemaVersion":1,"dockerInit":{"amd64":"latest"}}\n'),
    Buffer.from(
      '{"schemaVersion":1,"dockerInit":{"amd64":{},"arm64":{}},"extra":1}\n',
    ),
    Buffer.from(
      '{"schemaVersion":1,"schemaVersion":1,"dockerInit":{"amd64":{},"arm64":{}}}\n',
    ),
    Buffer.from('{ "schemaVersion":1,"dockerInit":{"amd64":{},"arm64":{}} }\n'),
  ]) {
    assert.throws(() => validateToolchainAllowlist(value), /allowlist/i);
  }
});

test("recompiles and relinks the complete graph on consecutive runs", () => {
  const runner = new URL("./run-native-build.mjs", import.meta.url);
  const production = new URL(
    "../build/Release/atomic_directory_publication.node",
    import.meta.url,
  );
  const testAddon = new URL(
    "../build/Test/atomic_directory_publication_test.node",
    import.meta.url,
  );
  const errno = new URL(
    "../build/Test/atomic-directory-publication-errors.test",
    import.meta.url,
  );
  const environment = {
    PATH: "/home/mamba/.nvm/versions/node/v22.22.1/bin:/usr/bin:/bin",
    LC_ALL: "C",
    LANG: "C",
    TZ: "UTC",
  };
  const run = () => {
    const result = spawnSync(process.execPath, [runner.pathname, "all"], {
      env: environment,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    return [production, testAddon, errno].map((url) => ({
      inode: lstatSync(url).ino,
      bytes: readFileSync(url),
    }));
  };
  const first = run();
  const second = run();
  for (let index = 0; index < first.length; index++) {
    assert.notEqual(first[index].inode, second[index].inode);
    assert.deepEqual(first[index].bytes, second[index].bytes);
  }
});

test("covers the exact full graph and every filesystem boundary", () => {
  assert.equal(runBuildPublicationMatrixForTest.length, 0);
  const matrix = runBuildPublicationMatrixForTest();
  const nativeRoot = new URL("../native/", import.meta.url).pathname;
  const expectedCompileArgv = [
    [
      "/usr/bin/gcc", "-fPIC", "-std=c11", "-DNAPI_VERSION=8", "-Wall",
      "-Wextra", "-Werror", "-O2", "-MD", "-I", "/node/include", "-MF",
      "build/.atomic-directory-publication-stage/obj/production/addon.d",
      "-c", `${nativeRoot}atomic-directory-publication-addon.c`, "-o",
      "build/.atomic-directory-publication-stage/obj/production/addon.o",
    ],
    [
      "/usr/bin/gcc", "-fPIC", "-std=c11", "-DNAPI_VERSION=8", "-Wall",
      "-Wextra", "-Werror", "-O2", "-MD", "-I", "/node/include", "-MF",
      "build/.atomic-directory-publication-stage/obj/production/errors.d",
      "-c", `${nativeRoot}atomic-directory-publication-errors.c`, "-o",
      "build/.atomic-directory-publication-stage/obj/production/errors.o",
    ],
    [
      "/usr/bin/gcc", "-fPIC", "-std=c11", "-DNAPI_VERSION=8",
      "-DATOMIC_PUBLISH_TEST_HOOKS=1", "-Wall", "-Wextra", "-Werror", "-O2",
      "-MD", "-I", "/node/include", "-MF",
      "build/.atomic-directory-publication-stage/obj/test/addon.d", "-c",
      `${nativeRoot}atomic-directory-publication-addon.c`, "-o",
      "build/.atomic-directory-publication-stage/obj/test/addon.o",
    ],
    [
      "/usr/bin/gcc", "-fPIC", "-std=c11", "-DNAPI_VERSION=8",
      "-DATOMIC_PUBLISH_TEST_HOOKS=1", "-Wall", "-Wextra", "-Werror", "-O2",
      "-MD", "-I", "/node/include", "-MF",
      "build/.atomic-directory-publication-stage/obj/test/errors.d", "-c",
      `${nativeRoot}atomic-directory-publication-errors.c`, "-o",
      "build/.atomic-directory-publication-stage/obj/test/errors.o",
    ],
    [
      "/usr/bin/gcc", "-fPIC", "-std=c11", "-DNAPI_VERSION=8",
      "-DATOMIC_PUBLISH_TEST_HOOKS=1", "-Wall", "-Wextra", "-Werror", "-O2",
      "-MD", "-I", "/node/include", "-MF",
      "build/.atomic-directory-publication-stage/obj/test/test-hooks.d", "-c",
      `${nativeRoot}atomic-directory-publication-test-hooks.c`, "-o",
      "build/.atomic-directory-publication-stage/obj/test/test-hooks.o",
    ],
    [
      "/usr/bin/gcc", "-std=c11", "-Wall", "-Wextra", "-Werror", "-O2",
      "-MD", "-MF",
      "build/.atomic-directory-publication-stage/obj/errno-test/main.d", "-c",
      `${nativeRoot}atomic-directory-publication-errors.test.c`, "-o",
      "build/.atomic-directory-publication-stage/obj/errno-test/main.o",
    ],
    [
      "/usr/bin/gcc", "-std=c11", "-Wall", "-Wextra", "-Werror", "-O2",
      "-MD", "-DATOMIC_PUBLISH_ERRNO_VARIANT_ALIAS=1",
      "-Datomic_publish_map_errno=atomic_publish_map_errno_alias", "-MF",
      "build/.atomic-directory-publication-stage/obj/errno-test/errors-alias.d",
      "-c", `${nativeRoot}atomic-directory-publication-errors.c`, "-o",
      "build/.atomic-directory-publication-stage/obj/errno-test/errors-alias.o",
    ],
    [
      "/usr/bin/gcc", "-std=c11", "-Wall", "-Wextra", "-Werror", "-O2",
      "-MD", "-DATOMIC_PUBLISH_ERRNO_VARIANT_DISTINCT=1",
      "-Datomic_publish_map_errno=atomic_publish_map_errno_distinct", "-MF",
      "build/.atomic-directory-publication-stage/obj/errno-test/errors-distinct.d",
      "-c", `${nativeRoot}atomic-directory-publication-errors.c`, "-o",
      "build/.atomic-directory-publication-stage/obj/errno-test/errors-distinct.o",
    ],
  ];
  const expectedCompileStdio = [
    ["ignore", "pipe", "pipe", "ignore", "ignore", "ignore", "ignore", "ignore", "ignore", 9],
    ["ignore", "pipe", "pipe", "ignore", "ignore", "ignore", "ignore", "ignore", "ignore", 9],
    ["ignore", "pipe", "pipe", "ignore", "ignore", "ignore", "ignore", "ignore", "ignore", 9],
    ["ignore", "pipe", "pipe", "ignore", "ignore", "ignore", "ignore", "ignore", "ignore", 9],
    ["ignore", "pipe", "pipe", "ignore", "ignore", "ignore", "ignore", "ignore", "ignore", 9],
    ["ignore", "pipe", "pipe", "ignore", "ignore", "ignore", "ignore", "ignore", "ignore", 9],
    ["ignore", "pipe", "pipe", "ignore", "ignore", "ignore", "ignore", "ignore", "ignore", 9],
    ["ignore", "pipe", "pipe", "ignore", "ignore", "ignore", "ignore", "ignore", "ignore", 9],
  ];
  const expectedLinkArgv = [
    [
      "/usr/bin/gcc", "-shared",
      "-Wl,-Map,build/.atomic-directory-publication-stage/Release/atomic_directory_publication.map",
      "-Wl,--trace",
      "build/.atomic-directory-publication-stage/obj/production/addon.o",
      "build/.atomic-directory-publication-stage/obj/production/errors.o",
      "-o",
      "build/.atomic-directory-publication-stage/Release/atomic_directory_publication.node",
    ],
    [
      "/usr/bin/gcc", "-shared",
      "-Wl,-Map,build/.atomic-directory-publication-stage/Test/atomic_directory_publication_test.map",
      "-Wl,--trace",
      "build/.atomic-directory-publication-stage/obj/test/addon.o",
      "build/.atomic-directory-publication-stage/obj/test/errors.o",
      "build/.atomic-directory-publication-stage/obj/test/test-hooks.o", "-o",
      "build/.atomic-directory-publication-stage/Test/atomic_directory_publication_test.node",
    ],
    [
      "/usr/bin/gcc",
      "-Wl,-Map,build/.atomic-directory-publication-stage/Test/atomic-directory-publication-errors.map",
      "-Wl,--trace",
      "build/.atomic-directory-publication-stage/obj/errno-test/main.o",
      "build/.atomic-directory-publication-stage/obj/errno-test/errors-alias.o",
      "build/.atomic-directory-publication-stage/obj/errno-test/errors-distinct.o",
      "-o",
      "build/.atomic-directory-publication-stage/Test/atomic-directory-publication-errors.test",
    ],
  ];
  const expectedTraceStdout = [
    "build/.atomic-directory-publication-stage/Release/atomic_directory_publication.trace",
    "build/.atomic-directory-publication-stage/Test/atomic_directory_publication_test.trace",
    "build/.atomic-directory-publication-stage/Test/atomic-directory-publication-errors.trace",
  ];
  const expectedLinkStdio = [
    ["ignore", "build/.atomic-directory-publication-stage/Release/atomic_directory_publication.trace", "pipe", "ignore", "ignore", "ignore", "ignore", "ignore", "ignore", 9],
    ["ignore", "build/.atomic-directory-publication-stage/Test/atomic_directory_publication_test.trace", "pipe", "ignore", "ignore", "ignore", "ignore", "ignore", "ignore", 9],
    ["ignore", "build/.atomic-directory-publication-stage/Test/atomic-directory-publication-errors.trace", "pipe", "ignore", "ignore", "ignore", "ignore", "ignore", "ignore", 9],
  ];
  assert.deepEqual(matrix.compileArgv, expectedCompileArgv);
  assert.deepEqual(matrix.compileStdio, expectedCompileStdio);
  assert.deepEqual(matrix.linkArgv, expectedLinkArgv);
  assert.deepEqual(matrix.linkStdio, expectedLinkStdio);
  assert.deepEqual(matrix.traceStdout, expectedTraceStdout);
  assert.equal(matrix.paths.length, 29);
  const success = matrix.cases.at(-1);
  assert.equal(success.boundaries.length, 161);
  assert.equal(matrix.cases.length, success.boundaries.length + 1);
  assert.ok(
    success.boundaries.some((name) => name === "compile:production-addon:spawn"),
  );
  assert.ok(
    success.boundaries.some((name) => name === "link:production:spawn"),
  );
  assert.ok(
    success.boundaries.some((name) =>
      name.endsWith("atomic-directory-publication.node.sha256:target-fsync"),
    ),
  );
  for (let index = 0; index < success.boundaries.length; index++) {
    const result = matrix.cases[index];
    assert.equal(result.failAt, index);
    assert.equal(result.crashed, true);
    assert.equal(result.complete, false);
    assert.equal(result.recovered, true);
    assert.equal(result.recoveryInterrupted, true);
    if (result.checksumIsNew) {
      assert.deepEqual(result.targetHashes, success.targetHashes);
    }
  }
  assert.equal(success.complete, true);
  assert.equal(success.checksumPublished, true);
  assert.equal(success.checksumIsNew, true);
  assert.equal(success.recovered, true);
  assert.equal(success.recoveryInterrupted, true);
  assert.equal(success.targetHashes.length, 29);
});
