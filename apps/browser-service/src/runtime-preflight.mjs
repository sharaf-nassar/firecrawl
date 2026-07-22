import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function assertBrowserServiceRuntime(version = process.version) {
  if (version !== "v22.22.1") {
    const error = new Error(
      `browser_service_runtime_mismatch: expected v22.22.1, received ${version}`,
    );
    error.category = "browser_service_runtime_mismatch";
    throw error;
  }
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  assertBrowserServiceRuntime();
}
