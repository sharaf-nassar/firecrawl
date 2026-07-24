import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  cpSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertBrowserServiceRuntime,
  assertTrustedBuildInputs,
  evaluateRuntimeDirectoryIdentityForTest,
  validateRuntimeAttestation,
} from "./runtime-preflight.mjs";

test("accepts only Node 22.22.1", () => {
  assert.doesNotThrow(() => assertBrowserServiceRuntime("v22.22.1"));
  for (const version of ["v22.22.0", "v23.0.0", "v25.8.2"]) {
    assert.throws(() => assertBrowserServiceRuntime(version), {
      category: "browser_service_runtime_mismatch",
    });
  }
});

test("accepts only Linux x64 and arm64", () => {
  for (const arch of ["x64", "arm64"]) {
    assert.doesNotThrow(() =>
      assertBrowserServiceRuntime("v22.22.1", "linux", arch),
    );
  }
  for (const [platform, arch] of [
    ["darwin", "x64"],
    ["win32", "x64"],
    ["linux", "ia32"],
    ["linux", "riscv64"],
  ]) {
    assert.throws(
      () => assertBrowserServiceRuntime("v22.22.1", platform, arch),
      /runtime_mismatch/,
    );
  }
});

test("rejects malformed or mismatched native attestations", () => {
  assert.throws(
    () => validateRuntimeAttestation(Buffer.from("{}\n"), Buffer.alloc(1)),
    /native artifact/i,
  );
  assert.throws(
    () =>
      validateRuntimeAttestation(
        Buffer.from(
          '{"interfaceVersion":"1.0.0","napiVersion":8,"sha256":"' +
            "0".repeat(64) +
            '"}\n',
        ),
        Buffer.from("wrong"),
      ),
    /native artifact/i,
  );
});

test("validates fixed preinstall flock and build inputs", () => {
  assert.doesNotThrow(() => assertTrustedBuildInputs());
});

test("accepts live one-link directories and rejects identity mutations", () => {
  const baseline = {
    type: "directory",
    dev: 7n,
    ino: 11n,
    uid: BigInt(process.getuid()),
    gid: BigInt(process.getgid()),
    mode: 0o40700n,
    nlink: 1n,
  };
  assert.deepEqual(
    evaluateRuntimeDirectoryIdentityForTest(baseline, baseline),
    { live: true, stable: true },
  );
  for (const mutation of [
    { nlink: 0n },
    { nlink: BigInt(Number.MAX_SAFE_INTEGER) + 1n },
    { type: "file" },
    { uid: baseline.uid + 1n },
    { mode: 0o40755n },
  ]) {
    assert.deepEqual(
      evaluateRuntimeDirectoryIdentityForTest(
        { ...baseline, ...mutation },
        baseline,
      ),
      { live: false, stable: false },
    );
  }
  for (const mutation of [
    { dev: baseline.dev + 1n },
    { ino: baseline.ino + 1n },
    { gid: baseline.gid + 1n },
    { nlink: baseline.nlink + 1n },
  ]) {
    assert.deepEqual(
      evaluateRuntimeDirectoryIdentityForTest(
        { ...baseline, ...mutation },
        baseline,
      ),
      { live: true, stable: false },
    );
  }
});

test(
  "runs prestart in final amd64 and arm64 image filesystems",
  {
    skip: process.env.FIRECRAWL_TASK6_IMAGE_ACCEPTANCE !== "1",
  },
  () => {
    const repositoryRoot = new URL("../../..", import.meta.url);
    const runId =
      `${process.pid}-${randomUUID().replaceAll("-", "")}`;
    const ownershipLabel = "com.firecrawl.task6.runtime-preflight";
    const label = `${ownershipLabel}=${runId}`;
    const images = [];
    const containers = [];
    const command = (argv, options = {}) =>
      spawnSync("docker", argv, {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        ...options,
      });
    const output = (result) =>
      [result.stdout, result.stderr].filter(Boolean).join("\n");
    const assertAbsent = (kind, name) => {
      const result = command([kind, "inspect", name]);
      assert.equal(result.error, undefined, result.error?.message);
      assert.notEqual(result.status, 0, `${kind} collision: ${name}`);
      assert.match(
        result.stderr,
        /No such (?:image|object|container)/i,
        output(result),
      );
    };
    const inspectOwned = (kind, name) => {
      const result = command([kind, "inspect", name]);
      assert.equal(result.error, undefined, result.error?.message);
      if (result.status !== 0) {
        assert.match(
          result.stderr,
          /No such (?:image|object|container)/i,
          output(result),
        );
        return false;
      }
      const [record] = JSON.parse(result.stdout);
      assert.equal(
        record?.Config?.Labels?.[ownershipLabel],
        runId,
        `${kind} ownership changed: ${name}`,
      );
      return true;
    };
    const metadataProbe = String.raw`
import { lstatSync } from "node:fs";
import { assertNativeRuntimeArtifact } from "./src/runtime-preflight.mjs";
const paths = [
  "build/Release",
  "build/Release/atomic_directory_publication.node",
  "build/Release/atomic-directory-publication.node.sha256",
];
assertNativeRuntimeArtifact();
process.stdout.write(JSON.stringify({
  accepted: true,
  metadata: paths.map((path) => {
    const status = lstatSync(path, { bigint: true });
    return {
      path,
      type: status.isDirectory() ? "directory" : status.isFile() ? "file" : "other",
      uid: String(status.uid),
      gid: String(status.gid),
      mode: (status.mode & 0o7777n).toString(8),
      nlink: String(status.nlink),
    };
  }),
}));
`;
    let acceptanceFailure;
    const cleanupFailures = [];
    const cleanupStep = (callback) => {
      try {
        callback();
      } catch (error) {
        cleanupFailures.push(error);
      }
    };
    try {
      for (const arch of ["amd64", "arm64"]) {
        const namespace = `firecrawl-task6-preflight-${runId}-${arch}`;
        const image = `${namespace}:test`;
        const container = `${namespace}-run`;
        assertAbsent("image", image);
        assertAbsent("container", container);
        images.push(image);
        containers.push(container);
        const build = command(
          [
            "build",
            "--platform",
            `linux/${arch}`,
            "--target",
            "browser-service-runtime",
            "--tag",
            image,
            "--label",
            label,
            "--file",
            "apps/browser-service/Dockerfile",
            ".",
          ],
          {
            cwd: repositoryRoot,
            timeout: 15 * 60 * 1000,
          },
        );
        assert.equal(build.error, undefined, build.error?.message);
        assert.equal(build.status, 0, output(build));
        assert.equal(inspectOwned("image", image), true);
        const preflight = command(
          [
            "run",
            "--rm",
            "--name",
            container,
            "--label",
            label,
            "--platform",
            `linux/${arch}`,
            "--entrypoint",
            "/usr/local/bin/node",
            image,
            "--input-type=module",
            "--eval",
            metadataProbe,
          ],
          { timeout: 2 * 60 * 1000 },
        );
        assert.equal(preflight.error, undefined, preflight.error?.message);
        assert.equal(preflight.status, 0, output(preflight));
        const result = JSON.parse(preflight.stdout);
        assert.equal(result.accepted, true);
        const expected = [
          {
            path: "build/Release",
            type: "directory",
            uid: "1000",
            gid: "1000",
            mode: "700",
          },
          {
            path: "build/Release/atomic_directory_publication.node",
            type: "file",
            uid: "1000",
            gid: "1000",
            mode: "600",
          },
          {
            path:
              "build/Release/atomic-directory-publication.node.sha256",
            type: "file",
            uid: "1000",
            gid: "1000",
            mode: "600",
          },
        ];
        assert.deepEqual(
          result.metadata.map(({ nlink: _nlink, ...entry }) => entry),
          expected,
        );
        for (const { nlink } of result.metadata) {
          assert.ok(BigInt(nlink) >= 1n, `unlinked image path: ${nlink}`);
          assert.ok(
            BigInt(nlink) <= BigInt(Number.MAX_SAFE_INTEGER),
            `unsafe image link count: ${nlink}`,
          );
        }
      }
    } catch (error) {
      acceptanceFailure = error;
    } finally {
      for (const container of containers.toReversed()) {
        cleanupStep(() => {
          if (!inspectOwned("container", container)) return;
          const removed = command(["container", "rm", "--force", container]);
          assert.equal(removed.status, 0, output(removed));
        });
      }
      for (const image of images.toReversed()) {
        cleanupStep(() => {
          if (!inspectOwned("image", image)) return;
          const removed = command(["image", "rm", image]);
          assert.equal(removed.status, 0, output(removed));
        });
      }
      for (const [kind, argv] of [
        [
          "container",
          [
            "container",
            "ls",
            "--all",
            "--filter",
            `label=${label}`,
            "--quiet",
          ],
        ],
        [
          "image",
          [
            "image",
            "ls",
            "--filter",
            `label=${label}`,
            "--quiet",
          ],
        ],
        [
          "volume",
          [
            "volume",
            "ls",
            "--filter",
            `label=${label}`,
            "--quiet",
          ],
        ],
      ]) {
        cleanupStep(() => {
          const inventory = command(argv);
          assert.equal(inventory.status, 0, output(inventory));
          assert.equal(
            inventory.stdout.trim(),
            "",
            `${kind} resources leaked for ${runId}`,
          );
        });
      }
    }
    const failures = [
      ...(acceptanceFailure === undefined ? [] : [acceptanceFailure]),
      ...cleanupFailures,
    ];
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        "Task6 image acceptance or cleanup failed",
      );
    }
  },
);

test("copied-package prestart rejects fixed artifact corruption", () => {
  const root = mkdtempSync(join(tmpdir(), "atomic-prestart-copy-"));
  try {
    for (const directory of [
      "src",
      "scripts",
      "native",
      "build/Release",
      "build/Test",
    ]) {
      mkdirSync(join(root, directory), { recursive: true });
    }
    chmodSync(join(root, "build/Release"), 0o700);
    chmodSync(join(root, "build/Test"), 0o700);
    writeFileSync(
      join(root, "package.json"),
      '{"private":true,"type":"module"}\n',
    );
    cpSync(
      new URL("./runtime-preflight.mjs", import.meta.url),
      join(root, "src/runtime-preflight.mjs"),
    );
    cpSync(
      new URL("../scripts/build-native.mjs", import.meta.url),
      join(root, "scripts/build-native.mjs"),
    );
    cpSync(
      new URL("../scripts/run-native-build.mjs", import.meta.url),
      join(root, "scripts/run-native-build.mjs"),
    );
    for (const leaf of [
      "atomic-directory-publication-addon.c",
      "atomic-directory-publication-errors.c",
      "atomic-directory-publication-errors.h",
      "toolchain-allowlist.json",
    ]) {
      cpSync(
        new URL(`../native/${leaf}`, import.meta.url),
        join(root, "native", leaf),
      );
    }
    const artifact = new URL(
      "../build/Release/atomic_directory_publication.node",
      import.meta.url,
    );
    const checksum = new URL(
      "../build/Release/atomic-directory-publication.node.sha256",
      import.meta.url,
    );
    cpSync(
      artifact,
      join(root, "build/Release/atomic_directory_publication.node"),
    );
    cpSync(
      checksum,
      join(root, "build/Release/atomic-directory-publication.node.sha256"),
    );
    cpSync(
      new URL(
        "../build/Test/atomic_directory_publication_test.node",
        import.meta.url,
      ),
      join(root, "build/Test/atomic_directory_publication_test.node"),
    );
    const runtimeSource = readFileSync(
      new URL("./runtime-preflight.mjs", import.meta.url),
      "utf8",
    );
    const writeVariant = (leaf, replacements) => {
      let source = runtimeSource;
      for (const [expected, replacement] of replacements) {
        assert.ok(
          source.includes(expected),
          `missing fixture anchor: ${expected}`,
        );
        source = source.replace(expected, replacement);
      }
      const path = join(root, "src", leaf);
      writeFileSync(path, source);
      return path;
    };
    const runPrestart = (path, options = {}) =>
      spawnSync(process.execPath, [path, "--phase=prestart"], {
        encoding: "utf8",
        ...options,
      });
    const valid = spawnSync(
      process.execPath,
      [join(root, "src/runtime-preflight.mjs"), "--phase=prestart"],
      { encoding: "utf8" },
    );
    assert.equal(valid.status, 0, valid.stderr);

    for (const mode of [0o664, 0o646]) {
      chmodSync(join(root, "scripts/build-native.mjs"), mode);
      const writableInput = spawnSync(
        process.execPath,
        [join(root, "src/runtime-preflight.mjs"), "--phase=preinstall"],
        { encoding: "utf8" },
      );
      assert.notEqual(writableInput.status, 0);
      assert.match(writableInput.stderr, /identity is untrusted/i);
    }
    chmodSync(join(root, "scripts/build-native.mjs"), 0o644);

    for (const mode of [0o664, 0o646]) {
      chmodSync(
        join(root, "native/atomic-directory-publication-errors.h"),
        mode,
      );
      const writableHeader = spawnSync(
        process.execPath,
        [join(root, "src/runtime-preflight.mjs"), "--phase=preinstall"],
        { encoding: "utf8" },
      );
      assert.notEqual(writableHeader.status, 0);
      assert.match(writableHeader.stderr, /identity is untrusted/i);
    }
    chmodSync(
      join(root, "native/atomic-directory-publication-errors.h"),
      0o644,
    );

    const headerLink = join(root, "native/errors-negative-hardlink.h");
    linkSync(
      join(root, "native/atomic-directory-publication-errors.h"),
      headerLink,
    );
    const linkedHeader = spawnSync(
      process.execPath,
      [join(root, "src/runtime-preflight.mjs"), "--phase=preinstall"],
      { encoding: "utf8" },
    );
    assert.notEqual(linkedHeader.status, 0);
    assert.match(linkedHeader.stderr, /identity is untrusted/i);
    unlinkSync(headerLink);

    unlinkSync(
      join(root, "build/Release/atomic_directory_publication.node"),
    );
    const absent = runPrestart(join(root, "src/runtime-preflight.mjs"));
    assert.notEqual(absent.status, 0);
    assert.match(absent.stderr, /held native load failed/i);
    cpSync(
      artifact,
      join(root, "build/Release/atomic_directory_publication.node"),
    );

    const dlopenCall = `process.dlopen(
      moduleRecord,
      \`/proc/self/fd/\${addonFd}\`,
      osConstants.dlopen.RTLD_NOW,
    );`;
    assert.ok(runtimeSource.includes(dlopenCall));
    assert.equal(
      runtimeSource.match(
        /`\$\{directoryProcfd\}\/\$\{nativeLeaf\}`/g,
      )?.length,
      1,
    );
    const heldDlopenChild = String.raw`
import {
  closeSync,
  copyFileSync,
  fstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const runtimePath = process.argv[2];
const root = process.argv[3];
const mode = process.argv[4];
const timing = process.argv[5];
const build = join(root, "build");
const release = join(root, "build/Release");
const packageLeaf = join(release, "atomic_directory_publication.node");
const testLeaf = join(root, "build/Test/atomic_directory_publication_test.node");
const backupRelease = join(build, ".held-child-original-release");
const originalDlopen = process.dlopen;
const identityKeys = [
  "dev", "ino", "size", "mode", "uid", "gid", "nlink", "mtimeNs", "ctimeNs",
];
let dlopenCount = 0;
let cleanupNeeded = false;
let originalIdentity;
let identityStable = false;
let replacementIdentity;

function deviceIdentity(device) {
  return {
    major: ((device >> 8n) & 0xfffn) | ((device >> 32n) & 0xfffff000n),
    minor: (device & 0xffn) | ((device >> 12n) & 0xffffff00n),
  };
}

function mapped(identity) {
  const device = deviceIdentity(identity.dev);
  return readFileSync("/proc/self/maps", "utf8").split("\n").some((line) => {
    const match = line.match(
      /^[0-9a-f]+-[0-9a-f]+\s+[-rwxps]{4}\s+[0-9a-f]+\s+([0-9a-f]+):([0-9a-f]+)\s+([0-9]+)(?:\s|$)/,
    );
    return match !== null &&
      BigInt("0x" + match[1]) === device.major &&
      BigInt("0x" + match[2]) === device.minor &&
      BigInt(match[3]) === identity.ino;
  });
}

function mappedThroughMemfd(identity) {
  const device = deviceIdentity(identity.dev);
  return readFileSync("/proc/self/maps", "utf8").split("\n").some((line) => {
    const match = line.match(
      /^[0-9a-f]+-[0-9a-f]+\s+[-rwxps]{4}\s+[0-9a-f]+\s+([0-9a-f]+):([0-9a-f]+)\s+([0-9]+)(?:\s+(.+))?$/,
    );
    return match !== null &&
      BigInt("0x" + match[1]) === device.major &&
      BigInt("0x" + match[2]) === device.minor &&
      BigInt(match[3]) === identity.ino &&
      (match[4] ?? "").includes("memfd:");
  });
}

function restore() {
  if (!cleanupNeeded) return;
  cleanupNeeded = false;
  rmSync(release, { recursive: true, force: true });
  renameSync(backupRelease, release);
}

function swapCanonicalLeaf() {
  if (mode === "none") return;
  renameSync(release, backupRelease);
  if (mode !== "unlink") {
    mkdirSync(release, { mode: 0o700 });
    if (mode === "rename") {
      copyFileSync(
        join(backupRelease, "atomic_directory_publication.node"),
        packageLeaf,
      );
    } else if (mode === "symlink") {
      symlinkSync(
        "../Test/atomic_directory_publication_test.node",
        packageLeaf,
      );
    } else {
      copyFileSync(testLeaf, packageLeaf);
    }
    replacementIdentity = statSync(packageLeaf, { bigint: true });
  }
  cleanupNeeded = true;
}

process.on("exit", restore);
process.dlopen = function (moduleRecord, filename, flags) {
  dlopenCount += 1;
  const match = filename.match(/^\/proc\/self\/fd\/([0-9]+)$/);
  if (match === null) throw new Error("loader did not use a held procfd");
  originalIdentity = fstatSync(Number(match[1]), { bigint: true });
  if (timing === "before") swapCanonicalLeaf();
  Reflect.apply(originalDlopen, this, [moduleRecord, filename, flags]);
  if (timing === "after") swapCanonicalLeaf();
  const afterSwap = fstatSync(Number(match[1]), { bigint: true });
  identityStable = identityKeys.every(
    (key) => afterSwap[key] === originalIdentity[key],
  );
};

const loaded = await import(pathToFileURL(runtimePath).href);
const native = loaded.loadAtomicDirectoryPublicationNativeHeld();
const originalMapped = mapped(originalIdentity);
const replacementMapped =
  replacementIdentity === undefined ? false : mapped(replacementIdentity);
const testMapped = mapped(statSync(testLeaf, { bigint: true }));
restore();
process.stdout.write(JSON.stringify({
  dlopenCount,
  identityStable,
  originalMapped,
  originalMappedThroughMemfd: mappedThroughMemfd(originalIdentity),
  replacementMapped,
  testMapped,
  testHooks: Object.hasOwn(native, "testHooks"),
  frozen: Object.isFrozen(native),
}));
`;
    const runHeldDlopenChild = (mode, timing) => {
      const child = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          heldDlopenChild,
          "held-dlopen-child",
          join(root, "src/runtime-preflight.mjs"),
          root,
          mode,
          timing,
        ],
        { encoding: "utf8", env: { ...process.env, VITEST: "true" } },
      );
      return child;
    };
    for (const timing of ["before", "after"]) {
      const unchanged = runHeldDlopenChild("none", timing);
      assert.equal(unchanged.status, 0, `${timing} none: ${unchanged.stderr}`);
      assert.deepEqual(JSON.parse(unchanged.stdout), {
        dlopenCount: 1,
        identityStable: true,
        originalMapped: true,
        originalMappedThroughMemfd: false,
        replacementMapped: false,
        testMapped: false,
        testHooks: false,
        frozen: true,
      });
      for (const mode of ["rename", "unlink", "symlink", "regular"]) {
        const child = runHeldDlopenChild(mode, timing);
        assert.equal(
          child.status,
          0,
          `${timing} ${mode}: ${child.stderr}`,
        );
        assert.deepEqual(JSON.parse(child.stdout), {
          dlopenCount: 1,
          identityStable: true,
          originalMapped: true,
          originalMappedThroughMemfd: false,
          replacementMapped: false,
          testMapped: false,
          testHooks: false,
          frozen: true,
        });
      }
    }

    const mutatedCall = `${dlopenCall}
    process.getBuiltinModule("node:fs").chmodSync(
      new URL(
        "../build/Release/atomic_directory_publication.node",
        import.meta.url,
      ),
      0o644,
    );`;
    const mutatedPath = writeVariant("runtime-preflight-mutated.mjs", [
      [dlopenCall, mutatedCall],
    ]);
    const mutated = runPrestart(mutatedPath);
    assert.notEqual(mutated.status, 0);
    assert.match(mutated.stderr, /post-load procfd identity/i);
    chmodSync(
      join(root, "build/Release/atomic_directory_publication.node"),
      0o600,
    );

    const linkedCall = `${dlopenCall}
    process.getBuiltinModule("node:fs").linkSync(
      new URL(
        "../build/Release/atomic_directory_publication.node",
        import.meta.url,
      ),
      new URL("../build/Release/.held-link.node", import.meta.url),
    );`;
    const linkedPath = writeVariant("runtime-preflight-linked.mjs", [
      [dlopenCall, linkedCall],
    ]);
    const linked = runPrestart(linkedPath);
    assert.notEqual(linked.status, 0);
    assert.match(linked.stderr, /post-load procfd identity/i);
    unlinkSync(join(root, "build/Release/.held-link.node"));

    const mtimeCall = `${dlopenCall}
    process.getBuiltinModule("node:fs").utimesSync(
      new URL(
        "../build/Release/atomic_directory_publication.node",
        import.meta.url,
      ),
      new Date(1),
      new Date(1),
    );`;
    const mtimePath = writeVariant("runtime-preflight-mtime.mjs", [
      [dlopenCall, mtimeCall],
    ]);
    const mtimeChanged = runPrestart(mtimePath);
    assert.notEqual(mtimeChanged.status, 0);
    assert.match(mtimeChanged.stderr, /post-load procfd identity/i);

    const ctimeCall = `${dlopenCall}
    process.getBuiltinModule("node:fs").chmodSync(
      new URL(
        "../build/Release/atomic_directory_publication.node",
        import.meta.url,
      ),
      0o600,
    );`;
    const ctimePath = writeVariant("runtime-preflight-ctime.mjs", [
      [dlopenCall, ctimeCall],
    ]);
    const ctimeChanged = runPrestart(ctimePath);
    assert.notEqual(ctimeChanged.status, 0);
    assert.match(ctimeChanged.stderr, /post-load procfd identity/i);

    const malformedProcfdPath = writeVariant(
      "runtime-preflight-procfd.mjs",
      [
        [
          "const procfd = `/proc/self/fd/${fd}`;",
          "const procfd = `/proc/self/fd/${fd + 1000000}`;",
        ],
      ],
    );
    const malformedProcfd = runPrestart(malformedProcfdPath);
    assert.notEqual(malformedProcfd.status, 0);
    assert.match(malformedProcfd.stderr, /held native load failed/i);

    const malformedFdinfoPath = writeVariant(
      "runtime-preflight-fdinfo.mjs",
      [
        [
          "const fdinfo = readFileSync(`/proc/self/fdinfo/${fd}`, \"utf8\");",
          'const fdinfo = "flags: invalid";',
        ],
      ],
    );
    const malformedFdinfo = runPrestart(malformedFdinfoPath);
    assert.notEqual(malformedFdinfo.status, 0);
    assert.match(malformedFdinfo.stderr, /native addon fdinfo/i);

    const malformedMapsPath = writeVariant("runtime-preflight-maps.mjs", [
      [
        'readFileSync("/proc/self/maps", "utf8").split("\\n")',
        '"malformed".split("\\n")',
      ],
    ]);
    const malformedMaps = runPrestart(malformedMapsPath);
    assert.notEqual(malformedMaps.status, 0);
    assert.match(malformedMaps.stderr, /native addon process maps/i);

    const closeTrace = join(root, "close-trace.txt");
    const tracedClosePath = writeVariant(
      "runtime-preflight-close-trace.mjs",
      [
        [
          "function closeVerified(fd, label) {\n  try {",
          `function closeVerified(fd, label) {
  process.getBuiltinModule("node:fs").appendFileSync(
    process.env.NATIVE_CLOSE_TRACE,
    \`\${label}\\n\`,
  );
  try {`,
        ],
      ],
    );
    const tracedClose = runPrestart(tracedClosePath, {
      env: { ...process.env, NATIVE_CLOSE_TRACE: closeTrace },
    });
    assert.equal(tracedClose.status, 0, tracedClose.stderr);
    const closeLabels = readFileSync(closeTrace, "utf8").trim().split("\n");
    assert.deepEqual(closeLabels.slice(-3), [
      "native checksum",
      "native addon",
      "native directory",
    ]);
    assert.ok(closeLabels.includes("native addon procfd probe"));
    assert.ok(closeLabels.includes("native addon post-load procfd probe"));

    writeFileSync(closeTrace, "");
    const failedClosePath = writeVariant(
      "runtime-preflight-failed-close-trace.mjs",
      [
        [
          "function closeVerified(fd, label) {\n  try {",
          `function closeVerified(fd, label) {
  process.getBuiltinModule("node:fs").appendFileSync(
    process.env.NATIVE_CLOSE_TRACE,
    \`\${label}\\n\`,
  );
  try {`,
        ],
        [
          "validateRuntimeAttestation(checksumBytes, addonBytes);",
          'throw nativeArtifactError("injected after held opens");',
        ],
      ],
    );
    const failedClose = runPrestart(failedClosePath, {
      env: { ...process.env, NATIVE_CLOSE_TRACE: closeTrace },
    });
    assert.notEqual(failedClose.status, 0);
    assert.deepEqual(
      readFileSync(closeTrace, "utf8").trim().split("\n").slice(-3),
      ["native checksum", "native addon", "native directory"],
    );

    const ebadfCloseChild = String.raw`
import fs, { fstatSync, statSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const runtimePath = process.argv[2];
const root = process.argv[3];
const release = join(root, "build/Release");
const checksum = join(release, "atomic-directory-publication.node.sha256");
const directoryIdentity = statSync(release, { bigint: true });
const checksumIdentity = statSync(checksum, { bigint: true });
const originalCloseSync = fs.closeSync;
let held;
const closeAttempts = [];

fs.closeSync = function (fd) {
  if (held !== undefined) {
    const label = Object.entries(held).find(([, value]) => value === fd)?.[0];
    if (label !== undefined) closeAttempts.push(label);
  }
  return originalCloseSync(fd);
};
syncBuiltinESMExports();

const originalDlopen = process.dlopen;
process.dlopen = function (moduleRecord, filename, flags) {
  const match = filename.match(/^\/proc\/self\/fd\/([0-9]+)$/);
  if (match === null) throw new Error("loader did not use a held procfd");
  const addon = Number(match[1]);
  let directory;
  let checksumFd;
  for (let fd = 0; fd < 1024; fd += 1) {
    try {
      const identity = fstatSync(fd, { bigint: true });
      if (
        identity.dev === directoryIdentity.dev &&
        identity.ino === directoryIdentity.ino
      ) directory = fd;
      if (
        identity.dev === checksumIdentity.dev &&
        identity.ino === checksumIdentity.ino
      ) checksumFd = fd;
    } catch (error) {
      if (error?.code !== "EBADF") throw error;
    }
  }
  if (directory === undefined || checksumFd === undefined) {
    throw new Error("held descriptor inventory incomplete");
  }
  held = { checksum: checksumFd, addon, directory };
  Reflect.apply(originalDlopen, this, [moduleRecord, filename, flags]);
  originalCloseSync(addon);
};

const loaded = await import(pathToFileURL(runtimePath).href);
let first;
let second;
try { loaded.loadAtomicDirectoryPublicationNativeHeld(); } catch (error) { first = error; }
try { loaded.loadAtomicDirectoryPublicationNativeHeld(); } catch (error) { second = error; }
const allClosed = Object.values(held).every((fd) => {
  try {
    fstatSync(fd);
    return false;
  } catch (error) {
    return error?.code === "EBADF";
  }
});
process.stdout.write(JSON.stringify({
  same: first === second,
  frozen: Object.isFrozen(first),
  category: first?.category,
  message: first?.message,
  reverseCloseAttempts: closeAttempts.slice(-3),
  allClosed,
}));
`;
    const ebadfClose = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        ebadfCloseChild,
        "ebadf-close-child",
        join(root, "src/runtime-preflight.mjs"),
        root,
      ],
      { encoding: "utf8" },
    );
    assert.equal(ebadfClose.status, 0, ebadfClose.stderr);
    assert.deepEqual(JSON.parse(ebadfClose.stdout), {
      same: true,
      frozen: true,
      category: "native_artifact_invalid",
      message: "native artifact invalid: native addon close",
      reverseCloseAttempts: ["checksum", "addon", "directory"],
      allClosed: true,
    });

    const loadCountScript = String.raw`
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const originalDlopen = process.dlopen;
let dlopenCount = 0;
process.dlopen = function (...args) {
  dlopenCount += 1;
  return Reflect.apply(originalDlopen, this, args);
};
const loaded = await import(pathToFileURL(process.argv[2]).href);
const first = loaded.loadAtomicDirectoryPublicationNativeHeld();
const second = loaded.loadAtomicDirectoryPublicationNativeHeld();
const mappings = readFileSync("/proc/self/maps", "utf8")
  .split("\n")
  .filter((line) => line.includes("atomic_directory_publication.node"));
process.stdout.write(JSON.stringify({
  dlopenCount,
  same: first === second,
  frozen: Object.isFrozen(first),
  mappings: mappings.length,
  executable: mappings.some((line) => /\sr-xp\s/.test(line)),
}));
`;
    const loadCount = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        loadCountScript,
        "not-the-runtime-entrypoint",
        join(root, "src/runtime-preflight.mjs"),
      ],
      { encoding: "utf8" },
    );
    assert.equal(loadCount.status, 0, loadCount.stderr);
    const loadCountResult = JSON.parse(loadCount.stdout);
    assert.equal(loadCountResult.dlopenCount, 1);
    assert.equal(loadCountResult.same, true);
    assert.equal(loadCountResult.frozen, true);
    assert.ok(loadCountResult.mappings > 0);
    assert.equal(loadCountResult.executable, true);

    const reentrantStickyScript = String.raw`
import { pathToFileURL } from "node:url";
let loaded;
let inner;
let dlopenCount = 0;
const originalDlopen = process.dlopen;
process.dlopen = function (...args) {
  dlopenCount += 1;
  try {
    loaded.loadAtomicDirectoryPublicationNativeHeld();
  } catch (error) {
    inner = error;
  }
  return Reflect.apply(originalDlopen, this, args);
};
loaded = await import(pathToFileURL(process.argv[2]).href);
let first;
let second;
try { loaded.loadAtomicDirectoryPublicationNativeHeld(); } catch (error) { first = error; }
try { loaded.loadAtomicDirectoryPublicationNativeHeld(); } catch (error) { second = error; }
process.stdout.write(JSON.stringify({
  dlopenCount,
  innerIsFirst: inner === first,
  same: first === second,
  frozen: Object.isFrozen(first),
  category: first?.category,
  message: first?.message,
}));
`;
    const reentrantSticky = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        reentrantStickyScript,
        "not-the-runtime-entrypoint",
        join(root, "src/runtime-preflight.mjs"),
      ],
      { encoding: "utf8" },
    );
    assert.equal(reentrantSticky.status, 0, reentrantSticky.stderr);
    assert.deepEqual(JSON.parse(reentrantSticky.stdout), {
      dlopenCount: 1,
      innerIsFirst: true,
      same: true,
      frozen: true,
      category: "native_artifact_invalid",
      message: "native artifact invalid: reentrant held native load",
    });

    const unsupportedArchPath = writeVariant(
      "runtime-preflight-unsupported-arch.mjs",
      [
        [
          '!["x64", "arm64"].includes(process.arch)',
          '!["x64", "arm64"].includes("riscv64")',
        ],
      ],
    );
    const unsupportedArch = runPrestart(unsupportedArchPath);
    assert.notEqual(unsupportedArch.status, 0);
    assert.match(unsupportedArch.stderr, /unsupported held native runtime/i);

    const productionCopy = readFileSync(artifact);
    const testArtifactCopy = readFileSync(
      new URL(
        "../build/Test/atomic_directory_publication_test.node",
        import.meta.url,
      ),
    );
    writeFileSync(
      join(root, "build/Release/atomic_directory_publication.node"),
      testArtifactCopy,
      { mode: 0o600 },
    );
    writeFileSync(
      join(root, "build/Release/atomic-directory-publication.node.sha256"),
      `${JSON.stringify({
        interfaceVersion: "1.0.0",
        napiVersion: 8,
        sha256: createHash("sha256").update(testArtifactCopy).digest("hex"),
      })}\n`,
      { mode: 0o600 },
    );
    const wrongModuleShape = runPrestart(
      join(root, "src/runtime-preflight.mjs"),
      { env: { ...process.env, VITEST: "true" } },
    );
    assert.notEqual(wrongModuleShape.status, 0);
    assert.match(wrongModuleShape.stderr, /module ABI/i);
    writeFileSync(
      join(root, "build/Release/atomic_directory_publication.node"),
      productionCopy,
      { mode: 0o600 },
    );
    cpSync(
      checksum,
      join(root, "build/Release/atomic-directory-publication.node.sha256"),
    );

    const corrupted = readFileSync(artifact);
    corrupted[0] ^= 0xff;
    writeFileSync(
      join(root, "build/Release/atomic_directory_publication.node"),
      corrupted,
    );
    const invalid = spawnSync(
      process.execPath,
      [join(root, "src/runtime-preflight.mjs"), "--phase=prestart"],
      { encoding: "utf8" },
    );
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /native addon ELF|attestation digest mismatch/i);

    writeFileSync(
      join(root, "build/Release/atomic-directory-publication.node.sha256"),
      `${JSON.stringify({
        interfaceVersion: "1.0.0",
        napiVersion: 8,
        sha256: createHash("sha256").update(corrupted).digest("hex"),
      })}\n`,
    );
    const invalidElf = spawnSync(
      process.execPath,
      [join(root, "src/runtime-preflight.mjs"), "--phase=prestart"],
      { encoding: "utf8" },
    );
    assert.notEqual(invalidElf.status, 0);

    cpSync(
      artifact,
      join(root, "build/Release/atomic_directory_publication.node"),
    );
    writeFileSync(
      join(root, "build/Release/atomic-directory-publication.node.sha256"),
      "{}\n",
    );
    const malformed = spawnSync(
      process.execPath,
      [join(root, "src/runtime-preflight.mjs"), "--phase=prestart"],
      { encoding: "utf8" },
    );
    assert.notEqual(malformed.status, 0);
    assert.match(malformed.stderr, /attestation shape/i);

    const repeatFailureScript = String.raw`
import { pathToFileURL } from "node:url";
const loaded = await import(pathToFileURL(process.argv[2]).href);
let first;
let second;
try { loaded.loadAtomicDirectoryPublicationNativeHeld(); } catch (error) { first = error; }
try { loaded.loadAtomicDirectoryPublicationNativeHeld(); } catch (error) { second = error; }
process.stdout.write(JSON.stringify({
  same: first === second,
  frozen: Object.isFrozen(first),
  category: first?.category,
  sameMessage: first?.message === second?.message,
}));
`;
    const repeatedFailure = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        repeatFailureScript,
        "not-the-runtime-entrypoint",
        join(root, "src/runtime-preflight.mjs"),
      ],
      { encoding: "utf8" },
    );
    assert.equal(repeatedFailure.status, 0, repeatedFailure.stderr);
    assert.deepEqual(JSON.parse(repeatedFailure.stdout), {
      same: true,
      frozen: true,
      category: "native_artifact_invalid",
      sameMessage: true,
    });

    unlinkSync(
      join(root, "build/Release/atomic-directory-publication.node.sha256"),
    );
    symlinkSync(
      checksum,
      join(root, "build/Release/atomic-directory-publication.node.sha256"),
    );
    const symlinked = spawnSync(
      process.execPath,
      [join(root, "src/runtime-preflight.mjs"), "--phase=prestart"],
      { encoding: "utf8" },
    );
    assert.notEqual(symlinked.status, 0);
    assert.match(symlinked.stderr, /held native load failed/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
