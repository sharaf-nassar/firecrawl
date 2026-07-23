import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  loadAtomicDirectoryPublicationNative,
  validateAtomicNativeModuleShape,
} from "./atomic-directory-publication-native";

const roots: string[] = [];
const testArtifact = new URL(
  "../build/Test/atomic_directory_publication_test.node",
  import.meta.url,
);
const productionArtifact = new URL(
  "../build/Release/atomic_directory_publication.node",
  import.meta.url,
);

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

type BarrierFixture = {
  child: ChildProcess;
  close: () => void;
  closeReleaseWriter: () => void;
  completion: Promise<{
    code: number | null;
    error?: Error;
    signal: NodeJS.Signals | null;
  }>;
  output: () => string;
  readyReader: number;
  releaseWriter: number;
  root: string;
  sourceFd: number;
  sourceLeaf: string;
  targetFd: number;
  targetLeaf: string;
};

const barrierChild = String.raw`
const { closeSync, constants, fstatSync, openSync, unlinkSync, writeSync } = require("node:fs");
const { constants: osConstants } = require("node:os");
const before = fstatSync(3, { bigint: true });
const moduleRecord = { exports: Object.create(null) };
process.dlopen(moduleRecord, "/proc/self/fd/3", osConstants.dlopen.RTLD_NOW);
const after = fstatSync(3, { bigint: true });
for (const key of ["dev", "ino", "size", "mode", "uid", "nlink", "mtimeNs", "ctimeNs"]) {
  if (before[key] !== after[key]) throw new Error("held test addon identity drifted");
}
if (process.argv[5] !== "") {
  closeSync(3);
  const replacement = openSync(
    process.argv[5],
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  if (replacement !== 3) throw new Error("replacement did not occupy fd3");
  unlinkSync(process.argv[5]);
}
try {
  moduleRecord.exports.renameNoReplace(
    Number(process.argv[3]),
    process.argv[1],
    Number(process.argv[4]),
    process.argv[2],
  );
  writeSync(1, "success\n");
} catch (error) {
  writeSync(1, String(error?.code ?? "unknown") + "\n");
}
closeSync(3);
`;

function closeIfOpen(open: Set<number>, descriptor: number): void {
  if (!open.delete(descriptor)) return;
  closeSync(descriptor);
}

function spawnBarrierFixture(
  phase: "before" | "after",
  options: {
    aliasFifos?: boolean;
    control?: string;
    nonblockingReadyWriter?: boolean;
    nonblockingReleaseReader?: boolean;
    replaceHeldAddon?: boolean;
    sourceOperand?: number;
    targetOperand?: number;
  } = {},
): BarrierFixture {
  const root = mkdtempSync(join(tmpdir(), "atomic-native-barrier-"));
  roots.push(root);
  const sourceLeaf = "source";
  const targetLeaf = "target";
  mkdirSync(join(root, sourceLeaf), { mode: 0o700 });

  const addonPath = join(root, "held-test-addon.node");
  copyFileSync(testArtifact, addonPath, constants.COPYFILE_EXCL);
  chmodSync(addonPath, 0o600);
  const addon = openSync(
    addonPath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  unlinkSync(addonPath);

  const sourceFd = openSync(
    root,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  const targetFd = openSync(
    root,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );

  const controlPath = join(root, "control");
  writeFileSync(
    controlPath,
    options.control ??
      `atomic-publish-syscall-barrier-v1:${phase}\n`,
    { flag: "wx", mode: 0o600 },
  );
  const control = openSync(
    controlPath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  unlinkSync(controlPath);
  let replacementPath = "";
  if (options.replaceHeldAddon) {
    replacementPath = join(root, "replacement-addon.node");
    copyFileSync(productionArtifact, replacementPath, constants.COPYFILE_EXCL);
    chmodSync(replacementPath, 0o600);
  }

  const readyPath = join(root, "ready");
  const releasePath = join(root, "release");
  const mkfifo = spawnSync(
    "/usr/bin/mkfifo",
    ["--mode=0600", "--", readyPath, releasePath],
    { encoding: "utf8" },
  );
  expect(mkfifo.status, mkfifo.stderr).toBe(0);

  const open = new Set<number>();
  const remember = (descriptor: number): number => {
    open.add(descriptor);
    return descriptor;
  };
  const readyAnchor = remember(
    openSync(
      readyPath,
      constants.O_RDWR |
        constants.O_NONBLOCK |
        constants.O_NOFOLLOW,
    ),
  );
  const releaseAnchor = remember(
    openSync(
      releasePath,
      constants.O_RDWR |
        constants.O_NONBLOCK |
        constants.O_NOFOLLOW,
    ),
  );
  const readyReader = remember(
    openSync(
      readyPath,
      constants.O_RDONLY |
        constants.O_NONBLOCK |
        constants.O_NOFOLLOW,
    ),
  );
  const readyWriter = remember(
    openSync(
      readyPath,
      constants.O_WRONLY |
        constants.O_NOFOLLOW |
        (options.nonblockingReadyWriter ? constants.O_NONBLOCK : 0),
    ),
  );
  const aliasReader = options.aliasFifos
    ? remember(
        openSync(readyPath, constants.O_RDONLY | constants.O_NOFOLLOW),
      )
    : undefined;
  const releaseWriter = remember(
    openSync(
      releasePath,
      constants.O_WRONLY |
        constants.O_NONBLOCK |
        constants.O_NOFOLLOW,
    ),
  );
  const releaseReader = remember(
    openSync(
      releasePath,
      constants.O_RDONLY |
        constants.O_NOFOLLOW |
        (options.nonblockingReleaseReader ? constants.O_NONBLOCK : 0),
    ),
  );
  unlinkSync(readyPath);
  unlinkSync(releasePath);
  closeIfOpen(open, readyAnchor);
  closeIfOpen(open, releaseAnchor);

  let output = "";
  const child = spawn(
    process.execPath,
    [
      "-e",
      barrierChild,
      sourceLeaf,
      targetLeaf,
      String(options.sourceOperand ?? 4),
      String(options.targetOperand ?? 5),
      replacementPath,
    ],
    {
      stdio: [
        "ignore",
        "pipe",
        "pipe",
        addon,
        sourceFd,
        targetFd,
        control,
        readyWriter,
        aliasReader ?? releaseReader,
      ],
    },
  );
  let spawnError: Error | undefined;
  child.once("error", error => {
    spawnError = error;
  });
  const completion = new Promise<{
    code: number | null;
    error?: Error;
    signal: NodeJS.Signals | null;
  }>(resolve => {
    child.once("close", (code, signal) => {
      resolve({ code, error: spawnError, signal });
    });
  });
  child.stdout?.setEncoding("utf8").on("data", chunk => {
    output += chunk;
  });
  child.stderr?.setEncoding("utf8").on("data", chunk => {
    output += `stderr:${chunk}`;
  });
  closeSync(addon);
  closeSync(control);
  closeIfOpen(open, readyWriter);
  closeIfOpen(open, releaseReader);
  if (aliasReader !== undefined) closeIfOpen(open, aliasReader);
  let parentsClosed = false;

  return {
    child,
    close: () => {
      for (const descriptor of [...open]) {
        closeIfOpen(open, descriptor);
      }
      if (!parentsClosed) {
        parentsClosed = true;
        closeSync(sourceFd);
        closeSync(targetFd);
      }
    },
    closeReleaseWriter: () => closeIfOpen(open, releaseWriter),
    completion,
    output: () => output,
    readyReader,
    releaseWriter,
    root,
    sourceFd,
    sourceLeaf,
    targetFd,
    targetLeaf,
  };
}

async function waitForBarrierReady(
  child: ChildProcess,
  descriptor: number,
): Promise<void> {
  const deadline = performance.now() + 3_000;
  const byte = Buffer.alloc(2);
  for (;;) {
    try {
      const count = readSync(descriptor, byte, 0, byte.length, null);
      if (count !== 1 || byte[0] !== 0x01) {
        throw new Error("invalid native syscall barrier ready record");
      }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EAGAIN") throw error;
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("barrier child exited before native rendezvous");
    }
    if (performance.now() >= deadline) {
      throw new Error("native syscall barrier ready deadline exceeded");
    }
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

async function waitForChild(
  fixture: BarrierFixture,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  let timer: NodeJS.Timeout;
  const outcome = await Promise.race([
    fixture.completion.then(result => ({ result, timedOut: false as const })),
    new Promise<{ timedOut: true }>(resolve => {
      timer = setTimeout(() => resolve({ timedOut: true }), 3_000);
    }),
  ]);
  if (outcome.timedOut) {
    fixture.child.kill("SIGKILL");
    await fixture.completion;
    throw new Error("native syscall barrier child deadline exceeded");
  }
  clearTimeout(timer!);
  if (outcome.result.error !== undefined) {
    throw outcome.result.error;
  }
  return {
    code: outcome.result.code,
    signal: outcome.result.signal,
  };
}

describe("atomic directory publication native loader", () => {
  it("rejects malformed native module shapes", () => {
    const hiddenExtra = {
      interfaceVersion: "1.0.0",
      napiVersion: 8,
      renameNoReplace() {},
    };
    Object.defineProperty(hiddenExtra, "hidden", { value: true });
    const symbolExtra = {
      interfaceVersion: "1.0.0",
      napiVersion: 8,
      renameNoReplace() {},
      [Symbol("extra")]: true,
    };
    const accessor = {
      get interfaceVersion() {
        return "1.0.0";
      },
      napiVersion: 8,
      renameNoReplace() {},
    };
    for (const fixture of [
      null,
      [],
      {},
      { interfaceVersion: "1.0.0", napiVersion: 8 },
      {
        interfaceVersion: "1.0.0",
        napiVersion: 9,
        renameNoReplace() {},
      },
      {
        interfaceVersion: "2.0.0",
        napiVersion: 8,
        renameNoReplace() {},
      },
      {
        interfaceVersion: "1.0.0",
        napiVersion: 8,
        renameNoReplace() {},
        extra: true,
      },
      hiddenExtra,
      symbolExtra,
      accessor,
    ]) {
      expect(() => validateAtomicNativeModuleShape(fixture)).toThrow(
        /native artifact/i,
      );
    }
  });

  it("returns a frozen wrapper bound to the validated module", () => {
    let moduleRecord: {
      interfaceVersion: string;
      napiVersion: number;
      renameNoReplace(): boolean;
    };
    moduleRecord = {
      interfaceVersion: "1.0.0",
      napiVersion: 8,
      renameNoReplace() {
        return this === moduleRecord;
      },
    };
    const validated = validateAtomicNativeModuleShape(moduleRecord);
    expect(Object.isFrozen(validated)).toBe(true);
    expect(
      (
        validated.renameNoReplace as unknown as () => boolean
      )(),
    ).toBe(true);
  });

  it("loads the package-relative production artifact with exact ABI", () => {
    const native = loadAtomicDirectoryPublicationNative();
    expect(Object.keys(native).sort()).toEqual([
      "interfaceVersion",
      "napiVersion",
      "renameNoReplace",
    ]);
    expect(native.interfaceVersion).toBe("1.0.0");
    expect(native.napiVersion).toBe(8);
    expect(typeof native.renameNoReplace).toBe("function");
    expect(loadAtomicDirectoryPublicationNative()).toBe(native);
    const require = createRequire(import.meta.url);
    const artifact = new URL(
      "../build/Release/atomic_directory_publication.node",
      import.meta.url,
    );
    expect(require.cache[artifact.pathname]).toBeUndefined();
  });

  it("keeps test hooks out of production and exact in test artifact", () => {
    const production = productionArtifact;
    const inspect = String.raw`
const { closeSync, fstatSync } = require("node:fs");
const { constants: osConstants } = require("node:os");
const keys = ["dev", "ino", "size", "mode", "uid", "gid", "nlink", "mtimeNs", "ctimeNs"];
const before = fstatSync(3, { bigint: true });
const moduleRecord = { exports: Object.create(null) };
process.dlopen(moduleRecord, "/proc/self/fd/3", osConstants.dlopen.RTLD_NOW);
const native = moduleRecord.exports;
const after = fstatSync(3, { bigint: true });
if (!keys.every((key) => after[key] === before[key])) {
  throw new Error("held test addon identity drifted");
}
closeSync(3);
try {
  fstatSync(3);
  throw new Error("held test addon remained open");
} catch (error) {
  if (error?.code !== "EBADF") throw error;
}
process.stdout.write(JSON.stringify({
  top: Object.keys(native).sort(),
  frozen: Object.isFrozen(native.testHooks),
  hooks: Object.keys(native.testHooks).sort(),
}));
`;
    const addon = openSync(
      testArtifact,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const addonIdentity = fstatSync(addon, { bigint: true });
    const result = spawnSync(process.execPath, ["-e", inspect], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe", addon],
    });
    expect(
      [
        "dev",
        "ino",
        "size",
        "mode",
        "uid",
        "gid",
        "nlink",
        "mtimeNs",
        "ctimeNs",
      ].every(
        (key) =>
          fstatSync(addon, { bigint: true })[
            key as keyof ReturnType<typeof fstatSync>
          ] ===
          addonIdentity[key as keyof typeof addonIdentity],
      ),
    ).toBe(true);
    closeSync(addon);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      top: ["interfaceVersion", "napiVersion", "renameNoReplace", "testHooks"],
      frozen: true,
      hooks: [
        "becomeChildSubreaperForTest",
        "claimAdoptedChildForTest",
        "prepareInheritedLockFdForTest",
        "reapClaimedChildForTest",
      ],
    });
    const symbols = spawnSync("/usr/bin/nm", ["-D", production.pathname], {
      encoding: "utf8",
    });
    expect(symbols.status, symbols.stderr).toBe(0);
    expect(symbols.stdout).not.toMatch(
      /becomeChildSubreaperForTest|prepareInheritedLockFdForTest|claimAdoptedChildForTest|reapClaimedChildForTest|atomic_publish_export_test_hooks|atomic_publish_test_hook_before|atomic_publish_test_hook_after|atomic_publish_test_hook_capture_addon_identity|atomic-publish-syscall-barrier/,
    );
  });

  it.each(["before", "after"] as const)(
    "holds the real %s-renameat2 syscall boundary until parent SIGKILL",
    async phase => {
      const fixture = spawnBarrierFixture(phase);
      try {
        await waitForBarrierReady(fixture.child, fixture.readyReader);
        expect(fixture.child.kill("SIGKILL")).toBe(true);
        expect(await waitForChild(fixture)).toEqual({
          code: null,
          signal: "SIGKILL",
        });
        expect(
          existsSync(join(fixture.root, fixture.sourceLeaf)),
        ).toBe(phase === "before");
        expect(
          existsSync(join(fixture.root, fixture.targetLeaf)),
        ).toBe(phase === "after");
      } finally {
        fixture.close();
      }
    },
  );

  it("releases the real syscall barrier only on exact byte 0x01", async () => {
    const fixture = spawnBarrierFixture("before");
    try {
      await waitForBarrierReady(fixture.child, fixture.readyReader);
      expect(
        writeSync(fixture.releaseWriter, Buffer.from([0x01]), 0, 1),
      ).toBe(1);
      expect(await waitForChild(fixture)).toEqual({
        code: 0,
        signal: null,
      });
      expect(fixture.output()).toBe("success\n");
      expect(existsSync(join(fixture.root, fixture.sourceLeaf))).toBe(false);
      expect(existsSync(join(fixture.root, fixture.targetLeaf))).toBe(true);
    } finally {
      fixture.close();
    }
  });

  it.each([
    {
      name: "wrong release byte",
      release: (fixture: BarrierFixture) => {
        writeSync(fixture.releaseWriter, Buffer.from([0x02]), 0, 1);
      },
    },
    {
      name: "release EOF",
      release: (fixture: BarrierFixture) => {
        fixture.closeReleaseWriter();
      },
    },
  ])("fails closed before rename on $name", async ({ release }) => {
    const fixture = spawnBarrierFixture("before");
    try {
      await waitForBarrierReady(fixture.child, fixture.readyReader);
      release(fixture);
      expect(await waitForChild(fixture)).toEqual({
        code: 0,
        signal: null,
      });
      expect(fixture.output()).toBe("atomic_publish_test_hook_invalid\n");
      expect(existsSync(join(fixture.root, fixture.sourceLeaf))).toBe(true);
      expect(existsSync(join(fixture.root, fixture.targetLeaf))).toBe(false);
    } finally {
      fixture.close();
    }
  });

  it.each([
    {
      name: "noncanonical control bytes",
      options: { control: "atomic-publish-syscall-barrier-v1:before" },
      phase: undefined,
    },
    {
      name: "aliased FIFO descriptors",
      options: { aliasFifos: true },
      phase: undefined,
    },
    {
      name: "nonblocking ready FIFO",
      options: { nonblockingReadyWriter: true },
      phase: undefined,
    },
    {
      name: "nonblocking release FIFO before rename",
      options: { nonblockingReleaseReader: true },
      phase: undefined,
    },
    {
      name: "nonblocking release FIFO before after-phase rename",
      options: { nonblockingReleaseReader: true },
      phase: "after" as const,
    },
    {
      name: "nonfixed native operands",
      options: { sourceOperand: 5, targetOperand: 4 },
      phase: undefined,
    },
    {
      name: "fd3 replacement after held-addon loading",
      options: { replaceHeldAddon: true },
      phase: undefined,
    },
  ])("rejects $name before rename", async ({ options, phase }) => {
    const fixture = spawnBarrierFixture(phase ?? "before", options);
    try {
      expect(await waitForChild(fixture)).toEqual({
        code: 0,
        signal: null,
      });
      expect(fixture.output()).toBe("atomic_publish_test_hook_invalid\n");
      expect(existsSync(join(fixture.root, fixture.sourceLeaf))).toBe(true);
      expect(existsSync(join(fixture.root, fixture.targetLeaf))).toBe(false);
    } finally {
      fixture.close();
    }
  });

  it("keeps production rename independent of test barrier descriptors", () => {
    const root = mkdtempSync(join(tmpdir(), "atomic-native-production-"));
    roots.push(root);
    mkdirSync(join(root, "source"), { mode: 0o700 });
    const sourceFd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY);
    const targetFd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY);
    const addon = openSync(
      productionArtifact,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const result = spawnSync(
        process.execPath,
        [
          "-e",
          String.raw`
const { constants: osConstants } = require("node:os");
const moduleRecord = { exports: Object.create(null) };
process.dlopen(moduleRecord, "/proc/self/fd/3", osConstants.dlopen.RTLD_NOW);
moduleRecord.exports.renameNoReplace(4, "source", 5, "target");
`,
        ],
        {
          encoding: "utf8",
          stdio: [
            "ignore",
            "pipe",
            "pipe",
            addon,
            sourceFd,
            targetFd,
            "ignore",
            "ignore",
            "ignore",
          ],
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(join(root, "source"))).toBe(false);
      expect(existsSync(join(root, "target"))).toBe(true);
    } finally {
      closeSync(addon);
      closeSync(sourceFd);
      closeSync(targetFd);
    }
  });

  it("publishes without replacement and returns stable errors", () => {
    const root = mkdtempSync(join(tmpdir(), "atomic-native-"));
    roots.push(root);
    const source = join(root, "source");
    const target = join(root, "target");
    const sourceFd = openSync(root, "r");
    const targetFd = openSync(root, "r");
    try {
      mkdirSync(source);
      const native = loadAtomicDirectoryPublicationNative();
      expect(
        native.renameNoReplace(sourceFd, "source", targetFd, "target"),
      ).toBeUndefined();
      mkdirSync(source);
      expect(() =>
        native.renameNoReplace(sourceFd, "source", targetFd, "target"),
      ).toThrow(/target_exists/);
      expect(() => native.renameNoReplace(-1, "x", targetFd, "y")).toThrow(
        /invalid_argument/,
      );
      for (const leaf of [
        "../x",
        ".",
        "..",
        "x/y",
        "x\\y",
        "Upper",
        "-leading",
        "trailing-",
        "x".repeat(129),
      ]) {
        expect(
          () => native.renameNoReplace(sourceFd, leaf, targetFd, "y"),
          leaf,
        ).toThrow(/invalid_argument/);
      }
      expect(() =>
        (native.renameNoReplace as (...args: unknown[]) => void)(
          sourceFd,
          "x",
          targetFd,
          "y",
          "extra",
        ),
      ).toThrow(/invalid_argument/);
    } finally {
      closeSync(sourceFd);
      closeSync(targetFd);
    }
  });
});
