# Atomic Directory Publication Design

**Date:** 2026-07-22

**Status:** Approved

**Scope:** Task 4 Browser Service profile publication hardening

## Decision

Build profile directories in a trusted private staging namespace and publish
them with a minimal Linux Node-API addon that calls dirfd-relative
`renameat2(..., RENAME_NOREPLACE)`. Unsupported native loading, kernels,
filesystems, ownership, permissions, or mount layouts fail Browser Service
readiness. There is no pathname or non-atomic fallback.

Node-API supplies an ABI-stable native interface across Node releases, while
Linux `renameat2` supplies the required atomic no-replace primitive:
[Node-API](https://nodejs.org/download/release/latest-v22.x/docs/api/n-api.html)
and [renameat2](https://man7.org/linux/man-pages/man2/renameat2.2.html).

## Threat model

Before startup, an untrusted different-UID actor may prepopulate or corrupt
persisted browser state and may swap configured root or ancestor pathnames. It
may leave files, directories, hard links, symlinks, mount aliases, collisions,
or malformed durable records for reconciliation to reject.

The staging tree is a distinct protection boundary: trusted deployment init
creates it under a non-attacker-writable volume parent, sets its exact runtime
owner/mode, and never exposes it through an actor-writable mount. Trusted init
also owns every public profile parent as the Browser Service UID with mode
`0700`. After validation and for the entire operation, neither staging nor a
held public profile parent is writable by the actor. The actor cannot replace
held handles, act as root, or compromise the kernel.

“Distinct” means a DAC/mount-exposure boundary inside the same allowlisted
filesystem mount required for atomic rename, not a different filesystem. Any
writable bind/ACL must not cover the state root, public profile parents, or
`.profile-publish-staging`. Same-service-UID code execution, privileged mount
mutation, and root/kernel compromise are out of scope. Detected owner, mode,
device, mount, or held-chain drift causes process-global fail-stop.

Required outcome:

- service data is never replaced by a conflicting destination;
- no attacker-selected inode is accepted as created or published data;
- failure never removes an entry without proven service ownership and location;
- only a completely synced, pinned bundle can enter a public namespace;
- a successful publish transfers held authority without reopening a pathname;
- readiness is unavailable whenever any claim cannot be proved.

## Why `mkdir` followed by `lstat` is insufficient

`mkdir(parent/name)` returns no handle or inode evidence and cannot express
no-replace transfer of a fully synced private tree. In a writable or
misconfigured parent, a later `lstat/open/fstat` could inspect a different
entry; this configuration is now rejected before operation rather than treated
as an in-scope concurrent race.

Held trusted parents make identity-pinned public source acquisition safe under
serialized service ownership. New public data still uses one atomic
private-to-public no-replace syscall so collision, crash, and publication state
have exact semantics. Native rename source is always private staging; public
source deletion never uses the native publisher.

## Trusted namespace provisioning

Reserved layout:

```text
<browser-state-root>/.profile-publish-staging/
  intents/
  bundles/
```

Trusted deployment init exclusively creates the browser-state root,
`.profile-publish-staging`, `intents`, and `bundles` from a held
non-attacker-writable volume parent before Browser Service starts. Absent
creation uses nonrecursive `mkdir(..., 0700)` and treats `EEXIST` as failure in
that init run. Init opens each result with `O_DIRECTORY | O_NOFOLLOW`, verifies
identity, syncs each child and parent, then drops privileges before service
exec. It never clears a directory from an earlier run; a separate validation
mode accepts existing roots only when their metadata/identity is valid and
leaves all contents untouched so Browser Service can recover restart intents.

Browser Service is validation-only for all four staging ancestors. It never
calls mkdir, chmod, chown, rename, repair, or recursive cleanup to establish
the staging root, `intents`, or `bundles`. It opens each through its held parent
with `O_DIRECTORY | O_NOFOLLOW`, then rejects absence, links,
non-directories, wrong owner, any mode other than `0700`, zero link count,
disallowed filesystem, or changed parent chain. It preserves valid existing
intents, temps, wrappers, and payloads for bounded recovery.

Exact invariants for `.profile-publish-staging`, `intents`, `bundles`,
`profiles`, every profile UUID directory, and every `working`, `staging`, and
`committed` parent are: owner equals effective Browser Service UID, mode
exactly `0700`, directory type, no symlink, positive link count, `st_dev` equal
to the held browser-state root, and membership in the current held root/startup
binding. Each publication's native precheck additionally proves equal statx
mount ID for its actual source and target parent. Existing valid `intents` and
`bundles` survive restart unchanged for recovery. Unknown or invalid reserved
entries fail readiness; they are never eagerly deleted.

No public profile directory is created by this provisioning path. Profile
scaffolding itself uses atomic publication below.

## Filesystem and mount proof

Before reconciliation or publication, Node `statfs` must identify every held
staging and public parent as exactly one of this allowlist:

- ext2/ext3/ext4: `0xef53`;
- XFS: `0x58465342`;
- Btrfs: `0x9123683e`;
- tmpfs: `0x01021994`; or
- OverlayFS: `0x794c7630`.

NFS, CIFS/SMB, FUSE, network, unknown, and user-configured filesystem types
are rejected even if a one-shot rename appears to work. No override exists.

The native call performs `statx` with `AT_EMPTY_PATH | AT_NO_AUTOMOUNT` and
requires `STATX_MNT_ID` for both directory fds. It requires equal mount IDs in
addition to directory type and equal `st_dev`. Missing statx support or mount
ID is `atomic_publish_unsupported`; unequal mount IDs or devices is
`atomic_publish_cross_device`. Thus bind mounts with reused device numbers
cannot pass. There is no cross-device copy or rename fallback.

Recovery repeats `statfs` on freshly opened staging and exact target-parent
handles. It requires allowlisted types and equal `st_dev`, then completes a
durable target-parent canary whose native call proves equal fresh statx mount
ID. No prior-process mount result is reused for classification or cleanup.

### Recoverable target-parent canary

A canary is an ordinary bounded intent with one immutable attempt. Before native
no-replace, intent persists canaryProof `planned` with exact private/public
leaves. Matching published empty directory is recorded `published` with
dev/ino/mode/digest and proves current mount. No replacement/history exists.

On restart, unfinished durable canary reopens same source/target parents and
runs fresh statfs. While proof is `planned` or `published`, it re-executes native
no-replace for the same publication leaves and performs held canonical
two-location proof. Pre-state may retry to success; post-state may return
`ENOENT` because the exact source already moved and the exact public target now
matches. The narrow authenticated replay rule below treats either as expected
same-attempt publication, so the current native statx equality is fresh mount
proof without replacement evidence. Conflict/mismatch fails closed. A new
canary record is created only when no unresolved canary already exists for exact
target parent.

For cleanup, persist canaryProof `deleting`, authenticate published canary as
protected-public source, and native-move it no-replace into absent private
`deletion-<operation-id>-0` under its wrapper. Prove public/private
locations after every result, sync both parents, then delete only pinned private
tree through manifest cursor. Never unlink canary from public parent. Proof
becomes `cleaned` only after private absence/sync. Canary leaves remain protected
while exact intent exists; orphan fails readiness.

The only nonfatal `ENOENT` rule is canary same-attempt replay. Native prechecks
and fresh statfs/statx must succeed; stable intent must bind the exact source
identity and leaves; and post-call canonical proof must find source absent plus
either the exact matching public canary target for publication replay or the
exact matching private deletion identity for cleanup replay. The latter uses
the attempt-zero root identity plus manifest/cursor-consistent remaining tree.
Normalize that result to `atomic_publish_replay_completed`, advance or finish
the expected durable phase, accept the current call's mount proof, and do not
close admission. Persist replay-completed when filling a null classification;
if classification is already durable, validate it unchanged and use the replay
result only as current-process proof. A mismatch, both/neither unexplained,
wrong phase/attempt, or any other `ENOENT` is
`atomic_publish_binding_invalid` and globally fail-stops.

If durable `deleting` evidence already places the canary in its private deletion
tree, or its cursor proves that tree partially/fully removed, recovery skips the
original private-proof-to-public publication. It resumes or finishes only the
private manifest cleanup authorized by `deleting`/`cleaned` evidence; it does
not require either original publication leaf to exist. A fully cleaned canary
does not itself supply fresh mount proof for other work; after its intent is
finished, recovery creates a new canary only if that parent still needs proof
and has no unresolved canary.

For `N` ordinary records across distinct target parents, `N` is at most 512
because every parent has at least one counted ordinary record. Recovery reserves
one fresh durable canary per distinct parent from 512 nonconsumable recovery
slots, so `512 >= N` guarantees headroom. Duplicate-parent work reuses first
successful proof. If recovery crashes, durable canary retries same attempt next
start and never allocates replacement/history.

## Global recovery and reservation bounds

Active stable intents have hard cap 512 across normal and canary kinds. During
pre-ready recovery, transient recovery records/temps may raise record total to
1,024 using 512 nonconsumable slots. Recovery processes target parents
sequentially, cleans/reuses scratch, and returns to at most 512 before ready.

User/profile payload entries have independent aggregate cap 25,000 and bytes
cap 1,073,741,824. Operational canary/proof/private-deletion directory scratch
has a separate cap of 1,024 filesystem entries and does not reduce user payload
or metadata-file budgets.
Operational stable metadata permits at most 3,072 files, 100,663,296 stable
manifest bytes, and 12,582,912 other stable metadata bytes. Reserved
metadata-file scratch permits at most 1,024 files, 33,554,432 manifest-temp
bytes, and 4,194,304 other temp bytes. Hard metadata totals are exactly 4,096
files, 134,217,728 manifest bytes, and 16,777,216 other metadata bytes.

Each manifest remains at most 25,000 entries, 33,554,432 encoded bytes, and
1,024-byte paths. Each user payload remains at most 25,000 entries and
268,435,456 bytes under existing depth/path/file limits. Overall bounded
filesystem-entry total is exactly 25,000 user payload + 1,024 scratch + 4,096
metadata = 30,120; categories never borrow from each other.

A generation-scoped reservation ledger updates synchronously before any await,
open, create, copy, hash read, intent temp, wrapper, or canary effect. Concurrent
operations serialize that synchronous reservation through admission; a
would-be count or byte over limit fails before effect. Reservations never
refund in-process after an ambiguous or close-unverified result. Restart
re-enumerates and reserves all durable state before cleanup or classification.
Exactly-at-maximum restart must succeed without creating normal work; the next
normal/canary/metadata/payload entry or byte fails synchronously.

Reads/hashes stream bounded chunks. File stat size is synchronously reserved
before first content read and exact EOF/trailing-byte checks follow. Manifest
encoder reserves before each buffer append and before temp creation; stable and
temp copies charge their stable/scratch partitions. Intent/other metadata
reserves encoded bytes before write. No parser buffers bytes beyond its
per-file, partition, and hard-total reservations.

## Names and tuple semantics

Exact private grammar:

```text
intents/<operation-id>.json
intents/<operation-id>.<phase>.<transition-id>.tmp
intents/<operation-id>.identities.json
intents/<operation-id>.identities.<transition-id>.tmp
bundles/<operation-id>/
bundles/<profile-operation-id>/payload/
bundles/<canary-operation-id>/proof-<canary-operation-id>-0/
bundles/<canary-operation-id>/deletion-<canary-operation-id>-0/
bundles/<prepare-or-finalize-id>/delete-<prepare-or-finalize-id>/
```

Operation and transition IDs are canonical lowercase UUIDs. `phase` is one of
`allocated`, `building`, `aborting_prepublication`, `ready`, `classified`,
`renamed`, `manifest_planned`,
`manifest_published`, `source_deleting`, `adopted`, `discarding`,
`manifest_deleting`, or `cleaned`. Target-parent canaries use only
`canary-<canonical-lowercase-uuid>-0` public leaves and
`proof-<canonical-lowercase-uuid>-0` private leaves under the same record.
Attempt is exactly decimal `0`; any replacement/history, other number, or
operation-kind-incompatible leaf fails readiness. Anything else fails
readiness.

Terms never alias:

- **operation**: logical canary/scaffold/working/prepare/finalize attempt
  identified by operation ID;
- **wrapper**: private `bundles/<operation-id>/` cleanup container that is
  never published;
- **payload**: profile-only pinned `wrapper/payload/` publication source;
- **intent**: sibling durable state record under `intents`, never inside the
  payload and never published;
- **identity manifest**: separate canonical cleanup/source evidence bytes whose
  exact filename/hash/count/size are bound by the stable intent;
- **target**: one exact public profile or generation leaf under a held parent;
- **publication tuple**: operation ID, kind, startup binding, source wrapper
  identity, kind-specific private-source identity, target locator/parent
  identity, checksum, size,
  and phase.

Scaffold/working/prepare/finalize wrappers contain exact publication leaf
`payload`; prepare/finalize may later also contain exact source-cleanup leaf
`delete-<operation-id>`. Canary wrappers contain exact publication leaf
`proof-<operation-id>-0` and may later also contain exact cleanup leaf
`deletion-<operation-id>-0`; they never contain `payload` or `delete-...`.
No wrapper may contain a leaf from another operation-kind grammar or any
unlisted coexisting leaf. Wrapper remains private and is removed after its
exact allowed leaves are absent.

## Bounded phase-specific intent

An intent is canonical UTF-8 JSON, at most 16 KiB, with no BOM, duplicate keys,
unknown fields, non-NFC strings, or unsafe numbers. Exact closed fields are:

```ts
type HeldParentEvidenceV1 = Readonly<{
  dev: string;
  ino: string;
  mode: 448;
}>;

type PublicationTargetV1 =
  | Readonly<{
      kind: "profile";
      profileId: CanonicalUuid;
      leaf: CanonicalUuid;
      parent: HeldParentEvidenceV1;
    }>
  | Readonly<{
      kind: "profile_state";
      profileId: CanonicalUuid;
      state: "working" | "staging" | "committed";
      generationId: CanonicalUuid;
      leaf: CanonicalUuid;
      parent: HeldParentEvidenceV1;
    }>
  | Readonly<{
      kind: "canary_parent";
      parentLocator:
        | Readonly<{ kind: "profiles" }>
        | Readonly<{
            kind: "profile_state";
            profileId: CanonicalUuid;
            state: "working" | "staging" | "committed";
          }>;
      parent: HeldParentEvidenceV1;
    }>;

type AtomicPublishIntentV1 = Readonly<{
  version: 1;
  operationId: CanonicalUuid;
  kind: "canary" | "scaffold" | "working" | "prepare" | "finalize";
  phase: "allocated" | "building" | "aborting_prepublication" |
    "ready" | "classified" |
    "renamed" | "manifest_planned" | "manifest_published" |
    "source_deleting" | "adopted" | "discarding" |
    "manifest_deleting" | "cleaned";
  binding: Readonly<{
    processNonce: string;
    controlGenerationNonce: string;
    snapshotDigest: Sha256;
  }>;
  target: PublicationTargetV1;
  wrapper: Readonly<{
    dev: string;
    ino: string;
    mode: 448;
  }> | null;
  privateSource: Readonly<{
    dev: string;
    ino: string;
    mode: 448;
    checksum: Sha256;
    byteSize: number;
  }> | null;
  publicSource: Readonly<{
    profileId: CanonicalUuid;
    state: "working" | "staging";
    generationId: CanonicalUuid;
    dev: string;
    ino: string;
    mode: 448;
    checksum: Sha256;
    byteSize: number;
    capabilityDigest: Sha256;
  }> | null;
  classification: Readonly<{
    outcome: "unpublished" | "conflict" | "published" | "ambiguous";
    nativeCode: "success" | "atomic_publish_replay_completed" |
      "atomic_publish_exists" |
      "atomic_publish_unsupported" | "atomic_publish_cross_device" |
      "atomic_publish_binding_invalid" | "atomic_publish_denied" |
      "atomic_publish_invalid_argument" | "atomic_publish_io";
    sourceMatches: boolean;
    targetMatches: boolean;
    targetOther: boolean;
    evidenceDigest: Sha256;
  }> | null;
  sourceDeletion: Readonly<{
    phase: "pending" | "moved_private" | "removing" | "removed";
    privateDeletionLeaf: `delete-${CanonicalUuid}`;
    evidenceDigest: Sha256;
    nextIndex: number;
  }> | null;
  adoption: Readonly<{
    authority: "scaffold" | "registry" | "prepare_token" |
      "reconciliation_snapshot";
    authorityDigest: Sha256;
  }> | null;
  cleanup: Readonly<{
    phase: "aborting_prepublication" | "discarding" | "cleaned";
    outcome: "never_attempted" | "unpublished" | "conflict" |
      "released_to_reconciliation" | "adopted" | "canary_complete";
    evidenceDigest: Sha256;
    suffix: "private_source_entries" | "private_source_root" | "wrapper_temps" |
      "wrapper_root" | "intent_temps" | "done";
    nextIndex: number;
  }> | null;
  canaryProof: Readonly<{
    attempt: 0;
    sourceLeaf: `proof-${CanonicalUuid}-0`;
    targetLeaf: `canary-${CanonicalUuid}-0`;
    deletionLeaf: `deletion-${CanonicalUuid}-0`;
    phase: "planned" | "published" | "deleting" | "cleaned";
    dev: string | null;
    ino: string | null;
    mode: 448 | null;
    evidenceDigest: Sha256 | null;
  }> | null;
  prepublicationAbort: Readonly<{
    outcome: "never_attempted";
    from: "allocated" | "building";
    evidenceDigest: Sha256;
  }> | null;
  identityManifest: Readonly<{
    phase: "planned" | "published" | "deleting";
    filename: `${CanonicalUuid}.identities.json`;
    tempFilename: `${CanonicalUuid}.identities.${CanonicalUuid}.tmp`;
    sha256: Sha256;
    entryCount: number;
    byteSize: number;
    dev: string | null;
    ino: string | null;
    mode: 448 | null;
  }> | null;
}>;
```

`target.parent.mode`, `wrapper.mode`, `privateSource.mode`, and `publicSource.mode`
are decimal `0700`. Decimal device/inode strings and indices contain only canonical
nonnegative integers. Internal private/public source `byteSize` is exactly
`0..268435456`. External `PreparedProfileGenerationV1.byteSize` remains
`1..268435456`; scaffold and initial-working payloads plus canary proof sources
may be zero bytes, but writer prepare rejects aggregate `byteSize === 0` as
`profile_schema_empty` before staging. This includes root-only trees and trees
containing any number of zero-byte files/directories; entry count never
substitutes for profile bytes.
`classification.nativeCode` is the module-private wrapper's normalized durable
result, so raw `atomic_publish_source_missing` never appears there.

Kind and target are inseparable: `canary` requires `canary_parent` plus
non-null `canaryProof`, and `privateSource` binds its exact proof leaf;
`scaffold`
requires `profile`, `leaf === profileId`, and held `profiles`; `working`
requires `profile_state/working`; `prepare` requires
`profile_state/staging`; `finalize` requires `profile_state/committed`. Every
profile-state target requires `leaf === generationId`. No dummy profile or
generation ID exists for a profiles-parent canary. Every noncanary
`privateSource` binds exact `payload` under its operation wrapper.
Nonces, digest, UUID, checksum, and size reuse existing Task 1/3 bounds and
canonical parsers; no second permissive parser exists.

### Canonical identity manifest

Before any private cleanup or protected public-source move, service writes immutable
`<operation-id>.identities.json`. Closed schema contains exactly `version: 1`,
operation ID, startup binding, target locator digest, and `entries`. Entries are
in exact postorder removal sequence and contain fixed keys:

```ts
type CleanupIdentityEntryV1 = Readonly<{
  index: number;
  scope: "private_profile_payload" | "private_canary_proof" |
    "public_source" | "private_profile_deletion" |
    "private_canary_deletion" | "wrapper_temp" | "intent_temp";
  path: string;
  type: "file" | "directory";
  dev: string;
  ino: string;
  mode: number;
  size: number;
  contentSha256: Sha256 | null;
}>;
```

Manifest permits at most 25,000 entries and 33,554,432 encoded bytes. Paths
are NFC relative paths, at most 1,024 UTF-8 bytes, at most 64 segments, each
1..255 bytes, with no empty, `.`, `..`, NUL, slash-in-segment, duplicate, or
prefix/type conflict. Regular-file size/checksum and directory null checksum
reuse canonical profile evidence. Indices are contiguous `0..entryCount-1`.
Stable encoding is existing fixed-key canonical JSON, raw UTF-8 path ordering
within equal removal depth, no whitespace, and one final newline.
The 1,024-byte path limit is the same shared Task 3/4 canonical-tree engine
limit, not a manifest-only parser rule.

Manifest protocol is intent-first. A classified non-ambiguous flow may enter it
after `classified`/`renamed`; a prepublication abort may enter it only after
durable `aborting_prepublication` with null classification and outcome
`never_attempted`:

1. Compute complete canonical bytes, hash, size, count, stable filename, and
   unique temp filename in bounded memory/streaming state without filesystem
   mutation.
2. Persist/fsync intent phase `manifest_planned` with identityManifest phase
   `planned`, exact locators/hash/size/count, and null inode evidence.
3. Create/write/fsync exact temp through authenticated
   `private_manifest_temp_file`, then publish temp to absent stable filename via
   capability-only native no-replace and sync `intents`.
4. Open/hash/size the stable file, capture dev/ino/mode, and persist/fsync phase
   `manifest_published` with identityManifest phase `published` before any
   cleanup/source mutation.

Recovery at `manifest_planned` accepts absent temp+stable and recreates exact
planned bytes, one exact temp, or one exact stable file. It verifies planned
locator/hash/size/count; a matching stable file completes binding and transition
to `manifest_published`. Temp+stable is allowed only when both exact byte hashes
match and native location proof shows stable publication; then the private temp
is authorization-first cleaned. Any extra/mismatch fails readiness. No cleanup
cursor is legal before `manifest_published`.

Cleanup cursor names next manifest index. Service persists it before removing
that identity, fsyncs containing directory, then advances. After all cleanup
entries and temps/wrapper are complete, it persists/fsyncs top-level phase
`manifest_deleting` and identityManifest phase `deleting` before unlinking the
stable manifest. Recovery in `manifest_deleting` accepts exact present or absent
stable manifest, completes unlink/directory sync when present, then persists
`cleaned`. Stable intent is always removed last. Manifest binding bytes remain
in cleaned intent until that final removal.

### Exhaustive stable-record validity

Every row inherits non-null version, operation ID, kind-valid target, binding,
and target-parent evidence. `S` means prepare/finalize only; `G` means scaffold
or working; `all` means every kind. No unlisted combination parses.

| Phase | Kinds | W/S | Class | Delete | Adopt | Cleanup/manifest |
|---|---|---|---|---|---|---|
| `allocated` | all | -/- | - | - | - | -/- |
| `building` | all | set/- | - | - | - | -/- |
| `aborting_prepublication` | all | inherited | - | - | - | abort/- |
| `ready` | all | set/set | - | - | - | -/- |
| `classified` | all | set/set | any | - | - | -/- |
| `renamed` | all | set/set | pub | - | - | -/- |
| `manifest_planned` | all | inherited | not amb or -/abort | - | - | inherited/planned |
| `manifest_published` | all | inherited | not amb or -/abort | - | - | inherited/published |
| `source_deleting` | S | set/set | pub | P/M/R/X | - | -/published |
| `adopted` | G,S | set/set | pub | G:-, S:X | exact | -/published |
| `discarding` | all | inherited | not amb or -/abort | - or S:X | -/old | disc/published |
| `manifest_deleting` | all | inherited | not amb or -/abort | as above | old | done/deleting |
| `cleaned` | all | inherited | not amb or -/abort | as above | old | done/deleting or abort/- |

`W/S` means wrapper/kind-specific private source. `pub`/`amb` mean
published/ambiguous. Source
deletion abbreviations are pending/moved-private/removing/removed (`P/M/R/X`).
`disc` means cleanup phase `discarding`; `done/deleting` means cleanup is
`cleaned/done` and immutable manifest evidence records authorized deletion.
`abort` means non-null immutable `prepublicationAbort`, null classification,
and cleanup outcome `never_attempted`. `inherited` cleanup is either null for
a classified flow or the unchanged abort cleanup record. `prepublicationAbort`
is null in every non-abort flow; once set, its origin/outcome/evidence remain
byte-for-byte through `cleaned`.

`classified/unpublished` requires sourceMatches true, targetMatches/targetOther
false. `classified/conflict` requires sourceMatches and targetOther true and
targetMatches false. `classified/published` requires targetMatches true and
both source flags false. `classified/ambiguous` is every other location tuple
and can only fail-stop; it cannot transition to deletion, adoption, or cleanup.

For `discarding/cleaned`, allowed outcome is exhaustive: prepublication abort
maps to `never_attempted`, unpublished maps to `unpublished`, conflict to
`conflict`, published canary to `canary_complete`, published snapshot-negative
data to `released_to_reconciliation`, and adopted data to `adopted`.
`never_attempted` is legal only with null classification, non-null
`prepublicationAbort`, and no native publication call. Prepare/finalize source
move uses only
`sourceDeletion.privateDeletionLeaf`; canary cleanup uses canaryProof evidence.

Adoption authority is exact: scaffold→`scaffold`, working→`registry`,
prepare→same-process `prepare_token` or restart
`reconciliation_snapshot`, finalize→`reconciliation_snapshot`, and canary→none.
`success` must classify published; `atomic_publish_replay_completed` must be a
canary same-attempt `ENOENT` resolution satisfying every narrow replay
predicate; `atomic_publish_exists` classifies conflict when trusted locations
match. Other native codes may classify unpublished or ambiguous. A target match
may classify published after an error only through the explicit canary replay
rule or when the wrapper proves the syscall succeeded before a later wrapper
failure; evidence/error precedence and global fail-stop remain preserved.

`publicSource` is required in every phase for prepare/finalize and null for
other kinds. It is derived from authenticated held source, not request text.
`identityManifest` is null through `renamed`, planned only in
`manifest_planned`, published with non-null dev/ino/mode in
`manifest_published`, and deleting only after cleanup completes. It remains
byte-for-byte through `cleaned` except those monotonic phase/evidence additions.
The sole exception is an empty prepublication abort: when no wrapper,
publication source, operation temp, or other private content exists, it moves
from `aborting_prepublication` directly to `cleaned` with null manifest and
`cleanup` set to `cleaned/never_attempted/done`. File absence is valid only in
`manifest_deleting`, `cleaned`, or that empty-abort path. Within a row,
later stable bytes inherit every earlier non-null immutable field byte-for-byte.
Only phase, monotonic source/cleanup/canary cursor, adoption, and defined
manifest transitions may change. No backward or skipped phase parses except
the explicit empty-abort transition.

For canary, `canaryProof` is required from `allocated`; noncanary requires null.
Attempt is immutable decimal zero and uses
planned→published→deleting→cleaned. Restart re-executes/resolves the same native
operation and leaves; no phase creates a new attempt or history. Current-process
resolution must prove publication before canary classification unless durable
`deleting`/`cleaned` evidence already proves that publication was consumed by
the later cleanup move. Cleanup must persist `deleting`, native-move the
protected-public target into its exact private deletion leaf, and prove both
parent/leaf locations as the canonical absent/match tuple before private-only
removal. This inspects both locators but never requires both leaves to exist.
Once `deleting` is durable, recovery
uses public/private-deletion identity plus manifest cursor and never requires
the original private proof or public canary leaf after their recorded move or
removal.

## Durable intent transitions

Intent durability always precedes corresponding filesystem effects:

1. Write `allocated` to a new closed-grammar temp with
   `O_CREAT | O_EXCL | O_NOFOLLOW`, sync file, authenticate it as
   `private_intent_temp_file`, publish to absent stable intent through native
   no-replace, resolve both locations, then sync `intents`. Only then may
   wrapper creation begin.
2. Create and pin wrapper plus its kind-specific private publication source,
   sync their parents, then write `building` using a new temp.
3. Finish/hash/sync that source, then write `ready` using a new temp.
4. Resolve the native result and prove source location, then write
   `classified` with exact outcome/evidence before cleanup or adoption.
5. For published data, sync parents and write `renamed`. Prepare/finalize then
   plan/publish identity manifest; unpublished/conflict proceeds directly to
   the same manifest planning.
6. From `manifest_published`, prepare/finalize completes source deletion.
   Acquire operation-specific authority and write `adopted`, or persist
   `discarding` before first cleanup deletion.
7. Advance durably synced cleanup suffix/cursor before each deletion. Persist
   `manifest_deleting` before manifest unlink, then `cleaned`, then remove
   stable intent last.

Before `ready`, failure follows a separate exhaustive branch. From `allocated`
or `building`, persist `aborting_prepublication` with null classification,
immutable `prepublicationAbort.from`, and cleanup
`aborting_prepublication/never_attempted` before deleting anything. If no
wrapper, publication source, operation temp, or other private content exists,
persist `cleaned/never_attempted/done` and remove the stable intent last. If any
such content exists, compute its complete bounded identity manifest, persist
`manifest_planned`, publish/bind it in `manifest_published`, then enter
`discarding/never_attempted` and use the normal cursor phases. This branch
never writes `classified`, invokes native publication, or infers unpublished
from absence.

Every existing-intent transition writes the complete next record to a unique
closed-grammar temp, syncs it, atomically renames it over the stable record
inside the trusted `intents` directory, and syncs that directory. A phase is
committed only after the final directory sync. No in-place writes occur.

The initial native temp-to-stable call and native preflight canaries obey the
same after-every-result rule as profile publication. They rewalk and revalidate
held root→staging→`intents` or canary parents, resolve both leaves, and classify
by pinned inode rather than return code before cleanup. Initial intent conflict
cannot touch the existing stable intent. Existing-intent phase replacement uses
ordinary atomic rename only inside the trusted non-attacker-writable directory.

At recovery, stable intent is authoritative. A temp must parse as the same
operation and either stable phase with the single next cleanup/source cursor or
its single legal successor phase. A valid temp with stable present is
uncommitted and removed after syncing `intents`; a valid initial `allocated`
temp with no stable intent and no wrapper is likewise removed. Multiple temps,
a cursor skip, mutated immutable evidence, a temp without stable plus any
wrapper, or malformed/unknown temp fails readiness without cleanup.

## Private construction and atomic publication

All new profile, state, generation, and copied nested directories are built
below profile-only private `payload`. Canary proof directories use their exact
private proof leaf instead. The private namespace is trusted against concurrent
mutation, so `mkdir` followed by no-follow open/fstat is permitted only there.

For one operation:

1. Validate admission, held root/staging chain, target locator/parent, target
   absence, filesystem type, device, and startup binding.
2. Durably publish `allocated` intent.
3. Exclusively create wrapper, pin and record it, exclusively create/pin the
   kind-specific publication source (`payload` for profile operations or exact
   `proof-<operation-id>-0` for canary), sync private parents, then durably
   publish `building`.
4. Populate with `O_CREAT | O_EXCL | O_NOFOLLOW`, bounded copy/hash checks,
   exact modes, file sync, and postorder directory sync.
5. Canonicalize publication source through held handles and durably publish
   `ready` with exact source evidence.
6. Immediately revalidate admission, full source and target chains, pinned
   source, target absence, statfs type, `st_dev`, and native mount preconditions.
7. Pass authenticated kind-specific private-source and target capabilities to the
   module-private wrapper; it alone extracts fds/leaves and invokes native
   `renameNoReplace`.
8. Whether native returns success or throws any code, run the location-proof
   algorithm below before classifying, cleaning, retrying, or adopting.
9. Persist `classified` before acting. On proved publication, sync wrapper and
   target parents and persist `renamed`; otherwise enter durable cleanup or
   permanent ambiguous fail-stop.

Profile scaffolding is one payload containing empty `working`, `staging`, and
`committed` directories, atomically published at the profile UUID. If the
target exists, it is a conflict: validate it as independent existing state but
never claim it as this operation's result.

Generation creation publishes one payload into `working`. Prepare copies and
revalidates held `working` into a new private payload, publishes it to
`staging`, then removes the proven owned working generation. Finalize performs
the same private rebuild from held `staging` into `committed`, publishes, then
removes the proven owned staging generation. Native publication source is
private; only the separately authenticated protected-public deletion move below
may use a public source. General removal never accepts committed state.

### Prepare/finalize source deletion

Prepare/finalize `allocated` intent records source locator, held
dev/ino/mode/checksum/size, and digest of its runtime-authenticated capability.
After destination is proved and `renamed` is durable:

1. Complete `manifest_planned`→`manifest_published` for held public source,
   private wrapper/temps, and planned private deletion leaf.
2. Persist `source_deleting/pending` with closed private
   `delete-<operation-id>` destination leaf before source mutation.
3. Under exclusive profile-operation lock, authenticate
   `protected_public_source` from held source locator/dev/ino/mode/checksum and
   full service-owned `0700` parent chain. Authenticate absent private deletion
   target under exact operation wrapper.
4. Wrapper revalidates both capabilities immediately before calling native
   no-replace from held public parent/source leaf into private wrapper/deletion
   leaf, then revalidates immediately after every result. No strings/fds escape.
5. Resolve public source and private deletion leaf against original pin. Only
   source-absent plus matching private leaf is moved; source-match plus private
   absence is unmoved. Any other tuple is ambiguous. Sync both parents, then
   persist `moved_private` only for moved state.
6. Use bound manifest identities at private deletion locator. Persist
   `removing` plus next postorder index before each removal, revalidate/remove,
   sync private parent, and advance cursor.
7. After private deletion leaf absence and wrapper sync are proved, persist
   `removed`.
   Only then may adoption or destination-release cleanup proceed.

A crash with public source and published destination present at `renamed` or
`pending` resumes protected source move. A partial private deletion resumes
from durable identity cursor. Public source absent plus matching private leaf
resumes removal. Both absent is accepted only when cursor/evidence proves final
private entry removal and wrapper sync; otherwise ambiguous fail-stop. Public
source plus private deletion leaf, mismatched identities, or unrecorded content
never triggers deletion.
Any owner/mode/device/mount/held-chain change closes process-global admission
before this protected-parent rename or removal.

## Mandatory post-call location proof

Raw native return or errno never determines publication state. After every
native call, including every error, keep source pin and both parent leases
and perform this bounded proof:

1. On restart, freshly open staging and target parent, repeat allowlisted
   `statfs`, equal-device checks, and the recoverable native mount canary before
   inspecting operation locations. For the unresolved canary itself, its
   authenticated publication or cleanup replay supplies this proof. A
   cursor-proved fully removed/cleaned canary only finishes its own durable
   records and cannot authorize another operation's mount-sensitive work.
2. Rewalk exact capability chains: root→profiles→profile→state for profile data,
   root→staging→`intents` for intent/manifest files, or both protected public
   source and private operation wrapper for source deletion. Compare every
   dev/ino/mode/device component with captured evidence.
3. Resolve source and target leaves with no-follow opens/lstats through held
   parents. Pin any found target before comparison.
4. Compare found entries against pinned source dev/ino/mode/type and bounded
   content hash/size when a file/tree has bytes. Revalidate both chains before
   and after each await and after all comparisons. Equal mount ID was proved in
   current native call or recovery canary; changed chain fails globally.
5. Classify only one stable location:
   - source matches and target absent: unpublished;
   - source matches and target exists with another identity: unpublished
     conflict;
   - source absent and target matches: published;
   - any other combination, target mismatch after apparent success, both
     locations, neither location, or chain drift: ambiguous fail-stop.

For unpublished/conflict profile or canary publication, cleanup may touch only
the still-pinned kind-specific private source/wrapper; it never alters public
target. For an unpublished protected-public source move, retain that source and
retry only through the durable move protocol. A published protected-public
move removes only its matching private deletion tree. For published profile
data, no cleanup may touch public target until adoption authority exists.
Ambiguous state closes admission, retains intent and all verifiable durable
evidence, and performs no namespace cleanup. The next process restarts with
kernel-closed old fds and recovery repeats the same held rewalk from durable
evidence.

## Operation-specific adoption authority

Before ProfileStore construction, Task 3 derives a fieldless
`PreReadyRecoveryAuthority` from the immutable reconciliation snapshot and
persisted Task 3 manifests. Its module-private record contains exact referenced
profile locators/checksums, expected namespace scaffolds, cleanup/quarantine
decisions, and process/control/snapshot binding. Intent recovery consumes it
before ready installation and never issues a database query. It does not depend
on a ProfileStore, Registry, or process-local session token.

- `scaffold`: pre-ready authority adopts only a complete empty three-state
  schema that the snapshot/manifest identifies as required namespace. No store
  callback is involved.
- `working`: restart never adopts a browser working generation because its
  Chromium owner is gone. Snapshot/manifest supplies negative resolution
  authority to release the verified target to ordinary Task 3 quarantine or
  cleanup. Same-process Registry capability is only a live-path optimization.
- `prepare`: restart adopts only an exact staging locator/checksum explicitly
  referenced by snapshot/manifest. Otherwise pre-ready authority releases it
  to Task 3 policy. Same-process prepare token is only a live optimization.
- `finalize`: restart adopts only an exact live committed locator/checksum
  referenced by snapshot. A committed payload lacking that row is never
  adopted, even if intent and checksum are valid; pre-ready authority releases
  it to Task 3 quarantine. Same-process finalize retains intent until a later
  snapshot proves this authority.

A stale `adopted` intent whose target is no longer authorized by the fresh
snapshot is not grandfathered by its old adoption digest. Negative pre-ready
authority explicitly permits transition to `discarding` with
`released_to_reconciliation` after fresh identity/mount/source-cleanup proof.
This includes committed data that was published but never adopted and data
whose formerly valid database reference was deleted.

An intent remains until the required authority is proved and `adopted` is
durably synced. Deleting an adopted intent additionally requires its runtime
holder to have accepted cleanup responsibility or the reconciliation snapshot
to prove durable ownership. Conflict never supplies adoption authority.
`authorityDigest` is SHA-256 of the existing fixed-key canonical encoding of
authority kind, startup binding, operation/profile/generation IDs, and payload
checksum plus the relevant snapshot row or module-private capability nonce.
It contains no database credentials and is recomputed from the already-held
snapshot/capability, never trusted as authority by itself.
After restart, a vanished live `capabilityDigest` supplies no authority.
`PreReadyRecoveryAuthority` replaces it only by matching bound public-source
locator, dev/ino/mode/checksum, canonical identity-manifest evidence, exact
target, and fresh snapshot/Task 3 manifest decision. Any mismatch fails closed;
stored digest alone can neither adopt nor delete.

## Startup and Task 3 quarantine ordering

Startup order is fixed:

1. Load/validate native addon; open and validate pre-created staging roots.
2. Capture immutable database snapshot plus existing Task 3 manifest evidence
   and build `PreReadyRecoveryAuthority`; readiness remains false.
3. Enumerate and reserve every intent/temp/wrapper plus its possible public
   source/target. Run fresh statfs/statx canaries and resolve all intents.
4. Adopt snapshot-authorized targets or durably enter `discarding`, finish
   source/private cleanup, then mark non-adopted public targets
   `released_to_reconciliation` and remove their intents last.
5. Only after no unresolved intent owns a public locator may general Task 3
   enumeration, plan publication, quarantine, or mutation begin. Recapture and
   seal resulting root/snapshot/manifest evidence.
6. Consume the internal outcome, construct generation-scoped ProfileStore from
   held recovered capabilities, atomically install authority/store/result, and
   flip ready.

Task 3 never quarantines or mutates an intent-owned source/target. Release is
crash-safe without a third location: durable `discarding` records outcome
`released_to_reconciliation`, proves source cleanup and target identity, writes
`cleaned`, then removes intent and syncs `intents` while leaving target in its
original public location. A crash before intent removal leaves it protected; a
crash after removal presents an ordinary unreferenced target to next Task 3
run. Thus unadopted committed data is quarantined only after intent removal and
can never be mistaken for adopted state.

## Capability transfer and release

Successful generation publication constructs `BoundProfileGeneration`
directly from the still-open payload handle, target pin/evidence, and retained
held root→`profiles`→profile→state parent leases. It does not reopen target by
pathname. A module-private WeakMap atomically moves the operation record from
`publishing` to `live`; only then may wrapper cleanup begin.

The live record owns generation pin, each ancestor/parent lease, intent lease,
startup binding, and adoption state. Registry/store attachment consumes that
record exactly once. Transition produces a newly pinned destination capability
before consuming the source. Normal close drains operations, releases intent
ownership when permitted, closes generation first, then state, profile,
`profiles`, and root leases in reverse order, attempting every close.

Forged, stale, foreign, double-consumed, or closed objects fail before effect.
A close-then-throw with verified closure reaches zero retained fds. A true
close rejection permanently marks this process `close_unverified`, closes
global admission, rejects every later operation/reconciliation/readiness
attempt, retains process-local fail-stop records, and cannot be cleared or
retried in-process. Process exit clears OS fds; only a fresh process may run
durable intent recovery and restore readiness.

No public API or callback receives a raw fd, procfd path, native binding,
staging path, intent, or unwrapped capability.

## Native boundary and ABI

Production loads one exact object from fixed package-relative build output:

```ts
type AtomicDirectoryPublicationNativeV1 = Readonly<{
  interfaceVersion: "1.0.0";
  napiVersion: 8;
  renameNoReplace(
    sourceDirectoryFd: number,
    sourceLeaf: string,
    targetDirectoryFd: number,
    targetLeaf: string,
  ): void;
}>;
```

The C addon compiles with `NAPI_VERSION=8`, uses Node-API only, and exposes
exactly those three own properties. `interfaceVersion` is semantic version
`1.0.0`; incompatible major/minor/patch values fail rather than negotiate.
Preflight requires compiled `napiVersion === 8` and numeric
`process.versions.napi >= 8`, freezes the validated wrapper, and logs source as
the constant `bundled_package_relative`; it never logs or accepts a path.

Raw native object stays module-private. Production wrapper accepts only these
runtime-authenticated discriminated source capabilities:

- `private_profile_payload_dir`: scaffold/working/prepare/finalize held
  operation wrapper plus exact `payload` leaf;
- `private_canary_proof_dir`: canary held operation wrapper plus exact
  `proof-<operation-id>-0` leaf;
- `private_intent_temp_file`: held `intents` parent plus exact initial-intent
  temp and planned stable intent leaf;
- `private_manifest_temp_file`: held `intents` parent plus exact planned
  manifest temp/stable locators and bytes hash/size; or
- `protected_public_source`: either prepare/finalize held working/staging source
  or exact published canary target, with intent-bound locator/dev/ino/mode/hash
  and service-owned `0700` chain.

Target capabilities are equally closed: an exact absent public profile/canary,
stable intent, or stable manifest leaf for publication; exact private
`delete-<operation-id>` only for prepare/finalize public-source movement; and
exact private `deletion-<operation-id>-0` only for canary public-source
movement. Profile publication is only wrapper/`payload`; canary publication is
only wrapper/`proof-<operation-id>-0`; intent and manifest publication is only
their planned private temps. The protected-public source variant exists only
for a move into its matching private deletion capability.

Each is a fieldless token backed by separate module-private WeakMap record.
Wrapper accepts a matching authenticated target capability, revalidates
source/target identity, binding, owner/mode/device/mount, and admission before
and after call, and alone extracts dirfds/leaves. No public/general string, fd,
path, or union-forging overload exists. Wrong discriminator/pair, public source
for publication, cross-kind wrapper leaf, or protected source with a
nonprivate/mismatched deletion target globally fail-stops. Generic C export
remains unchanged.

`renameNoReplace`:

- accepts exactly four arguments and returns `undefined` only on syscall
  success;
- requires nonnegative signed 32-bit fds;
- requires leaves of 1-128 ASCII bytes matching
  `[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?`;
- independently rejects NUL, `/`, `\\`, `.`, and `..`;
- `fstat`s both fds and requires directories and equal `st_dev`;
- `statx`s both fds and requires available/equal `STATX_MNT_ID`;
- calls Linux `renameat2` with exactly `RENAME_NOREPLACE`; and
- returns no fd, path, inode, native pointer, or raw errno text.

Stable internal codes and mandatory action:

- `EEXIST` and `ENOTEMPTY` → `atomic_publish_exists`: run location proof,
  classify conflict only if source remains pinned, then clean private state.
- `ENOSYS` and `EINVAL` → `atomic_publish_unsupported`: run location proof,
  close readiness globally, clean only proved-unpublished private state, retain
  ambiguous or published evidence, no fallback.
- `EOPNOTSUPP`, plus `ENOTSUP` only when it is a distinct platform constant →
  `atomic_publish_unsupported`: same action. C uses conditional compilation so
  aliased constants never create duplicate cases.
- `EXDEV` or unequal device/mount precheck → `atomic_publish_cross_device`: run
  location proof, close readiness, clean only proved-unpublished private state,
  retain ambiguous or published evidence, no fallback.
- `ENOENT` → internal native `atomic_publish_source_missing`: run canonical
  proof. Only the fully authenticated canary same-attempt publication/cleanup
  replay predicates normalize to `atomic_publish_replay_completed`, advance the
  expected phase, and preserve admission. Every other case normalizes to
  `atomic_publish_binding_invalid`, closes admission globally, cleans only
  proved-unpublished private state, and retains all other evidence. The raw
  source-missing code never escapes the module-private wrapper or enters a
  durable intent.
- `EBADF`, `ENOTDIR`, `ELOOP`, or `ESTALE` →
  `atomic_publish_binding_invalid`: run location proof, close admission, clean
  only proved-unpublished private state, and retain all other evidence.
- `EACCES`, `EPERM`, or `EROFS` → `atomic_publish_denied`: run location proof,
  fail operation, clean only proved-unpublished private state, and keep
  readiness closed until a fresh process reconciles.
- invalid arity, fd, or leaf → `atomic_publish_invalid_argument`: reject before
  syscall; prove source location, close admission because production supplied
  an invalid capability, then clean only proved-private state.
- any other errno → `atomic_publish_io`: run location proof, fail closed, and
  permanently close process-global admission/readiness until process exit;
  clean only proved-unpublished private state and retain all other evidence for
  fresh-process recovery. It is never downgraded to operation-local failure.

Error precedence is exact. First validate invocation/prechecks, then perform
post-call canonical proof. `ENOENT` may override binding-invalid action only by
the complete canary replay predicate above. For other errors, a proved target
match follows published recovery/adoption only when evidence proves the syscall
succeeded before a later wrapper failure. Ambiguous location always retains
evidence and closes admission. Code-specific action applies after that proof;
no generic “target exists” rule suppresses binding failure. This makes cleanup
and admission deterministic.

The TypeScript wrapper validates exact native object keys/version once,
runtime-authenticates held handles, and maps the internal source-missing code to
replay-completed or binding-invalid before returning/persisting a typed result.
Tests may fake wrapper capability/admission state, but never native
rename results in integration or recovery tests. Production cannot select a
module path.

## Crash recovery and cleanup matrix

Reconciliation runs reserved-namespace recovery before ready authority. It
first validates all stable intents, temps, wrappers, kind-specific private
sources, and target parents within global bounds, then acts. Each cleanup
revalidates held identity
immediately before unlink and syncs the containing directory afterward.
Every restart discards process-local proof, freshly derives
`PreReadyRecoveryAuthority`, reopens both parent chains, repeats statfs/statx
canary proof, and reacquires cleanup authority from durable intent evidence.
Prior-process mount results, fds, tokens, and in-memory classifications are
never reused. An unresolved durable canary record is resumed with its same
immutable attempt and leaves; its native call and location proof are rerun in
the current process.

- Initial temp only, no stable intent/wrapper: remove valid temp.
- Stable `allocated` or `building`: no native publication was attempted and
  classification must remain null. First persist
  `aborting_prepublication/never_attempted` with exact origin phase. If no
  wrapper, kind-specific publication source, operation temp, or other private
  content exists, persist empty-abort `cleaned` and remove the stable intent
  last. Otherwise enumerate/pin all exact partial private content under bounds,
  complete `manifest_planned`→`manifest_published`, then enter
  `discarding/never_attempted` before first deletion. Missing partial leaves are
  described by the manifest snapshot, never classified as unpublished.
  Wrapper without stable intent has no cleanup authority and fails.
- Stable `aborting_prepublication`: require null classification, immutable
  origin in `allocated|building`, and cleanup outcome `never_attempted`. Repeat
  exact bounded enumeration. Resume the empty-abort path only when nothing
  private exists; otherwise plan/publish the complete manifest before entering
  discard. Never invoke or infer a native publication result.
- Stable canary with proof `planned`/`published` before cleanup: run fresh
  prechecks/statfs/statx and replay the exact attempt-zero publication. Success
  follows normal proof. `ENOENT` advances as published only when durable source
  identity and canonical source-absent/public-target-match proof satisfy the
  narrow replay rule; otherwise global binding-invalid fail-stop applies.
- Stable canary with proof `deleting`: skip original publication. If the public
  canary remains and private deletion leaf is absent, replay its exact cleanup
  move. If public is absent and the exact private deletion root remains, replay
  that same move, including when its remaining tree matches a partial cursor;
  qualifying `ENOENT` supplies current mount proof, then private cleanup resumes
  at the durable cursor. If the cursor proves the private root fully removed,
  or proof is `cleaned`, finish manifest/intent cleanup without any original
  publication replay or requirement that either original publication leaf
  exist. Another operation needing mount proof must use a new canary after this
  record resolves.
- Stable `ready`: execute mandatory two-location proof. Matching source means
  unpublished; matching target means published; persist `classified` before
  either cleanup or renamed/adoption work. Anything else fails ambiguous.
- Stable `classified`: trust no boolean alone; repeat fresh mount/location
  proof and require its digest/outcome. Resume unpublished/conflict manifest
  planning, published renamed flow, or permanent ambiguous fail-stop.
- Stable `renamed`: require source absent, target matching, and operation-specific
  resolution, then plan/publish manifest before source deletion/adoption/release.
- Stable `manifest_planned`: require either a non-ambiguous classification or
  exact prepublication-abort evidence, validate planned stable/temp
  locators/hash/size, resume absent/temp/stable publication cases, and persist
  inode evidence only after exact stable manifest plus parent sync.
- Stable `manifest_published`: require exact open/hash/size/inode evidence, then
  resume abort discard, source deletion, adoption, or classified discard
  according to kind/outcome.
- Stable `source_deleting`: handle public source, private deletion leaf, both,
  or partial removal
  only through protected public source, private deletion leaf, manifest, and
  durable cursor. Foreign or unexplained entries fail without deletion.
- Stable `adopted`: validate authority against current snapshot/capability;
  transfer/confirm ownership, then enter discard only for private wrapper/temps;
  never delete adopted target.
- Stable `discarding`: repeat fresh mount/location and cleanup-authority proof,
  then resume exact suffix and index. A missing entry is accepted only when the
  prior synced cursor proves it was deliberately removed.
- Stable `manifest_deleting`: revalidate planned hash/inode and authorization;
  exact present or absent manifest is accepted, unlink/sync when present, then
  persist `cleaned`.
- Stable `cleaned`: require kind-specific private sources/temps/wrapper absent
  or target durably released/adopted as recorded. Require identity-manifest
  removal durably recorded except for the exact empty-abort variant; then remove
  stable intent and sync `intents`.
- Wrapper without stable intent, private source without matching evidence, duplicate
  operation, malformed entry, or target mismatch fails readiness without
  cleanup.

Cleanup suffix order is exhaustive and monotonic:

1. `private_source_entries`: persist next postorder manifest index, remove exact
   pinned private profile-payload, canary-proof, or private-deletion entry, sync
   parent, and advance; then remove its exact root when private.
2. `private_source_root`: prove the kind-specific source root absent or
   transferred to target; advance.
3. `wrapper_temps`: enumerate/remove only closed-grammar operation-owned
   wrapper artifacts with per-entry persisted cursor; advance.
4. `wrapper_root`: require empty matching wrapper, remove and sync `bundles`.
5. `intent_temps`: remove only matching legal temp records, syncing `intents`.
6. `done`: persist `discarding/done`, transition/fsync `manifest_deleting`,
   remove exact manifest if present, sync, persist `cleaned`, then remove stable
   intent last and sync again.

Source absent plus target absent is ambiguous in `ready`, `classified`, or
`renamed`. It is safe only in `discarding` when classified outcome was
unpublished/conflict and the synced cleanup cursor proves private-source-root
removal,
or when source-deletion cursor proves source removal and destination was
durably released to Task 3. Evidence, not absence alone, grants cleanup.

`EEXIST` or `ENOTEMPTY` never means success. If location proof finds source
matching and another target, remove only private payload, then empty wrapper,
then intent. If source or wrapper removal reports `ENOTEMPTY`, re-enumerate
under bounds; remove only entries proven in intent-owned private tree. Unknown
content fails readiness. If target matches payload despite error, classify by
location as published and retain intent; errno never overrides evidence.

Explicit crash seams: initial temp write/sync/publish/intents-sync; allocated
intent sync; wrapper mkdir/open/sync; payload mkdir/open/sync; building temp
write/sync/rename/dir-sync; each child create/write/file-sync/directory-sync;
ready transition; immediately before/during/after native syscall; source/target
location opens; root rewalk; classification sync; source-parent sync;
target-parent sync; renamed transition; every source-move/removal cursor;
capability transfer; each adoption check; Task3 release; every cleanup suffix;
wrapper removal; intent removal; and each fd close. Every seam has intent-only,
opdir-only, payload-missing, source-present, target-present, source+destination,
partial source deletion, conflict, and ambiguous fixtures where possible.

Recovery is idempotent. No cleanup starts until location is proved. Failed
cleanup retains stable intent and exact remaining evidence for restart.

## Build, loading, Docker, and preflight

`node-gyp` is pinned in Browser Service lockfile. `binding.gyp` compiles the
Linux C addon with `NAPI_VERSION=8`, warnings-as-errors, and a native test
target that exercises the same errno mapper. Package `install` invokes
`scripts/build-native.mjs`; it rejects non-Linux targets and verifies expected
artifact and exact object shape. Generated `build/` output is ignored and never
committed.

The test target compiles the same syscall function with a test-only macro that
blocks on inherited pipe/eventfd barriers immediately before and after
`renameat2`. It adds no production export, environment switch, or runtime code
path. Production build rejects the test macro; production native object remains
the exact three-property interface above.

`preinstall` checks platform, architecture, exact Node runtime, and build inputs
without loading an artifact that does not exist yet. Install builds and
load-checks addon. `prebuild`, `pretest`, and `prestart` require exact interface
and N-API versions. Startup root preflight validates staging/public invariants,
statfs allowlist, device and mount IDs, then performs a private positive canary
and no-replace conflict canary on actual persistent filesystem. Any missing
artifact, symbol, support, or proof leaves readiness false.

Browser Service Docker builder/test stage installs pinned Node, `python3`,
`make`, and C compiler packages; final digest-pinned runtime copies compiled
`.node` plus production files only. Runtime contains no compiler or package
manager cache. Artifact is built for final architecture/libc; no downloaded
prebuild exists. Docker tests inspect stages, run preflight in test and final
images, and run persistent-volume canaries as final non-root UID. Compose's
volume-init step exclusively creates browser-state root plus all reserved
staging children as exact runtime UID/mode before first service start and
validation-only preserves valid restart state thereafter. Browser Service only
validates them and fails if any is absent or invalid.

Task 6 still owns Dockerfile creation, but its plan/tests must be revised before
implementation to carry these native builder, artifact, UID, volume-init, and
canary requirements. A native-enabled Task 4 cannot be called deployable until
that Task 6 gate passes.

## RED and adversarial verification

Real compiled-addon integration tests, not mocked rename results, cover:

- many concurrent process publishers against one absent target: exactly one
  succeeds, all others return conflict, destination inode/content is winner's
  complete payload, and observers accept only complete pre-rename or complete
  post-rename state, never an intermediate state;
- a native test-only deterministic barrier immediately before and immediately
  after the actual `renameat2` syscall; parent coordinates child `SIGKILL` at
  both barriers without timing sleeps, then a fresh process accepts either
  atomic pre-state or atomic post-state and runs durable recovery;
- different-UID attacker prepopulates collision/corruption fixtures and swaps
  configured root/ancestor pathnames before startup capture; held-chain and
  init owner/mode validation reject them before publication. Tests do not claim
  attacker mutation inside a validated service-owned parent;
- privileged/same-UID test harness may force owner/mode/mount/held-chain drift
  only to prove deterministic global fail-stop, never supported recovery under
  that out-of-scope compromise;
- real `EEXIST`, invalid leaf/fd, closed fd, noncanary missing source,
  non-directory fd, denied parent, and read-only behavior with stable codes;
  noncanary missing source must surface binding-invalid and close admission.
  Real `ENOTEMPTY` is
  asserted only when the current allowlisted filesystem returns it, while the
  compiled errno mapper always proves `ENOTEMPTY` shares conflict handling;
- real cross-mount source/target using test container mounts, same-device bind
  mount-ID mismatch where supported, disallowed NFS-style statfs fixtures, and
  zero fallback;
- native test binary exercising every errno mapping, including separate and
  aliased `ENOTSUP`/`EOPNOTSUPP` compilation branches and internal
  `atomic_publish_source_missing` for `ENOENT`;
- exact native export stays three properties; wrapper accepts exact
  private-profile-payload, private-canary-proof, intent-temp, manifest-temp,
  and protected-public-source discriminators only with their kind-compatible
  targets. It rejects forged/raw/string/fd/cross-kind overloads and proves
  profile publication, canary publication, initial intent publication,
  manifest publication, prepare/finalize source move, and canary source move
  use real native no-replace;
- missing/corrupt addon, malformed/extra exports, interface mismatch, compiled
  N-API mismatch, and runtime N-API incompatibility keep readiness false;
- child process `SIGKILL` at every durable crash seam, followed by a fresh real
  process recovering the real filesystem and compiled addon;
- canary crashes before/after syscall and during every cleanup suffix. Restart
  runs fresh statfs/statx, re-executes/resolves the same operation ID, attempt
  zero, proof leaf, and public leaf for both native pre/post states; it neither
  replaces the record nor creates history. A new canary is admitted only when
  no unresolved record exists for that exact parent. Cleanup authenticates the
  protected-public canary, native-moves it to exact private `deletion-...-0`,
  proves both locations, and performs no public unlink. Orphans fail readiness;
- deterministic same-attempt canary `ENOENT` replay fixtures cover exact
  private-proof-absent/public-target-match publication and exact
  public-target-absent/private-deletion-match cleanup. Both require successful
  fresh native prechecks/statfs/statx, normalize to replay-completed, advance
  phase, and keep admission open. Wrong attempt/phase/source evidence, changed
  inode/hash/parent, both/neither unexplained, profile publication, and every
  other `ENOENT` normalize to binding-invalid and close admission globally;
- canary recovery already at private deletion, partial manifest cursor, fully
  removed private root, and proof `cleaned` skips original publication and
  finishes exact private/record cleanup without requiring the original proof or
  public leaves. Cleaned state never authorizes later work as current mount
  proof; a new canary is created only after the old record resolves;
- stable active intents at exactly 512 succeed. Sequential recovery may use
  exactly 512 additional transient records/temps, reach the hard 1,024 total,
  clean/reuse scratch per parent, and return to at most 512 before ready. A
  513th stable intent or 1,025th combined transient record/temp rejects before
  effect;
- admitted maxima restart successfully: 25,000 aggregate user-payload entries
  and 1,073,741,824 payload bytes; 3,072 stable metadata files with
  100,663,296 stable-manifest bytes and 12,582,912 other stable bytes; 1,024
  metadata-scratch files with 33,554,432 manifest-temp bytes and 4,194,304
  other temp bytes; 1,024 canary/proof/private-deletion directory-scratch
  entries; and combined totals of 4,096 metadata files, 134,217,728 manifest
  bytes, 16,777,216 other metadata bytes, and 30,120 filesystem entries. Every
  per-category and combined plus-one case rejects synchronously before
  read/create/cleanup, and recovery demonstrates scratch reuse rather than
  simultaneous per-parent accumulation;
- allocated/building failures before native publication persist
  `aborting_prepublication/never_attempted` with null classification before
  deletion. Empty abort removes stable intent last without a manifest; opdir,
  missing-source, partial-source, operation-temp, and mixed partial fixtures
  publish the exact bounded manifest/cursor before any removal and recover at
  every abort/manifest/discard crash seam;
- wrapper grammar fixtures accept only profile `payload`, canary
  `proof-<operation-id>-0` plus optional `deletion-<operation-id>-0`, and
  prepare/finalize optional `delete-<operation-id>`. Every cross-kind,
  unknown, duplicate, or extra coexisting leaf fails readiness;
- full intent/temp/wrapper/payload/target cleanup matrix, including intent-only,
  opdir-only, payload missing, malformed, duplicate, `EEXIST`, `ENOTEMPTY`,
  wrapper nonempty, both locations, neither location, mismatched target, every
  cleanup suffix, public-source+private-deletion, and partial source removal;
- identity-manifest stable bytes, fixed ordering, hash/count/size/path bounds,
  intent-first `manifest_planned`, absent/temp/stable recovery,
  `manifest_published` inode binding, unbound/stale/duplicate rejection, every
  cursor crash, authorization-first `manifest_deleting`, present/absent unlink
  recovery, and stable intent removal last;
- zero-byte scaffold, canary, and initial-working payloads succeed internally;
  root-only, one-zero-byte-file, and multiple-zero-byte-file writers each have
  aggregate zero and fail `profile_schema_empty` before staging/finalize;
- each operation-specific same-process and restart adoption path, plus forbidden
  adoption without snapshot/capability and proof no recovery DB query occurs;
- valid but snapshot-unreferenced committed publication is never adopted:
  source deletion recovers, intent releases target, intent disappears before
  Task 3 plan, and only then Task 3 quarantine may move it across every crash;
- publication returns a capability backed by original payload fd and held
  ancestors without pathname reopen; forced privileged chain drift fails global
  admission before later use;
- all success/failure paths attempt all closes; close-then-throw reaches zero
  fds; true close rejection permanently blocks current process; restart closes
  old OS fds and recovers from durable intent;
- host and final-image canaries on actual persistent filesystem.

Fakes are limited to wrapper admission/capability scheduling for deterministic
await boundaries. Atomicity, errno, mount, crash, location, and recovery claims
use compiled C addon and real filesystem/process boundaries. Existing Task 3
public reconciliation and Task 4 replay/proxy/registry/Chromium/checksum tests
remain passing. Shared persistent/schema integration suites run serially.

## Exact expanded Task 4 file scope

Existing Task 4 files remain in scope:

- `apps/browser-service/src/profile-store.ts`
- `apps/browser-service/src/profile-store.test.ts`
- `apps/browser-service/src/session-registry.ts`
- `apps/browser-service/src/session-registry.test.ts`
- `apps/browser-service/src/replay-restore.ts`
- `apps/browser-service/src/replay-restore.integration.test.ts`
- `apps/browser-service/src/egress-proxy.ts`
- `apps/browser-service/src/egress-proxy.test.ts`
- `apps/browser-service/src/reconciliation.ts`
- `apps/browser-service/src/reconciliation.test.ts`
- `apps/browser-service/src/startup-state.ts`
- `apps/browser-service/src/startup-state.test.ts`

Native publication adds exactly:

- `apps/browser-service/native/atomic-directory-publication.c` (new)
- `apps/browser-service/native/atomic-directory-publication-errors.h` (new)
- `apps/browser-service/native/atomic-directory-publication-errors.test.c`
  (new)
- `apps/browser-service/binding.gyp` (new)
- `apps/browser-service/scripts/build-native.mjs` (new)
- `apps/browser-service/src/atomic-directory-publication.ts` (new)
- `apps/browser-service/src/atomic-directory-publication.test.ts` (new)
- `apps/browser-service/src/atomic-directory-publication.integration.test.ts`
  (new)
- `apps/browser-service/src/atomic-publication-manifest.ts` (new)
- `apps/browser-service/src/atomic-publication-manifest.test.ts` (new)
- `apps/browser-service/src/runtime-preflight.mjs`
- `apps/browser-service/src/runtime-preflight.test.mjs`
- `apps/browser-service/package.json`
- `apps/browser-service/pnpm-lock.yaml`
- `.gitignore`

Design/plan alignment adds exactly:

- `docs/superpowers/specs/2026-07-22-atomic-directory-publication-design.md`
- `docs/superpowers/specs/2026-07-21-browser-service-plan-hardening-design.md`
- `docs/superpowers/plans/2026-07-19-browser-service-and-api.md`

Task 6 retains ownership of `apps/browser-service/Dockerfile` and
`apps/browser-service/src/dockerfile.test.ts`; its revised exact scope adds
`apps/browser-service/scripts/init-state-volume.mjs` and
`apps/browser-service/scripts/init-state-volume.test.mjs`. The Compose task
adds init-service/volume wiring in `compose.local.yaml`,
`scripts/local-firecrawl`, and `scripts/local-firecrawl.test.mjs`. No generated
`.node`, native test binary, `build/`, or `node_modules/` content enters a
commit.

## Rollout and observability

Roll out fail-closed from first native-enabled image; never support mixed safe
and unsafe publication modes. Before traffic, emit one structured
`atomic_publish_preflight` event containing platform, architecture,
`interfaceVersion`, compiled/runtime N-API versions, source constant
`bundled_package_relative`, allowlisted filesystem name, and sanitized result.
Do not log paths, fds, numeric owners, profile/generation/operation IDs,
checksums, mount IDs, or raw errno text.

Emit bounded counters for attempts, successes, conflicts, unsupported,
cross-device, binding-invalid, denied, I/O failures, recovered-unpublished,
recovered-published, ambiguous recovery, orphan/temporary state, and
close-unverified. Alert on unsupported, cross-device, binding-invalid,
ambiguous, orphan, close-unverified, or repeated conflicts. Health exposes only
existing sanitized `browser_unavailable`; details remain private diagnostics.

Acceptance requires host tests, compiled native integration, two image builds,
restart/crash recovery, volume-init permissions, and real persistent-volume
canary. Rollback may deploy an older image only after an offline checker proves
no unresolved native intent or wrapper. Never delete the reserved namespace to
make an old image start.
