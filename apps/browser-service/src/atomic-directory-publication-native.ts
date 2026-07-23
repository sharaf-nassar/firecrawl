// Runtime loader is intentionally implemented once in the executable
// preflight module so service startup and isolated preflight share one
// inode-pinned process.dlopen boundary.
// @ts-expect-error The checked-in ESM preflight module has no declaration file.
import * as runtimePreflight from "./runtime-preflight.mjs";

export type AtomicDirectoryPublicationNativeV1 = Readonly<{
  interfaceVersion: "1.0.0";
  napiVersion: 8;
  renameNoReplace(
    sourceDirectoryFd: number,
    sourceLeaf: string,
    targetDirectoryFd: number,
    targetLeaf: string,
  ): void;
}>;

export function validateAtomicNativeModuleShape(
  value: unknown,
): AtomicDirectoryPublicationNativeV1 {
  return runtimePreflight.validateAtomicNativeModuleShape(
    value,
  ) as AtomicDirectoryPublicationNativeV1;
}

export function loadAtomicDirectoryPublicationNative(): AtomicDirectoryPublicationNativeV1 {
  return runtimePreflight.loadAtomicDirectoryPublicationNativeHeld() as AtomicDirectoryPublicationNativeV1;
}
