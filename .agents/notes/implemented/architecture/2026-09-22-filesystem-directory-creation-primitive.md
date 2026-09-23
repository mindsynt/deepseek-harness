# Agent Note: Directory creation on the filesystem seam

Status: implemented

English | [中文](2026-09-22-filesystem-directory-creation-primitive.zh.md)

## Problem

The `dsh-fs` Service Definition shipped thirteen primitives and no way to create a directory. Consumers that needed one had to leave the seam: session creation spawned `mkdir -p` through a remote world's subprocess provider until this decision moved it onto the seam, and the directory picker still refuses to create inside a remote host at all. Both outcomes bypass the confinement the filesystem capability owns, and the subprocess workaround put process vocabulary into an operation whose only effect is a filesystem change.

An execution world can already create files through `writeText`, which creates missing parents as a side effect. A missing directory primitive therefore showed up as an accident of the write path rather than as a contract, and no consumer could ask whether the directory already existed.

## Decision

`FileSystem` gains an abstract `mkdir(target, signal?, sandboxPolicy?)` that returns `FsMkdirOutcome` (`{ created: boolean }`). Creation always includes every missing parent and is idempotent: a target that already exists as a directory is left untouched and reports `created: false`, while a target or parent component that exists as something else fails with `FS_NOT_DIRECTORY`. The operation takes no `recursive` or mode argument — parents are always created and the provider's umask decides permissions — and no version guard, because repeating it is safe by construction.

The existing `FsErrorCode` set carries the failures: `FS_NOT_DIRECTORY` for a non-directory target or parent, `FS_PERMISSION_DENIED` and `FS_IO_ERROR` from the provider, and `FS_ABORTED` for cancellation before the directory takes effect. The seam adds no error code, so the taxonomy, its documentation, and every consumer's branch set stay unchanged.

`fs-local` probes the target and then creates it with the same recursive helper its atomic write already used, mapping creation failures through one translation: a raced non-directory parent to `FS_NOT_DIRECTORY`, a permission fault to `FS_PERMISSION_DENIED`, and anything else to `FS_IO_ERROR`. `fs-sandbox` fences creation with `checkedTarget` exactly as it fences `writeText` and `editText`, then delegates with the freshly canonicalized target. `fs-ssh` forwards `fs.mkdir` with the resolved per-call policy, and the helper runs the remote `SandboxedFileSystem.mkdir` under that policy, so the remote fence is never weaker than a remote write.

No backend falls back: a provider that cannot create directories must fail loudly rather than report success, and the definition declares no default implementation.

## Remote helper and wire version

The helper's dispatch gained the `fs.mkdir` operation, which requires the caller's policy exactly as `fs.write` and `fs.edit` do. `SSH_PROTOCOL_VERSION` moved from 1 to 2 in the same change. The helper entry digest changes with any helper source edit, so an installed helper from version 1 is already rejected against a rebuilt installation; the version bump moves the failure to the handshake for a deployment whose configured artifact still points at the old helper, instead of leaving an unknown operation to surface later as `FS_IO_ERROR`. `helloSchema` reads the constant rather than a literal so the two cannot drift again.

## Alternatives considered

**A concrete base-class implementation that throws.** Keeping `mkdir` non-abstract would avoid breaking out-of-tree providers, but every other mutation on this seam is abstract, and a base default would let a provider that never implements creation activate and fail only for the model. Abstract members make the missing role a compile-time fact.

**Keep the subprocess `mkdir -p` workaround.** It worked for session creation and needed no seam change. It also bypassed the sandbox fence the filesystem capability exists to enforce, required the caller to supply an execution-world path independent of policy, and would have been copied by every later consumer. Moving the operation onto the seam keeps one owner for confinement.

**Add `recursive` and mode options.** A non-recursive mode would let the picker distinguish "already exists" with the platform's own error, and a mode would let a caller set permissions. No current consumer needs either: the picker maps `created: false`, and every caller accepts the umask. Options without a current owner are deferred rather than shipped.

**A new `FS_ALREADY_EXISTS` code for the non-directory case.** The picker's local implementation reported `EEXIST`, which a new code could mirror. A new union member changes the taxonomy every backend and consumer branches on; `created: false` plus `FS_NOT_DIRECTORY` expresses the same outcomes without it.

**Leave `SSH_PROTOCOL_VERSION` at 1.** An additive operation is wire-compatible, so no bump is strictly required. The installed helper and client are already pinned by digest, and the bump costs one line while converting a late, ambiguous per-call failure into a handshake rejection.

## Consequences

The seam now exposes fourteen primitives, and `dsh-fs` owns directory creation for the local, confined, and remote worlds behind one contract. Session creation moved onto this primitive in the same change, so it no longer spawns a process for a filesystem effect; the directory picker's remote half remains a separate follow-on that also needs a host identity on its wire request.

Every `FileSystem` implementer must implement the member. That includes in-repo test doubles outside the three providers, which gained minimal implementations in the same change. A released helper artifact must be rebuilt and reinstalled: the archive, its manifest digest, and `SSH_PROTOCOL_VERSION` all change together, and a deployment running the old artifact fails the handshake until it re-provisions.

`mkdir` creates parents and reports only whether this call created the target; it does not return a version, and a concurrent creator can make `created: true` report a directory another caller just made. That is consistent with idempotent creation: callers that need ownership coordination must serialize it themselves.

## Verification

`packages/fs/fs-local` unit-tests the probe and error translation for a created directory, an existing directory, a file target, an aborted call, a raced non-directory parent, a permission failure, and an I/O failure, and the provider tests resolve-then-create through `ctx.fs`. `packages/fs/fs-sandbox` proves `read-only` denial with nothing on disk, `workspace-write` creation inside and denial outside and through a symlinked-out ancestor, `danger-full-access` delegation, and a per-call escalation stamp. `packages/ssh/fs-ssh` asserts the forwarded request, the resolved policy on both the explicit and default paths, and the returned flag. `packages/ssh/ssh` drives the real helper over its private transport to prove creation, the second-call `created: false`, and `FS_SANDBOX_DENIED` under a read-only policy, with the helper's own filesystem suites covering the operation. All changed source files hold per-file 100% coverage.

The catalog and graph generators regenerate from the new declaration, and the helper artifact build produces the digest a deployment installs. `packages/sandbox/sandbox-policy` unit-tests that `provisioningPolicy` returns `workspace-write` bounded to the given root under a read-only deployment default and rejects a relative root, and `packages/api/session-controller` asserts the exact policy the remote branch passes, the no-policy-owner path, the unchanged Harness-host branch, and the loud failures for a missing or unopened host.

## Session-root provisioning authorization

Session creation provisions its working directory through `world.fs.mkdir`, and the policy that authorizes that call comes from the sandbox-policy owner rather than from the create request: `SandboxPolicyService.provisioningPolicy(root)` returns `{ mode: 'workspace-write', workspaceRoot: root }`, preserving the root's execution-world spelling exactly as `resolve` does. The destination root authorizes only its own subtree, which is the boundary `resolve` gives the Session once it exists — a Session cwd IS its `workspace-write` root — so provisioning widens no range beyond the directory being created, and the enforcing backend still fails loud when containment does not hold.

The authorization is deliberately independent of the deployment default mode and of the Session's mode, because creation happens before the Session exists: a `read-only` deployment must still create the directory a read-only Session will read, and the Session's own mode governs every model operation afterwards. A create request carries no mode, so neither the GUI nor any other client widens the fence at creation time. A composition without the policy owner reads no policy and leaves the backend its own rule.

A cwd outside every workspace has no separate meaning for this operation: the created directory is the fence root itself. What can still fail is a target that exists as a file (`FS_NOT_DIRECTORY`), a host permission or I/O fault (`FS_PERMISSION_DENIED` or `FS_IO_ERROR`), a backend containment mismatch (`FS_SANDBOX_DENIED`), and a named host without an open realm, which keeps its loud error instead of falling back to the Harness host's filesystem. The Harness host's own branch keeps its `node:fs.mkdir`, so local behaviour is unchanged.

## Deferred: the picker's remote half

The directory picker still creates only on the Harness host, and its `createDirectory` request carries no `hostId`, so it cannot address a remote world. That wire change is a separate follow-on, as is creating a session from a bare `cwd` rather than a Workspace identity: remote creation is addressed through a Workspace, which carries the host identity this decision needs.