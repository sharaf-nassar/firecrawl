export type TrackedCleanupFailure<T> = {
  resource: string;
  id: T;
  error: unknown;
};

export async function cleanupTrackedResources<T>(
  tracked: Set<T>,
  resource: string,
  release: (id: T) => Promise<void>,
): Promise<Array<TrackedCleanupFailure<T>>> {
  const failures: Array<TrackedCleanupFailure<T>> = [];

  await Promise.all(
    [...tracked].map(async id => {
      try {
        await release(id);
        tracked.delete(id);
      } catch (error) {
        failures.push({ resource, id, error });
      }
    }),
  );

  return failures;
}

export function throwTrackedCleanupFailures(
  failures: Array<TrackedCleanupFailure<unknown>>,
): void {
  if (failures.length === 0) return;
  throw new AggregateError(
    failures.map(failure => failure.error),
    failures
      .map(failure => `${failure.resource}:${String(failure.id)}`)
      .join(", "),
  );
}
