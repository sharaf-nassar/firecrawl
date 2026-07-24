import { defaultExclude, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [
      ...defaultExclude,
      "scripts/build-native.test.mjs",
      "scripts/check-atomic-publication-rollback.test.mjs",
      "scripts/init-state-volume.test.mjs",
      "src/lockfile.test.mjs",
      "src/runtime-preflight.test.mjs",
    ],
  },
});
