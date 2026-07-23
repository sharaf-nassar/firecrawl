# Atomic Directory Publication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development to implement this plan task-by-task.
> For every numbered implementation task, use one fresh implementer, then one
> requirements reviewer and one quality reviewer. Route findings to the same
> implementer and repeat both reviews before committing.

**Goal:** Complete host-native Task 4 so Browser Service constructs profile
state privately, publishes with Linux `renameat2(RENAME_NOREPLACE)`, recovers
durable ownership before Task 3 quarantine, and fails readiness whenever
native, filesystem, capability, cleanup, or adoption proof is incomplete.

**Architecture:** `atomic-publication-manifest.ts` is a pure closed codec.
`atomic-directory-publication.ts` is a pure one-effect-at-a-time reducer.
`reconciliation.ts` alone owns every held handle, raw fd, semantic/partial ID
WeakMap, `PreReadyRecoveryAuthority`, `BoundGeneration`, effect execution, and
native operand scope. Native C exposes only one generic no-replace operation.
Current plan ends at deterministic host acceptance with local activation still
disabled. Original master-plan Tasks 6 and 14 retain image, init-container,
privileged mount, named-volume, Compose, and activation ownership.

**Tech Stack:** Linux `renameat2`/`statx`, C11, Node-API v8, deterministic
`/usr/bin/gcc` or approved `/usr/bin/cc` fallback, existing
`/usr/bin/flock`, Node.js 22.22.1, TypeScript 5.9.3,
Vitest 4.1.9, Playwright 1.61.1.

---

## Scope, prerequisites, and dirty-worktree rules

Authoritative contract is committed spec `f18e5b275`:
`docs/superpowers/specs/2026-07-22-atomic-directory-publication-design.md`.
Do not edit that spec while executing this plan.

Execute directly in `/home/mamba/work/firecrawl` on current `main`. Do not
create a worktree, nested checkout, stash, backup tree, generated source copy,
or memory file.

Existing twelve Task 4 files are in-progress user work:

```text
apps/browser-service/src/egress-proxy.test.ts
apps/browser-service/src/egress-proxy.ts
apps/browser-service/src/profile-store.test.ts
apps/browser-service/src/profile-store.ts
apps/browser-service/src/reconciliation.test.ts
apps/browser-service/src/reconciliation.ts
apps/browser-service/src/replay-restore.integration.test.ts
apps/browser-service/src/replay-restore.ts
apps/browser-service/src/session-registry.test.ts
apps/browser-service/src/session-registry.ts
apps/browser-service/src/startup-state.test.ts
apps/browser-service/src/startup-state.ts
```

Preserve them. Modify a listed pair only in its atomic-integration task. Do not
commit any current file until that task's atomic integration, focused GREEN,
requirements review, and quality review all pass. Never reset, restore, clean,
or broad-stage the worktree.

Before every Browser Service command:

```bash
export PATH=/home/mamba/.nvm/versions/node/v22.22.1/bin:$PATH
node --version
realpath "$(command -v node)"
```

Expected: `v22.22.1` and
`/home/mamba/.nvm/versions/node/v22.22.1/bin/node`.

Verify existing tools; do not install substitutes:

```bash
test "$(command -v flock)" = /usr/bin/flock
test -f /home/mamba/.nvm/versions/node/v22.22.1/include/node/node_api.h
/usr/bin/flock --help
/usr/bin/flock --version
docker --version
docker buildx version
docker buildx imagetools inspect --help | rg -- '--raw'
if test -x /usr/bin/gcc && test -f "$(realpath /usr/bin/gcc)"; then
  test "$(command -v gcc)" = /usr/bin/gcc
  /usr/bin/gcc --version
else
  test "$(command -v cc)" = /usr/bin/cc
  test -f "$(realpath /usr/bin/cc)"
  case "$(realpath /usr/bin/cc)" in /usr/bin/*) ;; *) exit 1 ;; esac
  /usr/bin/cc --version
fi
```

Supported Linux architectures are exactly Node `x64` and `arm64`. Any other
platform/architecture fails preinstall/build before compiler execution. If
neither approved compiler exists, or another exact tool/header is missing,
stop and ask the user. Do not use `node-gyp`,
`binding.gyp`, downloaded headers, `npx`, `pnpm dlx`, apt, a global install,
`CC`, or caller compiler flags. No package dependency or lockfile change is
allowed for this work.

Before each commit, run these as separate commands:

```bash
git status --short
git diff --check
git diff --cached --name-only
apps/api/.husky/_/pre-commit
git diff --cached --name-only
git diff --cached --check
```

The two cached-name outputs must exactly equal that task's explicit `git add`
list. Use no `git add -A`, `git add .`, directory staging, or commit wrapper.
Each commit command below is one bare literal command.

In every task's GREEN/review/commit step, stop after GREEN, dispatch the fresh
requirements reviewer, then the fresh quality reviewer. If either reports a
finding, send it to the same implementer, rerun that task's GREEN, and repeat
both reviews. Stage only after both explicitly pass.

Generated `apps/browser-service/build/`, `.node`, executable, object, depfile,
map, trace, attestation, and `node_modules/` content stays ignored and unstaged.
Keep build artifacts between focused commands. Because compilation is
unconditional, run the exact build runner immediately before every command
that loads an addon. Remove generated build output only at final cleanup.
Task 4 does not run `pnpm start`: `src/index.ts` remains original master Task 6
ownership, and image/server/start acceptance is explicitly deferred.

## File ownership map

### Pure current modules

- `src/atomic-publication-manifest.ts` — closed intent/manifest codecs, full
  authenticated manifest binding, phase matrix, names, paths, and bounds.
- `src/atomic-directory-publication.ts` — data-only reducer, one outstanding
  effect, canonical transitions, recovery decisions; no I/O/import from
  reconciliation/startup/ProfileStore/Registry.
- `src/atomic-publication-observability.ts` — sanitized bounded counters and
  threshold-to-private-alert policy.

### Reconciliation-owned current boundary

- `src/reconciliation.ts` — sole handle/fd/capability authority; shared Task 3
  Budget/walker/encoder/hash/evidence machinery; semantic and partial-create
  registries; `ApplyAtomicEffectV1`; mount/canary, publication, deletion,
  recovery/adoption, and `PreReadyRecoveryAuthority` bridge.
- `src/profile-store.ts` — calls reconciliation-owned profile operations and
  receives only reconciliation-owned opaque `BoundGeneration` values.
- `src/startup-state.ts` — drain/mint, recovery-before-Task-3 ordering, and one
  atomic result/authority/store/ready install.
- `src/session-registry.ts`, `src/replay-restore.ts`, `src/egress-proxy.ts` —
  retained persistent Chromium/procfd, storage-only replay, and closed proxy
  ingress behavior over reconciled capabilities.

### Native/build current files

- Six split C sources/headers — production addon, shared errno map, test hooks,
  and standalone errno test.
- `native/toolchain-allowlist.json` — Task-4-owned closed tool policy with
  complete concrete `amd64`/`arm64` Docker-init identity tuples.
- `scripts/run-native-build.mjs` — umask/build-root/flock owner.
- `scripts/build-native.mjs` — direct compiler/linker, depfile parsing, complete
  tool/input attestations, fixed atomic outputs, unconditional rebuild.
- `src/atomic-directory-publication-native.ts` — fixed artifact/checksum/ELF/
  ABI loader used only by reconciliation and isolated preflight.
- `scripts/check-atomic-publication-rollback.mjs` — offline read-only rollback
  blocker for unresolved native state.

### Deferred ownership, not implemented by this plan

- Master Task 6: `server.ts`, `index.ts`, Dockerfile/tests, init script/tests,
  image metrics wiring, rollback checker copy, UID/mount/init acceptance.
- Master Task 14: Compose/env/wrapper/harness files, init-service sequencing,
  API-no-mount topology, named-volume restart, rollback invocation, and final
  `LOCAL_BROWSER_SERVICE_ENABLED=true` commit.

---

### Task 1: Build and load the split native boundary deterministically

**Files:**
- Create: `apps/browser-service/native/atomic-directory-publication-addon.c`
- Create: `apps/browser-service/native/atomic-directory-publication-errors.c`
- Create: `apps/browser-service/native/atomic-directory-publication-errors.h`
- Create: `apps/browser-service/native/atomic-directory-publication-test-hooks.c`
- Create: `apps/browser-service/native/atomic-directory-publication-test-hooks.h`
- Create: `apps/browser-service/native/atomic-directory-publication-errors.test.c`
- Create: `apps/browser-service/native/toolchain-allowlist.json`
- Create: `apps/browser-service/scripts/run-native-build.mjs`
- Create: `apps/browser-service/scripts/run-native-build.test.mjs`
- Create: `apps/browser-service/scripts/build-native.mjs`
- Create: `apps/browser-service/scripts/build-native.test.mjs`
- Create: `apps/browser-service/src/atomic-directory-publication-native.ts`
- Create: `apps/browser-service/src/atomic-directory-publication-native.test.ts`
- Modify: `apps/browser-service/src/runtime-preflight.mjs`
- Modify: `apps/browser-service/src/runtime-preflight.test.mjs`
- Modify: `apps/browser-service/package.json`
- Modify: `.gitignore`

- [ ] **Step 1: Write build-runner, compiler, loader, and preflight tests**

Use valid Node assertions only:

```js
assert.equal(result.status, 0);
assert.deepEqual(Object.keys(native).sort(), [
  "interfaceVersion", "napiVersion", "renameNoReplace",
]);
assert.equal(native.interfaceVersion, "1.0.0");
assert.equal(native.napiVersion, 8);
assert.equal(typeof native.renameNoReplace, "function");
assert.throws(
  () => validateAtomicNativeModuleShape(corruptFixture),
  /native artifact/i,
);
```

Test exact Linux `x64|arm64` acceptance and rejection of Darwin, Windows,
Linux ia32/riscv64, wrong Node, caller compiler variables, missing headers,
foreign compiler, missing/wrong flock, malformed allowlist, direct compiler
script invocation, concurrent runner serialization, lock timeout, killed-run
staging recovery, and symlink/foreign-owner build entries.

Lock tests require no-follow open of the exact lock leaf with numeric
`O_RDWR|O_CREAT|O_NOFOLLOW`, `0600`, then regular-file/current-uid/mode/link-
count-one proof. Assert `/usr/bin/flock --no-fork --exclusive --timeout 60 9
<real-node22> scripts/build-native.mjs <target>`, exact
`ATOMIC_BUILD_LOCK_FD=9`, and Node `stdio` of stdin `ignore`, stdout/stderr
`inherit`, fds 3..8 `ignore`, fd 9 mapped from the held lock. Every spawned
probe/compiler/linker/test/loader child must map fd 9 to child fd 9; real exec
probes prove it exists with `FD_CLOEXEC` clear in build script, compiler driver,
and pinned subtool.

Use a deterministic inherited-pipe barrier: compiler driver forks/execs a
descendant retaining fd 9, then tests SIGKILL runner, build script, and driver
variants. A contender must time out with zero staging inspection/removal until
the descendant signals exit and closes fd 9; it then acquires, discards exact
stale staging, and fully rebuilds. Driver failure spawns nothing later and
leaves staging untouched for the next lock owner.

`native/toolchain-allowlist.json` tests require exact top-level
`schemaVersion:1` and `dockerInit`, with only concrete `amd64` and `arm64`
tuples. Each tuple has exactly `targetArch`, `nodeBaseRepository`,
`nodeBaseIndexDigest`, `nodeBasePlatformDigest`, `osReleaseSha256`,
`dpkgArchitecture`, `utilLinuxPackage`, `utilLinuxVersion`, `flockRealpath`,
and `flockSha256`. Require immutable OCI digests, bare byte hashes, architecture
agreement, `util-linux`, and `/usr/bin/flock`; reject template/default/
wildcard/extra/duplicate/mutable tuples. Isolated Docker probes for both
platforms prove index/platform identity, exact `/etc/os-release` bytes, dpkg
architecture/package version, canonical flock path, and flock bytes. Task 1
cannot pass or commit until both real tuples and probe evidence pass.

Assert separate translation-unit argv and unique depfiles:

```text
production/addon.o       production/addon.d
production/errors.o      production/errors.d
test/addon.o             test/addon.d
test/errors.o            test/errors.d
test/test-hooks.o        test/test-hooks.d
errno-test/main.o             errno-test/main.d
errno-test/errors-alias.o     errno-test/errors-alias.d
errno-test/errors-distinct.o  errno-test/errors-distinct.d
```

Every listed path is relative to fixed staging root
`build/.atomic-directory-publication-stage/`, never final `build/obj`,
`build/Release`, or `build/Test`. Compiler/linker spy tests require every
selected source compile exactly once and every selected output link exactly
once on each run. Run two consecutive builds with identical inputs and matching
finals; reset counters between runs and assert the complete compile/link graph
again on the second run—no attestation/cache/skip branch is accepted.

Spies require every declared staging leaf O_EXCL-created, verified, fsynced,
renamed once to its final leaf, then both parents synced. Reject final-path
compiler/linker output, response files, undeclared output, or abstract trace
capture. Inject failure/crash at every compile, link, validation, fsync,
per-leaf rename, and checksum-last boundary; assert old finals remain usable or
prestart rejects mixed state. Next lock owner must discard exact staging and
fully rebuild, while foreign staging fails without deletion or spawn.

Addon compile argv is ordered
`-fPIC -std=c11 -DNAPI_VERSION=8 -Wall -Wextra -Werror -O2 -MD`, one derived
Node include, unique `-MF`, `-c`, source, `-o`, object. Test objects add only
`-DATOMIC_PUBLISH_TEST_HOOKS=1`. Errno executable objects omit Node include and
test macro. Assert three separate link commands and outputs:

```text
build/Release/atomic_directory_publication.node
build/Test/atomic_directory_publication_test.node
build/Test/atomic-directory-publication-errors.test
```

Test every errno mapping with one standalone executable linked from the test
main plus two separately compiled shared-map objects. Compile the alias object
with exact macros `-DATOMIC_PUBLISH_ERRNO_VARIANT_ALIAS=1` and
`-Datomic_publish_map_errno=atomic_publish_map_errno_alias`; compile the distinct
object with exact macros `-DATOMIC_PUBLISH_ERRNO_VARIANT_DISTINCT=1` and
`-Datomic_publish_map_errno=atomic_publish_map_errno_distinct`. Each variant macro
supplies its own synthetic `ENOTSUP`/`EOPNOTSUPP` values, rejects both/neither
macros, and exercises the real conditional case graph without duplicate C
cases. `main.o` calls both renamed symbols and requires identical unsupported
mapping for alias and distinct constants. Production and test addons expose
the same exact three properties; test barriers use inherited fds only.

Production loader always resolves its package-relative fixed Release artifact
and accepts no path, environment selector, or test hook. Shape failures call
the exported pure validator directly. Artifact/checksum/path corruption tests
spawn a child from a copied package fixture whose own fixed `build/Release`
contains the corrupt bytes; they never pass a path argument to production.
Test-hook integration may load the fixed Test artifact only inside its spawned
barrier child; that test-only loader is not exported or reachable in runtime.

- [ ] **Step 2: Run RED**

```bash
export PATH=/home/mamba/.nvm/versions/node/v22.22.1/bin:$PATH
cd apps/browser-service
node --test scripts/run-native-build.test.mjs scripts/build-native.test.mjs src/runtime-preflight.test.mjs
corepack pnpm exec vitest run src/atomic-directory-publication-native.test.ts
```

Expected: FAIL because native sources, runner, compiler script, loader, and
revised preflight do not exist.

- [ ] **Step 3: Implement runner and unconditional direct build**

Production addon exposes exactly `interfaceVersion`, `napiVersion`, and
`renameNoReplace(sourceDirectoryFd, sourceLeaf, targetDirectoryFd,
targetLeaf)`. It accepts exactly four arguments, signed nonnegative 32-bit fds,
and 1..128-byte ASCII leaves matching
`[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?`; independently reject NUL, slash,
backslash, `.`, and `..`. It `fstat`s both directory fds, requires equal device,
requires equal available `STATX_MNT_ID`, and invokes only
`renameat2(..., RENAME_NOREPLACE)`. Return `undefined` only on success and
expose stable code without raw errno/path/fd text. Test hooks bracket the real
syscall on inherited fds and add no export or runtime selector.

`run-native-build.mjs` accepts only `production|all`, sets umask `0077`, creates
exact `build/` with Node APIs, no-follow opens exact lock leaf with numeric
`O_RDWR|O_CREAT|O_NOFOLLOW` and mode `0600`, and proves the locked record shape
from Step 1. Verify fixed `/usr/bin/flock` plus `--no-fork`, then spawn this
exact argv with no shell:

```text
/usr/bin/flock --no-fork --exclusive --timeout 60 9
<real-node22> scripts/build-native.mjs <production|all>
```

Set exact `ATOMIC_BUILD_LOCK_FD=9`. Spawn stdio is `["ignore", "inherit",
"inherit", "ignore", "ignore", "ignore", "ignore", "ignore", "ignore",
heldLockFd]`. Retain the parent duplicate until child termination, then
verified-close it. Locked `build-native.mjs` rejects before mutation unless env
is exactly `9`, `fstatSync(9)` matches the runner record, and `/proc/self/fd/9`
exists. It propagates fd 9 at index 9 through every descendant, with 3..8
ignored; neither script closes fd 9.

Every build-script spawn declares its whole stdio array: stdin `ignore`, fds
3..8 `ignore`, fd 9 mapped to inherited 9. Probe/compile/test/loader stdout and
stderr use their specified bounded pipes. Link stderr uses bounded diagnostics,
while link stdout alone is the exact pre-opened O_EXCL trace fd. No child
inherits an undeclared descriptor.

`build-native.mjs` rejects direct invocation outside the runner. Select exact
`/usr/bin/gcc` when it is an executable regular file, or only if absent resolve
exact `/usr/bin/cc` from inherited fixed `PATH`, canonicalize its realpath,
require that realpath under `/usr/bin`, and bind its bytes/version. Derive
headers only from real Node 22
`process.execPath`. Compile every selected translation unit and relink every
selected output on every run; attestations are never cache keys.

Under the lock require fixed staging root
`build/.atomic-directory-publication-stage/` absent, then create it and exact
`obj/production`, `obj/test`, `obj/errno-test`, `Release`, and `Test`
directories no-follow at `0700`. Pre-create every selected object, depfile,
addon/binary, map, trace, input sidecar, and checksum staging leaf with numeric
`O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW`, mode `0600` except errno executable
`0700`. Verify every leaf. Close non-trace leaves before child execution; retain
each trace leaf's original fd only as its linker's stdout. Create/validate final
directories as owned no-follow `0700` and fsync `build/` before child spawn.
No child receives a final path in `-MF`, `-o`, map, trace, open, truncate, or
write authority.

Parse every `-MD` dependency including continuations/escaping. Reject missing,
duplicate, or dependencies outside repository native sources, Node header root,
`/usr/include`, and GCC canonical include root. Hash compiler/Node/runner/
builder/allowlist bytes, exact argv, dependencies, GCC specs/search/runtime,
`cc1|as|collect2|ld`, link maps/traces and resolved inputs, and ELF needs.
Required tool/trace/needed-library paths must be readable and resolvable.

Compiler tests compare these exact argv arrays after `nodeInclude` is derived:

```ts
const S = "build/.atomic-directory-publication-stage";
const productionAddon = [
  compiler, "-fPIC", "-std=c11", "-DNAPI_VERSION=8",
  "-Wall", "-Wextra", "-Werror", "-O2", "-MD",
];
const testAddon = [
  compiler, "-fPIC", "-std=c11", "-DNAPI_VERSION=8",
  "-DATOMIC_PUBLISH_TEST_HOOKS=1",
  "-Wall", "-Wextra", "-Werror", "-O2", "-MD",
];
const errno = [
  compiler, "-std=c11", "-Wall", "-Wextra", "-Werror",
  "-O2", "-MD",
];
const compileCommands = [
  [...productionAddon, "-I", nodeInclude,
    "-MF", `${S}/obj/production/addon.d`, "-c", addonSource,
    "-o", `${S}/obj/production/addon.o`],
  [...productionAddon, "-I", nodeInclude,
    "-MF", `${S}/obj/production/errors.d`, "-c", errorsSource,
    "-o", `${S}/obj/production/errors.o`],
  [...testAddon, "-I", nodeInclude,
    "-MF", `${S}/obj/test/addon.d`, "-c", addonSource,
    "-o", `${S}/obj/test/addon.o`],
  [...testAddon, "-I", nodeInclude,
    "-MF", `${S}/obj/test/errors.d`, "-c", errorsSource,
    "-o", `${S}/obj/test/errors.o`],
  [...testAddon, "-I", nodeInclude,
    "-MF", `${S}/obj/test/test-hooks.d`, "-c", testHooksSource,
    "-o", `${S}/obj/test/test-hooks.o`],
  [...errno, "-MF", `${S}/obj/errno-test/main.d`,
    "-c", errnoMainSource, "-o", `${S}/obj/errno-test/main.o`],
  [...errno, "-DATOMIC_PUBLISH_ERRNO_VARIANT_ALIAS=1",
    "-Datomic_publish_map_errno=atomic_publish_map_errno_alias",
    "-MF", `${S}/obj/errno-test/errors-alias.d`, "-c", errorsSource,
    "-o", `${S}/obj/errno-test/errors-alias.o`],
  [...errno, "-DATOMIC_PUBLISH_ERRNO_VARIANT_DISTINCT=1",
    "-Datomic_publish_map_errno=atomic_publish_map_errno_distinct",
    "-MF", `${S}/obj/errno-test/errors-distinct.d`, "-c", errorsSource,
    "-o", `${S}/obj/errno-test/errors-distinct.o`],
];
```

`addonSource`, `errorsSource`, `testHooksSource`, and `errnoMainSource` are
canonical real source paths inside `native/`; argv assertions compare those
exact strings, not abbreviated paths.

Link with exact fixed argv, after replacing `compiler` with the selected exact
path:

```ts
const links = [
  [compiler, "-shared",
    `-Wl,-Map,${S}/Release/atomic_directory_publication.map`,
    "-Wl,--trace", `${S}/obj/production/addon.o`,
    `${S}/obj/production/errors.o`, "-o",
    `${S}/Release/atomic_directory_publication.node`],
  [compiler, "-shared",
    `-Wl,-Map,${S}/Test/atomic_directory_publication_test.map`,
    "-Wl,--trace", `${S}/obj/test/addon.o`,
    `${S}/obj/test/errors.o`, `${S}/obj/test/test-hooks.o`, "-o",
    `${S}/Test/atomic_directory_publication_test.node`],
  [compiler,
    `-Wl,-Map,${S}/Test/atomic-directory-publication-errors.map`,
    "-Wl,--trace", `${S}/obj/errno-test/main.o`,
    `${S}/obj/errno-test/errors-alias.o`,
    `${S}/obj/errno-test/errors-distinct.o`, "-o",
    `${S}/Test/atomic-directory-publication-errors.test`],
];
```

For those three link commands, stdout is respectively the already-open O_EXCL
fd for `${S}/Release/atomic_directory_publication.trace`,
`${S}/Test/atomic_directory_publication_test.trace`, and
`${S}/Test/atomic-directory-publication-errors.trace`; stderr is bounded
diagnostic capture. Tests assert exact argv, stdio fd identity, nonempty map/
trace, declared outputs, and zero undeclared staging leaves. The build script
executes/loads verified staging outputs, and after publication repeats checks
on finals; no load command may reuse an earlier invocation's artifact.

Write all tool inventory inside only these three staging sidecars—never an
inventory leaf:

```text
Release/atomic_directory_publication.inputs.sha256
Test/atomic_directory_publication_test.inputs.sha256
Test/atomic-directory-publication-errors.test.inputs.sha256
```

Each is canonical UTF-8 JSON plus newline with exactly ordered top-level keys
`schemaVersion`, `output`, `compileArgv`, `linkArgv`, `dependencies`, `scripts`,
`node`, `compiler`, `driverProbes`, `subtools`, `linkInputs`, `needed`, and
`toolchainAllowlistSha256`. Lock exact nested schemas: `schemaVersion:1`;
`output` exact kind/final relative path/staging relative path/SHA-256;
execution-order argv arrays; raw-UTF-8-path-sorted canonical path/hash objects;
Node real executable/hash/version/N-API/header root/required-header hashes;
compiler real path/hash/version-bytes hash/dumpmachine/dumpfullversion; exactly
three `-dumpspecs`, `-print-search-dirs`, and `-print-libgcc-file-name` output
hashes; `cc1|as|collect2|ld` fixed-order path/
hash/version-output-hash entries; all trace-resolved link inputs; all ELF
sonames with resolved canonical path/hash; and allowlist byte hash. Sort
`linkInputs` by raw UTF-8 canonical path and `needed` by raw UTF-8 resolved path
then soname. Reject
unknown/missing/duplicate/null/unreadable fields, noncanonical ordering/JSON/
newline, digest mismatch, or any inventory filename in staging recovery.

After every child, no-follow verify each declared staging leaf's regular-file/
uid/link-count/mode and unchanged root chain, validate shapes/hashes, fsync and
verified-close leaves, then fsync staging directories bottom-up. Only a wholly
valid selected graph publishes. Rename one leaf at a time on the same
filesystem, immediately syncing both held source and destination directories,
in fixed order: objects, depfiles, maps, traces, input sidecars; errno binary
and test addon; production addon; runtime checksum last. Reopen/verify finals,
rerun final errno/addon checks, remove empty staging directories bottom-up, and
fsync `build/`. This is atomic per leaf; checksum-last is the production
generation commit marker.

On locked startup, absent staging begins fresh. Present staging is never
resumed: validate the exact finite crash-prefix grammar, current uid/modes,
regular link-count-one leaves, and no unknown/hard-link/special/symlink content;
then remove the entire stale generation bottom-up and fsync `build/`. Foreign
state fails without deletion or compiler spawn. Before first child, failure may
remove only verified current staging. After any child spawn, nonzero/signal/
validation/publication failure spawns nothing else and leaves staging for the
next lock owner—never race-cleaning an orphan. Per-leaf crash can leave mixed
final audit/binary leaves, but cannot publish checksum early; prestart rejects,
and the next owner discards staging and performs a full unconditional rebuild.

Production also writes exact canonical runtime attestation:

```json
{"interfaceVersion":"1.0.0","napiVersion":8,"sha256":"<64 lowercase hex>"}
```

One final newline is required. Compute the hash from verified staging addon
bytes, write/fsync the pre-created staging checksum, then publish addon followed
by checksum. Prestart treats checksum as the last-published generation marker,
hashes addon bytes, and verifies attestation before ELF/ABI/load checks. It
never requires compiler, headers, flock, or build-only attestations.

Patch only these script keys; do not replace the `scripts` object:

```json
{
  "preinstall": "node src/runtime-preflight.mjs --phase=preinstall",
  "build:native": "node scripts/run-native-build.mjs production",
  "build:native:test": "node scripts/run-native-build.mjs all",
  "test:native": "node scripts/run-native-build.mjs all",
  "install": "node scripts/run-native-build.mjs production",
  "prebuild": "node scripts/run-native-build.mjs production",
  "pretest": "node scripts/run-native-build.mjs all",
  "prestart": "node src/runtime-preflight.mjs --phase=prestart"
}
```

Preserve existing `build: "tsc -p tsconfig.json"`,
`start: "node dist/index.js"`, `test:bootstrap`, and `test` keys byte-for-byte,
along with every unrelated script and package metadata field. The new
`prebuild` compiles native code before the preserved `pnpm build` TypeScript
command; `pretest` does the same before the preserved bootstrap/Vitest command.
Preserve existing dependencies and lockfile unchanged.
Add only `/apps/browser-service/build/` to `.gitignore` for generated native
outputs.

- [ ] **Step 4: Run GREEN with build-before-load**

```bash
export PATH=/home/mamba/.nvm/versions/node/v22.22.1/bin:$PATH
cd apps/browser-service
node scripts/run-native-build.mjs all
node --test scripts/run-native-build.test.mjs scripts/build-native.test.mjs src/runtime-preflight.test.mjs src/lockfile.test.mjs
node --test --test-name-pattern='proves concrete amd64 and arm64 dockerInit tuples' scripts/build-native.test.mjs
node scripts/run-native-build.mjs all
corepack pnpm exec vitest run src/atomic-directory-publication-native.test.ts
node scripts/run-native-build.mjs production
node src/runtime-preflight.mjs --phase=prestart
corepack pnpm build
```

Expected: standalone errno runner exits zero; runner/build/preflight/loader
tests PASS; both concrete Docker-init platform probes PASS without skip; both
addon shapes PASS; runtime checksum PASS; build PASS.

- [ ] **Step 5: Review and commit exact Task 1 files**

Run requirements review, then quality review. Fix through same implementer and
repeat GREEN plus both reviews until both pass.

```bash
git add .gitignore apps/browser-service/native/atomic-directory-publication-addon.c apps/browser-service/native/atomic-directory-publication-errors.c apps/browser-service/native/atomic-directory-publication-errors.h apps/browser-service/native/atomic-directory-publication-test-hooks.c apps/browser-service/native/atomic-directory-publication-test-hooks.h apps/browser-service/native/atomic-directory-publication-errors.test.c apps/browser-service/native/toolchain-allowlist.json apps/browser-service/scripts/run-native-build.mjs apps/browser-service/scripts/run-native-build.test.mjs apps/browser-service/scripts/build-native.mjs apps/browser-service/scripts/build-native.test.mjs apps/browser-service/src/atomic-directory-publication-native.ts apps/browser-service/src/atomic-directory-publication-native.test.ts apps/browser-service/src/runtime-preflight.mjs apps/browser-service/src/runtime-preflight.test.mjs apps/browser-service/package.json
git diff --cached --name-only
apps/api/.husky/_/pre-commit
git diff --cached --name-only
git diff --cached --check
git commit -m "feat: build atomic publication addon" -m "Compile split native sources with the fixed host toolchain and attest
every dependency, tool, link input, and runtime artifact.

Serialize unconditional builds and reject incompatible runtime loading."
```

Expected cached names: exactly the 17 Task 1 paths; no original Task 4 file.

### Task 2: Implement pure lifecycle and authenticated manifest codecs

**Files:**
- Create: `apps/browser-service/src/atomic-publication-manifest.ts`
- Create: `apps/browser-service/src/atomic-publication-manifest.test.ts`

- [ ] **Step 1: Write closed-codec RED tests**

Lock the manifest return type so parsing never drops authentication fields:

```ts
export type CleanupIdentityManifestV1 = Readonly<{
  version: 1;
  operationId: CanonicalUuid;
  binding: Readonly<{
    processNonce: string;
    controlGenerationNonce: string;
    snapshotDigest: Sha256;
  }>;
  targetLocatorDigest: Sha256;
  entries: readonly CleanupIdentityEntryV1[];
}>;

export function parseCleanupIdentityManifest(
  bytes: Uint8Array,
): CleanupIdentityManifestV1;

export function encodeCleanupIdentityManifest(
  manifest: CleanupIdentityManifestV1,
): Readonly<{ bytes: Buffer; sha256: Sha256; entryCount: number }>;
```

Also test exact `AtomicPublishIntentV1`, `PublicationTargetV1`, phase table,
wrapper grammar, source/adoption/nullability combinations, native normalized
codes, immutable-field inheritance, and canonical intent bytes.

Reject BOM, duplicate/unknown key, non-NFC, unsafe number, noncanonical UUID/
decimal/SHA, invalid mode, kind-target mismatch, skipped/backward phase,
manifest binding mismatch, noncontiguous index, duplicate/prefix/type conflict,
bad postorder/raw-UTF-8 order, path/segment/depth/entry/byte plus-one, and any
flight semantic/effect/partial ID in durable bytes.

- [ ] **Step 2: Run RED**

```bash
export PATH=/home/mamba/.nvm/versions/node/v22.22.1/bin:$PATH
cd apps/browser-service
corepack pnpm exec vitest run src/atomic-publication-manifest.test.ts
```

Expected: FAIL because pure codec module does not exist.

- [ ] **Step 3: Implement pure codecs**

No filesystem, native, reconciliation, startup, ProfileStore, Registry, or
WeakMap import is allowed. Reuse canonical UUID/SHA/path constants exactly.
Intent maximum is 16 KiB. Manifest maximum is 25,000 entries and 33,554,432
bytes; path maximum is 1,024 UTF-8 bytes, 64 segments, 255 bytes per segment.
Fixed-key canonical JSON has no whitespace and exactly one final newline.

- [ ] **Step 4: Run GREEN, review, and commit**

```bash
export PATH=/home/mamba/.nvm/versions/node/v22.22.1/bin:$PATH
cd apps/browser-service
corepack pnpm exec vitest run src/atomic-publication-manifest.test.ts
corepack pnpm build
cd ../..
git add apps/browser-service/src/atomic-publication-manifest.ts apps/browser-service/src/atomic-publication-manifest.test.ts
git diff --cached --name-only
apps/api/.husky/_/pre-commit
git diff --cached --name-only
git diff --cached --check
git commit -m "feat: define atomic publication records" -m "Encode complete intent and cleanup-manifest authority with closed
canonical schemas and exhaustive monotonic phase validation.

Reject malformed durable state before any recovery effect can run."
```

Expected: focused tests/build/reviews PASS; cached names equal two files.

### Task 3: Establish pure effect protocol and reconciliation ownership

**Files:**
- Create: `apps/browser-service/src/atomic-directory-publication.ts`
- Create: `apps/browser-service/src/atomic-directory-publication.test.ts`
- Modify: `apps/browser-service/src/reconciliation.ts`
- Modify: `apps/browser-service/src/reconciliation.test.ts`

This bridge must be GREEN before mount, publication, cleanup, or recovery
reducers are implemented.

- [ ] **Step 1: Write reducer/protocol/controller RED tests**

Define the committed spec's exact closed unions
`AtomicEffectKindV1`, `AtomicEffectRequestV1`, and
`AtomicEffectObservationV1`. Lock reducer interface:

```ts
export type AtomicReducerStepV1 =
  | Readonly<{
      kind: "effect";
      state: AtomicReducerStateV1;
      request: AtomicEffectRequestV1;
    }>
  | Readonly<{
      kind: "terminal";
      state: AtomicReducerStateV1;
      result: AtomicTerminalResultV1;
    }>;

export function reduceAtomicPublication(
  state: AtomicReducerStateV1,
  observation: AtomicEffectObservationV1 | null,
): AtomicReducerStepV1;
```

Test exactly one outstanding effect; matching effect ID/request kind; rejection
of unknown, duplicate, replayed, out-of-order, or mismatched observation; no
batch/hidden continuation; 256-entry/65,536-byte directory observations;
65,536 decoded-byte file chunks; monotonic cursor and reserved-before-read.

Test composite `create_and_pin_*`: one `create_and_pin_completed` observation,
no following open; `create_and_pin_partial` mints one-use
`FlightPartialCreateId`; next reducer output must be
`cleanup_partial_create`. Only `partial_create_cleanup_observed` with
`absent/parentSynced:true` resumes. `partial_create_cleanup_failed` at close,
identity, remove, absence, or fsync closes admission and retains partial record
and reservation. Cap semantic plus partial IDs at 4,096 and partial IDs at
1,024.

Test held-procfd startup and adapter exactly. Preflight rejects missing or
inaccessible `/proc/self/fd`, non-procfs `statfsSync` type, fd-probe identity
mismatch, and unsupported Node operations with readiness false and no pathname
or addon fallback. Require `0x9fa0n`, numeric
`O_RDONLY|O_DIRECTORY|O_NOFOLLOW`, verified probe close, and equal procfd
`statSync` versus root `fstatSync` dev/ino/type. Adapter spies prove a
synchronous full-chain gate before and after every awaited filesystem call,
including rejection. Cover control leaves at 1/128 ASCII bytes, payload leaves
at 1/255 NFC UTF-8 bytes, round-trip failure, NUL, slash, backslash, empty,
`.`/`..`, and multi-segment rejection before I/O.

Lock exact create/open/remove sequences: directory
`mkdir(recursive:false,0700)`→numeric no-follow directory open→bigint stat;
file/temp numeric `O_RDWR|O_CREAT|O_EXCL|O_NOFOLLOW`→bigint stat; existing
directory/file numeric no-follow open→bigint stat; and removal
`lstat`→numeric open→`fstat`→identity compare→immediate `lstat`→`unlink` or
empty-directory `rmdir`→verified close→absence proof→held-parent sync. Only
then may `removal_observed` report the removed ID/full evidence,
`state:"absent"`, and `parentSynced:true`. Reject string flags, `rm`, recursive
removal/creation, second opens, retained procfd strings/fd numbers, or raw Node
`SystemError` leakage. Unknown errno closes admission with one constant,
path-free error and no `cause`.

Test import direction and ownership: atomic module imports no reconciliation,
startup, ProfileStore, Registry, fs, or native loader. Reconciliation owns all
WeakMaps and raw handles. Opaque `AnchoredRoot`, `BoundGeneration`, and
`PreReadyRecoveryAuthority` never enter reducer input/output.

- [ ] **Step 2: Run RED**

```bash
export PATH=/home/mamba/.nvm/versions/node/v22.22.1/bin:$PATH
cd apps/browser-service
node scripts/run-native-build.mjs all
corepack pnpm exec vitest run src/atomic-directory-publication.test.ts src/reconciliation.test.ts
```

Expected: FAIL because reducer/effect protocol and reconciliation controller
bridge do not exist.

- [ ] **Step 3: Implement pure reducer skeleton**

Reducer state contains durable bytes, flight nonce, step counter, semantic
data IDs, outstanding request, bounds, and cursor only. It owns no WeakMap and
performs no I/O. Effect IDs derive from flight nonce plus step counter.
Semantic IDs may originate only in initial authority input or typed controller
observations; reducer never constructs one.

- [ ] **Step 4: Implement reconciliation controller and shared machinery bridge**

Keep every WeakMap in `reconciliation.ts`:

```ts
type AtomicHeldRecord = Readonly<{
  role: AtomicObjectRoleV1;
  operationId: string;
  parentId: FlightSemanticId | null;
  leaf: string | null;
  handle: FileHandle;
  binding: ReadyProfileRootBinding;
  evidence: AtomicObjectEvidenceV1;
}>;

type ApplyAtomicEffectV1 = (
  request: AtomicEffectRequestV1,
) => Promise<AtomicEffectObservationV1>;
```

Create one private registry/epoch per flight. Unknown/foreign/stale IDs reject
before effect. Controller performs only the single requested effect.

Implement the reconciliation-owned held-procfd adapter; Node exposes no
`mkdirat`, `openat`, or `unlinkat` API. Resolve the already-held parent, validate
one role-specific strict leaf, and construct
`/proc/self/fd/<held-parent-fd>/<strict-leaf>` only in the stack frame around
one awaited Node operation. Never store the numeric fd separately or retain,
return, capture, log, persist, export, or place the procfd string in a request,
observation, or long-lived closure. Nested traversal requires another held
parent ID plus one leaf.

Before reducer admission, run the exact procfs preflight described in Step 1.
Around every awaited filesystem operation run synchronous full-chain
validation over admission, all volume→state→operation records, role/parent/
operation linkage, and `fstatSync` dev/ino/type/mode; run the post gate in a
`finally` path even when the operation rejects. Create/open with only the
numeric flags and sequences locked above. Reads, writes, enumeration, hashing,
and fsync use the already-held handles and never reconstruct a pathname.

For every logical removal, require lstat/fstat/registry/request full evidence
to match, repeat lstat immediately before mutation, call only
`fs.promises.unlink` or `fs.promises.rmdir`, verify pin close, prove absence,
then sync the already-held parent before emitting `removal_observed`. Any stage
failure fails closed without phase/cursor success. Map only allowlisted errno
inside the effect frame and discard the original `SystemError`.

Composite create returns one observation after the exact procfd create/open/
stat sequence. Partial cleanup closes its partial pin when present, verifies
the canonical leaf through the same adapter, performs the exact identity-bound
unlink/rmdir sequence, proves absence, and syncs parent. It never claims an
`*at` JavaScript operation. Cleanup failure retains the one-use partial ID,
record, and reservation.

Reuse Task 3's private `Budget`, held walker, fixed encoder, file/tree hash,
evidence comparison, EOF, tombstone, and close machinery directly inside the
controller. Do not create a second hash/checksum/path implementation and do not
make the atomic reducer import reconciliation. Tests require one implementation
identity: `reconciliation-private-held-profile-hash`.

Before first reducer call, acquire only held trusted volume→state→profiles and
staging authority and construct reconciliation-owned fieldless
`PreReadyRecoveryAuthority`. Do not enumerate/read operation state yet.

- [ ] **Step 5: Run GREEN, review, and commit**

```bash
export PATH=/home/mamba/.nvm/versions/node/v22.22.1/bin:$PATH
cd apps/browser-service
node scripts/run-native-build.mjs all
corepack pnpm exec vitest run src/atomic-directory-publication.test.ts src/reconciliation.test.ts
corepack pnpm build
cd ../..
git add apps/browser-service/src/atomic-directory-publication.ts apps/browser-service/src/atomic-directory-publication.test.ts apps/browser-service/src/reconciliation.ts apps/browser-service/src/reconciliation.test.ts
git diff --cached --name-only
apps/api/.husky/_/pre-commit
git diff --cached --name-only
git diff --cached --check
git commit -m "feat: own atomic effects in reconciliation" -m "Add a pure single-effect reducer while reconciliation alone resolves
held handles, semantic IDs, partial creates, and recovery authority.

Reuse Task 3 canonical evidence without exposing descriptors or paths."
```

Expected: protocol/controller/shared-hash tests/build/reviews PASS; cached names
equal four files. This is first allowed commit of reconciliation pair.

### Task 4: Add mount proof and recoverable parent canaries

**Files:**
- Modify: `apps/browser-service/src/atomic-directory-publication.ts`
- Modify: `apps/browser-service/src/atomic-directory-publication.test.ts`
- Create: `apps/browser-service/src/atomic-directory-publication.integration.test.ts`
- Modify: `apps/browser-service/src/reconciliation.ts`
- Modify: `apps/browser-service/src/reconciliation.test.ts`

- [ ] **Step 1: Write mount/canary RED tests**

Test exact statfs allowlist, equal device, native statx mount proof, preflight
positive/conflict canaries, one unresolved attempt-zero canary per target
parent, fresh restart proof, same-attempt publication/cleanup `ENOENT`, raw
source-missing followed by separate `observe_locations`, and every invalid
phase/attempt/identity/location tuple closing admission.

Host integration uses only unprivileged claims: current allowlisted filesystem,
real native positive/conflict, concurrent same-parent canary serialization,
SIGKILL at test-hook pre/post syscall barriers with inherited fds, and fresh
process recovery. Also cover many concurrent profile publishers with one
complete winner, real EEXIST, invalid/closed/non-directory fd, invalid leaf,
noncanary missing source, and exact raw stable codes. Do not claim different
UID, denied/read-only mount, cross-mount, same-device bind mount, NFS/CIFS/FUSE,
or privileged mutation here; those are deferred Task 6 Docker harness cases.

- [ ] **Step 2: Run RED with unconditional rebuild first**

```bash
export PATH=/home/mamba/.nvm/versions/node/v22.22.1/bin:$PATH
cd apps/browser-service
node scripts/run-native-build.mjs all
corepack pnpm exec vitest run --no-file-parallelism src/atomic-directory-publication.test.ts src/atomic-directory-publication.integration.test.ts src/reconciliation.test.ts
```

Expected: FAIL because mount/canary reducer states and effects are absent.

- [ ] **Step 3: Implement mount/canary slice**

Use explicit reducer effects for revalidation and controller `statfs`; statx
remains inside requested native call. Native request returns only
`native_resolved`; reducer then requests `observe_locations`. Canonical
classification only accepts source-match/target-absent, source-match/
target-other, or source-absent/target-match. Both/neither/mismatch is ambiguous.

Canary cleanup first persists `deleting`, requests protected-public native move
to `deletion-<operation-id>-0`, proves locations, syncs both parents, then uses
manifest cursor. Cleaned canary cannot prove later work.

- [ ] **Step 4: Run GREEN, review, and commit**

```bash
export PATH=/home/mamba/.nvm/versions/node/v22.22.1/bin:$PATH
cd apps/browser-service
node scripts/run-native-build.mjs all
corepack pnpm exec vitest run --no-file-parallelism src/atomic-directory-publication.test.ts src/atomic-directory-publication.integration.test.ts src/reconciliation.test.ts
corepack pnpm build
cd ../..
git add apps/browser-service/src/atomic-directory-publication.ts apps/browser-service/src/atomic-directory-publication.test.ts apps/browser-service/src/atomic-directory-publication.integration.test.ts apps/browser-service/src/reconciliation.ts apps/browser-service/src/reconciliation.test.ts
git diff --cached --name-only
apps/api/.husky/_/pre-commit
git diff --cached --name-only
git diff --cached --check
git commit -m "feat: prove atomic publication mounts" -m "Validate allowlisted held parents and recover each target-parent canary
through explicit native and location-observation effects.

Normalize only authenticated same-attempt canary replay."
```

Expected: mount/canary/native crash tests/build/reviews PASS; five cached files.

### Task 5: Implement private construction and profile publication

**Files:**
- Modify: `apps/browser-service/src/atomic-directory-publication.ts`
- Modify: `apps/browser-service/src/atomic-directory-publication.test.ts`
- Modify: `apps/browser-service/src/atomic-directory-publication.integration.test.ts`
- Modify: `apps/browser-service/src/reconciliation.ts`
- Modify: `apps/browser-service/src/reconciliation.test.ts`

- [ ] **Step 1: Write publication RED tests**

Cover allocated→building→ready→classified→renamed→manifest states; reservation
before every await/effect; composite private wrapper/directory/file/temp create;
payload chunk copy/write/hash; file sync; postorder directory sync; initial
intent/manifest native publication; later intent replacement; profile scaffold
with exact empty `working|staging|committed`; working publication; EEXIST
conflict; mandatory post-call proof; and no public mkdir/pathname fallback.
Keep public ProfileStore prepare/finalize integration deliberately unwired and
RED until Task 6 completes protected source deletion; Task 5 proves only the
private construction/publication protocol slice, never complete user-visible
prepare/finalize behavior.

Lock persistence authority structurally. Each `persist_intent` and
`persist_manifest` request carries effect/operation/expected phase, canonical
`Uint8Array` bytes and SHA-256 `contentDigest`, exact `tempParentId`/`tempLeaf`,
existing `tempObjectId`, full `expectedTemp`, exact
`stableParentId`/`stableLeaf`, and `expectedStable:{absent:true}`. The
controller must match role/operation/parent/leaf/dev/ino/type/mode/size/hash/
evidence digest against the already-pinned post-write/post-fsync temp record
and the bytes/digest/length against canonical bytes. Spy tests reject any temp
path/procfd open, lstat, read, filesystem hash, selector reconstruction, or
hidden reopen.

Lock separate closed `native_resolved` and `observe_locations` variants for
`persist_intent/intent_publish`, `persist_manifest/manifest_publish`, and
`native_no_replace/<AtomicNativeMoveV1>`. Persistence location requests repeat
operation, temp object/full evidence and both parent/leaf pairs, original
stable-absence precondition, and post-move target evidence. Observations echo
request kind/move/operation, requested source ID, observed source/target IDs,
and complete canonical evidence; absence means every object/scalar/evidence is
null, while match/other requires internally agreeing full evidence. Wrong
association/discriminator/evidence is unrepresentable or rejected.

Test exact maxima and synchronous plus-one before controller effect: stable 512,
recovery 1,024, payload entries 25,000, aggregate payload bytes 1,073,741,824,
scratch entries 1,024, metadata files 3,072/1,024/4,096, manifest bytes
100,663,296/33,554,432/134,217,728, other metadata bytes
12,582,912/4,194,304/16,777,216, total entries 30,120. Reservation release
occurs only through later reducer effect after verified close.

Profile tests prove zero-byte scaffold/canary/initial working succeeds, while
root-only and any aggregate-zero writer reject `profile_schema_empty` before
staging. Copy source is committed only; destination new working only. No atomic
module API accepts/returns `AnchoredRoot`, `BoundGeneration`, fd, path, native
binding, or capability callback.

- [ ] **Step 2: Run RED**

```bash
export PATH=/home/mamba/.nvm/versions/node/v22.22.1/bin:$PATH
cd apps/browser-service
node scripts/run-native-build.mjs all
corepack pnpm exec vitest run --no-file-parallelism src/atomic-directory-publication.test.ts src/atomic-directory-publication.integration.test.ts src/reconciliation.test.ts
```

Expected: FAIL because private construction and persistence protocol are
incomplete.

- [ ] **Step 3: Implement publication slice**

Reducer emits one effect and consumes one matching observation. Initial
intent/manifest protocol is reserve, composite temp create, chunk writes, file
fsync, complete persistence authorization, native result, exact location
observation, parent fsync, and close. Immutable manifest has no replacement
effect.

For `persist_intent`/`persist_manifest`, resolve only the request's already-
pinned `tempObjectId`, verify every `expectedTemp` and canonical byte field,
then invoke `renameNoReplace` with that record's held source parent/leaf. Do no
rediscovery or hidden filesystem verification. Emit `native_resolved` with the
exact request kind, operation, move discriminator, source ID/full evidence,
raw code, precheck digest, and evidence digest; reducer must request the exact
separate persistence `observe_locations` variant next.

`replace_intent` carries the same pinned-temp authorization plus full expected
stable evidence. After identical byte/evidence validation, call Node 22
`fs.promises.rename` between two locally constructed held-parent procfd child
strings without reopening either record; follow with explicit stable open/hash
observation and parent sync. It never invokes the native addon.

Controller calls native only inside synchronous `withNativeOperands`; no
operand survives callback. Task 5 stops at a durable manifest/publication state
that is not exposed as completed ProfileStore prepare/finalize. BoundGeneration
adoption and public integration remain Task 6 work after deletion is GREEN.

- [ ] **Step 4: Run GREEN, review, and commit**

```bash
export PATH=/home/mamba/.nvm/versions/node/v22.22.1/bin:$PATH
cd apps/browser-service
node scripts/run-native-build.mjs all
corepack pnpm exec vitest run --no-file-parallelism src/atomic-publication-manifest.test.ts src/atomic-directory-publication.test.ts src/atomic-directory-publication.integration.test.ts src/reconciliation.test.ts
corepack pnpm build
cd ../..
git add apps/browser-service/src/atomic-directory-publication.ts apps/browser-service/src/atomic-directory-publication.test.ts apps/browser-service/src/atomic-directory-publication.integration.test.ts apps/browser-service/src/reconciliation.ts apps/browser-service/src/reconciliation.test.ts
git diff --cached --name-only
apps/api/.husky/_/pre-commit
git diff --cached --name-only
git diff --cached --check
git commit -m "feat: publish private profile payloads" -m "Drive durable private construction and no-replace publication through
complete pinned-temp authority and exact location observations.

Keep public profile operations closed until protected deletion lands."
```

Expected: private publication/bounds tests/build/reviews PASS; five cached
files. ProfileStore remains unstaged and public prepare/finalize remains closed.

### Task 6: Implement protected source deletion and manifest cleanup

**Files:**
- Modify: `apps/browser-service/src/atomic-directory-publication.ts`
- Modify: `apps/browser-service/src/atomic-directory-publication.test.ts`
- Modify: `apps/browser-service/src/atomic-directory-publication.integration.test.ts`
- Modify: `apps/browser-service/src/reconciliation.ts`
- Modify: `apps/browser-service/src/reconciliation.test.ts`
- Modify: `apps/browser-service/src/profile-store.ts`
- Modify: `apps/browser-service/src/profile-store.test.ts`

- [ ] **Step 1: Write deletion/cleanup RED tests**

Cover `manifest_planned`/temp/stable/both recovery, inode/hash/size binding,
`source_deleting` pending/moved_private/removing/removed, protected working or
staging source native-moved to exact private `delete-<operation-id>`, protected
canary moved to `deletion-<operation-id>-0`, and general removal limited to
owned working/tombstone—never committed.

For each identity, reducer persists next cursor first, requests exactly one
remove, consumes only `removal_observed` with matching request kind/object ID/
full evidence plus `absent/parentSynced:true`, releases reservation, then may
advance. Reconciliation itself must complete lstat/open/fstat/re-lstat/remove/
verified-close/absence/parent-sync before that observation. Cover every cleanup
suffix, stable manifest authorization-first
removal, stable intent last, partial create at every stage, ENOTEMPTY unknown
content, source+private deletion, both absent with/without cursor proof, close-
then-throw, and true close rejection.

Add the still-RED public ProfileStore prepare/finalize cases from Task 5. Prove
protected working/staging sources move to private deletion before any public
operation can complete, cleanup is durably cursor-bound, then adoption mints a
reconciliation-owned opaque `BoundGeneration` from still-open target and
ancestor leases. During an ordinary runtime publication, the already-installed
generation ProfileStore receives that authority exactly once under operation
lock after durable adoption and never constructs or reopens the target. A
pre-ready path must instead seal it inside reconciliation with zero Registry or
ProfileStore attachment; Task 7 installs those sealed capabilities.

- [ ] **Step 2: Run RED**

```bash
export PATH=/home/mamba/.nvm/versions/node/v22.22.1/bin:$PATH
cd apps/browser-service
node scripts/run-native-build.mjs all
corepack pnpm exec vitest run --no-file-parallelism src/atomic-directory-publication.test.ts src/atomic-directory-publication.integration.test.ts src/reconciliation.test.ts src/profile-store.test.ts
```

Expected: FAIL because protected source move and cleanup cursor branches are
incomplete.

- [ ] **Step 3: Implement deletion/cleanup slice**

No public unlink is legal. Every move is native no-replace plus separate
location proof. Every cleanup action consumes full authenticated manifest
binding—operation ID, startup binding, target locator digest, and entries.
Partial cleanup failure retains ID/record/reservation and emits global fail-stop
without advancing phase/cursor or removing stable authority.

After source deletion and manifest-authorized cleanup are complete,
reconciliation persists authorized adoption, mints `BoundGeneration` in its
sole-owner WeakMap from the still-open target pin and ancestor leases. Runtime
publication attaches it exactly once to the existing installed generation
store under the operation lock. Pre-ready publication transfers it only into a
non-exported sealed reconciliation outcome and cannot touch Registry/
ProfileStore. Only the applicable runtime attachment or pre-ready seal may
precede wrapper cleanup. Wire public runtime prepare/finalize now; no earlier
task may claim these behaviors GREEN.

- [ ] **Step 4: Run GREEN, review, and commit**

```bash
export PATH=/home/mamba/.nvm/versions/node/v22.22.1/bin:$PATH
cd apps/browser-service
node scripts/run-native-build.mjs all
corepack pnpm exec vitest run --no-file-parallelism src/atomic-directory-publication.test.ts src/atomic-directory-publication.integration.test.ts src/reconciliation.test.ts src/profile-store.test.ts
corepack pnpm build
cd ../..
git add apps/browser-service/src/atomic-directory-publication.ts apps/browser-service/src/atomic-directory-publication.test.ts apps/browser-service/src/atomic-directory-publication.integration.test.ts apps/browser-service/src/reconciliation.ts apps/browser-service/src/reconciliation.test.ts apps/browser-service/src/profile-store.ts apps/browser-service/src/profile-store.test.ts
git diff --cached --name-only
apps/api/.husky/_/pre-commit
git diff --cached --name-only
git diff --cached --check
git commit -m "feat: clean protected profile sources" -m "Move superseded writable sources into intent-owned private deletion
trees before manifest-authorized cursor cleanup.

Retain ambiguous, unsynced, or close-unverified ownership for restart."
```

Expected: deletion/cleanup/crash and end-to-end ProfileStore prepare/finalize
tests/build/reviews PASS; seven cached files. This is first allowed commit of
the profile-store pair.

### Task 7: Complete recovery, adoption, startup, and metrics

**Files:**
- Modify: `apps/browser-service/src/atomic-directory-publication.ts`
- Modify: `apps/browser-service/src/atomic-directory-publication.test.ts`
- Modify: `apps/browser-service/src/atomic-directory-publication.integration.test.ts`
- Create: `apps/browser-service/src/atomic-publication-observability.ts`
- Create: `apps/browser-service/src/atomic-publication-observability.test.ts`
- Modify: `apps/browser-service/src/reconciliation.ts`
- Modify: `apps/browser-service/src/reconciliation.test.ts`
- Modify: `apps/browser-service/src/startup-state.ts`
- Modify: `apps/browser-service/src/startup-state.test.ts`

- [ ] **Step 1: Write recovery/adoption/startup RED tests**

Lock startup order: native load; held trusted-parent/state/profiles/staging
validation; immutable snapshot and Task 3 manifest capture; reconciliation-
owned `PreReadyRecoveryAuthority`; reducer-driven enumerate/read/reserve;
fresh canaries; intent recovery/adopt-or-release; all locators released; Task 3
enumerate/plan/quarantine; recapture/seal evidence and capabilities; consume
that outcome into one ProfileStore construction; one atomic result/authority/
store/generation CAS install.

Count exactly one generation-scoped ProfileStore constructor and one Registry
compare-and-swap install for each successful generation. Every pre-ready
`BoundGeneration` remains visible only in reconciliation's non-exported sealed
outcome until that single constructor consumes all records. Reject provisional,
discovery-time, per-profile, retry, or pre-recovery stores and any early
Registry/store attachment. Constructor failure performs no install. CAS failure
verified-closes the one uninstalled store and every transferred handle, keeps
the prior generation unchanged/readiness false, and never constructs a second
store in-process. Inject both failures and both sides of CAS to prove no partial
`generation|authority|store|result` visibility. Runtime publication separately
attaches once to the already-installed generation store under operation lock.

Cover every stable phase and temp/wrapper/payload/target topology; allocated or
building abort with `never_attempted` before deletion; empty abort; every crash
seam; canary deleting/partial/cleaned; stale adopted intent; scaffold, working,
prepare, finalize adoption matrix; snapshot-unreferenced committed release;
zero recovery database query; Task 3 never touching intent-owned locator;
crash before/after intent release; fresh-process idempotence.

Test generation rollover and all close effects in reverse order. Verified
close-then-throw reaches zero fds. True close rejection retains controller
records and permanently closes current-process admission.

- [ ] **Step 2: Write observability RED tests**

`atomic-publication-observability.ts` owns monotonic safe counters for attempts,
success, conflict, unsupported, cross-device, binding-invalid, denied, I/O,
recovered-unpublished/published, ambiguous, orphan/temp, close-unverified. It
owns one-shot private alerts for every severe category and one repeated-
conflict alert at fixed process threshold `8`. Reconciliation emits through an
injected sink. Events reject paths, fds, owners, IDs, hashes, mount IDs, and raw
errno. No public health shape changes in current task.

One sanitized `atomic_publish_preflight` event contains only platform,
architecture, interface version, compiled/runtime N-API versions, source
constant `bundled_package_relative`, allowlisted filesystem name, and result.
Task 7 proves event generation; deferred Task 6 alone wires the sink before
traffic and keeps alerts private.

- [ ] **Step 3: Run RED**

```bash
export PATH=/home/mamba/.nvm/versions/node/v22.22.1/bin:$PATH
cd apps/browser-service
node scripts/run-native-build.mjs all
corepack pnpm exec vitest run --no-file-parallelism src/atomic-directory-publication.test.ts src/atomic-directory-publication.integration.test.ts src/atomic-publication-observability.test.ts src/reconciliation.test.ts src/startup-state.test.ts
```

Expected: FAIL because complete recovery/adoption/startup/metrics branches are
absent.

- [ ] **Step 4: Implement recovery and startup install**

Recovery discovery begins only with reducer effects. No controller helper may
hide an unrequested open/read/hash/write/fsync/rename/unlink/close/reservation.
Reconciliation resolves its authority only for `resolve_adoption`; engine sees
decision/digest only. Durable adopted transition precedes reconciliation-owned
capability mint/attachment. Release follows durable discard/cleaned and exact
`release_publication`.

Startup clears ready and drains old sessions/store/root before minting unready.
Startup calls one reconciliation-owned sealed-outcome consumer; no caller or
startup helper constructs a ProfileStore. That consumer invokes the constructor
exactly once from held recovery records plus all sealed capabilities, forms one
immutable `{generation, authority, store, result}` bundle, and performs exactly
one Registry CAS under reconciliation lock. Only successful CAS flips ready.
Forged/stale/repeated outcome, constructor failure, CAS failure, and partial
construction verified-close all newly owned records without partial install or
retry. The prior installed generation, if any, is unchanged.

- [ ] **Step 5: Run GREEN, review, and commit**

```bash
export PATH=/home/mamba/.nvm/versions/node/v22.22.1/bin:$PATH
cd apps/browser-service
node scripts/run-native-build.mjs all
corepack pnpm exec vitest run --no-file-parallelism src/atomic-publication-manifest.test.ts src/atomic-directory-publication.test.ts src/atomic-directory-publication.integration.test.ts src/atomic-publication-observability.test.ts src/reconciliation.test.ts src/startup-state.test.ts
corepack pnpm build
cd ../..
git add apps/browser-service/src/atomic-directory-publication.ts apps/browser-service/src/atomic-directory-publication.test.ts apps/browser-service/src/atomic-directory-publication.integration.test.ts apps/browser-service/src/atomic-publication-observability.ts apps/browser-service/src/atomic-publication-observability.test.ts apps/browser-service/src/reconciliation.ts apps/browser-service/src/reconciliation.test.ts apps/browser-service/src/startup-state.ts apps/browser-service/src/startup-state.test.ts
git diff --cached --name-only
apps/api/.husky/_/pre-commit
git diff --cached --name-only
git diff --cached --check
git commit -m "feat: recover atomic publication ownership" -m "Resolve every durable publication before Task 3 quarantine and bind
adoption to fresh reconciliation authority.

Install readiness atomically and emit sanitized private diagnostics."
```

Expected: recovery/startup/metrics tests/build/reviews PASS; nine cached files.
This is first allowed commit of startup pair.

### Task 8: Integrate session, replay, and proxy lifecycle

**Files:**
- Modify: `apps/browser-service/src/session-registry.ts`
- Modify: `apps/browser-service/src/session-registry.test.ts`
- Modify: `apps/browser-service/src/replay-restore.ts`
- Modify: `apps/browser-service/src/replay-restore.integration.test.ts`
- Modify: `apps/browser-service/src/egress-proxy.ts`
- Modify: `apps/browser-service/src/egress-proxy.test.ts`

- [ ] **Step 1: Write lifecycle RED tests over reconciled capabilities**

Retain all existing TTL, writer, cleanup, semantic replay, and ingress tests.
Prove persistent Chromium launches only through reconciliation-owned procfd
scope, keeps generation/root/intent leases through session lifetime, and
releases exactly once after verified context or Browser closure. Neither atomic
module nor Registry sees fd/path/native operands.

Cover trusted `preSpawn`, unknown launch rejection/timeout, post-context
failure, Registry attachment failure, context close reject/timeout, Browser
fallback, listener/socket/profile cleanup, sweeper, and restart. Unknown launch
or close keeps fail-stop ownership and performs no prepare/finalize/discard.

Replay order remains validate, provisional Registry, working capability,
restore-closed proxy, launch attempt, procfd launch, storage set/export/parse/
semantic compare, zero ingress, gate open, first page/navigation. HTTP/CONNECT/
Upgrade closed attempts stop before DNS/policy/dial. Positive controls run after
open. Playwright helper pages are not an egress oracle.

- [ ] **Step 2: Run RED**

```bash
export PATH=/home/mamba/.nvm/versions/node/v22.22.1/bin:$PATH
cd apps/browser-service
node scripts/run-native-build.mjs all
corepack pnpm exec vitest run --no-file-parallelism src/session-registry.test.ts src/replay-restore.integration.test.ts src/egress-proxy.test.ts src/profile-store.test.ts src/reconciliation.test.ts src/startup-state.test.ts
```

Expected: FAIL until lifecycle uses finalized reconciliation-owned authority.

- [ ] **Step 3: Implement without widening ownership**

Use existing opaque reconciliation/ProfileStore APIs. Do not import atomic
reducer/native loader into Registry, replay, or proxy. Preserve exact semantic
normalization, gate counters, no pre-verification service page work, aggregate
cleanup, and fail-stop semantics.

- [ ] **Step 4: Run GREEN, review, and commit**

```bash
export PATH=/home/mamba/.nvm/versions/node/v22.22.1/bin:$PATH
cd apps/browser-service
node scripts/run-native-build.mjs all
corepack pnpm exec vitest run --no-file-parallelism src/session-registry.test.ts src/replay-restore.integration.test.ts src/egress-proxy.test.ts src/profile-store.test.ts src/reconciliation.test.ts src/startup-state.test.ts
corepack pnpm build
cd ../..
git add apps/browser-service/src/session-registry.ts apps/browser-service/src/session-registry.test.ts apps/browser-service/src/replay-restore.ts apps/browser-service/src/replay-restore.integration.test.ts apps/browser-service/src/egress-proxy.ts apps/browser-service/src/egress-proxy.test.ts
git diff --cached --name-only
apps/api/.husky/_/pre-commit
git diff --cached --name-only
git diff --cached --check
git commit -m "feat: retain reconciled profile sessions" -m "Hold reconciliation-owned profile authority through Chromium launch,
replay verification, proxy admission, and verified shutdown.

Keep uncertain cleanup under process-global fail-stop ownership."
```

Expected: lifecycle/real Chromium tests/build/reviews PASS; six cached files.
All original twelve Task 4 files are now atomic-integrated and reviewed.

### Task 9: Add offline rollback safety checker

**Files:**
- Create: `apps/browser-service/scripts/check-atomic-publication-rollback.mjs`
- Create: `apps/browser-service/scripts/check-atomic-publication-rollback.test.mjs`

- [ ] **Step 1: Write rollback checker RED tests**

Checker accepts only exact child state root argument, opens held layout
no-follow, validates owner/mode/type/device, and succeeds only when intents has
no stable/temp intent or manifest and bundles has no wrapper, canary, payload,
or private deletion. Cover malformed/unknown state, symlink/root swap, every
unresolved grammar entry, exact empty success, and read-only proof. Assert no
write syscall, repair, delete, force flag, or alternate root.

Exact current invocation is:

```bash
node scripts/check-atomic-publication-rollback.mjs /var/lib/firecrawl-browser-volume/state
```

- [ ] **Step 2: Run RED**

```bash
export PATH=/home/mamba/.nvm/versions/node/v22.22.1/bin:$PATH
cd apps/browser-service
node --test scripts/check-atomic-publication-rollback.test.mjs
```

Expected: FAIL because checker does not exist.

- [ ] **Step 3: Implement read-only checker**

Exit `0` only for proved safe rollback; use distinct nonzero exit for unresolved
state versus invalid layout. Emit sanitized category only. Never accept
`--force`, never remove bytes, and never treat absence of one subtree as proof
without validating full reserved layout.

- [ ] **Step 4: Run GREEN, review, and commit**

```bash
export PATH=/home/mamba/.nvm/versions/node/v22.22.1/bin:$PATH
cd apps/browser-service
node --test scripts/check-atomic-publication-rollback.test.mjs
cd ../..
git add apps/browser-service/scripts/check-atomic-publication-rollback.mjs apps/browser-service/scripts/check-atomic-publication-rollback.test.mjs
git diff --cached --name-only
apps/api/.husky/_/pre-commit
git diff --cached --name-only
git diff --cached --check
git commit -m "feat: block unsafe browser rollback" -m "Inspect the held child state root without mutation and reject rollback
while any native publication authority or private state remains.

Expose no repair or force path."
```

Expected: checker tests/reviews PASS; cached names equal two files.

### Task 10: Run deterministic host acceptance and clean artifacts

**Files:** No edits expected. A failure returns to its owning task, same
implementer, both reviews, scoped fix commit, then reruns this gate.

- [ ] **Step 1: Verify tracked scope and forbidden architecture**

```bash
git status --short
git diff --check
! git ls-files | rg '(^|/)(build|node_modules)/|\.node$|\.o$|\.d$|\.map$|\.trace$'
! rg -n 'node-gyp|binding\.gyp' apps/browser-service/package.json apps/browser-service/scripts apps/browser-service/native
! rg -n 'from .*reconciliation|from .*startup-state|from .*profile-store|from .*session-registry|node:fs|atomic-directory-publication-native' apps/browser-service/src/atomic-directory-publication.ts apps/browser-service/src/atomic-publication-manifest.ts
! rg -n 'AnchoredRoot|BoundGeneration|PreReadyRecoveryAuthority|WeakMap|FileHandle|DirectoryFd|NativeBinding|renameNoReplace|proc/self/fd' apps/browser-service/src/atomic-directory-publication.ts apps/browser-service/src/atomic-publication-manifest.ts
```

Expected: no generated tracked artifact, forbidden build mechanism, reverse
import, I/O import, authority/fd/path type in pure modules.

- [ ] **Step 2: Rebuild immediately before each native-loading suite**

```bash
export PATH=/home/mamba/.nvm/versions/node/v22.22.1/bin:$PATH
cd apps/browser-service
node scripts/run-native-build.mjs all
node --test scripts/run-native-build.test.mjs scripts/build-native.test.mjs src/runtime-preflight.test.mjs src/lockfile.test.mjs scripts/check-atomic-publication-rollback.test.mjs
node --test --test-name-pattern='proves concrete amd64 and arm64 dockerInit tuples' scripts/build-native.test.mjs
node scripts/run-native-build.mjs all
corepack pnpm exec vitest run --no-file-parallelism src/atomic-directory-publication-native.test.ts src/atomic-directory-publication.integration.test.ts
node scripts/run-native-build.mjs all
corepack pnpm exec vitest run --no-file-parallelism src/atomic-publication-manifest.test.ts src/atomic-directory-publication.test.ts src/atomic-publication-observability.test.ts src/reconciliation.test.ts src/startup-state.test.ts src/profile-store.test.ts src/session-registry.test.ts src/replay-restore.integration.test.ts src/egress-proxy.test.ts
node scripts/run-native-build.mjs all
corepack pnpm exec vitest run --no-file-parallelism
node scripts/run-native-build.mjs production
node src/runtime-preflight.mjs --phase=prestart
corepack pnpm build
```

Expected: standalone errno runner, all bootstrap/native/reducer/controller/
recovery/lifecycle tests, runtime checksum, and build PASS. Host tests make no
different-UID, privileged mount, read-only mount, cross-mount, bind-mount-ID,
named-volume, image, server, Compose, or activation claim.
The two mandatory isolated Docker-init tuple probes claim only immutable base/
OS/package/flock identity, not deferred Browser/init image acceptance.

- [ ] **Step 3: Run hook and final review gate**

```bash
apps/api/.husky/_/pre-commit
git diff --check
git diff --cached --name-only
git status --short
```

Expected: hook PASS, cached output empty, current implementation clean except
this plan if parent workflow intentionally leaves it uncommitted. Complete one
final requirements review against every spec section and one quality review of
full Task 4 diff.

- [ ] **Step 4: Clean only generated native output**

```bash
rm -rf apps/browser-service/build
git status --short
```

Expected: build artifacts removed; no user state, container, volume, cache, or
source removed. `LOCAL_BROWSER_SERVICE_ENABLED` remains unchanged/false.

---

## Deferred master-plan Task 6 amendment — do not execute in this plan

**Prerequisites:** Current Tasks 1-10 committed and host acceptance PASS;
master Task 5 operations complete. Original Task 6 creates `src/server.ts` and
`src/index.ts` in its existing server step before amended Docker Step 6 uses
them.

This is an amendment to original master-plan Task 6, not a replacement. Keep
its original title and streams/artifacts/server scope. Extend original Step 1
with the init/Docker tests below and original Step 2 with their RED commands;
then keep original Steps 3-5 in order. Replace original Docker Step 6 with the
amended build/init implementation below, replace original Step 7 with exact
image acceptance below, then perform one expanded original Step 8 commit. Net
Task 6 files are:

```text
apps/browser-service/src/streams.ts
apps/browser-service/src/streams.test.ts
apps/browser-service/src/artifacts.ts
apps/browser-service/src/artifacts.test.ts
apps/browser-service/src/server.ts
apps/browser-service/src/server.test.ts
apps/browser-service/src/index.ts
apps/browser-service/Dockerfile
apps/browser-service/src/dockerfile.test.ts
apps/browser-service/scripts/init-state-volume.mjs
apps/browser-service/scripts/init-state-volume.test.mjs
```

Amend original Step 1 TDD before its combined RED, then implement only in the
corresponding original Steps 3-6:

1. Add init tests for named-volume parent layout, fixed
   `/usr/bin/flock --exclusive --timeout 60
   /var/lib/firecrawl-browser-volume /usr/local/bin/node
   scripts/init-state-volume.mjs`, no marker/state→init-new, matching
   marker/state→validate-existing, mismatch failure, concurrent init
   serialization, crash lock release, and zero `.mjs` flock emulation.
2. Init-new opens held trusted parent, exclusively creates child `state`,
   `profiles`, `.profile-publish-staging`, `intents`, `bundles`, uses exact
   `fchown(1000,1000)`, `fchmod(0700)`, no-follow identity proof, bottom-up
   fsync, parent `root:1000/0750`, then exclusive marker
   `.firecrawl-browser-initialized-v1` containing
   `firecrawl-browser-volume-v1\n` as `root:root/0600` with fsync. Validate mode
   performs zero create/chown/chmod/remove/rename/truncate/repair.
3. Builder/test stages contain compiler/headers and run deterministic runner.
   Final service image copies only production `.node`, runtime checksum, and
   application runtime—no compiler, headers, flock, util-linux, objects,
   depfiles, input attestations, test addon, maps/traces, build cache, or package
   cache. Separate init target contains pinned util-linux/flock, Node 22, init
   script, allowlist, and no Browser server. Task 6 selects and verifies only
   the exact Task-4-owned `dockerInit[TARGETARCH]` tuple; it never generates,
   edits, widens, or commits `native/toolchain-allowlist.json`. Unsupported
   architecture fails before package installation, and no unpinned
   `apt-get install util-linux` is allowed.
4. Wire `atomic-publication-observability` through `index.ts`; server returns
   only existing `browser_unavailable`. Copy rollback checker into runtime.
5. Docker harness owns different-UID collision/root-swap, privileged owner/mode
   drift, read-only mount, real cross-mount, same-device bind mount-ID, denied,
   disallowed filesystem, final UID `1000:1000`, and init preservation tests.

The Node base `FROM` uses the tuple's exact repository plus immutable index
digest. Before package installation the stage proves its selected platform
digest and `/etc/os-release` hash. The init build stage then parses only the
selected `TARGETARCH` tuple and uses this exact install/verification sequence.
`TARGETARCH` is the only Docker-provided selector; caller package/version/hash/
compiler variables are rejected:

```Dockerfile
ARG TARGETARCH
RUN set -eu; \
    tuple="$(node --input-type=module -e 'const fs=await import("node:fs/promises");const arch=process.argv[1];const x=JSON.parse(await fs.readFile("native/toolchain-allowlist.json","utf8"));const keys=["targetArch","nodeBaseRepository","nodeBaseIndexDigest","nodeBasePlatformDigest","osReleaseSha256","dpkgArchitecture","utilLinuxPackage","utilLinuxVersion","flockRealpath","flockSha256"];if(x.schemaVersion!==1||Object.keys(x).join(",")!=="schemaVersion,dockerInit"||Object.keys(x.dockerInit).join(",")!=="amd64,arm64"||!Object.hasOwn(x.dockerInit,arch)||!Object.hasOwn({amd64:1,arm64:1},arch))process.exit(1);const t=x.dockerInit[arch];if(Object.keys(t).join(",")!==keys.join(",")||t.targetArch!==arch)process.exit(1);process.stdout.write(JSON.stringify(t))' "$TARGETARCH")"; \
    util_linux_version="$(printf '%s' "$tuple" | node --input-type=module -e 'let s="";for await(const c of process.stdin)s+=c;const x=JSON.parse(s);if(x.utilLinuxPackage!=="util-linux"||typeof x.utilLinuxVersion!=="string"||x.utilLinuxVersion.length===0)process.exit(1);process.stdout.write(x.utilLinuxVersion)')"; \
    expected_dpkg_arch="$(printf '%s' "$tuple" | node --input-type=module -e 'let s="";for await(const c of process.stdin)s+=c;const x=JSON.parse(s);process.stdout.write(x.dpkgArchitecture)')"; \
    expected_os_release_sha="$(printf '%s' "$tuple" | node --input-type=module -e 'let s="";for await(const c of process.stdin)s+=c;const x=JSON.parse(s);if(!/^[a-f0-9]{64}$/.test(x.osReleaseSha256))process.exit(1);process.stdout.write(x.osReleaseSha256)')"; \
    expected_flock_realpath="$(printf '%s' "$tuple" | node --input-type=module -e 'let s="";for await(const c of process.stdin)s+=c;const x=JSON.parse(s);process.stdout.write(x.flockRealpath)')"; \
    expected_flock_sha="$(printf '%s' "$tuple" | node --input-type=module -e 'let s="";for await(const c of process.stdin)s+=c;const x=JSON.parse(s);if(!/^[a-f0-9]{64}$/.test(x.flockSha256))process.exit(1);process.stdout.write(x.flockSha256)')"; \
    test "$(sha256sum /etc/os-release | cut -d' ' -f1)" = "$expected_os_release_sha"; \
    apt-get update; \
    apt-get install -y --no-install-recommends "util-linux=${util_linux_version}"; \
    test "$(dpkg --print-architecture)" = "$expected_dpkg_arch"; \
    test "$(dpkg-query -W -f='${Version}' util-linux)" = "$util_linux_version"; \
    test "$(realpath /usr/bin/flock)" = "$expected_flock_realpath"; \
    test "$(sha256sum /usr/bin/flock | cut -d' ' -f1)" = "$expected_flock_sha"; \
    /usr/bin/flock --help >/dev/null; \
    rm -rf /var/lib/apt/lists/*
```

`dockerfile.test.ts` rejects allowlist writes, fallback tuple selection,
wildcard installation, missing base/platform/os/package/binary check, unknown
architecture/field, or package acquisition outside this sequence. Builder,
test, and init stages repeat all tuple checks after installation. Init target
sets exact exec-form entrypoint:

Before either architecture build, the test reads the selected immutable tuple,
requires every Node `FROM` equal the tuple's `nodeBaseRepository`, literal
`@`, and `nodeBaseIndexDigest` concatenation, resolves that OCI index, and
requires the selected `linux/${TARGETARCH}` manifest equal
`nodeBasePlatformDigest`.
Inside each stage it requires the exact os-release hash, dpkg architecture,
installed util-linux version, flock realpath, and flock byte hash above. Any
check is mandatory and unskippable; Dockerfile and tests never write allowlist
bytes.

```Dockerfile
ENTRYPOINT ["/usr/bin/flock","--exclusive","--timeout","60","/var/lib/firecrawl-browser-volume","/usr/local/bin/node","scripts/init-state-volume.mjs"]
```

Resolve immutable Playwright manifest using exact verified commands:

```bash
docker buildx imagetools inspect --help | rg -- '--raw'
docker build --help | rg -- '--no-cache|--pull|--target'
docker buildx imagetools inspect --raw mcr.microsoft.com/playwright:v1.61.1-noble > /tmp/firecrawl-playwright-v1.61.1-noble.manifest.json
sha256sum /tmp/firecrawl-playwright-v1.61.1-noble.manifest.json
```

Expected digest derivation: SHA-256 of exact raw manifest bytes, shown as 64
lowercase hex plus filename. Prefix emitted hex with `sha256:` and append it
after `mcr.microsoft.com/playwright:v1.61.1-noble@` in every Playwright `FROM`.
Before editing Dockerfile, capture and validate the emitted field, then verify
the exact pinned reference:

```bash
read -r manifest_sha256 manifest_name < <(sha256sum /tmp/firecrawl-playwright-v1.61.1-noble.manifest.json)
test "$manifest_name" = /tmp/firecrawl-playwright-v1.61.1-noble.manifest.json
test "${#manifest_sha256}" -eq 64
printf '%s\n' "$manifest_sha256" | rg '^[a-f0-9]{64}$'
docker buildx imagetools inspect "mcr.microsoft.com/playwright:v1.61.1-noble@sha256:${manifest_sha256}"
```

The amendment copies that verified value as a literal digest before commit;
Dockerfile contains no variable or unresolved token.

RED commands:

```bash
node --test apps/browser-service/scripts/init-state-volume.test.mjs
corepack pnpm --dir apps/browser-service exec vitest run src/streams.test.ts src/artifacts.test.ts src/server.test.ts src/dockerfile.test.ts
```

GREEN/image acceptance runs as this one exact repository-root harness. It uses
a fresh namespace, rejects every pre-existing resource collision before
mutation, pre-registers every planned resource, and labels each Docker resource
with that exact namespace before use. The EXIT handler removes only resources
whose expected name/tag and namespace label both match, leaves foreign
replacements untouched, preserves any original nonzero status, converts
cleanup failure after success to status 1, and verifies every registered
container, image, volume, and extraction path is absent. No broad prefix
cleanup or ignored cleanup failure is permitted.

```bash
set -Eeuo pipefail
export PATH=/home/mamba/.nvm/versions/node/v22.22.1/bin:$PATH
test "$PWD" = /home/mamba/work/firecrawl
test "$(command -v timeout)" = /usr/bin/timeout
/usr/bin/timeout --help | rg -- '--foreground'
suffix="$(node --input-type=module -e 'import { randomBytes } from "node:crypto";process.stdout.write(randomBytes(16).toString("hex"))')"
[[ "$suffix" =~ ^[a-f0-9]{32}$ ]]
namespace="firecrawl-browser-task6-${suffix}"
work="/tmp/${namespace}"
declare -a created_containers=()
declare -a created_images=()
declare -a created_volumes=()
owned_run_counter=0
work_registered=0

declare -a functional_images=(
  "${namespace}-init-1" "${namespace}-test-1" "${namespace}-final-1"
  "${namespace}-init-2" "${namespace}-test-2" "${namespace}-final-2"
)
declare -a repro_images=()
declare -a repro_containers=()
for arch in amd64 arm64; do
  repro_images+=("${namespace}-repro-a:${arch}" "${namespace}-repro-b:${arch}")
  repro_containers+=("${namespace}-repro-a-${arch}" "${namespace}-repro-b-${arch}")
done
declare -a volumes=("${namespace}-state-1" "${namespace}-state-2")
declare -a servers=("${namespace}-server-1" "${namespace}-server-2")

classify_resource() {
  local kind="$1"
  local name="$2"
  local format
  local output
  local status
  local identity
  local label
  local image_name="$name"
  RESOURCE_STATE=error
  RESOURCE_DETAIL=
  case "$kind" in
    container)
      format='{{printf "%s\n%s" .Name (index .Config.Labels "firecrawl.acceptance.namespace")}}'
      ;;
    image)
      format='{{printf "%s\n%s" (json .RepoTags) (index .Config.Labels "firecrawl.acceptance.namespace")}}'
      if [[ "$image_name" != *:* ]]; then
        image_name="${image_name}:latest"
      fi
      ;;
    volume)
      format='{{printf "%s\n%s" .Name (index .Labels "firecrawl.acceptance.namespace")}}'
      ;;
    *)
      RESOURCE_DETAIL="unknown resource kind"
      return 0
      ;;
  esac
  if output="$(docker "$kind" inspect --format "$format" "$name" 2>&1)"; then
    if [[ "$output" != *$'\n'* ]]; then
      RESOURCE_STATE=foreign
      RESOURCE_DETAIL="missing identity or namespace label"
      return 0
    fi
    identity="${output%%$'\n'*}"
    label="${output#*$'\n'}"
    if test "$label" != "$namespace"; then
      RESOURCE_STATE=foreign
      RESOURCE_DETAIL="namespace label mismatch"
      return 0
    fi
    case "$kind" in
      container)
        if test "$identity" = "/$name"; then
          RESOURCE_STATE=owned
        else
          RESOURCE_STATE=foreign
          RESOURCE_DETAIL="container name mismatch"
        fi
        ;;
      image)
        if node --input-type=module -e 'const tags=JSON.parse(process.argv[1]);if(!Array.isArray(tags)||!tags.includes(process.argv[2]))process.exit(1)' "$identity" "$image_name"; then
          RESOURCE_STATE=owned
        else
          RESOURCE_STATE=foreign
          RESOURCE_DETAIL="image tag mismatch"
        fi
        ;;
      volume)
        if test "$identity" = "$name"; then
          RESOURCE_STATE=owned
        else
          RESOURCE_STATE=foreign
          RESOURCE_DETAIL="volume name mismatch"
        fi
        ;;
    esac
    return 0
  else
    status=$?
  fi
  while [[ "$output" == $'\n'* ]]; do
    output="${output#$'\n'}"
  done
  case "${kind}:${output}" in
    "container:Error response from daemon: No such container: ${name}" | \
    "image:Error response from daemon: No such image: ${image_name}" | \
    "volume:Error response from daemon: get ${name}: no such volume")
      RESOURCE_STATE=absent
      return 0
      ;;
  esac
  RESOURCE_STATE=error
  RESOURCE_DETAIL="status ${status}: ${output:0:4096}"
}

cleanup() {
  original_status=$?
  trap - EXIT HUP INT TERM
  set +e
  cleanup_status=0
  for ((i=${#created_containers[@]} - 1; i >= 0; i--)); do
    name="${created_containers[$i]}"
    classify_resource container "$name"
    case "$RESOURCE_STATE" in
      owned)
        if ! docker rm -f "$name" >/dev/null; then
          printf "failed to remove container %s\n" "$name" >&2
          cleanup_status=1
        fi
        ;;
      absent)
        ;;
      foreign)
        printf "refusing to remove foreign container %s: %.4096s\n" "$name" "$RESOURCE_DETAIL" >&2
        cleanup_status=1
        ;;
      error)
        printf "container inspection failed for %s: %.4096s\n" "$name" "$RESOURCE_DETAIL" >&2
        cleanup_status=1
        ;;
    esac
  done
  for ((i=${#created_volumes[@]} - 1; i >= 0; i--)); do
    name="${created_volumes[$i]}"
    classify_resource volume "$name"
    case "$RESOURCE_STATE" in
      owned)
        if ! docker volume rm "$name" >/dev/null; then
          printf "failed to remove volume %s\n" "$name" >&2
          cleanup_status=1
        fi
        ;;
      absent)
        ;;
      foreign)
        printf "refusing to remove foreign volume %s: %.4096s\n" "$name" "$RESOURCE_DETAIL" >&2
        cleanup_status=1
        ;;
      error)
        printf "volume inspection failed for %s: %.4096s\n" "$name" "$RESOURCE_DETAIL" >&2
        cleanup_status=1
        ;;
    esac
  done
  for ((i=${#created_images[@]} - 1; i >= 0; i--)); do
    name="${created_images[$i]}"
    classify_resource image "$name"
    case "$RESOURCE_STATE" in
      owned)
        if ! docker image rm "$name" >/dev/null; then
          printf "failed to remove image %s\n" "$name" >&2
          cleanup_status=1
        fi
        ;;
      absent)
        ;;
      foreign)
        printf "refusing to remove foreign image %s: %.4096s\n" "$name" "$RESOURCE_DETAIL" >&2
        cleanup_status=1
        ;;
      error)
        printf "image inspection failed for %s: %.4096s\n" "$name" "$RESOURCE_DETAIL" >&2
        cleanup_status=1
        ;;
    esac
  done
  if test "$work_registered" -eq 1; then
    if ! rm -rf -- "$work"; then
      printf "failed to remove extraction state %s\n" "$work" >&2
      cleanup_status=1
    fi
  fi
  for name in "${created_containers[@]}"; do
    classify_resource container "$name"
    case "$RESOURCE_STATE" in
      absent)
        ;;
      owned)
        printf "owned container remains: %s\n" "$name" >&2
        cleanup_status=1
        ;;
      foreign)
        printf "foreign replacement container remains: %s: %.4096s\n" "$name" "$RESOURCE_DETAIL" >&2
        cleanup_status=1
        ;;
      error)
        printf "container absence verification failed for %s: %.4096s\n" "$name" "$RESOURCE_DETAIL" >&2
        cleanup_status=1
        ;;
    esac
  done
  for name in "${created_images[@]}"; do
    classify_resource image "$name"
    case "$RESOURCE_STATE" in
      absent)
        ;;
      owned)
        printf "owned image remains: %s\n" "$name" >&2
        cleanup_status=1
        ;;
      foreign)
        printf "foreign replacement image remains: %s: %.4096s\n" "$name" "$RESOURCE_DETAIL" >&2
        cleanup_status=1
        ;;
      error)
        printf "image absence verification failed for %s: %.4096s\n" "$name" "$RESOURCE_DETAIL" >&2
        cleanup_status=1
        ;;
    esac
  done
  for name in "${created_volumes[@]}"; do
    classify_resource volume "$name"
    case "$RESOURCE_STATE" in
      absent)
        ;;
      owned)
        printf "owned volume remains: %s\n" "$name" >&2
        cleanup_status=1
        ;;
      foreign)
        printf "foreign replacement volume remains: %s: %.4096s\n" "$name" "$RESOURCE_DETAIL" >&2
        cleanup_status=1
        ;;
      error)
        printf "volume absence verification failed for %s: %.4096s\n" "$name" "$RESOURCE_DETAIL" >&2
        cleanup_status=1
        ;;
    esac
  done
  if test "$work_registered" -eq 1 && test -e "$work"; then
    printf "owned extraction state remains: %s\n" "$work" >&2
    cleanup_status=1
  fi
  if test "$original_status" -ne 0; then
    exit "$original_status"
  fi
  if test "$cleanup_status" -ne 0; then
    exit 1
  fi
  exit 0
}
trap cleanup EXIT
trap "exit 129" HUP
trap "exit 130" INT
trap "exit 143" TERM

require_absent() {
  local kind="$1"
  local name="$2"
  classify_resource "$kind" "$name"
  case "$RESOURCE_STATE" in
    absent)
      return 0
      ;;
    owned)
      printf "owned %s collision: %s\n" "$kind" "$name" >&2
      ;;
    foreign)
      printf "foreign %s collision: %s: %.4096s\n" "$kind" "$name" "$RESOURCE_DETAIL" >&2
      ;;
    error)
      printf "%s collision inspection failed for %s: %.4096s\n" "$kind" "$name" "$RESOURCE_DETAIL" >&2
      ;;
  esac
  return 1
}

run_owned() {
  owned_run_counter=$((owned_run_counter + 1))
  owned_name="${namespace}-run-${owned_run_counter}"
  if ! require_absent container "$owned_name"; then
    return 1
  fi
  created_containers+=("$owned_name")
  docker create --label "firecrawl.acceptance.namespace=${namespace}" --name "$owned_name" "$@" >/dev/null
  docker start -a "$owned_name"
  classify_resource container "$owned_name"
  if test "$RESOURCE_STATE" != owned; then
    printf "refusing post-run removal for %s container %s: %.4096s\n" "$RESOURCE_STATE" "$owned_name" "$RESOURCE_DETAIL" >&2
    return 1
  fi
  docker rm "$owned_name" >/dev/null
}

for name in "${servers[@]}" "${repro_containers[@]}"; do
  if ! require_absent container "$name"; then
    exit 1
  fi
done
for name in "${functional_images[@]}" "${repro_images[@]}"; do
  if ! require_absent image "$name"; then
    exit 1
  fi
done
for name in "${volumes[@]}"; do
  if ! require_absent volume "$name"; then
    exit 1
  fi
done
if test -e "$work"; then
  printf "extraction-state collision: %s\n" "$work" >&2
  exit 1
fi

created_images=("${functional_images[@]}" "${repro_images[@]}")
created_volumes=("${volumes[@]}")
work_registered=1
mkdir -m 0700 "$work"

docker build --pull --no-cache --label "firecrawl.acceptance.namespace=${namespace}" --target browser-volume-init -f apps/browser-service/Dockerfile -t "${namespace}-init-1" .
docker build --pull --no-cache --label "firecrawl.acceptance.namespace=${namespace}" --target browser-test -f apps/browser-service/Dockerfile -t "${namespace}-test-1" .
docker build --pull --no-cache --label "firecrawl.acceptance.namespace=${namespace}" --target browser-service-runtime -f apps/browser-service/Dockerfile -t "${namespace}-final-1" .
docker build --pull --no-cache --label "firecrawl.acceptance.namespace=${namespace}" --target browser-volume-init -f apps/browser-service/Dockerfile -t "${namespace}-init-2" .
docker build --pull --no-cache --label "firecrawl.acceptance.namespace=${namespace}" --target browser-test -f apps/browser-service/Dockerfile -t "${namespace}-test-2" .
docker build --pull --no-cache --label "firecrawl.acceptance.namespace=${namespace}" --target browser-service-runtime -f apps/browser-service/Dockerfile -t "${namespace}-final-2" .

for arch in amd64 arm64; do
  image_a="${namespace}-repro-a:${arch}"
  image_b="${namespace}-repro-b:${arch}"
  container_a="${namespace}-repro-a-${arch}"
  container_b="${namespace}-repro-b-${arch}"
  docker buildx build --no-cache --progress=plain --platform "linux/${arch}" --label "firecrawl.acceptance.namespace=${namespace}" --target browser-service-runtime --load -f apps/browser-service/Dockerfile -t "$image_a" .
  docker buildx build --no-cache --progress=plain --platform "linux/${arch}" --label "firecrawl.acceptance.namespace=${namespace}" --target browser-service-runtime --load -f apps/browser-service/Dockerfile -t "$image_b" .
  mkdir -m 0700 "$work/${arch}-a" "$work/${arch}-b"
  created_containers+=("$container_a")
  docker create --label "firecrawl.acceptance.namespace=${namespace}" --name "$container_a" "$image_a"
  created_containers+=("$container_b")
  docker create --label "firecrawl.acceptance.namespace=${namespace}" --name "$container_b" "$image_b"
  docker cp "$container_a:/app/apps/browser-service/build/Release/atomic_directory_publication.node" "$work/${arch}-a/atomic_directory_publication.node"
  docker cp "$container_a:/app/apps/browser-service/build/Release/atomic-directory-publication.node.sha256" "$work/${arch}-a/atomic-directory-publication.node.sha256"
  docker cp "$container_b:/app/apps/browser-service/build/Release/atomic_directory_publication.node" "$work/${arch}-b/atomic_directory_publication.node"
  docker cp "$container_b:/app/apps/browser-service/build/Release/atomic-directory-publication.node.sha256" "$work/${arch}-b/atomic-directory-publication.node.sha256"
  cmp "$work/${arch}-a/atomic_directory_publication.node" "$work/${arch}-b/atomic_directory_publication.node"
  cmp "$work/${arch}-a/atomic-directory-publication.node.sha256" "$work/${arch}-b/atomic-directory-publication.node.sha256"
  test "$(sha256sum "$work/${arch}-a/atomic_directory_publication.node" | cut -d" " -f1)" = "$(sha256sum "$work/${arch}-b/atomic_directory_publication.node" | cut -d" " -f1)"
  test "$(sha256sum "$work/${arch}-a/atomic-directory-publication.node.sha256" | cut -d" " -f1)" = "$(sha256sum "$work/${arch}-b/atomic-directory-publication.node.sha256" | cut -d" " -f1)"
  node --input-type=module -e 'import fs from "node:fs";import crypto from "node:crypto";for(const d of process.argv.slice(1)){const a=fs.readFileSync(`${d}/atomic_directory_publication.node`);const c=fs.readFileSync(`${d}/atomic-directory-publication.node.sha256`,"utf8");if(!c.endsWith("\n")||c.slice(0,-1).includes("\n"))process.exit(1);const x=JSON.parse(c);if(Object.keys(x).join(",")!=="interfaceVersion,napiVersion,sha256"||x.interfaceVersion!=="1.0.0"||x.napiVersion!==8||x.sha256!==crypto.createHash("sha256").update(a).digest("hex"))process.exit(1)}' "$work/${arch}-a" "$work/${arch}-b"
done

for n in 1 2; do
  volume="${namespace}-state-${n}"
  init_image="${namespace}-init-${n}"
  test_image="${namespace}-test-${n}"
  final_image="${namespace}-final-${n}"
  server="${namespace}-server-${n}"
  docker volume create --label "firecrawl.acceptance.namespace=${namespace}" "$volume" >/dev/null
  run_owned --user 0:0 --mount "type=volume,source=${volume},target=/var/lib/firecrawl-browser-volume" "$init_image"
  run_owned --user 0:0 --mount "type=volume,source=${volume},target=/var/lib/firecrawl-browser-volume" "$init_image"
  run_owned --user 0:0 --mount "type=volume,source=${volume},target=/var/lib/firecrawl-browser-volume" --entrypoint /bin/sh "$init_image" -ceu 'test "$(stat -c "%u:%g:%a" /var/lib/firecrawl-browser-volume)" = "0:1000:750"; test "$(stat -c "%u:%g:%a" /var/lib/firecrawl-browser-volume/state)" = "1000:1000:700"; test "$(stat -c "%u:%g:%a" /var/lib/firecrawl-browser-volume/.firecrawl-browser-initialized-v1)" = "0:0:600"; test "$(cat /var/lib/firecrawl-browser-volume/.firecrawl-browser-initialized-v1)" = "firecrawl-browser-volume-v1"; /usr/bin/flock --help >/dev/null'
  run_owned --user 1000:1000 --mount "type=volume,source=${volume},target=/var/lib/firecrawl-browser-volume" -e LOCAL_BROWSER_STATE_ROOT=/var/lib/firecrawl-browser-volume/state --entrypoint node "$final_image" src/runtime-preflight.mjs --phase=prestart
  run_owned --user 1000:1000 --mount "type=volume,source=${volume},target=/var/lib/firecrawl-browser-volume" -e LOCAL_BROWSER_STATE_ROOT=/var/lib/firecrawl-browser-volume/state -e ATOMIC_IMAGE_CASE=native-and-mount --entrypoint corepack "$test_image" pnpm exec vitest run --no-file-parallelism src/atomic-directory-publication.integration.test.ts src/dockerfile.test.ts
  docker image inspect "$final_image" --format "{{.Config.User}}" | rg "^1000:1000$"
  run_owned --entrypoint /bin/sh "$final_image" -ceu 'test -f build/Release/atomic_directory_publication.node; test -f build/Release/atomic-directory-publication.node.sha256; test ! -e /usr/bin/flock; test ! -e build/Test; test -z "$(find build -type f \( -name "*.o" -o -name "*.d" -o -name "*.map" -o -name "*.trace" -o -name "*.inputs.sha256" \) -print -quit)"; ! command -v gcc; ! command -v cc'
  created_containers+=("$server")
  docker create --label "firecrawl.acceptance.namespace=${namespace}" --name "$server" --user 1000:1000 --mount "type=volume,source=${volume},target=/var/lib/firecrawl-browser-volume" -e LOCAL_BROWSER_STATE_ROOT=/var/lib/firecrawl-browser-volume/state -e BROWSER_SERVICE_API_KEY=0123456789abcdef0123456789abcdef -e PORT=3010 "$final_image" >/dev/null
  docker start "$server" >/dev/null
  ready=0
  for attempt in {1..30}; do
    classify_resource container "$server"
    case "$RESOURCE_STATE" in
      owned)
        ;;
      absent)
        printf "server disappeared before readiness: %s\n" "$server" >&2
        break
        ;;
      foreign)
        printf "foreign server replacement before readiness: %s: %.4096s\n" "$server" "$RESOURCE_DETAIL" >&2
        break
        ;;
      error)
        printf "readiness inspect failed for %s: %.4096s\n" "$server" "$RESOURCE_DETAIL" >&2
        break
        ;;
    esac
    if ! running="$(docker container inspect --format '{{.State.Running}}' "$server")"; then
      printf "server state inspection failed: %s\n" "$server" >&2
      break
    fi
    if test "$running" != true; then
      printf "server stopped before readiness: %s\n" "$server" >&2
      break
    fi
    if /usr/bin/timeout --foreground 5 docker exec "$server" node -e 'fetch("http://127.0.0.1:3010/health/live",{signal:AbortSignal.timeout(2000)}).then(r=>{if(r.status!==200)process.exit(1)}).catch(()=>process.exit(1))'; then
      ready=1
      break
    fi
    sleep 1
  done
  if test "$ready" -ne 1; then
    classify_resource container "$server"
    if test "$RESOURCE_STATE" != owned; then
      printf "readiness failed for %s; bounded logs withheld for %s resource: %.4096s\n" "$server" "$RESOURCE_STATE" "$RESOURCE_DETAIL" >&2
      exit 1
    fi
    log_file="$work/readiness-${n}.log"
    set +e
    docker logs --tail 200 "$server" 2>&1 | node --input-type=module -e 'let remaining=32768;for await(const chunk of process.stdin){if(remaining>0){const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);const part=bytes.subarray(0,remaining);process.stdout.write(part);remaining-=part.length}}' > "$log_file"
    log_pipeline_status=("${PIPESTATUS[@]}")
    set -e
    docker_logs_status="${log_pipeline_status[0]}"
    log_cap_status="${log_pipeline_status[1]}"
    logs="$(<"$log_file")"
    if test "$docker_logs_status" -eq 0 && test "$log_cap_status" -eq 0; then
      printf "readiness failed for %s after 30 attempts\n%s\n" "$server" "$logs" >&2
    else
      printf "readiness failed for %s; docker logs status %s, cap status %s\n%s\n" "$server" "$docker_logs_status" "$log_cap_status" "$logs" >&2
    fi
    exit 1
  fi
  classify_resource container "$server"
  if test "$RESOURCE_STATE" != owned; then
    printf "refusing post-readiness removal for %s container %s: %.4096s\n" "$RESOURCE_STATE" "$server" "$RESOURCE_DETAIL" >&2
    exit 1
  fi
  docker rm -f "$server" >/dev/null
done

for n in 1 2; do
  volume="${namespace}-state-${n}"
  test_image="${namespace}-test-${n}"
  for test_name in "different uid rejects held roots" "read only volume rejects startup" "cross mount rejects native publication" "same device bind mount id mismatch rejects publication" "privileged owner and mode drift fail stops" "denied parent rejects startup" "disallowed filesystem rejects startup"; do
    run_owned --privileged --user 0:0 --mount "type=volume,source=${volume},target=/var/lib/firecrawl-browser-volume" -e LOCAL_BROWSER_STATE_ROOT=/var/lib/firecrawl-browser-volume/state -e ATOMIC_IMAGE_CASE=privileged-mount --entrypoint corepack "$test_image" pnpm exec vitest run --no-file-parallelism src/dockerfile.test.ts -t "$test_name"
  done
done

manifest_file="$work/playwright-v1.61.1-noble.manifest.json"
docker buildx imagetools inspect --raw mcr.microsoft.com/playwright:v1.61.1-noble > "$manifest_file"
read -r manifest_sha256 manifest_name < <(sha256sum "$manifest_file")
test "$manifest_name" = "$manifest_file"
test "${#manifest_sha256}" -eq 64
printf "%s\n" "$manifest_sha256" | rg "^[a-f0-9]{64}$"
expected_playwright_ref="mcr.microsoft.com/playwright:v1.61.1-noble@sha256:${manifest_sha256}"
docker buildx imagetools inspect "$expected_playwright_ref" >/dev/null
playwright_froms_file="$work/playwright-froms.txt"
if ! node --input-type=module -e 'import fs from "node:fs";const lines=fs.readFileSync(process.argv[1],"utf8").split(/\r?\n/).filter(x=>/^\s*FROM\b/i.test(x)&&/playwright/i.test(x));if(lines.length===0)process.exit(1);const refs=lines.map(line=>line.trim().split(/\s+/).find(x=>x.startsWith("mcr.microsoft.com/playwright:")));if(refs.some(ref=>typeof ref!=="string"||ref!==process.argv[2]))process.exit(1);process.stdout.write(`${refs.join("\n")}\n`)' apps/browser-service/Dockerfile "$expected_playwright_ref" > "$playwright_froms_file"; then
  printf "Playwright FROM validation failed\n" >&2
  exit 1
fi
mapfile -t playwright_froms < "$playwright_froms_file"
test "${#playwright_froms[@]}" -gt 0
for ref in "${playwright_froms[@]}"; do
  test "$ref" = "$expected_playwright_ref"
done
```

The two reproducibility build argv for each architecture are identical except
their unique `a`/`b` image tag. Exactly the addon and checksum are declared
reproducibility artifacts; audit maps/traces/objects/depfiles/input sidecars
are neither extracted nor mislabeled reproducible. Every functional and
reproducibility resource is cleaned if any intermediate build or check fails.
The final manifest block refetches raw Playwright bytes after both image suites,
recomputes their digest, parses every Playwright `FROM`, and requires each
literal reference to equal the immutable inspected digest before cleanup and
commit.


Stage exactly the 11 net
Task 6 files above, run actual hook, then one compliant original Task 6 commit;
do not make a separate atomic-publication Docker commit.

```bash
git add apps/browser-service/src/streams.ts apps/browser-service/src/streams.test.ts apps/browser-service/src/artifacts.ts apps/browser-service/src/artifacts.test.ts apps/browser-service/src/server.ts apps/browser-service/src/server.test.ts apps/browser-service/src/index.ts apps/browser-service/Dockerfile apps/browser-service/src/dockerfile.test.ts apps/browser-service/scripts/init-state-volume.mjs apps/browser-service/scripts/init-state-volume.test.mjs
git diff --cached --name-only
apps/api/.husky/_/pre-commit
git diff --cached --name-only
git diff --cached --check
git commit -m "feat: serve private browser sessions" -m "Add authenticated browser transports after locked volume initialization
and verified native publication startup.

Ship only attested runtime artifacts in the non-root service image."
```

## Deferred master-plan Task 14 amendment — do not execute in this plan

**Prerequisites:** Deferred Task 6 image/init acceptance PASS and all original
master Tasks 7-13 complete.

**Owned files:**

```text
compose.local.yaml
.env.example.local
scripts/local-firecrawl
scripts/local-firecrawl.test.mjs
apps/api/package.json
apps/api/src/harness.ts
apps/api/src/harness-browser-service.ts
apps/api/src/harness-browser-service.test.ts
```

Amend master Task 14 TDD before implementation:

1. Named volume mounts only at trusted parent
   `/var/lib/firecrawl-browser-volume` in init and Browser Service. API has no
   read-only or read-write browser-state mount. Browser root passed to service
   is child `/var/lib/firecrawl-browser-volume/state`.
2. Init service holds parent-directory flock and selects locked init-new or
   validate-existing before Browser Service. Wrapper trace is init, Browser
   live/preflight, dependencies, MinIO init, API, API reconciliation, ready.
3. Tests seed valid intents/temps/wrappers, restart, and prove bytes preserved
   then recovered. Invalid marker/owner/mode/mount fails before Browser/API.
4. Downgrade invokes copied offline rollback checker first. Failure aborts
   downgrade without deletion/repair; success alone permits older image.
5. Rendered Compose proves API-no-mount, no Browser public port, exact init
   dependency, named-volume persistence, final UID, and one metrics owner.
6. Keep `LOCAL_BROWSER_SERVICE_ENABLED=false` through all RED/GREEN work. Only
   final downstream acceptance commit, after named-volume restart and real
   persistent canary pass, may set Compose and documented local default true.
7. Add exact `apps/api/package.json` script:

   ```json
   "test:local-firecrawl:lifecycle": "node ../../scripts/local-firecrawl.test.mjs --full-lifecycle"
   ```

   The harness rejects missing, equal, tag-only, or non-`@sha256:` candidate/
   rollback refs before Docker mutation.

RED/GREEN commands:

```bash
node --test scripts/local-firecrawl.test.mjs
pnpm --dir apps/api exec vitest run --no-file-parallelism src/harness-browser-service.test.ts
docker compose --project-name firecrawl --project-directory . -f compose.yaml -f compose.local.yaml config --quiet
docker compose --project-name firecrawl --project-directory . -f compose.yaml -f compose.local.yaml config --format json
docker compose --project-name firecrawl --project-directory . -f compose.yaml -f compose.local.yaml build browser-service api
pnpm --dir apps/api run test:local-firecrawl:lifecycle
```

First run is RED before amendment. For GREEN, CI/operator exports actual
distinct immutable `FIRECRAWL_ACCEPTANCE_CANDIDATE_IMAGE` and
`FIRECRAWL_ACCEPTANCE_ROLLBACK_IMAGE` `@sha256:` references; the harness itself
validates them before mutation. The exact command remains:

```bash
pnpm --dir apps/api run test:local-firecrawl:lifecycle
```

This package command is the sole lifecycle gate and owns one unique labeled
Compose project. It must, in one invocation:

1. Render/inspect API-no-volume plus init/browser-only parent-volume topology.
2. Create a fresh named volume, run `init-new`, start candidate with an
   acceptance-only enable override, wait for real readiness and compiled-addon
   canary, publish a real profile through API, and record manifest/content ID.
3. Restart Browser Service; then fully stop/start without `down -v` so init
   runs `validate-existing`. After both restarts require byte-identical profile
   state and a new successful real canary after each restart.
4. Stop primary, clone its volume into a disposable rejection project, insert
   one test-owned closed-grammar reserved-state fixture as uid `1000`, and prove
   wrapper rejects rollback before any rollback container is created/started.
   Destroy the clone project/volume without deleting the fixture to force pass.
5. On untouched primary, wait for natural reconciliation to reach zero intent/
   temp/wrapper/manifest/canary/private-deletion state; require read-only checker
   success, deploy immutable rollback image, and prove preserved profile bytes
   plus healthy API behavior.
6. In `finally`, remove candidate/rollback containers, networks, both volumes,
   extraction/state, and override files; query exact Compose project labels and
   fail if any resource or cleanup error remains. Query containers, networks,
   and volumes with `com.docker.compose.project` equal to the generated unique
   primary project value and the disposable rejection project's generated
   value; every result set must be empty.

After implementation and both Task 6 image suites, every static command and
this full lifecycle command must be GREEN with `LOCAL_BROWSER_SERVICE_ENABLED`
still false.
Stage only eight owned Task 14 files, run actual hook, and commit wiring with
flag false:

```bash
git add compose.local.yaml .env.example.local scripts/local-firecrawl scripts/local-firecrawl.test.mjs apps/api/package.json apps/api/src/harness.ts apps/api/src/harness-browser-service.ts apps/api/src/harness-browser-service.test.ts
git diff --cached --name-only
apps/api/.husky/_/pre-commit
git diff --cached --name-only
git diff --cached --check
git commit -m "feat: wire persistent browser state" -m "Gate Browser Service startup on locked named-volume initialization and
keep API containers outside the browser-state trust boundary.

Leave local activation disabled until persistent acceptance passes."
```

After the wiring commit, rerun the same exact immutable-image gate and require
zero-resource cleanup before activation:

```bash
pnpm --dir apps/api run test:local-firecrawl:lifecycle
```

Only that zero exit authorizes staging the two activation files and the
separate final commit:

```bash
git add compose.local.yaml .env.example.local
git diff --cached --name-only
apps/api/.husky/_/pre-commit
git diff --cached --name-only
git diff --cached --check
git commit -m "feat: enable local browser service" -m "Enable the local Browser Service only after image, init, restart,
API-isolation, rollback, and persistent-canary acceptance pass."
```

## Final plan self-review matrix

| Committed spec section | Plan owner |
|---|---|
| Decision and threat model | Tasks 1-9; deferred Task 6 mount harness |
| Trusted namespace provisioning | Deferred Tasks 6 and 14 |
| Filesystem and mount proof | Task 4; privileged cases deferred Task 6 |
| Recoverable target-parent canary | Task 4 |
| Global recovery and reservation bounds | Tasks 3, 5, and 7 |
| Names and tuple semantics | Task 2 |
| Bounded phase-specific intent | Task 2 |
| Canonical identity manifest | Tasks 2 and 6 |
| Exhaustive stable-record validity | Tasks 2 and 7 |
| Durable intent transitions | Tasks 5-7 |
| Reconciliation-owned capability and effect boundary | Task 3 |
| Private construction and publication | Task 5 |
| Prepare/finalize source deletion | Task 6 |
| Mandatory post-call location proof | Tasks 4-6 |
| Operation-specific adoption authority | Task 7 |
| Startup and Task 3 quarantine ordering | Task 7 |
| Capability transfer and release | Tasks 6-8 |
| Native boundary and ABI | Tasks 1, 3, and 4 |
| Crash recovery and cleanup matrix | Tasks 4-7 |
| Build, loading, Docker, and preflight | Task 1; deferred Task 6 |
| RED and adversarial verification | Every task; Task 10 acceptance |
| Exact current and deferred file scope | File map; Tasks 1-9; deferred sections |
| Rollout and observability | Tasks 7 and 9; deferred Tasks 6 and 14 |

- [ ] Current implementation has 9 TDD tasks plus one acceptance gate; deferred
  Task 6/14 sections are explicitly non-executable here.
- [ ] Pure codec/reducer modules own no I/O, WeakMap, authority, fd, procfd,
  native binding, or reconciliation/ProfileStore/Registry import.
- [ ] Reconciliation controller/semantic registry/PreReady bridge is GREEN in
  Task 3 before mount/publication/deletion/recovery reducer slices.
- [ ] Oversized durable engine is split into codec, protocol/controller,
  mount/canary, publication, source cleanup, and recovery/adoption/metrics
  tasks; every task has RED, GREEN, reviews, exact staging, and one commit.
- [ ] Manifest parse result retains version, operation ID, startup binding,
  target locator digest, and entries.
- [ ] Native build uses x64/arm64 allowlist, split translation units, unique
  staging depfiles, separately forced alias/distinct errno variants, inherited
  fd-9 no-fork flock chain, exact staging-only compile/link/map/trace argv,
  atomic checksum-last publication/recovery, unconditional second-build spawn
  counts, pure/fixed-package loader validation, and a build immediately before
  every addon load.
- [ ] Task 1 commits complete concrete `amd64`/`arm64` `dockerInit` tuples and
  both isolated probes. Deferred Task 6 selects/verifies one tuple without
  editing the allowlist and extracts/compares addon plus checksum from two
  independent no-cache builds per architecture.
- [ ] Three named `.inputs.sha256` sidecars contain the complete exact inventory
  schemas; no inventory leaf exists or is accepted by staging recovery.
- [ ] Held-procfd effects use strict single leaves, procfs preflight, numeric
  flags, pre/post-await full-chain gates, exact create/open/removal sequences,
  and no claimed Node `mkdirat`/`openat`/`unlinkat` API.
- [ ] Intent/manifest persistence carries pinned temp object/full evidence and
  canonical bytes/digest; it performs no hidden reopen/read/hash. Public
  ProfileStore prepare/finalize first becomes GREEN with Task 6 deletion.
- [ ] Pre-ready adopted capabilities remain sealed in reconciliation until one
  ProfileStore constructor and one Registry CAS install the immutable bundle;
  runtime publication attaches once to the existing installed store.
- [ ] Host tests claim only unprivileged host behavior. Image/UID/privileged/
  mount/named-volume claims remain deferred with exact Docker harness owner.
- [ ] Deferred init owns trusted parent plus child state/profiles/staging,
  exact held fchown/chmod/fsync, marker, flock, validate-only preservation, and
  API-no-mount topology.
- [ ] Current rollback checker and metrics have exact owners; Task 6/14 only
  wire/copy/invoke them.
- [ ] Local feature activation remains false until separate final Task 14
  downstream commit, authorized only by the exact full-lifecycle package command
  with immutable images and zero labeled acceptance resources afterward.
- [ ] Current twelve Task 4 files are committed only after their atomic slice
  passes both reviews; no broad staging exists.
- [ ] Placeholder scan is empty:

```bash
! rg -n 'T[O]DO|T[B]D|F[I]XME|<i[n]sert|p[l]aceholder|as n[e]eded|and s[o] on' docs/superpowers/plans/2026-07-22-atomic-directory-publication.md
```

- [ ] Type/ownership scan finds expected definitions and no forbidden imports:

```bash
rg -n 'CleanupIdentityManifestV1|AtomicReducerStepV1|AtomicEffectRequestV1|AtomicEffectObservationV1|ApplyAtomicEffectV1|PreReadyRecoveryAuthority|withNativeOperands' docs/superpowers/plans/2026-07-22-atomic-directory-publication.md
```

- [ ] Commit messages and body lines are at most 72 characters; `git diff
  --check` passes; approved spec has no diff; only plan file changed by this
  planning task.
