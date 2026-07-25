import { spawnSync } from "node:child_process";
import {
  chmodSync,
  chownSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { constants as osConstants, tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const packageRoot = resolve(import.meta.dirname, "..");
const dockerfilePath = resolve(packageRoot, "Dockerfile");
const allowlistPath = resolve(packageRoot, "native/toolchain-allowlist.json");
const runtimeNodeHeaderPaths = [
  "/usr/include/node",
  "/usr/local/include/node",
] as const;
const dependencyPayloadDirectories = new Set([
  "test",
  "tests",
  "__tests__",
  "fixture",
  "fixtures",
]);
const dependencyPayloadFile =
  /^(?:(?:test|spec|fixtures?)[._-].+|.+[._-](?:test|spec|fixtures?)(?:\..*)?)$/u;

async function source() {
  return readFile(dockerfilePath, "utf8");
}

function stage(text: string, alias: string) {
  const start = text.indexOf(`AS ${alias}`);
  expect(start).toBeGreaterThanOrEqual(0);
  const next = text.indexOf("\nFROM ", start);
  return text.slice(start, next === -1 ? undefined : next);
}

const imageRoots: string[] = [];
const imageMounts: string[] = [];
const privilegedImageCase =
  process.env.ATOMIC_IMAGE_CASE === "privileged-mount";
const runtimeFilesystemCase =
  process.env.ATOMIC_IMAGE_CASE === "runtime-filesystem";
const operationId = "11111111-1111-4111-8111-111111111111";
const processNonce = Buffer.alloc(32, 4).toString("base64url");
const controlGenerationNonce = Buffer.alloc(32, 5).toString("base64url");

afterEach(() => {
  for (const mountpoint of imageMounts.splice(0).reverse()) {
    spawnSync("/usr/bin/umount", ["--lazy", "--", mountpoint]);
  }
  for (const root of imageRoots.splice(0).reverse()) {
    rmSync(root, { recursive: true, force: true });
  }
});

function imageRoot() {
  const root = mkdtempSync(resolve(tmpdir(), "firecrawl-image-mount-"));
  chmodSync(root, 0o700);
  imageRoots.push(root);
  return root;
}

function command(path: string, args: string[]) {
  const result = spawnSync(path, args, { encoding: "utf8" });
  expect(result.status, `${path}: ${result.stderr}`).toBe(0);
}

function mount(args: string[], mountpoint: string) {
  command("/usr/bin/mount", args);
  imageMounts.push(mountpoint);
}

function provisionAtomicRoot(root: string) {
  mkdirSync(resolve(root, "profiles"), { mode: 0o700 });
  mkdirSync(resolve(root, ".profile-publish-staging"), { mode: 0o700 });
  mkdirSync(resolve(root, ".profile-publish-staging", "intents"), {
    mode: 0o700,
  });
  mkdirSync(resolve(root, ".profile-publish-staging", "bundles"), {
    mode: 0o700,
  });
}

function snapshotAtomicRoot(root: string) {
  const relatives = [
    ".",
    "profiles",
    ".profile-publish-staging",
    ".profile-publish-staging/intents",
    ".profile-publish-staging/bundles",
  ];
  return relatives.map(relative => {
    const target = relative === "." ? root : resolve(root, relative);
    const status = lstatSync(target, { bigint: true });
    return {
      relative,
      dev: status.dev,
      ino: status.ino,
      uid: status.uid,
      gid: status.gid,
      mode: status.mode,
      nlink: status.nlink,
      names: readdirSync(target).sort(),
    };
  });
}

function admission() {
  return {
    signal: new AbortController().signal,
    assertAdmitted() {},
  };
}

function assertNativeCrossMountRejected(source: string, target: string) {
  const addon = resolve(
    packageRoot,
    "build/Release/atomic_directory_publication.node",
  );
  const moduleRecord: { exports: Record<string, unknown> } = {
    exports: Object.create(null),
  };
  process.dlopen(moduleRecord, addon, osConstants.dlopen.RTLD_NOW);
  const renameNoReplace = moduleRecord.exports.renameNoReplace;
  expect(typeof renameNoReplace).toBe("function");
  mkdirSync(resolve(source, "source"), { mode: 0o700 });
  const sourceFd = openSync(
    source,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  const targetFd = openSync(
    target,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    expect(() =>
      Reflect.apply(renameNoReplace as (...args: unknown[]) => unknown, null, [
        sourceFd,
        "source",
        targetFd,
        "target",
      ]),
    ).toThrow();
    expect(existsSync(resolve(source, "source"))).toBe(true);
    expect(existsSync(resolve(target, "target"))).toBe(false);
  } finally {
    closeSync(targetFd);
    closeSync(sourceFd);
  }
}

function dockerInstructions(stageText: string) {
  return stageText
    .replace(/\\\r?\n\s*/g, " ")
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(Boolean);
}

function assertHermeticNativeBuild(
  stageText: string,
  mode: "production" | "all",
) {
  const nativeBuilds = dockerInstructions(stageText).filter(line =>
    line.includes("scripts/run-native-build.mjs"),
  );
  expect(nativeBuilds).toHaveLength(1);
  const [nativeBuild] = nativeBuilds;
  const normalizedNativeBuild = nativeBuild!.replace(/\s+/gu, " ");
  expect(normalizedNativeBuild).toContain(
    'test "$PWD" = /app/apps/browser-service',
  );
  expect(normalizedNativeBuild).toContain(
    'test "$NODE_VERSION" = 22.22.1',
  );
  expect(normalizedNativeBuild).toContain(
    'test "$YARN_VERSION" = 1.22.22',
  );
  expect(normalizedNativeBuild).toContain(
    "/usr/bin/env -i HOME=/root PATH=/usr/local/bin:/usr/bin:/bin " +
      "LANG=C.UTF-8 USER=root LOGNAME=root SHELL=/bin/sh " +
      "PWD=/app/apps/browser-service /usr/local/bin/node " +
      `/app/apps/browser-service/scripts/run-native-build.mjs ${mode}`,
  );
  expect(normalizedNativeBuild).not.toMatch(
    /(?:^|\s)(?:NODE_VERSION|YARN_VERSION|TARGETARCH)=\S+\s+\/usr\/local\/bin\/node/u,
  );
  expect(normalizedNativeBuild).not.toMatch(
    /(?:^|&&\s+)(?:node|\/usr\/local\/bin\/node)\s+scripts\/run-native-build\.mjs/u,
  );
}

function assertTestRuntimePreflightPackaging(
  testBuild: string,
  browserTest: string,
) {
  const normalizedBuild = dockerInstructions(testBuild).join(" ");
  const compile = "pnpm exec tsc -p tsconfig.json";
  const packagePreflight =
    "cp src/runtime-preflight.mjs dist/runtime-preflight.mjs";
  const verifyPreflight =
    "cmp -s src/runtime-preflight.mjs dist/runtime-preflight.mjs";
  const compileIndex = normalizedBuild.indexOf(compile);
  const packageIndex = normalizedBuild.indexOf(packagePreflight);
  expect(compileIndex).toBeGreaterThanOrEqual(0);
  expect(packageIndex).toBeGreaterThan(compileIndex);
  expect(normalizedBuild).toContain(verifyPreflight);

  const normalizedTest = dockerInstructions(browserTest).join(" ");
  expect(normalizedTest).toContain("test -f dist/runtime-preflight.mjs");
  expect(normalizedTest).toContain(verifyPreflight);
}

function assertMinimalRuntimeDefinition(runtime: string) {
  const allowedCopies = new Map([
    ["/usr/local/bin/node", "/usr/local/bin/node"],
    ["node_modules", "/app/apps/browser-service/node_modules"],
    ["package.json", "/app/apps/browser-service/package.json"],
    ["dist", "/app/apps/browser-service/dist"],
    [
      "build/Release/atomic_directory_publication.node",
      "/app/apps/browser-service/build/Release/atomic_directory_publication.node",
    ],
    [
      "build/Release/atomic-directory-publication.node.sha256",
      "/app/apps/browser-service/build/Release/atomic-directory-publication.node.sha256",
    ],
    [
      "src/runtime-preflight.mjs",
      "/app/apps/browser-service/src/runtime-preflight.mjs",
    ],
    [
      "dist/runtime-preflight.mjs",
      "/app/apps/browser-service/src/runtime-preflight.mjs",
    ],
    [
      "scripts/check-atomic-publication-rollback.mjs",
      "/app/apps/browser-service/scripts/check-atomic-publication-rollback.mjs",
    ],
  ]);
  const copies = dockerInstructions(runtime).filter(line =>
    line.startsWith("COPY "),
  );
  for (const instruction of copies) {
    const operands = instruction
      .slice("COPY ".length)
      .split(/\s+/u)
      .filter(token => !token.startsWith("--"));
    if (operands.length !== 2) {
      throw new Error(`runtime COPY shape is unsupported: ${instruction}`);
    }
    const [copySource, destination] = operands;
    if (allowedCopies.get(destination!) !== copySource) {
      throw new Error(`runtime COPY is not allowlisted: ${instruction}`);
    }
  }
  if (copies.length !== allowedCopies.size) {
    throw new Error("runtime COPY inventory is incomplete");
  }
  if (!/find dist build src scripts \\\( -type p -o/u.test(runtime)) {
    throw new Error("runtime cleanup does not select FIFO nodes by type");
  }
  if (!/find \. -type p -print -quit/u.test(runtime)) {
    throw new Error("runtime verification does not reject FIFO nodes");
  }
}

function assertDependencyPayloadCleanup(runtime: string) {
  const normalized = runtime
    .replace(/\\\r?\n\s*/gu, " ")
    .replace(/\s+/gu, " ");
  const cleanup = normalized.match(
    /find \/app\/apps\/browser-service\/node_modules .*? -delete/u,
  )?.[0];
  if (cleanup === undefined) {
    throw new Error("dependency payload cleanup is missing");
  }
  if (
    !cleanup.startsWith(
      "find /app/apps/browser-service/node_modules -xdev -depth ",
    )
  ) {
    throw new Error("dependency payload cleanup is not bounded");
  }
  for (const overbroad of [
    "-name '*test*'",
    "-name '*spec*'",
    "-name '*fixture*'",
    "-name 'package.json'",
    "-iname 'license*'",
  ]) {
    if (cleanup.includes(overbroad)) {
      throw new Error(`dependency payload cleanup is overbroad: ${overbroad}`);
    }
  }
  for (const component of [
    "-path '*/test' -o -path '*/test/*'",
    "-path '*/tests' -o -path '*/tests/*'",
    "-path '*/__tests__' -o -path '*/__tests__/*'",
    "-path '*/fixture' -o -path '*/fixture/*'",
    "-path '*/fixtures' -o -path '*/fixtures/*'",
  ]) {
    if (!cleanup.includes(component)) {
      throw new Error(`dependency payload directory is unhandled: ${component}`);
    }
  }
  for (const pattern of [
    "-name 'test.*'",
    "-name 'spec.*'",
    "-name 'fixture.*'",
    "-name 'fixtures.*'",
    "-name '*.test.*'",
    "-name '*.spec.*'",
    "-name '*.fixture.*'",
    "-name '*.fixtures.*'",
  ]) {
    if (!cleanup.includes(pattern)) {
      throw new Error(`dependency payload file is unhandled: ${pattern}`);
    }
  }
}

function assertRuntimeHeaderCleanup(runtime: string) {
  const cleanup = dockerInstructions(runtime).find(line =>
    line.startsWith("RUN rm -rf "),
  );
  if (cleanup === undefined) {
    throw new Error("runtime Node header cleanup is not exact");
  }
  if (
    /(?:^|\s)\/usr\/include(?:\s|$)/u.test(cleanup) ||
    /(?:^|\s)\/usr\/local\/include(?:\s|$)/u.test(cleanup)
  ) {
    throw new Error("runtime Node header cleanup is overbroad");
  }
  if (!cleanup.includes("/usr/include/node /usr/local/include/node")) {
    throw new Error("runtime Node header cleanup is not exact");
  }
  for (const path of runtimeNodeHeaderPaths) {
    if (!runtime.includes(`test ! -e ${path}`)) {
      throw new Error(`runtime Node header absence is unverified: ${path}`);
    }
  }
}

function walkRuntimeFilesystem(
  root: string,
  visit: (path: string, relative: string) => void,
) {
  const pending = [root];
  let visited = 0;
  while (pending.length !== 0) {
    const current = pending.pop()!;
    const relative = current.slice(root.length).replace(/^\/+/u, "");
    visit(current, relative);
    const status = lstatSync(current);
    if (status.isDirectory()) {
      for (const child of readdirSync(current)) {
        pending.push(resolve(current, child));
      }
    }
    visited += 1;
    if (visited > 1_000_000) {
      throw new Error("runtime filesystem inventory exceeds its bound");
    }
  }
}

describe("browser service Dockerfile", () => {
  it("pins Node and Playwright bases to immutable verified indexes", async () => {
    const text = await source();
    const allowlist = JSON.parse(await readFile(allowlistPath, "utf8"));
    const nodeRef = `${allowlist.dockerInit.amd64.nodeBaseRepository}@${allowlist.dockerInit.amd64.nodeBaseIndexDigest}`;
    const froms = text.match(/^FROM\s+\S+/gim) ?? [];
    const nodeFroms = froms.filter(line => line.includes("node:22.22.1"));
    expect(nodeFroms.length).toBeGreaterThan(0);
    expect(nodeFroms.every(line => line.includes(nodeRef))).toBe(true);
    const playwrightRef =
      "mcr.microsoft.com/playwright:v1.61.1-noble@sha256:5b8f294aff9041b7191c34a4bab3ac270157a28774d4b0660e9743297b697e48";
    const playwrightFroms = froms.filter(line => line.includes("playwright:"));
    expect(playwrightFroms.length).toBeGreaterThan(0);
    expect(playwrightFroms.every(line => line.includes(playwrightRef))).toBe(true);
  });

  it("acquires one fixed pnpm tool with literal URL and SRI", async () => {
    const text = await source();
    expect(text.match(/\bAS browser-service-pnpm-tool\b/g)).toHaveLength(1);
    expect(text).toContain(
      "https://registry.npmjs.org/pnpm/-/pnpm-10.33.0.tgz",
    );
    expect(text).toContain(
      "sha512-EFaLtKavtYyes2MNqQzJUWQXq+vT+rvmc58K55VyjaFJHp21pUTHatjrdXD1xLs9bGN7LLQb/c20f6gjyGSTGQ==",
    );
    expect(text).toContain("/opt/pnpm/10.33.0/bin/pnpm.cjs");
    expect(text).toMatch(/actual!==expected[\s\S]*writeFile[\s\S]*tar --extract/);
    expect(text).toContain("rm /tmp/pnpm-10.33.0.tgz");
    expect(text).not.toMatch(
      /(?:^|\n)\s*(?:RUN\s+|&&\s*)corepack\b|\bnpm\s+(?:i|install)\b|curl|wget/i,
    );
    expect(text).not.toMatch(/ARG\s+(?:PNPM|PNPM_VERSION|PNPM_URL|PNPM_SRI)/i);
  });

  it("copies the verified pnpm tree into build and test stages", async () => {
    const text = await source();
    expect(
      text.match(
        /COPY --from=browser-service-pnpm-tool \/opt\/pnpm\/10\.33\.0 \/opt\/pnpm\/10\.33\.0/g,
      )?.length,
    ).toBeGreaterThanOrEqual(2);
    expect(text).toContain("WORKDIR /app/apps/browser-service");
    expect(text).toContain(
      'test "$(realpath /usr/local/bin/pnpm)" = /opt/pnpm/10.33.0/bin/pnpm.cjs',
    );
    expect(text).toContain(
      'test "$(/usr/local/bin/pnpm --version)" = 10.33.0',
    );
    expect(text).toMatch(/browser-test[\s\S]*node_modules\/\.bin\/vitest/);
  });

  it("closes the native build environment before Node base runners", async () => {
    const text = await source();
    const production = stage(text, "browser-service-build");
    const tests = stage(text, "browser-service-test-build");
    assertHermeticNativeBuild(production, "production");
    assertHermeticNativeBuild(tests, "all");
    expect(() =>
      assertHermeticNativeBuild(
        production.replace("/usr/bin/env -i", "/usr/bin/env"),
        "production",
      ),
    ).toThrow();
  });

  it("packages the runtime preflight module into the browser test image", async () => {
    const text = await source();
    const testBuild = stage(text, "browser-service-test-build");
    const browserTest = stage(text, "browser-test");
    assertTestRuntimePreflightPackaging(testBuild, browserTest);
    expect(() =>
      assertTestRuntimePreflightPackaging(
        testBuild.replace(
          "cp src/runtime-preflight.mjs dist/runtime-preflight.mjs",
          "true",
        ),
        browserTest,
      ),
    ).toThrow();
    expect(() =>
      assertTestRuntimePreflightPackaging(
        testBuild,
        browserTest.replace("test -f dist/runtime-preflight.mjs", "true"),
      ),
    ).toThrow();
  });

  it("selects and verifies only the exact dockerInit tuple", async () => {
    const text = await source();
    for (const field of [
      "targetArch",
      "nodeBaseRepository",
      "nodeBaseIndexDigest",
      "nodeBasePlatformDigest",
      "osReleaseSha256",
      "dpkgArchitecture",
      "utilLinuxPackage",
      "utilLinuxVersion",
      "flockRealpath",
      "flockSha256",
    ]) {
      expect(text).toContain(field);
    }
    expect(text).toContain('Object.keys(x.dockerInit).join(",")!=="amd64,arm64"');
    expect(text).toContain('"util-linux=${util_linux_version}"');
    expect(text).toContain("sha256sum /etc/os-release");
    expect(text).toContain("dpkg --print-architecture");
    expect(text).toContain("dpkg-query -W");
    expect(text).toContain("realpath /usr/bin/flock");
    expect(text).toContain("sha256sum /usr/bin/flock");
    expect(text).not.toMatch(/toolchain-allowlist\.json\s*(?:>|>>)|sed\s+-i|jq\s+.*toolchain-allowlist/);
    expect(text).not.toMatch(/apt-get install[^\\\n]*\butil-linux(?:\s|$)/);
  });

  it("provides an init-only target with exact external flock entrypoint", async () => {
    const text = await source();
    const init = stage(text, "browser-volume-init");
    expect(init).toContain("WORKDIR /app/apps/browser-service");
    expect(init).toContain(
      'ENTRYPOINT ["/usr/bin/flock","--exclusive","--timeout","60","/var/lib/firecrawl-browser-volume","/usr/local/bin/node","scripts/init-state-volume.mjs"]',
    );
    expect(init).toContain("native/toolchain-allowlist.json");
    expect(init).toContain("scripts/init-state-volume.mjs");
    expect(init).not.toContain("dist/index.js");
  });

  it("keeps the final runtime minimal and fixed to uid 1000", async () => {
    const text = await source();
    const runtime = stage(text, "browser-service-runtime");
    assertMinimalRuntimeDefinition(runtime);
    assertDependencyPayloadCleanup(runtime);
    assertRuntimeHeaderCleanup(runtime);
    expect(() =>
      assertMinimalRuntimeDefinition(
        `${runtime}\nCOPY --from=browser-service-build /opt/pnpm /opt/pnpm\n`,
      ),
    ).toThrow(/not allowlisted/i);
    expect(() =>
      assertMinimalRuntimeDefinition(
        runtime.replace(
          "src/runtime-preflight.mjs dist/runtime-preflight.mjs",
          "src/runtime-preflight.mjs dist/runtime-preflight.js",
        ),
      ),
    ).toThrow(/not allowlisted/i);
    expect(runtime).toContain("USER 1000:1000");
    expect(runtime).toContain("check-atomic-publication-rollback.mjs");
    expect(runtime).toContain("atomic_directory_publication.node");
    expect(runtime).toContain("atomic-directory-publication.node.sha256");
    for (const forbidden of [
      "/opt/pnpm",
      "/usr/local/bin/pnpm",
      "/usr/bin/flock",
      "build/Test",
      "*.o",
      "*.d",
      "*.map",
      "*.trace",
      "*.inputs.sha256",
      "testHooks",
      "becomeChildSubreaperForTest",
      "prepareInheritedLockFdForTest",
      "claimAdoptedChildForTest",
      "reapClaimedChildForTest",
      "orphan-ready-v1",
    ]) {
      expect(runtime).toContain(forbidden);
    }
  });

  it("uses bounded dependency test and fixture payload cleanup", async () => {
    const text = await source();
    const runtime = stage(text, "browser-service-runtime");
    assertDependencyPayloadCleanup(runtime);
    expect(() =>
      assertDependencyPayloadCleanup(
        runtime.replace(
          "/app/apps/browser-service/node_modules -xdev -depth",
          "/app/apps/browser-service -xdev -depth",
        ),
      ),
    ).toThrow(/missing|not bounded/i);
    expect(() =>
      assertDependencyPayloadCleanup(runtime.replace(" -depth", "")),
    ).toThrow(/not bounded/i);
    expect(() =>
      assertDependencyPayloadCleanup(
        runtime.replace(
          " -path '*/__tests__' -o -path '*/__tests__/*'",
          "",
        ),
      ),
    ).toThrow(/directory is unhandled/i);
    expect(() =>
      assertDependencyPayloadCleanup(runtime.replace(" -name '*.spec.*'", "")),
    ).toThrow(/file is unhandled/i);
    expect(() =>
      assertDependencyPayloadCleanup(
        runtime.replace("-name 'test.*'", "-name '*test*'"),
      ),
    ).toThrow(/overbroad/i);
  });

  it("uses bounded exact-path Node header cleanup", async () => {
    const text = await source();
    const runtime = stage(text, "browser-service-runtime");
    assertRuntimeHeaderCleanup(runtime);
    expect(() =>
      assertRuntimeHeaderCleanup(
        runtime.replace(
          "/usr/include/node /usr/local/include/node",
          "/usr/include /usr/local/include",
        ),
      ),
    ).toThrow(/overbroad/i);
    expect(() =>
      assertRuntimeHeaderCleanup(
        runtime.replace("test ! -e /usr/include/node", "true"),
      ),
    ).toThrow(/absence is unverified/i);
  });

  it("normalizes final native artifact ownership and modes", async () => {
    const text = await source();
    const runtime = stage(text, "browser-service-runtime");
    const normalizedRuntime = runtime
      .replace(/\\\r?\n\s*/gu, " ")
      .replace(/\s+/gu, " ");
    expect(normalizedRuntime).toContain(
      "chown 1000:1000 build/Release " +
        "&& chmod 0700 build/Release " +
        "&& chmod 0600 build/Release/atomic_directory_publication.node " +
        "build/Release/atomic-directory-publication.node.sha256",
    );
  });

  it("selects and rejects real FIFO nodes in runtime cleanup", async () => {
    const text = await source();
    const runtime = stage(text, "browser-service-runtime");
    assertMinimalRuntimeDefinition(runtime);
    const root = imageRoot();
    const fifo = resolve(root, "runtime-fixture-without-fifo-suffix");
    const made = spawnSync("/usr/bin/mkfifo", ["--mode=0600", "--", fifo], {
      encoding: "utf8",
    });
    expect(made.status, made.stderr).toBe(0);
    expect(lstatSync(fifo).isFIFO()).toBe(true);
    const removed = spawnSync(
      "/usr/bin/find",
      [root, "(", "-type", "p", ")", "-delete"],
      { encoding: "utf8" },
    );
    expect(removed.status, removed.stderr).toBe(0);
    expect(existsSync(fifo)).toBe(false);
    const verified = spawnSync(
      "/usr/bin/find",
      [root, "-type", "p", "-print", "-quit"],
      { encoding: "utf8" },
    );
    expect(verified.status, verified.stderr).toBe(0);
    expect(verified.stdout).toBe("");
  });

  it("keeps package runtime versions exact", async () => {
    const manifest = JSON.parse(
      await readFile(resolve(packageRoot, "package.json"), "utf8"),
    );
    expect(manifest.dependencies.playwright).toBe("1.61.1");
    expect(manifest.dependencies.typescript).toBe("5.9.3");
    expect(manifest.packageManager).toBe("pnpm@10.33.0");
    expect(manifest.engines.node).toBe("22.22.1");
  });
});

describe("guarded final runtime filesystem acceptance", () => {
  it.runIf(runtimeFilesystemCase)(
    "owns native artifacts as uid and gid 1000 with exact modes",
    () => {
      const root = process.env.ATOMIC_RUNTIME_ROOT;
      expect(root).toMatch(/^\//u);
      const release = resolve(
        root!,
        "app/apps/browser-service/build/Release",
      );
      const metadata = [
        [release, 0o700],
        [resolve(release, "atomic_directory_publication.node"), 0o600],
        [
          resolve(release, "atomic-directory-publication.node.sha256"),
          0o600,
        ],
      ] as const;
      for (const [entry, expectedMode] of metadata) {
        const status = lstatSync(entry);
        expect(status.uid, entry).toBe(1000);
        expect(status.gid, entry).toBe(1000);
        expect(status.mode & 0o7777, entry).toBe(expectedMode);
      }
    },
  );

  it.runIf(runtimeFilesystemCase)(
    "contains no FIFO, toolchain, test hook, or pnpm payload",
    () => {
      const root = process.env.ATOMIC_RUNTIME_ROOT;
      expect(root).toMatch(/^\//u);
      expect(statSync(root!).isDirectory()).toBe(true);
      for (const path of runtimeNodeHeaderPaths) {
        const relative = path.slice(1);
        expect(existsSync(resolve(root!, relative)), relative).toBe(false);
      }
      for (const forbidden of [
        "opt/pnpm",
        "pnpm",
        "pnpm-store",
        "root/.cache/pnpm",
        "root/.cache/node/corepack",
        "root/.local/share/pnpm",
        "home/pwuser/.cache/pnpm",
        "home/pwuser/.cache/node/corepack",
        "home/pwuser/.local/share/pnpm",
        "usr/local/bin/pnpm",
        "usr/local/bin/corepack",
        "usr/local/lib/node_modules",
        "usr/lib/node_modules",
        "usr/bin/flock",
        "usr/bin/gcc",
        "usr/bin/g++",
        "usr/bin/cc",
        "usr/bin/c++",
        "usr/bin/make",
        "usr/bin/ar",
        "usr/bin/ld",
        "usr/bin/nm",
        "usr/bin/strip",
        "usr/lib/gcc",
      ]) {
        expect(existsSync(resolve(root!, forbidden)), forbidden).toBe(false);
      }
      const forbiddenContent =
        /testHooks|becomeChildSubreaperForTest|prepareInheritedLockFdForTest|claimAdoptedChildForTest|reapClaimedChildForTest|orphan-ready-v1/u;
      walkRuntimeFilesystem(root!, (entry, relative) => {
        const status = lstatSync(entry);
        expect(status.isFIFO(), `FIFO node: ${relative}`).toBe(false);
        if (
          relative !== "app/apps/browser-service" &&
          !relative.startsWith("app/apps/browser-service/")
        ) {
          return;
        }
        const leaf = relative.split("/").at(-1) ?? "";
        const dependencyPrefix =
          "app/apps/browser-service/node_modules/";
        const inDependencies = relative.startsWith(dependencyPrefix);
        if (inDependencies) {
          expect(
            dependencyPayloadDirectories.has(leaf),
            `forbidden dependency directory: ${relative}`,
          ).toBe(false);
        }
        if (status.isFile()) {
          if (inDependencies) {
            expect(
              dependencyPayloadFile.test(leaf),
              `forbidden dependency file: ${relative}`,
            ).toBe(false);
          } else {
            expect(
              /test|fixture|\.fifo$|\.o$|\.d$|\.map$|\.trace$|\.inputs\.sha256$|^pnpm\.cjs$|^pnpmrc$/iu.test(
                leaf,
              ),
              `forbidden runtime file: ${relative}`,
            ).toBe(false);
          }
          expect(status.size, `unbounded content scan: ${relative}`).toBeLessThanOrEqual(
            32 * 1024 * 1024,
          );
          expect(
            forbiddenContent.test(readFileSync(entry).toString("latin1")),
            `test hook bytes: ${relative}`,
          ).toBe(false);
        }
      });
    },
  );
});

describe("privileged browser image mount acceptance", () => {
  it.runIf(privilegedImageCase)(
    "different uid replacement root-swap collision rejects held roots",
    async () => {
      const root = imageRoot();
      provisionAtomicRoot(root);
      const reconciliation = await import("./reconciliation.js");
      const displaced = `${root}-held`;
      imageRoots.push(displaced);
      let swapped = false;
      await expect(
        reconciliation.runWithReconciliationFilesystemTestContext(
          {
            beforeCall(point) {
              if (point !== "open-root" || swapped) return;
              swapped = true;
              renameSync(root, displaced);
              mkdirSync(root, { mode: 0o700 });
              provisionAtomicRoot(root);
              chownSync(root, 1001, 1001);
            },
          },
          () =>
            reconciliation.acquireAtomicPreReadyRecoveryAuthorityFromCanonicalRoot(
              root,
              {
                processNonce,
                controlGenerationNonce,
                snapshotDigest: "a".repeat(64),
              },
              admission(),
              operationId,
            ),
        ),
      ).rejects.toMatchObject({
        category: "reconciliation_filesystem_unsafe",
      });
      expect(swapped).toBe(true);
      expect(lstatSync(root).uid).toBe(1001);
      expect(existsSync(displaced)).toBe(true);
    },
  );

  it.runIf(privilegedImageCase)(
    "read only volume rejects startup",
    async () => {
      const root = imageRoot();
      provisionAtomicRoot(root);
      mount(["--bind", "--", root, root], root);
      command("/usr/bin/mount", [
        "--options",
        "remount,bind,ro",
        "--",
        root,
      ]);
      const reconciliation = await import("./reconciliation.js");
      const snapshot = reconciliation.canonicalizeReconciliationSnapshot([]);
      await expect(
        reconciliation.reconcileBrowserState(
          root,
          {
            version: 1,
            processNonce,
            controlGenerationNonce,
            snapshotDigest: snapshot.snapshotDigest,
            references: [],
          },
          { admission: admission() },
        ),
      ).rejects.toMatchObject({
        category: expect.stringMatching(
          /^reconciliation_(?:execution|filesystem|cleanup)/,
        ),
      });
    },
  );

  it.runIf(privilegedImageCase)(
    "cross mount rejects native publication",
    () => {
      const root = imageRoot();
      const source = resolve(root, "source-mount");
      const target = resolve(root, "target");
      mkdirSync(source, { mode: 0o700 });
      mkdirSync(target, { mode: 0o700 });
      mount(
        [
          "--types",
          "tmpfs",
          "--options",
          "mode=0700,size=4m",
          "tmpfs",
          source,
        ],
        source,
      );
      assertNativeCrossMountRejected(source, target);
    },
  );

  it.runIf(privilegedImageCase)(
    "same device bind mount id mismatch rejects publication",
    () => {
      const root = imageRoot();
      const backing = resolve(root, "backing");
      const view = resolve(root, "view");
      const target = resolve(root, "target");
      mkdirSync(backing, { mode: 0o700 });
      mkdirSync(view, { mode: 0o700 });
      mkdirSync(target, { mode: 0o700 });
      mount(["--bind", "--", backing, view], view);
      assertNativeCrossMountRejected(view, target);
    },
  );

  it.runIf(privilegedImageCase)(
    "privileged owner drift fail stops without repair",
    async () => {
      const root = imageRoot();
      provisionAtomicRoot(root);
      chownSync(resolve(root, "profiles"), 1001, 1001);
      const reconciliation = await import("./reconciliation.js");
      await expect(
        reconciliation.acquireAtomicPreReadyRecoveryAuthorityFromCanonicalRoot(
          root,
          {
            processNonce,
            controlGenerationNonce,
            snapshotDigest: "b".repeat(64),
          },
          admission(),
          operationId,
        ),
      ).rejects.toMatchObject({
        category: "reconciliation_filesystem_unsafe",
      });
      expect(
        (await import("node:fs")).statSync(resolve(root, "profiles")).uid,
      ).toBe(1001);
    },
  );

  it.runIf(privilegedImageCase)(
    "privileged mode drift fail stops without repair",
    async () => {
      const root = imageRoot();
      provisionAtomicRoot(root);
      chmodSync(resolve(root, "profiles"), 0o755);
      const reconciliation = await import("./reconciliation.js");
      await expect(
        reconciliation.acquireAtomicPreReadyRecoveryAuthorityFromCanonicalRoot(
          root,
          {
            processNonce,
            controlGenerationNonce,
            snapshotDigest: "b".repeat(64),
          },
          admission(),
          operationId,
        ),
      ).rejects.toMatchObject({
        category: "reconciliation_filesystem_unsafe",
      });
      expect(statSync(resolve(root, "profiles")).mode & 0o7777).toBe(0o755);
    },
  );

  it.runIf(privilegedImageCase)(
    "denied parent fail stops the real server startup without mutation",
    () => {
      const root = imageRoot();
      const denied = resolve(root, "denied");
      mkdirSync(denied, { mode: 0o700 });
      chownSync(denied, 0, 0);
      chmodSync(denied, 0o000);
      const before = lstatSync(denied, { bigint: true });
      const beforeEntries = readdirSync(denied);
      const server = resolve(packageRoot, "dist/index.js");
      expect(existsSync(server), "built server entrypoint").toBe(true);
      const preflight = resolve(packageRoot, "dist/runtime-preflight.mjs");
      expect(existsSync(preflight), "packaged runtime preflight").toBe(true);
      const imported = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          "await import('./dist/runtime-preflight.mjs')",
        ],
        {
          cwd: packageRoot,
          encoding: "utf8",
          timeout: 15_000,
        },
      );
      expect(imported.error).toBeUndefined();
      expect(
        imported.status,
        `runtime preflight import:\n${imported.stdout}\n${imported.stderr}`,
      ).toBe(0);
      const attempt = spawnSync(
        process.execPath,
        [server],
        {
          cwd: packageRoot,
          encoding: "utf8",
          uid: 1000,
          gid: 1000,
          timeout: 15_000,
          env: {
            ...process.env,
            HOME: "/tmp",
            LOCAL_BROWSER_STATE_ROOT: denied,
            BROWSER_SERVICE_API_KEY:
              "0123456789abcdef0123456789abcdef",
            PORT: "3010",
          },
        },
      );
      expect(attempt.error).toBeUndefined();
      expect(attempt.status).not.toBe(0);
      expect(`${attempt.stdout}\n${attempt.stderr}`).toMatch(
        /reconciliation_filesystem_unsafe/i,
      );
      const after = lstatSync(denied, { bigint: true });
      expect({
        dev: after.dev,
        ino: after.ino,
        uid: after.uid,
        gid: after.gid,
        mode: after.mode,
        nlink: after.nlink,
      }).toEqual({
        dev: before.dev,
        ino: before.ino,
        uid: before.uid,
        gid: before.gid,
        mode: before.mode,
        nlink: before.nlink,
      });
      expect(readdirSync(denied)).toEqual(beforeEntries);
    },
  );

  it.runIf(privilegedImageCase)(
    "disallowed filesystem rejects startup",
    async () => {
      const root = imageRoot();
      mount(
        [
          "--types",
          "ramfs",
          "--options",
          "mode=0700",
          "ramfs",
          root,
        ],
        root,
      );
      chmodSync(root, 0o700);
      const filesystemType = statfsSync(root, { bigint: true }).type;
      expect(
        new Set([
          0xef53n,
          0x58465342n,
          0x9123683en,
          0x01021994n,
          0x794c7630n,
        ]).has(filesystemType),
        `ramfs magic ${filesystemType.toString(16)} must remain disallowed`,
      ).toBe(false);
      provisionAtomicRoot(root);
      const before = snapshotAtomicRoot(root);
      const reconciliation = await import("./reconciliation.js");
      await expect(
        reconciliation.acquireAtomicPreReadyRecoveryAuthorityFromCanonicalRoot(
          root,
          {
            processNonce,
            controlGenerationNonce,
            snapshotDigest: "c".repeat(64),
          },
          admission(),
          operationId,
        ),
      ).rejects.toMatchObject({
        category: "reconciliation_filesystem_unsafe",
        message: "atomic publication filesystem is unsupported",
      });
      expect(snapshotAtomicRoot(root)).toEqual(before);
    },
  );
});
