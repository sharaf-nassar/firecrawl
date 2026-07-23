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
have exact semantics. Protected working/staging/canary cleanup may use the same
native primitive only for its authenticated public-to-private deletion move.

## Trusted namespace provisioning

The Docker named volume is mounted only at the trusted parent
`/var/lib/firecrawl-browser-volume`. Browser Service state root is its child
`/var/lib/firecrawl-browser-volume/state`, never the mountpoint itself:

```text
/var/lib/firecrawl-browser-volume/
  .firecrawl-browser-initialized-v1
  state/
    profiles/
    .profile-publish-staging/
      intents/
      bundles/
```

The init container verifies fixed `/usr/bin/flock` from its pinned util-linux
package against the image's checked-in path/version/binary-digest allowlist.
With umask `0077`, its fixed command is
`/usr/bin/flock --exclusive --timeout 60
/var/lib/firecrawl-browser-volume <node22>
scripts/init-state-volume.mjs`. The path is the already-provisioned trusted
volume-parent directory itself; `flock` opens/locks that existing inode, holds
the lock in the parent for the entire child lifetime, and kernel-releases it on
exit/crash. It never uses `-o`, a creatable lock path, marker file, or child
state path as lock object. Init-new and validate-existing create no lock
artifact. The `.mjs` never calls/emulates flock. It opens the same parent with
`O_DIRECTORY | O_NOFOLLOW`, requires exact provisioned parent identity, and
selects mode only under this launcher. No marker and no `state` selects
`init-new`; matching initialization marker selects `validate-existing`;
marker/state disagreement or unexpected reserved child fails. Marker records
completed initialization only and never supplies mutual exclusion. Selection
cannot be overridden or repaired after inspection.

`init-new` exclusively creates `state`, `profiles`,
`.profile-publish-staging`, `intents`, and `bundles` one segment at a time
through held parent descriptors. Every create uses nonrecursive
`mkdir(..., 0700)` and treats `EEXIST` as failure. Before release, init uses
`fchown` to exact UID/GID `1000:1000`, `fchmod` to exact `0700`, revalidates
type/dev/ino/owner/mode/link count with no-follow handles, fsyncs children
bottom-up, and fsyncs each containing parent. It sets the volume parent to exact
`root:1000`/`0750`, then exclusively writes marker bytes
`firecrawl-browser-volume-v1\n` as exact `root:root`/`0600`, fsyncs marker and
parent, and releases the lock. `validate-existing` requires those same parent,
marker, child, and content invariants.
`validate-existing` performs the same held-handle validation but never creates,
chowns, chmods, removes, renames, truncates, or repairs anything. It leaves all
contents untouched for recovery.

Browser Service is validation-only for `state`, pre-created `profiles`, and all
staging ancestors. It never calls mkdir, chmod, chown, rename, repair, or
recursive cleanup to establish them. It opens each through its held parent with
`O_DIRECTORY | O_NOFOLLOW`, then rejects absence, links,
non-directories, wrong owner, any mode other than `0700`, zero link count,
disallowed filesystem, or changed parent chain. It preserves valid existing
intents, temps, wrappers, and payloads for bounded recovery.

After init completes, Browser Service opens validated `state` and pre-created
`profiles`; reconciliation places those held descriptors/identities into root
evidence before any scaffold, canary, intent recovery, or general Task 3 scan.
No code lazily creates `profiles`. The API container does
not mount this named volume read-write or read-only; it receives reconciliation
data over the authenticated service protocol. A future explicit API filesystem
requirement needs a separate design review and is not implied here.

Exact invariants for `.profile-publish-staging`, `intents`, `bundles`,
`profiles`, every profile UUID directory, and every `working`, `staging`, and
`committed` parent are: owner equals effective Browser Service UID, mode
exactly `0700`, directory type, no symlink, positive link count, `st_dev` equal
to the held browser-state root, and membership in the current held root/startup
binding. Each publication's native precheck additionally proves equal statx
mount ID for its actual source and target parent. Existing valid `intents` and
`bundles` survive restart unchanged for recovery. Unknown or invalid reserved
entries fail readiness; they are never eagerly deleted.

No profile UUID directory is created by provisioning. Profile scaffolding
itself uses atomic publication below the pre-created `profiles` parent.

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
and fresh statfs/statx must succeed. Controller first returns
`native_resolved/atomic_publish_source_missing` with no locations and performs
no classification, cleanup, retry, or admission action. Reducer must next emit
the exact separate `observe_locations` effect. Stable intent must bind the exact
source identity and selectors, and its `locations_observed` must find source absent plus
either the exact matching public canary target for publication replay or the
exact matching private deletion identity for cleanup replay. The latter uses
the attempt-zero root identity plus manifest/cursor-consistent remaining tree.
Only reducer then normalizes to `atomic_publish_replay_completed`, advances or
finishes the expected durable phase, accepts the current call's mount proof,
and leaves admission open. Persist replay-completed when filling a null classification;
if classification is already durable, validate it unchanged and use the replay
result only as current-process proof. A mismatch, both/neither unexplained,
wrong phase/attempt, or any other `ENOENT` makes reducer emit
`close_admission/binding_invalid`, wait for its observation, then record global
fail-stop. Controller never normalizes source-missing itself.

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

A generation-scoped reservation ledger updates only through a reducer-emitted
`reserve_budget` effect observed before any await/open/create/copy/hash/temp/
wrapper/canary effect. Concurrent operations serialize controller execution of
that request through admission; a would-be count or byte over limit returns a
closed rejection observation before filesystem effect. Reservations never
refund in-process after an ambiguous or close-unverified result. Restart
uses explicit enumerate/read/reserve effects for all durable state before
cleanup or classification.
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
`classification.nativeCode` is reducer-normalized durable result after separate
location observation, so raw `atomic_publish_source_missing` never appears
there.

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
   `private_manifest_temp_file`, retain its pinned semantic ID and full
   post-write evidence, then publish that exact temp to the absent stable
   filename via reconciliation-controlled native no-replace without reopening
   it, and sync `intents`.
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
rule or when the controller proves the syscall succeeded before a later
controller failure; evidence/error precedence and global fail-stop remain
preserved.

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
   `private_intent_temp_file`, retain its pinned semantic ID/full evidence, and
   publish that exact object to absent stable intent through native no-replace
   without reopening it. Resolve both locations, then sync `intents`. Only then
   may wrapper creation begin.
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

## Reconciliation-owned capability and effect boundary

`reconciliation.ts` is the sole owner of the `AnchoredRoot`, `BoundGeneration`,
and `PreReadyRecoveryAuthority` WeakMaps, every held directory/file object, and
every raw descriptor. Opaque objects may cross existing ProfileStore/Registry
APIs, but only reconciliation can resolve, mint, move, or consume their backing
records. The atomic engine never accepts or returns those opaque objects, a raw
fd, a native binding, a procfd/path, or a callback that exposes one.

`atomic-directory-publication.ts` is a pure canonical reducer plus durable
effect protocol. Its closed data-only interface is:

```ts
type AtomicNativeMoveV1 = "profile_publish" | "canary_publish" |
  "profile_source_to_private" | "canary_source_to_private";
type AtomicLocationMoveV1 = AtomicNativeMoveV1 | "intent_publish" |
  "manifest_publish";

declare const flightIdBrand: unique symbol;
type FlightSemanticId = Readonly<{ [flightIdBrand]: true }>;
type FlightEffectId = Readonly<{ effect: true; [flightIdBrand]: true }>;
type FlightPartialCreateId = Readonly<{
  partialCreate: true;
  [flightIdBrand]: true;
}>;

type AtomicObjectEvidenceV1 = Readonly<{
  dev: string;
  ino: string;
  mode: number;
  size: number;
  contentSha256: Sha256 | null;
  evidenceDigest: Sha256;
}>;

type AtomicObjectRoleV1 = "trusted_parent" | "state_root" |
  "profiles_parent" | "staging_root" | "intents_parent" |
  "bundles_parent" | "wrapper" | "private_source" | "payload_entry" |
  "intent_temp" | "intent_stable" | "manifest_temp" | "manifest_stable" |
  "private_deletion" | "public_source" | "public_target";

type AtomicEffectKindV1 =
  | "reserve_budget" | "release_budget"
  | "create_and_pin_wrapper" | "create_and_pin_directory" |
    "create_and_pin_file" | "create_and_pin_temp_file" |
    "cleanup_partial_create"
  | "open_pin_handle" | "revalidate_handle" | "close_handle" |
    "enumerate_directory" | "read_file_chunk"
  | "populate_payload_entry" | "copy_payload_chunk" |
    "write_file_chunk" | "canonicalize_tree_step" | "hash_content_chunk"
  | "fsync_file" | "fsync_directory" | "fsync_parent"
  | "persist_intent" | "replace_intent" | "remove_intent" |
    "persist_manifest" | "remove_manifest"
  | "native_no_replace" | "observe_locations"
  | "remove_file" | "remove_directory" | "remove_root"
  | "resolve_adoption" | "adopt_generation" | "release_publication" |
    "close_admission";

type CanonicalLocationEvidenceV1 = Readonly<{
  state: "absent" | "match" | "other";
  objectId: FlightSemanticId | null;
  dev: string | null;
  ino: string | null;
  mode: number | null;
  evidence: AtomicObjectEvidenceV1 | null;
  evidenceDigest: Sha256;
}>;

type AtomicRawNativeCodeV1 = "success" | "atomic_publish_exists" |
  "atomic_publish_source_missing" | "atomic_publish_unsupported" |
  "atomic_publish_cross_device" | "atomic_publish_binding_invalid" |
  "atomic_publish_denied" | "atomic_publish_invalid_argument" |
  "atomic_publish_io";

type AtomicEffectRequestV1 =
  | Readonly<{
      kind: "reserve_budget" | "release_budget";
      effectId: FlightEffectId;
      operationId: CanonicalUuid;
      reservation: "payload_entries" | "payload_bytes" | "stable_files" |
        "scratch_files" | "manifest_bytes" | "other_metadata_bytes";
      count: number;
      byteSize: number;
    }>
  | Readonly<{
      kind: "create_and_pin_wrapper" | "create_and_pin_directory" |
        "create_and_pin_file" | "create_and_pin_temp_file";
      effectId: FlightEffectId;
      operationId: CanonicalUuid;
      role: AtomicObjectRoleV1;
      parentId: FlightSemanticId;
      leaf: string;
      parentEvidenceDigest: Sha256;
      mode: 384 | 448;
      expectedAbsence: true;
    }>
  | Readonly<{
      kind: "cleanup_partial_create";
      effectId: FlightEffectId;
      operationId: CanonicalUuid;
      partialId: FlightPartialCreateId;
    }>
  | Readonly<{
      kind: "open_pin_handle";
      effectId: FlightEffectId;
      operationId: CanonicalUuid;
      role: AtomicObjectRoleV1;
      parentId: FlightSemanticId;
      leaf: string;
      flags: "directory_nofollow" | "file_read_nofollow" |
        "file_write_nofollow" | "path_nofollow";
      expected: AtomicObjectEvidenceV1;
    }>
  | Readonly<{
      kind: "revalidate_handle" | "close_handle" |
        "enumerate_directory" | "read_file_chunk";
      effectId: FlightEffectId;
      operationId: CanonicalUuid;
      role: AtomicObjectRoleV1;
      objectId: FlightSemanticId;
      cursor: number;
      byteLength: number;
      expected: AtomicObjectEvidenceV1;
    }>
  | Readonly<{
      kind: "populate_payload_entry" | "canonicalize_tree_step";
      effectId: FlightEffectId;
      operationId: CanonicalUuid;
      rootId: FlightSemanticId;
      cursor: number;
      evidenceDigest: Sha256;
    }>
  | Readonly<{
      kind: "copy_payload_chunk" | "write_file_chunk";
      effectId: FlightEffectId;
      operationId: CanonicalUuid;
      sourceFileId: FlightSemanticId | null;
      inlineBytes: Uint8Array | null;
      destinationFileId: FlightSemanticId;
      offset: number;
      byteLength: number;
      expectedChunkSha256: Sha256;
      expectedResultSha256: Sha256;
    }>
  | Readonly<{
      kind: "hash_content_chunk";
      effectId: FlightEffectId;
      operationId: CanonicalUuid;
      objectId: FlightSemanticId;
      offset: number;
      byteLength: number;
      evidenceDigest: Sha256;
    }>
  | Readonly<{
      kind: "fsync_file" | "fsync_directory" | "fsync_parent";
      effectId: FlightEffectId;
      operationId: CanonicalUuid;
      role: AtomicObjectRoleV1;
      objectId: FlightSemanticId;
      expected: AtomicObjectEvidenceV1;
    }>
  | Readonly<{
      kind: "persist_intent" | "persist_manifest";
      effectId: FlightEffectId;
      operationId: CanonicalUuid;
      expectedPhase: AtomicPublishIntentV1["phase"] | null;
      canonicalBytes: Uint8Array;
      contentDigest: Sha256;
      tempParentId: FlightSemanticId;
      tempLeaf: string;
      tempObjectId: FlightSemanticId;
      expectedTemp: AtomicObjectEvidenceV1;
      stableParentId: FlightSemanticId;
      stableLeaf: string;
      expectedStable: Readonly<{ absent: true }>;
    }>
  | Readonly<{
      kind: "replace_intent";
      effectId: FlightEffectId;
      operationId: CanonicalUuid;
      expectedPhase: AtomicPublishIntentV1["phase"];
      canonicalBytes: Uint8Array;
      contentDigest: Sha256;
      tempParentId: FlightSemanticId;
      tempLeaf: string;
      tempObjectId: FlightSemanticId;
      expectedTemp: AtomicObjectEvidenceV1;
      stableParentId: FlightSemanticId;
      stableLeaf: string;
      expectedStable: AtomicObjectEvidenceV1;
    }>
  | Readonly<{
      kind: "remove_intent" | "remove_manifest";
      effectId: FlightEffectId;
      operationId: CanonicalUuid;
      stableParentId: FlightSemanticId;
      stableLeaf: string;
      stableObjectId: FlightSemanticId;
      expectedStable: AtomicObjectEvidenceV1;
    }>
  | Readonly<{
      kind: "native_no_replace";
      effectId: FlightEffectId;
      operationId: CanonicalUuid;
      move: AtomicNativeMoveV1;
      sourceParentId: FlightSemanticId;
      sourceId: FlightSemanticId;
      sourceLeaf: string;
      targetParentId: FlightSemanticId;
      targetLeaf: string;
      expectedSource: AtomicObjectEvidenceV1;
      expectedTarget: AtomicObjectEvidenceV1 | Readonly<{ absent: true }>;
      evidenceDigest: Sha256;
    }>
  | Readonly<{
      kind: "observe_locations";
      requestKind: "native_no_replace";
      effectId: FlightEffectId;
      operationId: CanonicalUuid;
      move: AtomicNativeMoveV1;
      sourceParentId: FlightSemanticId;
      sourceId: FlightSemanticId | null;
      sourceLeaf: string;
      targetParentId: FlightSemanticId;
      targetLeaf: string;
      expectedSource: AtomicObjectEvidenceV1;
      expectedTarget: AtomicObjectEvidenceV1 | Readonly<{ absent: true }>;
      evidenceDigest: Sha256;
    }>
  | Readonly<{
      kind: "observe_locations";
      requestKind: "persist_intent";
      effectId: FlightEffectId;
      operationId: CanonicalUuid;
      move: "intent_publish";
      tempParentId: FlightSemanticId;
      tempLeaf: string;
      tempObjectId: FlightSemanticId;
      expectedTemp: AtomicObjectEvidenceV1;
      stableParentId: FlightSemanticId;
      stableLeaf: string;
      expectedTargetBefore: Readonly<{ absent: true }>;
      expectedTargetAfter: AtomicObjectEvidenceV1;
      evidenceDigest: Sha256;
    }>
  | Readonly<{
      kind: "observe_locations";
      requestKind: "persist_manifest";
      effectId: FlightEffectId;
      operationId: CanonicalUuid;
      move: "manifest_publish";
      tempParentId: FlightSemanticId;
      tempLeaf: string;
      tempObjectId: FlightSemanticId;
      expectedTemp: AtomicObjectEvidenceV1;
      stableParentId: FlightSemanticId;
      stableLeaf: string;
      expectedTargetBefore: Readonly<{ absent: true }>;
      expectedTargetAfter: AtomicObjectEvidenceV1;
      evidenceDigest: Sha256;
    }>
  | Readonly<{
      kind: "remove_file" | "remove_directory" | "remove_root";
      effectId: FlightEffectId;
      operationId: CanonicalUuid;
      role: AtomicObjectRoleV1;
      parentId: FlightSemanticId;
      leaf: string;
      objectId: FlightSemanticId;
      expected: AtomicObjectEvidenceV1;
      manifestSha256: Sha256;
      cursor: number;
    }>
  | Readonly<{
      kind: "resolve_adoption" | "adopt_generation" |
        "release_publication";
      effectId: FlightEffectId;
      operationId: CanonicalUuid;
      authorityDigest: Sha256;
    }>
  | Readonly<{
      kind: "close_admission";
      effectId: FlightEffectId;
      operationId: CanonicalUuid;
      reason: "binding_invalid" | "ambiguous" | "unsupported" |
        "cross_device" | "denied" | "io" | "close_unverified";
      evidenceDigest: Sha256;
    }>;

type AtomicEffectObservationV1 =
  | Readonly<{
      kind: "effect_rejected";
      effectId: FlightEffectId;
      requestKind: AtomicEffectKindV1;
      code: "budget_exceeded" | "binding_invalid" | "conflict" |
        "unsupported" | "denied" | "io" | "close_unverified";
      evidenceDigest: Sha256;
    }>
  | Readonly<{
      kind: "effect_completed";
      effectId: FlightEffectId;
      requestKind: Exclude<
        AtomicEffectKindV1,
        "native_no_replace" | "observe_locations" |
          "persist_intent" | "persist_manifest" |
          "remove_intent" | "remove_manifest" |
          "remove_file" | "remove_directory" | "remove_root" |
          "create_and_pin_wrapper" | "create_and_pin_directory" |
          "create_and_pin_file" | "create_and_pin_temp_file" |
          "open_pin_handle" |
          "enumerate_directory" | "read_file_chunk" |
          "canonicalize_tree_step" | "hash_content_chunk" |
          "cleanup_partial_create" |
          "resolve_adoption" | "adopt_generation" |
          "release_publication"
      >;
      evidenceDigest: Sha256;
      count: number;
      byteSize: number;
    }>
  | Readonly<{
      kind: "create_and_pin_completed";
      effectId: FlightEffectId;
      requestKind: "create_and_pin_wrapper" | "create_and_pin_directory" |
        "create_and_pin_file" | "create_and_pin_temp_file";
      handleId: FlightSemanticId;
      evidence: AtomicObjectEvidenceV1;
    }>
  | Readonly<{
      kind: "existing_handle_pinned";
      effectId: FlightEffectId;
      handleId: FlightSemanticId;
      evidence: AtomicObjectEvidenceV1;
    }>
  | Readonly<{
      kind: "create_and_pin_partial";
      effectId: FlightEffectId;
      requestKind: "create_and_pin_wrapper" | "create_and_pin_directory" |
        "create_and_pin_file" | "create_and_pin_temp_file";
      partialId: FlightPartialCreateId;
      stage: "entry_created" | "handle_opened" | "fstat_failed";
      entryCreated: true;
      handleOpened: boolean;
      evidence: AtomicObjectEvidenceV1 | null;
      code: "binding_invalid" | "denied" | "io";
      evidenceDigest: Sha256;
    }>
  | Readonly<{
      kind: "partial_create_cleanup_observed";
      effectId: FlightEffectId;
      partialId: FlightPartialCreateId;
      state: "absent";
      parentSynced: true;
      evidenceDigest: Sha256;
    }>
  | Readonly<{
      kind: "partial_create_cleanup_failed";
      effectId: FlightEffectId;
      partialId: FlightPartialCreateId;
      stage: "close" | "identity_verify" | "remove" |
        "absence_verify" | "parent_fsync";
      state: "present" | "unknown" | "absent_unsynced";
      parentSynced: false;
      code: "binding_invalid" | "denied" | "io" |
        "close_unverified";
      evidenceDigest: Sha256;
    }>
  | Readonly<{
      kind: "removal_observed";
      effectId: FlightEffectId;
      requestKind: "remove_intent" | "remove_manifest" |
        "remove_file" | "remove_directory" | "remove_root";
      objectId: FlightSemanticId;
      removedEvidence: AtomicObjectEvidenceV1;
      state: "absent";
      parentSynced: true;
      evidenceDigest: Sha256;
    }>
  | Readonly<{
      kind: "directory_observed";
      effectId: FlightEffectId;
      cursor: number;
      entries: ReadonlyArray<Readonly<{
        leaf: string;
        role: AtomicObjectRoleV1;
        objectId: FlightSemanticId;
        type: "file" | "directory";
        evidenceDigest: Sha256;
      }>>;
      done: boolean;
      evidenceDigest: Sha256;
    }>
  | Readonly<{
      kind: "file_chunk_observed";
      effectId: FlightEffectId;
      cursor: number;
      byteSize: number;
      bytesBase64: string;
      contentDigest: Sha256;
      eof: boolean;
      evidenceDigest: Sha256;
    }>
  | Readonly<{
      kind: "native_resolved";
      effectId: FlightEffectId;
      requestKind: "native_no_replace";
      operationId: CanonicalUuid;
      move: AtomicNativeMoveV1;
      sourceObjectId: FlightSemanticId;
      sourceEvidence: AtomicObjectEvidenceV1;
      rawCode: AtomicRawNativeCodeV1;
      nativePrecheckEvidenceDigest: Sha256;
      evidenceDigest: Sha256;
    }>
  | Readonly<{
      kind: "native_resolved";
      effectId: FlightEffectId;
      requestKind: "persist_intent";
      operationId: CanonicalUuid;
      move: "intent_publish";
      sourceObjectId: FlightSemanticId;
      sourceEvidence: AtomicObjectEvidenceV1;
      rawCode: AtomicRawNativeCodeV1;
      nativePrecheckEvidenceDigest: Sha256;
      evidenceDigest: Sha256;
    }>
  | Readonly<{
      kind: "native_resolved";
      effectId: FlightEffectId;
      requestKind: "persist_manifest";
      operationId: CanonicalUuid;
      move: "manifest_publish";
      sourceObjectId: FlightSemanticId;
      sourceEvidence: AtomicObjectEvidenceV1;
      rawCode: AtomicRawNativeCodeV1;
      nativePrecheckEvidenceDigest: Sha256;
      evidenceDigest: Sha256;
    }>
  | Readonly<{
      kind: "locations_observed";
      effectId: FlightEffectId;
      requestKind: "native_no_replace";
      operationId: CanonicalUuid;
      move: AtomicNativeMoveV1;
      sourceParentId: FlightSemanticId;
      sourceLeaf: string;
      targetParentId: FlightSemanticId;
      targetLeaf: string;
      requestedSourceObjectId: FlightSemanticId | null;
      sourceObjectId: FlightSemanticId | null;
      targetObjectId: FlightSemanticId | null;
      source: CanonicalLocationEvidenceV1;
      target: CanonicalLocationEvidenceV1;
      evidenceDigest: Sha256;
    }>
  | Readonly<{
      kind: "locations_observed";
      effectId: FlightEffectId;
      requestKind: "persist_intent";
      operationId: CanonicalUuid;
      move: "intent_publish";
      tempParentId: FlightSemanticId;
      tempLeaf: string;
      stableParentId: FlightSemanticId;
      stableLeaf: string;
      requestedSourceObjectId: FlightSemanticId;
      sourceObjectId: FlightSemanticId | null;
      targetObjectId: FlightSemanticId | null;
      source: CanonicalLocationEvidenceV1;
      target: CanonicalLocationEvidenceV1;
      evidenceDigest: Sha256;
    }>
  | Readonly<{
      kind: "locations_observed";
      effectId: FlightEffectId;
      requestKind: "persist_manifest";
      operationId: CanonicalUuid;
      move: "manifest_publish";
      tempParentId: FlightSemanticId;
      tempLeaf: string;
      stableParentId: FlightSemanticId;
      stableLeaf: string;
      requestedSourceObjectId: FlightSemanticId;
      sourceObjectId: FlightSemanticId | null;
      targetObjectId: FlightSemanticId | null;
      source: CanonicalLocationEvidenceV1;
      target: CanonicalLocationEvidenceV1;
      evidenceDigest: Sha256;
    }>
  | Readonly<{
      kind: "content_observed";
      effectId: FlightEffectId;
      requestKind: "canonicalize_tree_step" | "hash_content_chunk";
      cursor: number;
      byteSize: number;
      contentDigest: Sha256;
      evidenceDigest: Sha256;
    }>
  | Readonly<{
      kind: "authority_observed";
      effectId: FlightEffectId;
      requestKind: "resolve_adoption" | "adopt_generation" |
        "release_publication";
      adopted: boolean;
      authorityDigest: Sha256;
      evidenceDigest: Sha256;
    }>;

type ApplyAtomicEffectV1 = (
  request: AtomicEffectRequestV1,
) => Promise<AtomicEffectObservationV1>;
```

Each controller invocation owns one non-exported semantic registry with an
active flight nonce and `WeakMap<FlightSemanticId, HeldRecord>`. Initial semantic IDs are
minted only for immutable held-authority inputs acquired before reducer start.
Every later semantic ID is minted only in the typed observation that created/opened/
discovered/pinned its exact object; the reducer cannot construct an ID. Each
record binds role, operation, parent ID, canonical leaf, held handle, startup
binding, and dev/ino/mode/size/hash evidence. Unknown/foreign/stale IDs reject
before effect.

### Held-procfd adapter for non-rename effects

Logical create, existing-open, and removal effects have one exact Linux/Node 22
implementation. Reconciliation resolves the request's held parent record,
validates a single leaf, and constructs
`/proc/self/fd/<held-parent-fd>/<strict-leaf>` only in the stack frame executing
that effect. `<strict-leaf>` must pass its closed role grammar: control leaves
use the 1-128-byte ASCII native-leaf grammar; payload leaves use one canonical
NFC UTF-8 manifest segment of 1..255 bytes. Both independently reject NUL,
`/`, `\\`, empty, `.`, and `..`, and require encode/decode round-trip equality.
Nested traversal is represented by another held parent ID and another single
strict leaf; a slash-containing or multi-segment selector is never accepted.
The numeric fd extracted from the held `FileHandle` is not stored as separate
record data, and the constructed procfd string is not retained beyond the one
awaited Node operation. Neither is returned, captured by a controller-owned
long-lived closure, placed in a request or observation, logged, persisted, or
exported.

Startup preflight requires Linux procfs before reducer admission. It calls
Node 22 `statfsSync("/proc/self/fd", { bigint: true })`, requires filesystem
type `PROC_SUPER_MAGIC` (`0x9fa0n`), opens `/proc/self/fd` with numeric
`O_RDONLY | O_DIRECTORY | O_NOFOLLOW`, and closes that probe with verified
closure. It then `statSync`s `/proc/self/fd/<held-root-fd>` and requires its
dev/ino/type to equal `fstatSync(<held-root-fd>)`. Missing/inaccessible procfs,
the wrong filesystem type, a non-kernel-controlled fd directory, mismatch, or
any unsupported Node operation produces `atomic_publish_unsupported`, leaves
readiness false, and permits no pathname or native-addon fallback.

Before and after every awaited filesystem operation, the controller runs a
synchronous full-chain gate over the held volume→state→operation parent chain.
The gate resolves every flight-local record, checks global admission, verifies
the operation/role/parent linkage, and compares `fstatSync` dev/ino/type/mode
with its captured startup/record evidence. Any drift or closed/replaced record
rejects the effect and closes admission before another operation. The second
gate runs even when the awaited call rejects. This guarantee relies on the
specified protected-parent invariant: after startup ownership/mode validation,
neither an untrusted process nor request code can mutate these directories.
Privileged or same-UID mutation is an out-of-scope compromise tested only to
prove detection/fail-stop; this design does not claim race-safe removal from an
attacker-writable parent.

Directory creation calls Node 22
`fs.promises.mkdir(procfdChild, { mode: 0o700, recursive: false })`, then
`fs.promises.open(procfdChild, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)`, with all
flags passed as numeric `fs.constants` values, then `FileHandle.stat({ bigint:
true })`. File/temp creation calls `fs.promises.open` with numeric
`O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW` and the role's fixed mode, then the
same bigint handle stat. Existing-directory open uses numeric
`O_RDONLY | O_DIRECTORY | O_NOFOLLOW`; existing-file open uses numeric
`O_RDONLY | O_NOFOLLOW`; each is immediately statted and matched to the
request's complete evidence before its semantic ID is minted or accepted.
String flags, recursive creation, ordinary configured/root paths, and a second
unrequested open are forbidden.

Node `SystemError` objects may contain their procfd `path`, `dest`, `syscall`,
or message. They never leave the effect frame: reconciliation reads only the
allowlisted errno `code`, maps it to the closed path-free rejection code, and
discards the original error before observation/logging. An unknown error closes
admission and surfaces one constant path-free internal failure without attaching
the original as `cause`. No telemetry or diagnostic serialization receives the
Node error object.

Every logical removal—including intent/manifest and tree cleanup—resolves its
existing pinned record, `lstat`s the procfd child, opens it with the applicable
numeric flags—`O_RDONLY | O_NOFOLLOW` for a file and
`O_RDONLY | O_DIRECTORY | O_NOFOLLOW` for a directory—then
`FileHandle.stat({ bigint: true })` pins the observed child. It requires lstat,
fstat, registry evidence, role, and requested full evidence to match. It repeats
`lstat` immediately before namespace mutation and requires the same identity.
It then calls exactly `fs.promises.unlink` for a file or `fs.promises.rmdir` for
an empty directory on that procfd child; neither recursive removal nor `rm` is
permitted. After verified closure of the removal pin, it proves the leaf absent,
calls `sync()` on the already-held parent
`FileHandle`, and only then emits `removal_observed` with the removed object ID,
full removed evidence, `state: "absent"`, and `parentSynced: true`. Child
absence/replacement or failure at lstat/open/fstat/recheck/remove/close/absence
proof/parent sync fails closed and never advances phase/cursor or reports
success.

Reads, writes, hashes, enumeration, and fsync effects operate only on their
already-held `FileHandle` records; they do not reconstruct a pathname. The only
native operation remains `renameNoReplace`. Effect names such as
`create_and_pin_*`, `open_pin_handle`, and `remove_*` describe semantic
results; this design makes no claim that JavaScript calls a `mkdirat`, `openat`,
or `unlinkat` API.

Create-and-pin effects are composite only inside an already-held protected
parent. Wrapper/directory creation executes the exact procfd mkdir/open/stat
sequence above. File/temp creation executes the exact procfd exclusive
open/stat sequence above. Success is one
`create_and_pin_completed` observation with new `handleId` and complete
evidence; no
following `open_pin_handle` is legal. That open effect is only for an existing
leaf with exact expected evidence.

Failure before entry creation is ordinary `effect_rejected`. Failure after
creation returns `create_and_pin_partial` before cleanup and mints a one-use
`FlightPartialCreateId` in a separate private WeakMap. Reducer must emit
`cleanup_partial_create`. As one specified composite effect, controller closes
the partial handle when present and requires verified closure, reopens/stats the
canonical leaf through the held protected parent, establishes or compares exact
dev/ino/type/mode against the exclusive-creation record, and uses the exact
procfd `fs.promises.unlink` or `fs.promises.rmdir` removal sequence above for
that identity. It proves leaf absence, fsyncs
the held containing parent, and only then returns exactly
`partial_create_cleanup_observed` with `state: "absent"` and
`parentSynced: true`.

Failure at close, identity verification, remove, absence proof, or parent fsync
returns `partial_create_cleanup_failed` with exact stage/state and
`parentSynced: false`. Controller retains the partial ID/record, reducer emits
global fail-stop, and neither may advance phase/cursor, release reservation,
remove stable intent, or attempt another entry. Controller never silently
closes, unlinks, or treats absent-but-unsynced as durable cleanup.

Effect IDs derive only from flight nonce plus reducer step counter and bind one
request/observation; they never identify filesystem objects. Semantic IDs,
partial-create IDs, and effect IDs are flight-local opaque objects, never
strings. Canonical
intent/manifest encoders reject them, logs never render them, and no ID is
persisted or returned publicly. At most 4,096 semantic plus partial-create IDs
exist, including at most 1,024 partial-create IDs; discovery and cleanup reuse
them sequentially. Normal terminal/drain emits required close effects, then
revokes registry epoch and drops records. Partial-cleanup or close-unverified
fail-stop instead retains affected IDs/records until process exit; admission is
closed and they cannot be used for another effect. No ID is ever reused.
Restart opens stable locators through fresh reducer effects
and typed observations remint new IDs from durable locator/evidence bytes.

Object IDs, native moves, selectors, inline bytes, and observations are closed
semantic data, not descriptors or unrestricted paths. `sourceFileId` XOR
`inlineBytes` is required for copy/write; inline bytes equal `byteLength`, and
all leaves pass the operation-kind grammar. The reducer accepts durable state plus at most
one observation whose effect ID/kind exactly matches its outstanding request.
It returns exactly one typed effect or one terminal result—never a batch and
never “continue and also mutate.” Unknown, duplicate, out-of-order, mismatched,
or replayed observations fail closed. It performs no I/O, imports no
reconciliation/ProfileStore/Registry module, owns no WeakMap, and cannot invoke
the addon.

Directory observations contain at most 256 entries and 65,536 encoded bytes;
file observations contain at most 65,536 decoded bytes. Their storage is
reserved before controller read and released only by a later reducer effect.
The reducer validates canonical leaf/base64/content hashes and streams larger
records across monotonic cursors; no unbounded discovery is hidden in a helper.

The reconciliation-owned controller implements `ApplyAtomicEffectV1`. For a
native request it resolves exact semantic IDs against its WeakMap without I/O
and calls a private
`withNativeOperands` scope. Only the synchronous callback body can see
`{sourceDirectoryFd, sourceLeaf, targetDirectoryFd, targetLeaf}`; it invokes
the fixed native binding and returns no operand. The controller converts the
raw native result/precheck digest only; locations require the reducer's next
separate effect. No operand is stored in an effect request/observation, promise,
closure that outlives the callback, log, or exported value.

`persist_intent` and `persist_manifest` requests are complete publication
authorizations, not instructions to rediscover a temp. Each carries the exact
existing `tempObjectId`, temp and stable parent IDs/leaves, full
`expectedTemp`, canonical `Uint8Array` bytes, their SHA-256 digest, and exact
absent-stable expectation. The controller resolves the already-pinned temp
record created by the preceding `create_and_pin_temp_file`; requires its
operation, role, parent, leaf, dev/ino/type/mode/size/content hash, and evidence
digest to match; hashes `canonicalBytes` and requires that digest, byte length,
`contentDigest`, and the temp record's post-write/post-fsync content evidence
all agree. It then invokes `renameNoReplace` using that record's held source
parent and leaf. It performs no temp pathname/procfd open, lstat, read,
filesystem hash, or selector reconstruction inside persistence. A
`native_resolved` observation
echoes the exact request kind, operation ID, and closed move discriminator and
binds `sourceObjectId` plus full `sourceEvidence` to the native precheck/result;
a different association or ID/evidence pair is not a matching observation.
Location proof remains the next explicit reducer
effect. For intent its exact tuple is `observe_locations`, `persist_intent`,
`intent_publish`; for manifest it is `observe_locations`, `persist_manifest`,
`manifest_publish`. That request repeats the same operation ID, temp object/full
evidence and temp parent/leaf, stable parent/leaf, original target-absence
precondition, and expected post-move target evidence. It must associate with the
immediately preceding matching
`native_resolved` source ID/evidence; profile/canary/source moves instead use
`observe_locations/native_no_replace/<AtomicNativeMoveV1>`.

Every `locations_observed` echoes the exact request kind and closed
`AtomicLocationMoveV1` discriminator, the requested source object ID, and the
observed source/target object IDs alongside their complete canonical location
proofs. Each explicit object ID must equal its corresponding
`CanonicalLocationEvidenceV1.objectId`; absence requires null and match/other
requires the ID minted by that exact observation. Absence also requires null
dev/ino/mode/evidence; match/other requires full non-null evidence whose
dev/ino/mode equal the scalar fields and whose digest participates in the
location digest. Effect ID, request kind, move, operation, authorized source
ID/evidence, both parent IDs/leaves, and target expectations must all match the
outstanding request before the reducer can classify or sync. Wrong persistence/
native discriminator pairing is not representable in the closed union and
fails parsing at runtime.

`replace_intent` carries the same exact pinned-temp authorization plus full
expected stable evidence. After identical byte/evidence checks, reconciliation
uses Node 22 `fs.promises.rename` between locally constructed held-parent
procfd child strings to replace only that authenticated stable intent. It does
not reopen either record. Its following explicit stable-open/hash observation
and parent sync establish the committed phase. Ordinary replacement never
enters the native addon; the addon still implements only `renameNoReplace`.

Before the first reducer call only, reconciliation may acquire/validate/lease
the trusted volume→state→`profiles`/staging authority and construct
`PreReadyRecoveryAuthority`. That acquisition does not enumerate/read intent,
wrapper, payload, manifest, source, or target contents; recovery discovery
starts with reducer-emitted `enumerate_directory`/`open_pin_handle`/
`read_file_chunk` effects. If acquisition fails before reducer start,
reconciliation closes only the handles opened by that failed acquisition and
performs no namespace mutation. After reducer start, every filesystem action,
reservation change, handle open/close, computation read, native call, adoption,
and release occurs only in response to the reducer's single outstanding typed
effect. Controller helpers cannot perform an unrequested mkdir/open/read/write/
fsync/rename/unlink/close or budget mutation.

Ordering is fixed for every loop and expands every earlier protocol step:

1. Reconciliation validates and leases held volume/state/`profiles`/staging
   roots and constructs `PreReadyRecoveryAuthority` before engine recovery.
2. Reservation is `reserve_budget`; wrapper/tree construction is one
   `create_and_pin_*` followed directly by required `fsync_parent`—never a
   second open. Payload population repeats `populate_payload_entry`, composite
   create-and-pin,
   `copy_payload_chunk` or `write_file_chunk`, hash/canonicalize, `fsync_file`,
   postorder `fsync_directory`, and close. Each effect is separately observed.
   A partial-create observation branches immediately to the single composite
   cleanup effect; its internal close→identity verify→remove→absence proof→
   containing-parent fsync order is fixed. Reducer resumes only from observed
   `absent/parentSynced`; any failed stage retains partial ID and intent under
   fail-stop.
3. Initial intent and manifest publication sequence is reserve, composite temp
   creation with `create_and_pin_temp_file`, chunk writes, file fsync,
   hash/evidence finalization, then `persist_intent|persist_manifest` carrying
   that existing temp ID/evidence, exact parents/leaves, and canonical bytes/
   digest. Native resolution binds the same source ID/evidence, followed by
   the exact `intent_publish` or `manifest_publish` location request/observation
   carrying the same temp/stable authority, then parent fsync and close;
   persistence performs no hidden reopen. Later intent transition uses the same pinned-temp sequence
   with `replace_intent`. Stable record removal is
   `remove_intent|remove_manifest`, whose successful observation already proves
   parent fsync, followed by budget release.
   Immutable manifests have no replace effect; a replacement request is outside
   the closed union and fails parsing.
4. Profile/canary/source movement is exactly `native_no_replace`,
   raw `native_resolved`, separate `observe_locations`, then reducer
   classification and required source/target parent fsync effects. In
   particular source-missing carries no locations/admission decision; no native
   result implies observation, normalization, sync, or fail-stop.
5. Cleanup first persists the next cursor using step 3, then emits exactly one
   `remove_file|remove_directory|remove_root`; its sole success observation
   proves exact identity removal, absence, and containing-parent fsync. It then
   closes the retained handle and releases its reservation. It cannot advance
   cursor or remove the next identity in the same reducer step.
6. Reconciliation resolves its own authority only for `resolve_adoption`. The
   reducer first completes durable adopted intent replacement, then emits
   `adopt_generation`; release follows durable discard/cleaned transitions and
   exact `release_publication`. Reconciliation verifies its authority record,
   durably commits `adopted`, then mints/moves `BoundGeneration` into its own
   WeakMap. During pre-ready recovery, that capability is retained only inside
   reconciliation's non-exported sealed recovery outcome; Registry and
   ProfileStore do not yet exist and receive nothing. The single startup
   constructor/install consumes all sealed capabilities once. During an
   ordinary runtime publication, reconciliation instead attaches the new
   capability once to the already-installed generation store under the
   operation lock. No observer can see adopted state without the corresponding
   sealed-or-installed live capability; crash after durable commit is recovered
   from the same authority evidence.
7. Every exit emits required `close_handle` effects in reverse ownership order;
   only observed releases emit `release_budget`. Failure to close follows the
   existing close-unverified fail-stop and never licenses implicit cleanup.

Imports are one-way: `reconciliation.ts` imports the pure engine and private
native loader; the engine never imports reconciliation, startup, ProfileStore,
Registry, server, or index modules. This prevents circular authority and raw-fd
escape.

## Private construction and atomic publication

All new profile, state, generation, and copied nested directories are built
below profile-only private `payload`. Canary proof directories use their exact
private proof leaf instead. The private namespace is trusted against concurrent
mutation, so the composite create-and-pin mkdir/open/fstat effect is permitted
only there; no caller observes an unpinned successful creation.

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
7. Reducer emits the exact semantic `native_no_replace` request. The
   reconciliation-owned controller resolves its held records and invokes native
   `renameNoReplace` only inside `withNativeOperands`.
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
3. Under exclusive profile-operation lock, reconciliation authenticates the
   protected public source from held locator/dev/ino/mode/checksum and full
   service-owned `0700` parent chain, then authenticates the absent private
   deletion target under the exact operation wrapper.
4. Controller revalidates both held records immediately before callback-scoped
   native no-replace from public parent/source leaf into private
   wrapper/deletion leaf, then revalidates after every result. No operand/fd
   escapes the callback.
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
2. Rewalk exact held chains: root→profiles→profile→state for profile data,
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

Before ProfileStore construction or atomic-engine recovery,
`reconciliation.ts` derives a fieldless `PreReadyRecoveryAuthority` and stores
its record in its sole-owner WeakMap. Inputs are the immutable reconciliation
snapshot and persisted Task 3 manifests. The record contains exact referenced
profile locators/checksums, expected namespace scaffolds, cleanup/quarantine
decisions, and process/control/snapshot binding. Engine observations contain
only its digest and adoption decision, never the authority object/record.
Recovery issues no database query and does not depend on a ProfileStore,
Registry, or process-local session token.

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

1. Load/validate native addon; open and validate pre-created `state`, `profiles`,
   and staging roots from the held trusted volume parent.
2. Capture immutable database snapshot plus existing Task 3 manifest evidence
   and build `PreReadyRecoveryAuthority`; readiness remains false.
3. Enumerate and reserve every intent/temp/wrapper plus its possible public
   source/target. Run fresh statfs/statx canaries and resolve all intents.
4. Adopt snapshot-authorized targets or durably enter `discarding`, finish
   source/private cleanup, then mark non-adopted public targets
   `released_to_reconciliation` and remove their intents last. Each adopted
   `BoundGeneration` remains solely in reconciliation's sealed outcome; no
   Registry/ProfileStore attachment occurs in this step.
5. Only after no unresolved intent owns a public locator may general Task 3
   enumeration, plan publication, quarantine, or mutation begin. Recapture and
   seal resulting root/snapshot/manifest evidence.
6. Reconciliation consumes the sealed internal outcome, invokes the
   generation-scoped ProfileStore constructor exactly once from its own held
   recovered records and sealed `BoundGeneration` capabilities, forms one
   immutable `{generation, authority, store, result}` install bundle, and
   performs exactly one Registry compare-and-swap installation under the
   reconciliation lock.
   Only that successful atomic install flips ready.

No provisional, discovery-time, per-profile, retry, or pre-recovery
ProfileStore construction is legal. The single store cannot become visible
before its authority/result, and authority/result cannot become visible without
that same store. Constructor failure performs no install; compare-and-swap
failure verified-closes the one uninstalled store and all transferred handles,
leaves the prior generation unchanged and readiness false, and never retries by
constructing another store in-process. Tests count one constructor call and one
install call for each successful generation and inject failure on both sides of
the atomic install to prove no partial Registry/ProfileStore state.

Task 3 never quarantines or mutates an intent-owned source/target. Release is
crash-safe without a third location: durable `discarding` records outcome
`released_to_reconciliation`, proves source cleanup and target identity, writes
`cleaned`, then removes intent and syncs `intents` while leaving target in its
original public location. A crash before intent removal leaves it protected; a
crash after removal presents an ordinary unreferenced target to next Task 3
run. Thus unadopted committed data is quarantined only after intent removal and
can never be mistaken for adopted state.

## Capability transfer and release

After successful publication, the engine returns only a semantic adoption
effect. Under the operation lock, reconciliation uses the still-open target
pin/evidence and retained root→`profiles`→profile→state leases, persists the
authorized adopted transition, and constructs `BoundGeneration` directly in
its sole-owner WeakMap without pathname reopen. Pre-ready recovery moves that
record from `publishing` to reconciliation's sealed outcome only; it cannot
touch Registry/ProfileStore. Startup's one ProfileStore constructor consumes
all sealed records and its one compare-and-swap installs capability/store/result
together. Runtime publication may move a new record from `publishing` to the
already-installed generation store exactly once under the operation lock.
Only the applicable seal/install/installed-store attachment may precede wrapper
cleanup. The engine never sees or mints `BoundGeneration`.

The reconciliation-owned live record holds generation pin, every ancestor/
parent lease, intent lease, startup binding, and adoption state. Registry/store
attachment consumes it exactly once through reconciliation-owned methods.
Transition pins destination before consuming source. Normal close drains
operations, releases intent ownership when permitted, and reconciliation closes
generation, state, profile, `profiles`, and root leases in reverse order while
attempting every close.

Forged, stale, foreign, double-consumed, or closed objects fail before effect.
A close-then-throw with verified closure reaches zero retained fds. A true
close rejection permanently marks this process `close_unverified`, closes
global admission, rejects every later operation/reconciliation/readiness
attempt, retains process-local fail-stop records, and cannot be cleared or
retried in-process. Process exit clears OS fds; only a fresh process may run
durable intent recovery and restore readiness.

No public API, engine input/output, or callback outside reconciliation's
synchronous `withNativeOperands` scope receives a raw fd, procfd path, native
binding, staging path, intent, or unwrapped capability.

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

Raw native object stays module-private to the service loader consumed only by
the reconciliation controller. The isolated preflight script may load the
fixed artifact to validate shape but exposes no object/operand to service code.
The pure engine emits four `native_no_replace` moves plus explicit
`persist_intent`/`persist_manifest` effects for the two private-temp record
publications; it never
accepts native operands or authority capabilities. Reconciliation maps each
move against records in its own WeakMaps:

- `profile_publish`: profile operation wrapper plus exact `payload` to exact
  absent public profile/generation leaf;
- `canary_publish`: canary wrapper plus exact `proof-<operation-id>-0` to exact
  absent public canary leaf;
- initial `persist_intent`: exact initial-intent temp to absent stable intent;
- `persist_manifest`: exact planned manifest temp/hash/size to absent stable
  manifest;
- `profile_source_to_private`: exact held working/staging public source to
  absent private `delete-<operation-id>`; or
- `canary_source_to_private`: exact held public canary to absent private
  `deletion-<operation-id>-0`.

For each mapping, reducer first emits and observes explicit revalidation effects
for source/target/root leases and admission. The requested native call performs
its specified internal fstat/statx prechecks; controller performs no extra
filesystem read before/after it. Reducer then emits explicit location
observation/revalidation effects. Only synchronous `withNativeOperands`
extracts dirfds/leaves and calls the generic C export. No general string/fd/path
overload, capability adapter,
or exported operand constructor exists. Wrong move/kind/phase/leaf pair,
public source for publication, or mismatched private deletion target globally
fail-stops. Generic C export remains unchanged.

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
- `ENOENT` → raw `atomic_publish_source_missing` observation with native
  precheck digest and no locations/action. Reducer must request separate
  canonical location observation. Only fully authenticated canary same-attempt
  publication/cleanup replay normalizes to `atomic_publish_replay_completed`
  and preserves admission. Every other case requires observed
  `close_admission/binding_invalid` before fail-stop/authorized cleanup. Raw
  source-missing never enters a durable intent.
- `EBADF`, `ENOTDIR`, `ELOOP`, or `ESTALE` →
  `atomic_publish_binding_invalid`: run location proof, close admission, clean
  only proved-unpublished private state, and retain all other evidence.
- `EACCES`, `EPERM`, or `EROFS` → `atomic_publish_denied`: run location proof,
  fail operation, clean only proved-unpublished private state, and keep
  readiness closed until a fresh process reconciles.
- invalid arity, fd, or leaf → `atomic_publish_invalid_argument`: reject before
  syscall; prove source location, close admission because production supplied
  an invalid internal operand binding, then clean only proved-private state.
- any other errno → `atomic_publish_io`: run location proof, fail closed, and
  permanently close process-global admission/readiness until process exit;
  clean only proved-unpublished private state and retain all other evidence for
  fresh-process recovery. It is never downgraded to operation-local failure.

Error precedence is exact. First validate invocation/prechecks, return raw
native observation, then let reducer request post-call canonical proof.
`ENOENT` may override binding-invalid action only after the complete canary
replay predicate above. For other errors, a proved target
match follows published recovery/adoption only when evidence proves the syscall
succeeded before a later controller failure. Ambiguous location always retains
evidence and closes admission. Code-specific action applies after that proof;
no generic “target exists” rule suppresses binding failure. This makes cleanup
and admission deterministic.

The private native loader validates exact object keys/version once. The
reconciliation controller authenticates held records but returns source-missing
unchanged; reducer alone normalizes after a separately observed location tuple.
Tests may fake pure effect scheduling/admission state, but never native
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
  returns raw native result, then requires separate location effect. Source
  missing advances as published only when durable source identity and canonical
  source-absent/public-target-match observation satisfy the narrow replay rule;
  otherwise reducer requests binding-invalid admission closure.
- Stable canary with proof `deleting`: skip original publication. If the public
  canary remains and private deletion leaf is absent, replay its exact cleanup
  move. If public is absent and the exact private deletion root remains, replay
  that same move, including when its remaining tree matches a partial cursor;
  source-missing followed by qualifying separate observation supplies current
  mount proof, then private cleanup resumes at the durable cursor. If the cursor
  proves the private root fully removed,
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
intent sync; every composite create after mkdir/open/fstat and before success
observation; partial cleanup before/after handle close, identity open/fstat,
unlink/rmdir, absence proof, containing-parent fsync, and cleanup observation;
wrapper mkdir/open/sync; payload mkdir/open/sync; building temp
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

No `node-gyp`, `binding.gyp`, downloaded headers, native-build npm dependency,
or lockfile change is part of this design. `scripts/build-native.mjs` rejects
non-Linux or non-Node-22 execution, resolves real `process.execPath`, derives
the header root only as
`dirname(dirname(realpath(process.execPath)))/include/node`, and requires exact
local `node_api.h`, `node_api_types.h`, and `node_version.h`. It never downloads
or searches another header tree.

Compiler selection is deterministic: use executable regular file
`/usr/bin/gcc` when present; otherwise resolve `cc` from the inherited fixed
build-stage `PATH`, canonicalize its realpath, require it under `/usr/bin`, and
record/verify its `--version` bytes. `CC`, `CFLAGS`, `CPPFLAGS`, `LDFLAGS`, npm
compiler settings, shell interpolation, and arbitrary compiler paths are
rejected.

Build locking belongs to `scripts/run-native-build.mjs`, not the compiler
script. Package scripts invoke the runner with closed target `production` or
`all`. The runner sets umask `0077`, creates exact `build/` with Node filesystem
APIs, and no-follow opens exact
`build/.atomic-directory-publication-build.lock` with numeric
`O_RDWR | O_CREAT | O_NOFOLLOW`, mode `0600`; it requires regular file/current
uid/mode `0600`/link count one. It verifies fixed `/usr/bin/flock` and
`--no-fork` support, then spawns exact argv `/usr/bin/flock --no-fork
--exclusive --timeout 60 9 <real-node22> scripts/build-native.mjs <target>`.
The Node spawn `stdio` array is exactly stdin `ignore`, stdout/stderr `inherit`,
indices 3..8 `ignore`, and index 9 the opened parent lock fd. Mapping a numeric
parent fd to child fd 9 duplicates the same open file description with
`FD_CLOEXEC` clear on child fd 9. Environment contains exact
`ATOMIC_BUILD_LOCK_FD=9`; no other lock-fd value is accepted.

`flock` locks fd 9 and `--no-fork` execs Node rather than retaining a wrapper
that could explicitly unlock after only its direct child exits. Runner retains
its duplicate until the exec child terminates, then verified-closes it. Locked
`build-native.mjs` first requires the env value, `fstatSync(9)` equality with
the runner's no-follow lock record, and `/proc/self/fd/9` presence before any
staging inspection. Every child it spawns—compiler identity probe, compilation,
link, test executable, or addon loader—uses an explicit Node `stdio` array with
fd 9 mapped to child fd 9; compile/probe stdout and stderr use their specified
bounded pipes, link stdout uses its O_EXCL trace fd, unused 3..8 are `ignore`.
The inherited fd remains non-CLOEXEC across compiler-driver exec and its pinned
`cc1`/assembler/collect2/linker descendants. Neither script closes fd 9.

Consequently SIGKILL of runner, locked build script, or compiler driver cannot
release the flock while any descendant still has fd 9. A new runner may open
the lock leaf but its separate open file description blocks/times out in flock
and cannot inspect/remove/create staging. Only after the last descendant exits
and closes fd 9 can a new build acquire the lock, validate fd 9, and discard the
old staging generation before creating another. `build-native.mjs` never calls
flock or creates the build root; direct invocation without the inherited locked
fd is unsupported and rejects before filesystem mutation. Package/Docker
entrypoints use only the runner. Host tests verify path/version/flag support.
Current Task 4 owns the complete immutable Docker-init allowlist described
below; Task 6
builder/test/init images only consume it to verify `/usr/bin/flock`. Browser
runtime does not contain or need flock; only the separate init image retains it
at runtime.

`native/toolchain-allowlist.json` is fully owned and completed by current Task
4, including Docker-init identities that Task 6 has not yet consumed. Its exact
top-level keys are `schemaVersion` (integer `1`) and `dockerInit`. `dockerInit`
has exactly `amd64` and `arm64`; no default/wildcard/fallback entry exists. Each
architecture object has exactly these concrete string fields:
`targetArch`, `nodeBaseRepository`, `nodeBaseIndexDigest`,
`nodeBasePlatformDigest`, `osReleaseSha256`, `dpkgArchitecture`,
`utilLinuxPackage`, `utilLinuxVersion`, `flockRealpath`, and `flockSha256`.
Digest fields are lowercase `sha256:<64-hex>` for OCI identities and bare
64-lowercase-hex for file/bytes identities; `targetArch` equals its map key,
`utilLinuxPackage` is `util-linux`, and `flockRealpath` is `/usr/bin/flock`.
All other fields are exact nonempty values captured from the pinned Node 22
Debian image/platform and installed package for that architecture. Placeholders,
mutable tags without both index/platform digests, extra architectures/fields,
and duplicated tuples fail Task 4 tests.

Task 4 is not complete until both concrete tuples are committed and a probe for
each platform proves base index/platform identity, exact `/etc/os-release`
bytes, `dpkg --print-architecture`, exact `dpkg-query` util-linux version,
canonical flock realpath, and flock byte hash. Deferred Task 6 must use the
tuple's pinned base digests and select only `dockerInit[TARGETARCH]`; unsupported
`TARGETARCH` fails before package installation. Its builder/test/init stages
repeat every tuple check after installation. Task 6 never generates, edits, or
widens the allowlist. A future base/package/architecture change requires a
separate explicit change to this Task-4-owned file and its probe evidence before
Dockerfile consumption can change.

Native inputs are split exactly:

- `native/atomic-directory-publication-addon.c`: production Node-API/syscall
  entrypoint;
- `native/atomic-directory-publication-errors.c` and `.h`: shared errno map;
- `native/atomic-directory-publication-test-hooks.c` and `.h`: test-only
  pipe/eventfd barriers around the real syscall; and
- `native/atomic-directory-publication-errors.test.c`: standalone errno-map
  test main.

Every invocation uses the one fixed, build-locked staging root
`build/.atomic-directory-publication-stage/`, mirroring `obj/production`,
`obj/test`, `obj/errno-test`, `Release`, and `Test`. Final `build/obj`,
`build/Release`, and `build/Test` paths are never compiler/linker outputs. Under
the flock lock, `build-native.mjs` requires the staging root absent, creates it and each
fixed directory with `mkdir(..., { recursive: false, mode: 0o700 })`, and
pre-creates every selected declared object, depfile, addon/binary, map, trace, digest,
and checksum leaf using numeric
`O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW` (`0600`, except the standalone test
binary is `0700`). It verifies each pre-created leaf; non-trace leaves are
verified-closed before their deterministic staging pathname is passed to a
child, while each trace leaf's original O_EXCL fd remains open only as that
linker's stdout and is verified-closed immediately after child exit. It also
creates or validates the fixed final directories as owned no-follow `0700`
directories and fsyncs `build/` before child spawn. Compiler/linker
truncation is therefore confined to a newly created build-owned staging leaf;
no child opens, truncates, or writes an existing final artifact.

Every translation unit compiles separately. With `<S>` equal to the fixed
staging root and `<NODE_INCLUDE>` the derived header directory, exact ordered
addon argv is `<compiler> -fPIC -std=c11 -DNAPI_VERSION=8 -Wall -Wextra
-Werror -O2 -MD -I <NODE_INCLUDE> -MF <S>/obj/<graph>/<base>.d -c
<canonical-source> -o <S>/obj/<graph>/<base>.o`. Production addon/errors use
graph `production`; test addon/errors/hooks use graph `test` and insert exactly
`-DATOMIC_PUBLISH_TEST_HOOKS=1` immediately after `-DNAPI_VERSION=8`;
standalone main/errors use graph `errno-test` and exact argv `<compiler>
-std=c11 -Wall -Wextra -Werror -O2 -MD -MF
<S>/obj/errno-test/<base>.d -c <canonical-source> -o
<S>/obj/errno-test/<base>.o`, with no Node include or test-hook macro. Each
object has its own same-basename staging `.d`; multi-source compilation,
shared depfiles, response files, shell expansion, and final-path `-MF`/`-o`
arguments are forbidden.

Link commands also target staging only. Exact ordered production argv is
`<compiler> -shared -Wl,-Map,<S>/Release/atomic_directory_publication.map
-Wl,--trace <ordered-production-staging-objects> -o
<S>/Release/atomic_directory_publication.node`; test-addon argv substitutes
the fixed `Test/atomic_directory_publication_test.map`, ordered test objects,
and `Test/atomic_directory_publication_test.node`; errno-runner argv omits
`-shared` and uses `-Wl,-Map,<S>/Test/atomic-directory-publication-errors.map
-Wl,--trace <ordered-errno-staging-objects> -o
<S>/Test/atomic-directory-publication-errors.test`. For each link, child stdout
is exactly the already-open O_EXCL staging trace leaf:
`<S>/Release/atomic_directory_publication.trace`,
`<S>/Test/atomic_directory_publication_test.trace`, or
`<S>/Test/atomic-directory-publication-errors.trace`, respectively; stderr is
bounded diagnostic capture and is never an artifact. Thus GNU ld `--trace`
bytes go only to that fixed leaf, while `-Map` writes the fixed map leaf.
Nonempty trace/map, exit zero, declared output, and zero undeclared staging
leaves are mandatory. The locked build script executes the verified staging errno binary
after `all`, requires exit zero, and load-checks both verified staging `.node`
outputs. Test hooks add no production export, environment switch, or runtime
path; production linkage rejects hook symbols.

The script parses every `-MD` depfile including continuations/escaping,
canonicalizes every dependency, rejects missing/duplicate/out-of-root paths,
and hashes every dependency byte. Allowed roots are only repository native
sources, the derived Node prefix header root, `/usr/include`, and the canonical
compiler include root returned by `<compiler> -print-file-name=include`.
Per-output canonical digests also bind compiler binary bytes, realpath,
`--version`, `-dumpmachine`, `-dumpfullversion`, real Node executable/version,
platform/architecture, exact compile/link argv, and
`scripts/build-native.mjs`, runner bytes, and toolchain-allowlist bytes.

Attestation also records/hashes the GCC driver's `-dumpspecs`,
`-print-search-dirs`, and `-print-libgcc-file-name` results. For each of
`cc1`, `as`, `collect2`, and `ld`, the script resolves
`-print-prog-name=<tool>`, records canonical path/version, and hashes regular
binary bytes. Link steps emit fixed map/trace files; every resolved startup
object, archive, shared-library input, and compiler-runtime file in that trace
is canonicalized, required readable, and hashed. Final ELF `DT_NEEDED`
entries are recorded as names plus resolved image-build path/hash. An
unreadable, missing, or unresolvable required tool, trace input, or needed
library fails build.

Exact final digest sidecars are
`build/Release/atomic_directory_publication.inputs.sha256`,
`build/Test/atomic_directory_publication_test.inputs.sha256`, and
`build/Test/atomic-directory-publication-errors.test.inputs.sha256`. Each binds
only its transitive objects/dependencies plus shared tool identity; each output
has a distinct attestation. The script writes the selected subset of these
three sidecars plus the already-declared depfiles, maps, and traces into their
pre-created O_EXCL staging counterparts, never final paths.

There are no separate tool-inventory leaves. Each named `.inputs.sha256` is
itself canonical UTF-8 JSON plus one newline with exactly these ordered
top-level keys: `schemaVersion` (`1`), `output`, `compileArgv`, `linkArgv`,
`dependencies`, `scripts`, `node`, `compiler`, `driverProbes`, `subtools`,
`linkInputs`, `needed`, and `toolchainAllowlistSha256`. `output` contains exact
kind/final relative path/staging relative path/SHA-256. Argv arrays preserve
execution order and exact strings. `dependencies` and `scripts` are raw-UTF-8-
path-sorted objects of canonical path and byte SHA-256. `node` contains real
executable path/hash/version/N-API/header-root and required-header hashes.
`compiler` contains real path/hash/version-bytes hash/dumpmachine/
dumpfullversion. `driverProbes` contains the three fixed probe names and output
hashes. `subtools` contains exactly path/hash/version-output-hash entries for
`cc1`, `as`, `collect2`, and `ld`, sorted by that fixed order. `linkInputs`
contains canonical path/hash for every trace-resolved startup object, archive,
shared library, and compiler runtime; `needed` contains each ELF soname plus
resolved canonical path/hash, both sorted by raw UTF-8 path then soname.
Unknown/missing/duplicate fields, null/unreadable required paths, noncanonical
order/JSON/newline, or digest mismatch fails before publication. These three
already-named attestation leaves are the sole storage for tool inventory data;
staging creation/recovery grammars contain no inventory filename class.

After each child exits, locked `build-native.mjs` no-follow opens every declared
staging output, requires regular file/current uid/link count one/fixed mode and
an unchanged staging-root chain, validates depfile/map/trace/ELF/addon/test
shapes and hashes, then fsyncs and verified-closes every leaf. It fsyncs every
staging directory bottom-up. Only after the complete selected `production|all`
graph passes does publication begin. The fixed publication order is objects, depfiles, maps,
traces, and input-digest sidecars; errno binary and test addon;
production addon; runtime checksum last. Each leaf uses one Node
`fs.promises.rename(stagingLeaf, finalLeaf)` on the same filesystem to
atomically create/replace the final, followed immediately by `sync()` on both
already-held source and destination directories. Final parents are no-follow
verified build-owned directories. The locked script reopens/verifies published
finals, runs the final errno binary/load checks for `all`, validates final addon
against the checksum, removes now-empty staging directories bottom-up, and fsyncs
`build/`. This is atomic per leaf, not a false multi-file transaction; the
runtime checksum published last is the production generation commit marker, so
a mixed crash state cannot pass prestart.

At invocation start under the lock, an absent staging root starts a fresh
generation. A present root is never resumed: `build-native.mjs` no-follow
validates the exact finite directory/leaf grammar, allowing only the prefix/
subset reachable at a declared create/write/publish crash seam, current uid, fixed modes,
regular-file link count one, and absence of symlink/device/socket/fifo/hard-link/
unknown content. It then removes that entire stale generation bottom-up and
fsyncs `build/`. Any foreign shape/owner/mode/name fails without deletion or
compiler spawn. Failure before the first child spawn may remove and sync only
the current verified staging tree. After any child has spawned, every nonzero,
signal, validation, or publication failure is terminal: the locked script
spawns nothing else, performs no staging cleanup/reuse, closes its own non-lock
fds, and exits, leaving the fixed tree for the next lock owner. This avoids
racing an orphan subtool that may still hold/open a staging output. Kill/crash
likewise leaves the fixed tree; inherited fd 9 prevents another generation
until the last descendant exits, after which the next locked invocation
discards the stale tree and performs a full fresh build. Failure during
per-leaf publication may leave older/newer
audit or binary leaves, but cannot publish the new checksum early; prestart
fails and the next invocation unconditionally rebuilds/replaces the complete
selected graph. It never resumes publication or trusts a staging/final digest
as a cache key.

Every invocation recompiles every selected translation unit and relinks every
selected output even when all final objects, binaries, depfiles, maps, traces,
and attestations match. Digests, depfiles, embedded tool inventory data, maps,
and traces are audit evidence only, never up-to-date/skip inputs. This unconditional rebuild
prevents stale reuse across unobserved compiler/linker/startup/library changes.
Generated `build/` content is ignored and never committed.

Production build additionally emits distinct runtime checksum attestation
`build/Release/atomic-directory-publication.node.sha256`. Its exact canonical
UTF-8 bytes are one fixed-key JSON object plus newline:
`{"interfaceVersion":"1.0.0","napiVersion":8,"sha256":"<64 lowercase hex>"}\n`.
The hash is computed from verified staging
`atomic_directory_publication.node` bytes after link. The canonical bytes are
written/fsynced in the pre-created staging checksum leaf, then the addon and
checksum are atomically published in that order. Unknown/missing/reordered
fields, whitespace other than final newline, noncanonical number/string, wrong
hash, or mismatched version fails. This file attests runtime artifact bytes
only; `.d`, `.inputs.sha256`, maps, traces, and objects remain build-only audit
artifacts and are never substituted for it. No separate tool-inventory artifact
exists.

`preinstall` checks platform, architecture, exact Node runtime, flock path, and
build inputs without loading an artifact that does not exist yet.
`build:native` is exactly `node scripts/run-native-build.mjs production`;
`build:native:test` is exactly `node scripts/run-native-build.mjs all`;
`test:native` runs the latter runner and its standalone/load checks. Install and
prebuild use `build:native`; pretest uses `build:native:test`; prestart only
hashes the already-built production addon, parses the exact runtime checksum
attestation, requires hash/interface/N-API match, then validates ELF, ABI, and
the loaded three-property interface. It never compiles and never trusts input
audit sidecars for runtime integrity.
Startup root preflight first proves the exact Linux procfs held-fd adapter,
then validates staging/public invariants, statfs allowlist, device and mount
IDs, and performs a private positive canary plus no-replace conflict canary on
the actual persistent filesystem. Any missing/inaccessible/wrong-type procfs,
fd-identity mismatch, artifact, symbol, support, or proof leaves readiness
false with no alternate path implementation.

Current Task 4 proves deterministic host compilation/loading, unprivileged
filesystem semantics, and the two isolated Docker-init allowlist probe tuples.
Those probes establish base/package/binary identity only; they do not claim the
deferred Browser/init image, different-UID, privileged mount, read-only mount,
bind-mount-ID, or named-volume acceptance. Those require the exact downstream
Docker harness.

Original master-plan Task 6 remains owner of `src/server.ts`, `src/index.ts`,
`Dockerfile`, and `src/dockerfile.test.ts`. Its amendment must add a compiler
only to builder/test stages, run the deterministic script there, and copy only
the verified production `.node`, exact runtime checksum attestation, and
runtime application files into the final image. Final runtime contains no
compiler, headers, depfiles, input-hash
sidecars, test addon, flock/util-linux, build cache, or package-manager cache.
The same Dockerfile defines a separate init target containing pinned util-linux
`/usr/bin/flock`, Node 22, init script, and allowlist verification but no
Browser server. Task 6 also adds init tests and image-level different-UID,
read-only, bind/cross-mount, native preflight, and final UID `1000:1000` checks
after server/index exist.

Task 6's Docker test runs two independent no-cache builds for every supported
native CI `TARGETARCH`. From repository root it spawns the same fixed argv twice
except tag: `docker buildx build --no-cache --progress=plain --platform
linux/<TARGETARCH> --target browser-service-runtime --load -f
apps/browser-service/Dockerfile -t
firecrawl-browser-repro-a:<TARGETARCH> .`, then the identical argv with
`firecrawl-browser-repro-b:<TARGETARCH>`. It creates one stopped container per image and `docker cp`s exactly
`/app/apps/browser-service/build/Release/atomic_directory_publication.node`
and `/app/apps/browser-service/build/Release/atomic-directory-publication.node.sha256`
to two fresh test-owned extraction directories. It requires byte-for-byte
`cmp` and SHA-256 equality across builds for both files, independently parses
both canonical checksum files, and requires their embedded hash to equal the
corresponding extracted addon. Container/image/extraction cleanup runs in a
`finally` path. These addon and checksum files are the exact declared runtime
reproducibility artifact set; maps, traces, objects, depfiles, and input
attestations remain audit artifacts and are not mislabeled reproducible. Adding
another declared reproducibility artifact requires adding it to this two-build
extraction/equality gate.

Original Task 14 remains owner of `compose.local.yaml`, local wrapper/harness,
and named-volume lifecycle. Its amendment mounts the named volume only at
`/var/lib/firecrawl-browser-volume` for init and Browser Service, never API;
runs locked `init-new|validate-existing` before Browser Service; passes child
`state` as service root; and runs restart/persistent-volume/canary acceptance.
No Task 4 completion claim includes those deferred files or tests. Native Task
4 is host-complete but not deployable/locally activated until Task 6 and Task 14
acceptance gates pass.

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
- current host tests prepopulate collision/corruption fixtures and swap
  configured root/ancestor pathnames before startup capture; held-chain and
  init metadata validation reject them before publication. Different-UID and
  privileged owner/mount mutations are deferred to Task 6's Docker harness;
- deferred privileged/same-UID image fixtures force owner/mode/mount/held-chain
  drift only to prove deterministic global fail-stop, never supported recovery
  under that out-of-scope compromise;
- real host `EEXIST`, invalid leaf/fd, closed fd, noncanary missing source, and
  non-directory fd behavior with stable codes; denied-parent/read-only mount
  cases run in the deferred Task 6 image harness. Noncanary missing source must
  surface binding-invalid and close admission. Real `ENOTEMPTY` is asserted
  only when the current allowlisted filesystem returns it, while the compiled
  errno mapper always proves `ENOTEMPTY` shares conflict handling;
- current host tests reject injectable disallowed statfs identities and prove
  zero fallback. Deferred Task 6 image tests own real cross-mount source/target,
  same-device bind mount-ID mismatch, read-only, and privileged mount fixtures;
- native test binary exercising every errno mapping, including separate and
  aliased `ENOTSUP`/`EOPNOTSUPP` compilation branches and internal
  `atomic_publish_source_missing` for `ENOENT`;
- build-runner tests create `build/` before lock invocation, assert exact
  `/usr/bin/flock --no-fork --exclusive --timeout 60 9` argv with real Node 22,
  exact `ATOMIC_BUILD_LOCK_FD=9`, and Node stdio indices 3..8 ignored/fd 9
  mapped from the verified lock handle. Real exec probes require fd 9 present
  with CLOEXEC clear in build script, compiler driver, and pinned subtool.
  Concurrent builders serialize and timeout has no compiler/staging effect.
  A deterministic pipe barrier makes a compiler driver fork/exec a descendant
  that retains fd 9, then SIGKILLs runner/build script/driver variants. A second
  build must remain blocked with zero staging inspection/removal until that
  descendant signals exit; only its final fd close admits the contender, which
  then discards stale staging and fully rebuilds. Driver failure also proves the
  current build spawns nothing further and leaves staging untouched rather than
  racing orphan cleanup. Compiler tests assert every exact compile/link argv uses only
  the fixed staging tree for object, unique depfile, map, binary/addon, and
  `-o`/`-MF` output; linker tests assert exact `-Wl,-Map,<staging-map>` and
  `-Wl,--trace`, with stdout wired to the exact pre-opened staging trace fd.
  Spies reject any child open/truncate/write of a final path, undeclared output,
  multi-source/shared depfile, response file, or abstract/uncollected trace;
  they verify every staging leaf was O_EXCL-created, shape-checked, fsynced,
  atomically renamed, and followed by source/destination directory fsync;
- compiler inventory tests hash every allowed dependency/tool/script and
  inventory/hash driver specs, subordinate tools, link inputs, and final needed
  libraries. They require all inventory fields inside the exact canonical
  schema of the three named `.inputs.sha256` sidecars and prove no separate
  inventory leaf is created, accepted by stale recovery, or published. Two
  consecutive invocations with identical inputs and matching
  finals/attestations use child-spawn counters to require every selected source
  compile exactly once and every selected addon/binary link exactly once on the
  second invocation; zero cache/skip branches are permitted. Failure/crash at
  every compile, link, validation, fsync, rename, and checksum-last boundary
  proves prior finals remain or prestart rejects the mixed generation. Exact
  stale staging is discarded and fully rebuilt under lock; foreign staging
  fails without deletion or compiler spawn. Standalone errno runner and both
  addon load checks pass from staging and finals. Runtime checksum tests require
  exact canonical JSON/newline and reject addon-byte, checksum, interface,
  N-API, field-order, extra-field, and whitespace tampering;
- Docker build/init tests verify fixed flock path, pinned util-linux
  version/binary digest from both complete Task-4-owned `amd64`/`arm64`
  `dockerInit` tuples and absence of flock from Browser runtime. Schema/probe
  tests reject missing, placeholder, extra, cross-architecture, mutable-base,
  or mismatched base/platform/os/package/path/hash data. Task 6 tests prove the
  Dockerfile consumes the selected tuple without modifying the allowlist.
  Deferred Task 6 init tests serialize concurrent
  starters by locking the pre-existing trusted parent directory, create no lock
  artifact, release on timeout/exit/SIGKILL, prove marker
  mode selection, exclusive held-parent creation/bottom-up fsync, exact UID/GID
  `1000:1000` plus `0700`, and zero repair in existing mode. Browser validation
  receives pre-created `profiles` before scaffold/canary/recovery;
- final-image tests prove only production `.node` and
  `atomic-directory-publication.node.sha256` are copied from native build
  outputs; input dep/hash sidecars, objects, maps, traces, and test outputs are
  absent. Two independent `--no-cache` Docker builds per native supported
  `TARGETARCH` extract those exact runtime paths and require byte/hash equality
  for both addon and canonical checksum plus embedded-addon-hash agreement.
  Prestart rejects independent tampering of addon or attestation before service
  initialization;
- deferred Task 14 rendered-Compose tests prove only init and Browser Service
  mount the named volume at `/var/lib/firecrawl-browser-volume`, API has no
  volume mount, service root is exact child `state`, init gates service start,
  and activation remains false until final acceptance commit;
- Task 14's exact `test:local-firecrawl:lifecycle` command proves fresh init,
  candidate readiness/real canary/profile publication, Browser restart,
  full validate-existing restart with byte-identical persistent profile, a new
  real canary, rollback rejection without rollback-container start on the
  disposable reserved-state clone, rollback-check/deploy success on naturally
  clean primary state, preserved API/profile behavior, and finally zero labeled
  containers/networks/volumes. Missing any phase, failed cleanup, or default
  activation before the later commit fails acceptance;
- held-procfd preflight tests cover missing `/proc`, inaccessible
  `/proc/self/fd`, injected non-procfs `statfs` type, fd-probe dev/ino/type
  mismatch, and unsupported Node operations; every case keeps readiness false
  and proves no configured-path or addon fallback. Adapter spies assert exact
  Node 22 `mkdir`/numeric-flag `open`/bigint-stat and
  lstat→open→fstat→re-lstat→unlink-or-rmdir→absence→parent-sync sequences.
  Control and payload strict-leaf boundary/invalid-encoding fixtures reject
  before I/O; string flags, missing `O_DIRECTORY`/`O_NOFOLLOW`, missing
  `O_CREAT`/`O_EXCL`, recursive mkdir/removal, `rm`, and ordinary-path access
  fail the test;
- barriers before and after every adapter await replace a held parent/ancestor,
  remove or replace the selected child between lstat/open/fstat/recheck/removal,
  and drift admission/record identity. Host-protected cases and deferred
  privileged/same-UID Docker cases must detect drift, perform no wrong-object
  mutation, emit no success, and globally fail-stop. Instrumentation inspects
  every request, observation, error, log, registry field, returned value, and
  promise/retained closure and proves no extracted numeric-fd field or
  constructed procfd string escapes reconciliation's effect frame;
- exact native export stays three properties; reducer tests cover every closed
  effect kind and require exactly one matching observation before the next
  effect. Composite create-and-pin tests prove exact procfd Node-operation
  sequences, success returns one ID/full evidence with no second open, and
  partial failure returns a one-use partial ID before explicit cleanup. Cleanup
  tests require close when applicable, protected-parent identity verification,
  exact procfd unlink/rmdir, absence proof, and containing-parent fsync before
  the sole `absent/parentSynced` success observation. Injected failure/crash at
  each awaited-operation boundary retains partial ID and stable intent, emits
  no phase/cursor/reservation advance, and fail-stops on close/remove/fsync
  failure;
- intent/manifest publication tests require exact `tempObjectId`,
  `expectedTemp`, temp/stable parent IDs and leaves, canonical `Uint8Array`
  bytes/digest, and absent-stable evidence. Altering any ID, evidence field,
  byte, digest, size, role, operation, parent, or leaf rejects before native
  invocation. Spies prove persistence resolves the existing pinned temp and
  performs no procfd/path open, lstat, read, or filesystem hash;
  `native_resolved` must bind the same request kind, operation ID, publication
  discriminator, source ID, and full source evidence. The next request must use
  the exact `intent_publish` or `manifest_publish` discriminator and repeat
  operation, temp object/evidence,
  both parents/leaves, target-absence precondition, and expected target
  evidence. Its observation must echo request kind/discriminator/requested
  source ID, return explicit source/target IDs equal to the IDs inside both
  canonical location proofs, and reject null/match or full-evidence/scalar
  inconsistencies. Swapped
  intent/manifest discriminators, native-move discriminators, stale preceding
  `native_resolved`, altered target evidence, or mismatched IDs reject before
  classification/fsync. Restart may remint authority only through the earlier
  explicit discovery/open effects. Native
  export inspection remains exactly the three specified properties and exposes
  no mkdir/open/unlink helper;
- fresh-process partial-create recovery tests cover crash after mkdir/open/fstat
  and after remove but before parent fsync/observation. Lost flight IDs grant no
  authority: recovery remints from stable intent plus exact locator/evidence,
  completes manifest-authorized cleanup, fsyncs parent, and removes intent only
  afterward. Existing-entry open requires exact evidence. Injected controller spies fail on any
  unrequested reserve/create/open/
  read/write/hash/fsync/native/observe/remove/record/close/adopt/release call,
  including crash recovery. Only reconciliation-owned callback scope sees
  native operands, and all profile/canary/intent/manifest/source moves use real
  native no-replace;
- selector tests require exact parent/object IDs, canonical leaves, flags,
  evidence, offsets/lengths/hashes, and inline-bytes XOR source ID. Create/open/
  discovery observations alone mint IDs with full evidence. Forged, persisted,
  cross-flight, over-4,096, post-terminal, and post-drain IDs reject before I/O;
  restart remints IDs only by stable-locator enumeration/open observations.
  Controller syscall spies prove no hidden reads or selector reconstruction;
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
  public-target-absent/private-deletion-match cleanup. Native observation first
  returns raw source-missing with no locations/admission effect; reducer then
  emits exactly one location observation. Only matching observation normalizes
  replay-completed and keeps admission open. Wrong attempt/phase/evidence,
  changed inode/hash/parent, both/neither unexplained, profile publication, and
  every other source-missing require a separately observed
  `close_admission/binding_invalid` before global fail-stop;
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
  adoption without snapshot/capability and proof no recovery DB query occurs.
  Startup spies require exactly one generation-scoped ProfileStore constructor
  and one atomic install; every pre-ready adoption is visible only in the sealed
  reconciliation outcome until that constructor consumes it, with zero earlier
  Registry/store attachment. Constructor/install failure exposes no partial
  bundle, never constructs a replacement store in-process, and verified-closes
  the uninstalled store/handles. Runtime adoption attaches exactly once to the
  already-installed store;
- valid but snapshot-unreferenced committed publication is never adopted:
  source deletion recovers, intent releases target, intent disappears before
  Task 3 plan, and only then Task 3 quarantine may move it across every crash;
- reconciliation mints `BoundGeneration` from its original target pin and held
  ancestors without pathname reopen; engine receives no capability/fd.
  Deferred privileged chain drift fails global admission before later use;
- all success/failure paths attempt all closes; close-then-throw reaches zero
  fds; true close rejection permanently blocks current process; restart closes
  old OS fds and recovers from durable intent;
- current host canaries on an unprivileged local filesystem; final-image UID,
  init-new/validate-existing, named-volume, mount, and persistent-restart
  canaries only in deferred Task 6/14 Docker acceptance.

Fakes are limited to pure effect scheduling and controller admission boundaries.
Current atomicity, errno, crash, location, and recovery claims use compiled C
addon and real unprivileged filesystem/process boundaries; privileged/mount/
volume claims use downstream Docker tests only. Existing Task 3
public reconciliation and Task 4 replay/proxy/registry/Chromium/checksum tests
remain passing. Shared persistent/schema integration suites run serially.

## Exact current and deferred file scope

Current Task 4 existing files in scope:

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

- `apps/browser-service/native/atomic-directory-publication-addon.c` (new)
- `apps/browser-service/native/atomic-directory-publication-errors.c` (new)
- `apps/browser-service/native/atomic-directory-publication-errors.h` (new)
- `apps/browser-service/native/atomic-directory-publication-test-hooks.c` (new)
- `apps/browser-service/native/atomic-directory-publication-test-hooks.h` (new)
- `apps/browser-service/native/atomic-directory-publication-errors.test.c`
  (new)
- `apps/browser-service/native/toolchain-allowlist.json` (new)
- `apps/browser-service/scripts/run-native-build.mjs` (new)
- `apps/browser-service/scripts/run-native-build.test.mjs` (new)
- `apps/browser-service/scripts/build-native.mjs` (new)
- `apps/browser-service/scripts/build-native.test.mjs` (new)
- `apps/browser-service/scripts/check-atomic-publication-rollback.mjs` (new)
- `apps/browser-service/scripts/check-atomic-publication-rollback.test.mjs`
  (new)
- `apps/browser-service/src/atomic-directory-publication.ts` (new)
- `apps/browser-service/src/atomic-directory-publication.test.ts` (new)
- `apps/browser-service/src/atomic-directory-publication.integration.test.ts`
  (new)
- `apps/browser-service/src/atomic-directory-publication-native.ts` (new)
- `apps/browser-service/src/atomic-directory-publication-native.test.ts` (new)
- `apps/browser-service/src/atomic-publication-manifest.ts` (new)
- `apps/browser-service/src/atomic-publication-manifest.test.ts` (new)
- `apps/browser-service/src/atomic-publication-observability.ts` (new)
- `apps/browser-service/src/atomic-publication-observability.test.ts` (new)
- `apps/browser-service/src/runtime-preflight.mjs`
- `apps/browser-service/src/runtime-preflight.test.mjs`
- `apps/browser-service/package.json`
- `.gitignore`

No native dependency is added, so `binding.gyp` does not exist and
`apps/browser-service/pnpm-lock.yaml` changes only if another independently
required package change demands it. This spec revision changes exactly:

- `docs/superpowers/specs/2026-07-22-atomic-directory-publication-design.md`

Deferred original master-plan Task 6 amendment owns exactly:

- `apps/browser-service/src/server.ts`
- `apps/browser-service/src/server.test.ts`
- `apps/browser-service/src/index.ts`
- `apps/browser-service/Dockerfile`
- `apps/browser-service/src/dockerfile.test.ts`
- `apps/browser-service/scripts/init-state-volume.mjs` (new)
- `apps/browser-service/scripts/init-state-volume.test.mjs` (new)

It wires current observability into server/index, copies the rollback checker
and production addon, and runs image/init/mount acceptance. None is pulled into
Task 4 before server/index exist.

Deferred original master-plan Task 14 amendment owns exactly:

- `compose.local.yaml`
- `.env.example.local`
- `scripts/local-firecrawl`
- `scripts/local-firecrawl.test.mjs`
- `apps/api/package.json`
- `apps/api/src/harness.ts`
- `apps/api/src/harness-browser-service.ts`
- `apps/api/src/harness-browser-service.test.ts`

It owns init-service/volume/API-no-mount wiring, rollback-wrapper invocation,
and the final local activation commit. No generated `.node`, runtime checksum
attestation, native test binary, object, depfile, input-hash sidecar, map, trace,
`build/`, or `node_modules/` content enters a commit.

Task 14 adds exact package script
`"test:local-firecrawl:lifecycle": "node ../../scripts/local-firecrawl.test.mjs --full-lifecycle"`
to `apps/api/package.json`. The sole activation gate is this repository-root
command:

```bash
pnpm --dir apps/api run test:local-firecrawl:lifecycle
```

CI/operator must export `FIRECRAWL_ACCEPTANCE_CANDIDATE_IMAGE` and
`FIRECRAWL_ACCEPTANCE_ROLLBACK_IMAGE`; the script rejects missing, tag-only,
equal, or non-`@sha256:` refs before Docker mutation.

That one command owns a unique test Compose project and performs this exact
real lifecycle: render/inspect API-no-volume and init/browser-only volume
topology; create a fresh named volume; run `init-new`; start the candidate with
an acceptance-only enable override; wait for real readiness and successful
compiled-addon startup canary; publish a real profile generation through API;
record its manifest/content identity; restart Browser Service; then fully stop
and start without `down -v` so init runs `validate-existing`; require the same
generation bytes plus a new successful real canary after both restarts.

For rollback rejection, the harness clones the stopped primary volume into a
second disposable rejection project, inserts one exact test-owned closed-grammar
reserved-state fixture as uid `1000`, and proves `scripts/local-firecrawl`
refuses the requested rollback before creating/starting any rollback container.
It destroys that entire disposable project/volume; it never removes the fixture
to make the checker pass and never mutates primary reserved state. On the
primary project, normal service reconciliation must reach zero reserved
intent/temp/wrapper/manifest/canary/private-deletion state. The wrapper's
read-only checker must then succeed, deploy the immutable rollback image, and
the harness must prove preserved profile bytes and healthy API behavior.

A `finally` block stops/removes candidate and rollback containers, networks,
both named volumes, temporary extraction/state, and acceptance overrides, then
asserts by exact Compose project labels that none remain. Nonzero cleanup or a
remaining resource fails the command. Task 14 may change the documented/default
activation flag only in a later commit after this command exits zero and cleanup
verification passes; partial lifecycle subcommands, rendered-config-only tests,
or a retained acceptance volume cannot authorize activation.

## Rollout and observability

Task 4 lands fail-closed code with local service activation still disabled. It
does not change `LOCAL_BROWSER_SERVICE_ENABLED`. Task 6 builds/tests the image
while the flag remains false. Only Task 14's final downstream acceptance commit,
after image, init, named-volume restart, API-no-mount, and persistent canary
checks pass, may set local `LOCAL_BROWSER_SERVICE_ENABLED=true` in
`compose.local.yaml` and its documented local default. No earlier commit or
runtime auto-detection enables it; mixed safe/unsafe publication is unsupported.

Current `atomic-publication-observability.ts` owns sanitized bounded counters
and threshold-to-alert-event policy; `reconciliation.ts` emits through its
injected sink. Before traffic, it emits one `atomic_publish_preflight` event
containing platform, architecture, `interfaceVersion`, compiled/runtime N-API
versions, source constant `bundled_package_relative`, allowlisted filesystem
name, and sanitized result. It counts attempts, successes, conflicts,
unsupported, cross-device, binding-invalid, denied, I/O failures,
recovered-unpublished, recovered-published, ambiguous recovery,
orphan/temporary state, and close-unverified. Alert events cover unsupported,
cross-device, binding-invalid, ambiguous, orphan, close-unverified, and bounded
repeated-conflict thresholds. Paths, fds, numeric owners, IDs, checksums, mount
IDs, and raw errno text never enter events.

Deferred Task 6 `src/index.ts` wires that sink and `src/server.ts` exposes only
existing sanitized `browser_unavailable`; its tests prove alert events remain
private diagnostics. Deferred Task 14 `scripts/local-firecrawl` treats failed
preflight/readiness as startup failure but does not implement a second metrics
path.

Current `scripts/check-atomic-publication-rollback.mjs` plus its test owns the
offline read-only checker. It opens the exact child state root, validates held
layout/owner/mode, and succeeds only when no stable/temp intent, wrapper,
manifest, canary, or private deletion remains. It never mutates or offers a
force option. Task 6 copies it into the image; Task 14's local wrapper invokes
it before any requested downgrade. Rollback may deploy an older image only
after checker success. Never delete reserved state to make rollback pass.

Current acceptance is host build hashing, addon shape, pure reducer/controller
tests, unprivileged native integration, and crash recovery. Deferred Task 6
adds two deterministic image builds and image/init/UID/mount checks. Deferred
Task 14's one exact full-lifecycle command adds locked init mode selection,
API-no-mount Compose topology, candidate restart and full validate-existing
restart, persistent profile identity, real named-volume canaries, rollback
rejection on a disposable clone, rollback success on clean primary state, and
zero-resource cleanup. Final flag activation follows only in a later commit.
Claims do not move earlier than their owning task.
