import type { Application } from "express";

import {
  createBrowserRunsInternalRouter,
  type InternalBrowserRunsDependencies,
} from "../controllers/internal/browser-runs";

/** @public Mounts private adapter callbacks before public body parsers. */
export function registerInternalRoutes(
  app: Application,
  deps: InternalBrowserRunsDependencies,
): void {
  app.use(createBrowserRunsInternalRouter(deps));
}
