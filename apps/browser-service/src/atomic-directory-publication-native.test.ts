import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  loadAtomicDirectoryPublicationNative,
  validateAtomicNativeModuleShape,
} from "./atomic-directory-publication-native";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

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
    const production = new URL(
      "../build/Release/atomic_directory_publication.node",
      import.meta.url,
    );
    const testArtifact = new URL(
      "../build/Test/atomic_directory_publication_test.node",
      import.meta.url,
    );
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
      /becomeChildSubreaperForTest|prepareInheritedLockFdForTest|claimAdoptedChildForTest|reapClaimedChildForTest|atomic_publish_export_test_hooks/,
    );
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
