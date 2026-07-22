import assert from "node:assert/strict";
import test from "node:test";
import { assertBrowserServiceRuntime } from "./runtime-preflight.mjs";

test("accepts only Node 22.22.1", () => {
  assert.doesNotThrow(() => assertBrowserServiceRuntime("v22.22.1"));
  for (const version of ["v22.22.0", "v23.0.0", "v25.8.2"]) {
    assert.throws(() => assertBrowserServiceRuntime(version), {
      category: "browser_service_runtime_mismatch",
    });
  }
});
