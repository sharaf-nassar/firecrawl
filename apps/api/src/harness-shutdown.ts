export function createSharedShutdown(
  runShutdown: () => Promise<void>,
): () => Promise<void> {
  let shutdownPromise: Promise<void> | undefined;

  return () => {
    shutdownPromise ??= Promise.resolve().then(runShutdown);
    return shutdownPromise;
  };
}
