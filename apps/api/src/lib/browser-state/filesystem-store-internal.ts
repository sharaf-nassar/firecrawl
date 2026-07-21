import { AsyncLocalStorage } from "node:async_hooks";

interface BrowserStateCheckpointPlan {
  generationId: string;
  pathId: string;
  byteSize: number;
  checksum: string;
  writerLease: string;
  writerPid: number;
  writerBootId: string;
  writerStartTime: string;
}

interface BrowserStateFilesystemContext {
  beforeCheckpointWrite?: (
    checkpoint: BrowserStateCheckpointPlan,
  ) => Promise<void>;
  syncDirectory?: (directory: string) => Promise<void>;
}

const filesystemContext =
  new AsyncLocalStorage<BrowserStateFilesystemContext>();

export async function runWithBrowserStateFilesystemContext<T>(
  context: BrowserStateFilesystemContext,
  callback: () => Promise<T>,
): Promise<T> {
  return filesystemContext.run(Object.freeze({ ...context }), callback);
}

export async function prepareBrowserStateCheckpoint(
  checkpoint: BrowserStateCheckpointPlan,
): Promise<void> {
  await filesystemContext.getStore()?.beforeCheckpointWrite?.(checkpoint);
}

export async function syncBrowserStateDirectory(
  directory: string,
  fallback: (directory: string) => Promise<void>,
): Promise<void> {
  await (filesystemContext.getStore()?.syncDirectory ?? fallback)(directory);
}
