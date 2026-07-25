/** @public */
export type ApiStartupLifecycleDependencies<Handoff> = {
  persistenceEnabled: boolean;
  browserEnabled: boolean;
  acquireBrowserControl: () => Promise<Handoff>;
  runMigrations: (handoff: Handoff | undefined) => Promise<void>;
  startOperationalRetention: () => Promise<void>;
  initializeBrowser: (handoff: Handoff) => Promise<void>;
  startApplication: () => Promise<void>;
};

/** @public */
export async function runApiStartupLifecycle<Handoff>(
  deps: ApiStartupLifecycleDependencies<Handoff>,
): Promise<void> {
  const handoff = deps.browserEnabled
    ? await deps.acquireBrowserControl()
    : undefined;
  if (deps.persistenceEnabled) {
    await deps.runMigrations(handoff);
    await deps.startOperationalRetention();
  }
  if (handoff !== undefined) {
    await deps.initializeBrowser(handoff);
  }
  await deps.startApplication();
}
