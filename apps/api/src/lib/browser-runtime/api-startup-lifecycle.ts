/** @public */
export type ApiStartupLifecycleStage =
  | "browser_control"
  | "migrations"
  | "browser_reconciliation"
  | "operational_retention"
  | "browser_retention"
  | "server_listen"
  | "startup_cleanup";

/** @public */
export type ApiStartupLifecycleEvent = Readonly<{
  version: 1;
  event: "api_startup_lifecycle";
  owner: "api";
  sequence: number;
  stage: ApiStartupLifecycleStage;
  status: "started" | "completed" | "failed";
}>;

/** @public */
export type ApiStartupLifecycleDependencies<Handoff, Application> = {
  persistenceEnabled: boolean;
  browserEnabled: boolean;
  acquireBrowserControl: () => Promise<Handoff>;
  runMigrations: (handoff: Handoff | undefined) => Promise<void>;
  initializeBrowser: (handoff: Handoff) => Promise<void>;
  startOperationalRetention: () => Promise<void>;
  startApplication: () => Promise<Application>;
  cleanupStartupResources: () => Promise<void>;
  observe?: (event: ApiStartupLifecycleEvent) => void;
};

/** @public */
export async function runApiStartupLifecycle<Handoff, Application>(
  deps: ApiStartupLifecycleDependencies<Handoff, Application>,
): Promise<Application> {
  let sequence = 0;
  let activeStage: ApiStartupLifecycleStage = "browser_control";
  const emit = (
    stage: ApiStartupLifecycleStage,
    status: ApiStartupLifecycleEvent["status"],
  ) => {
    sequence += 1;
    try {
      deps.observe?.({
        version: 1,
        event: "api_startup_lifecycle",
        owner: "api",
        sequence,
        stage,
        status,
      });
    } catch {
      // Observability cannot change startup ownership or ordering.
    }
  };

  try {
    const handoff = deps.browserEnabled
      ? await (async () => {
          activeStage = "browser_control";
          const acquired = await deps.acquireBrowserControl();
          emit("browser_control", "completed");
          return acquired;
        })()
      : undefined;

    if (deps.persistenceEnabled) {
      activeStage = "migrations";
      await deps.runMigrations(handoff);
      emit("migrations", "completed");
    }

    if (deps.persistenceEnabled) {
      activeStage = "operational_retention";
      await deps.startOperationalRetention();
      emit("operational_retention", "completed");
    }

    if (handoff !== undefined) {
      activeStage = "browser_reconciliation";
      emit("browser_reconciliation", "started");
      await deps.initializeBrowser(handoff);
      emit("browser_reconciliation", "completed");
      emit("browser_retention", "started");
    }

    activeStage = "server_listen";
    const application = await deps.startApplication();
    emit("server_listen", "completed");
    return application;
  } catch (error) {
    emit(activeStage, "failed");
    try {
      await deps.cleanupStartupResources();
      emit("startup_cleanup", "completed");
    } catch (cleanupError) {
      emit("startup_cleanup", "failed");
      throw new AggregateError(
        [error, cleanupError],
        "API startup and cleanup failed",
      );
    }
    throw error;
  }
}
