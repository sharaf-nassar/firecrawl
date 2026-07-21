# Codex Browser Gate Rolling-Version Design

## Context

The Browser Interact Gate currently requires the active CLI to report exactly
`codex-cli 0.144.5`. The first `codex` executable resolved through the current
`PATH` now reports `codex-cli 0.144.6`, so the Gate fails before exercising
the compatibility checks that establish whether the installed app-server can
support the Browser Interact contract.

Characterization against 0.144.6 produced the same canonical generated-schema
hash and feature-inventory hash as 0.144.5. The failure is therefore caused by
the release-label allowlist, not an observed protocol or feature change. Since
Codex is upgraded frequently on this host, the Gate should test capabilities
of the active installation and report its version instead of requiring a
repository edit for every compatible release.

## Goals

- Use the active `codex` selected by `PATH` when the Gate starts.
- Accept compatible Codex releases without a version-specific repository
  change.
- Strictly validate and report the active Codex semantic version.
- Detect an executable or version change during one Gate invocation.
- Preserve all existing protocol, feature, action-loop, safety, isolation, and
  cleanup requirements.
- Keep schema and feature hashes useful for diagnostics and consistency checks
  without turning them into cross-release allowlists.
- Resume Browser Interact foundation Task 8 after this design is implemented,
  tested, and reviewed.

## Non-Goals

- Do not search NVM directories, npm caches, filesystem prefixes, or package
  registries for the numerically greatest installed Codex release.
- Do not install, downgrade, or upgrade Codex.
- Do not relax generated-schema validation, feature policy, event auditing, or
  the live two-turn action/final behavior.
- Do not select model or reasoning effort dynamically.
- Do not add a minimum-version rule or a per-version compatibility table.
- Do not alter production Browser Service behavior, enable its rollout, or
  expand Task 8 scope.

## Meaning of Latest Installed

For this Gate, "latest installed" means the first executable named `codex`
that the Gate's inherited `PATH` resolves at invocation start. This matches
the Codex that Claude, Codex, and an operator receive in the same environment.
It does not mean scanning all possible installations and comparing versions.

An operator controls selection by updating `PATH` or the executable to which
its first matching entry resolves before starting the Gate. A later Codex
installation that is not active on `PATH` is intentionally ignored.

## Approved Design

### Active executable identity

Before any live run, the Gate resolves `codex` once using `PATH` order and
records an identity containing:

- the selected executable path;
- its resolved real path;
- its filesystem device and inode; and
- the parsed semantic version returned by that executable.

The Gate uses that selected executable for every schema, feature, and
app-server process in the invocation. It must not independently resolve a
possibly different `codex` for each child process.

After all requested live runs and before emitting PASS, the Gate resolves the
first `codex` from the original `PATH` again, records the same identity fields,
and invokes `--version` again. The preflight and post-run identities must be
equal. A changed `PATH` winner, symlink target, executable file, or reported
version fails the invocation. This prevents a successful result from combining
evidence from two Codex installations.

### Strict version parsing

Successful `codex --version` output must be exactly one line with this shape:

```text
codex-cli <semver>
```

`<semver>` follows SemVer 2.0.0: three numeric core components without illegal
leading zeroes, with optional valid prerelease and build metadata. Leading or
trailing whitespace, extra lines, a different product name, a missing patch
component, or arbitrary suffix text is invalid. The parsed semantic-version
string, including any prerelease or build metadata, is the version printed in
the PASS line.

There is no comparison against a pinned version, minimum version, or list of
known versions. Valid syntax identifies the build; capability checks determine
compatibility.

### Capability compatibility contract

Every existing compatibility check remains mandatory:

- generate the installed app-server V2 schema and parse every JSON file with
  the lossless parser;
- require the bundle file, structural validity, supported schema vocabulary,
  and all required definitions, including `ThreadStartParams`,
  `TurnStartParams`, `ThreadStartResponse`, and
  `TurnCompletedNotification`;
- validate every sent parameter and received result against the generated
  schemas;
- validate the complete feature inventory against the disabled-feature list,
  reviewed enabled non-tool features, and tool-surface policy;
- start one isolated app-server process and one ephemeral thread per live run;
- keep approval policy `never`, sandbox `read-only`, no dynamic tools, no MCP
  configuration, no environments, and no runtime workspace roots;
- require the exact first-turn structured `fill` action, execute it once,
  validate cached replay and mismatch rejection, then require the exact
  second-turn final result;
- reject forbidden events, forbidden items, unknown thread or turn identities,
  late messages, tool activity, and approval activity;
- require exact turn, action, write, tool, and approval counts; and
- retain all temporary-root modes, detached-process supervision, timeout,
  signal, cleanup, and cross-run identity-isolation checks.

Model remains pinned to `gpt-5.6-terra`. Reasoning effort remains pinned to
`medium`. A Codex release that changes either required live behavior or any
safety boundary fails even if its version is newer.

### Version-neutral schema digest

Generated schema files retain their relative paths and lossless canonical
contents. For hashing only, each file receives this fixed logical prefix:

```text
host/browser-runtime/protocol/codex-app-server/<relative-path>
```

The prefix contains no release label. No directory with that logical name is
created, and generated files remain inside the invocation's private temporary
root. Removing `0.144.5` from hash framing ensures a release label alone cannot
change the protocol digest.

All other canonicalization rules remain unchanged: normalized separators,
lexicographic path ordering, existing framing, lossless JSON normalization, and
SHA-256. A content or relative-path change still changes the digest.

### Hash semantics

Schema and feature hashes are observability fields and within-invocation
consistency assertions:

- every live run in one invocation must produce the same schema hash;
- every live run in one invocation must produce the same feature hash; and
- the successful PASS line reports both hashes.

The Gate does not compare either hash with a repository constant, historical
result, or per-version allowlist. Compatibility comes from structural schema
validation, explicit feature policy, and live behavior. Hashes make unexpected
changes visible and prevent one invocation from silently combining divergent
results.

## Success and Failure Behavior

A successful live invocation retains one stdout line and existing field order:

```text
codex_browser_gate: PASS runs=<runs> version=<detected-semver> model=gpt-5.6-terra effort=medium turns=<turns> actions=<actions> writes=<writes> tools=0 approvals=0 schema=<sha256> features=<sha256>
```

Named deterministic self-tests remain independent of an installed Codex and
retain their current output. Normal preflight remains silent.

Failure behavior stays fail-closed: one rendered error plus newline goes to
stderr, exit status is `1`, and no PASS line is emitted. Existing error codes
remain unchanged except where version handling needs these explicit outcomes:

- initial resolution failure, nonzero `--version`, or invalid version output:
  `codex_version_mismatch`;
- any post-run resolution, filesystem identity, or semantic-version difference,
  including a missing or invalid replacement: `codex_version_changed`.

The post-run check occurs before PASS output. Cleanup still runs for version
failures, and primary-before-cleanup error aggregation remains unchanged. Error
details may include sanitized version text or an identity-field name but must
not expose environment contents, authentication data, or temporary paths.

## Testing and Verification Strategy

Implementation follows test-driven development. First update characterization
tests so the current pinned behavior fails against the approved rolling
contract, then make the smallest production changes needed to pass.

Deterministic tests must cover:

- valid stable, prerelease, and build-metadata version output;
- malformed product names, whitespace, extra lines, incomplete versions,
  illegal leading zeroes, and invalid prerelease syntax;
- PATH selection choosing only the first executable;
- no scanning or numeric comparison of inactive installations;
- every post-run identity difference producing
  `codex_version_changed` before PASS;
- the selected executable being reused for schema, feature, app-server, and
  post-run commands;
- version-neutral schema framing producing equal hashes for identical content
  attributed to different Codex releases;
- schema content and relative-path changes still changing the hash;
- multiple runs still rejecting inconsistent schema or feature hashes; and
- unchanged model, effort, capability, forbidden-event, action-loop,
  isolation, lifecycle, output, and cleanup contracts.

Verification then runs the standalone canonicalizer suite, complete Gate
characterization suite, every named self-test, and the live three-run Gate with
the active Codex. The live PASS line must report the preflight-detected version,
all three runs must agree on both hashes, and tool and approval counts must be
zero. Run the repository's actual pre-commit hook after focused verification.

## Documentation and Supersession

This document supersedes only exact Codex `0.144.5` requirements for the
Browser Interact Gate in these earlier documents:

- `docs/superpowers/specs/2026-07-19-local-browser-interact-runtime-design.md`;
- `docs/superpowers/specs/2026-07-20-codex-browser-gate-modularization-design.md`;
- Gate0 sections of
  `docs/superpowers/plans/2026-07-19-browser-interact-gate-and-state.md`; and
- Gate implementation sections of
  `docs/superpowers/plans/2026-07-20-codex-browser-gate-modularization.md`.

Those documents remain historical records and are not bulk rewritten. Their
model, reasoning-effort, protocol, safety, lifecycle, and live-behavior
requirements remain authoritative unless this design explicitly replaces
them. Broader host deployment plans that intentionally pin a packaged Codex
artifact are outside this change.

After the rolling-version implementation passes requirements and quality
review, Browser Interact foundation Task 8 resumes against the active Codex.

## Rejected Alternatives

### Per-version hash allowlist

This preserves a static release approval step but forces a repository change
for every compatible upgrade. Hash equality also cannot replace structural and
live behavior validation. Rejected because it recreates the operational block
this design removes.

### Minimum semantic version

A lower bound permits newer releases without edits but says nothing about
protocol or safety compatibility. A newer version can regress a required
capability. Rejected because the existing capability suite is stronger and
more directly tied to Browser Interact requirements.

### Scan all installations and choose the greatest version

This would make Gate selection differ from normal `codex` invocation, require
installation-manager-specific discovery, and risk selecting an unconfigured or
unauthenticated binary. Rejected in favor of standard `PATH` semantics.
