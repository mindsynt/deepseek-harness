---
description: "Remote filesystem provider for hosts reached through the SFTP subsystem of one OpenSSH connection."
kind: "package-reference"
---

# @deepseek-ai/dsh-fs-sftp

English | [中文](README.zh.md)

## Summary

Use `dsh-fs-sftp` when a remote host's files must be read, listed, written and edited over one OpenSSH connection: the backend runs the whole `ctx.fs` contract through the SFTP subsystem, so the remote needs no Node.js runtime and no helper daemon. Resolve, stat, list, text and byte reads, streaming, directory creation, full writes and literal edits all keep the remote realpath as the target key and return typed `FsError` codes. Version guards arrive but are discarded, so guarded edits are plain read-modify-write and a concurrent write is not detected.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the class in a composition with `ctx.plugin(SftpFileSystem)`, or mount it on a `ctx.isolate('fs', …)` realm beside `sshNative` and `subprocess`: the backend registers under the `fs` service name in whichever realm it is mounted into.

The package declares no plugin `Config`, so there is no field to set and no configuration to carry in a mount. Every tunable lives in the injected `sshNative` service — the remote host, port, credentials, host-key policy and read caps — because this backend owns no coordinates of its own.

| Injected service | What the backend reads from it |
|---|---|
| `sshNative` | every I/O call: `sftpRealpath`, `sftpStat`, `sftpLstat`, `sftpRead`, `sftpReadRange`, `sftpWrite`, `sftpMkdir`, `sftpReaddir` |
| `sandboxPolicy` | `defaultMode` only, reported as `sandboxMode` |

### Path identity and containment

`resolve(path, { cwd })` joins `cwd` when it is supplied, calls `sftpRealpath`, and returns the resolved path as both `targetKey` and `displayPath`. `processPath` is that key as a string, `fileUrl` wraps it in a `file:` URI, and `contains` compares two keys with a lexical `posix.relative` test and no I/O. The remote path is therefore exposed to consumers rather than hidden behind an opaque id, and `processPathFromHostPath` stays unoverridden, so a local host file has no mapping into this backend.

### Mutations and guards

`mkdir` creates every missing parent and reports `created: false` when the path already exists instead of failing. `writeText` stats the path first to decide `create` versus `update`, reads the previous content into the `before` half of the outcome on an update, writes the new content, and reports a version derived from the write time and the new character count. Both `writeText` and `editText` accept a guard and discard it, so a stale file is never rejected and `FS_STALE_VERSION` never arises from this backend.

`editText` has no native compare-and-swap to call. It reads the file, applies the literal replacement in memory, and writes the result back. With `replaceAll` false it fails with `FS_EDIT_NOT_FOUND` when `oldString` occurs nowhere, the one edit failure that reaches a caller untransformed. There is no lock, no reservation and no second read after the write, so a change that lands between the read and the write is invisible.

### Sandbox reporting

`sandboxMode` returns `sandboxPolicy.defaultMode` verbatim, so it never reports `undefined`. The per-call `SandboxExecutionPolicy` that `mkdir`, `writeText` and `editText` receive is accepted and discarded, and the backend performs no harness-side confinement: enforcement is whatever the remote account allows.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Every method is one SFTP round-trip through `sshNative` inside one `try` that funnels failures through `toFsError`. That mapper re-derives a code from message text only: an aborted signal wins `FS_ABORTED`, `ENOENT` or `No such file` gives `FS_NOT_FOUND`, `EEXIST` gives `FS_IO_ERROR`, `EPERM` or `EACCES` gives `FS_PERMISSION_DENIED`, and everything else gives `FS_IO_ERROR`. It discards the code on any incoming `FsError`, which is why the typed errors `streamText` constructs inside its own `try` never reach a caller — absent-target and not-a-regular-file cases surface as `FS_IO_ERROR` too.

Observed state carries `FsVersion(mtime:size)` from `stat`, `lstat` and directory entries; a mutation carries `FsVersion(Date.now():charCount)`. The two scales do not agree, so a version a consumer receives from a write cannot be matched against a later `stat`.

Reads split into one-shot and streaming paths. `readText` is a single `sftpRead` decode, bounded by ssh-native's own `maxSftpReadBytes`, and that cap fails as `FS_IO_ERROR` rather than `FS_TOO_LARGE`. `streamText` stats the target first, then yields 64 KiB windows from `sftpReadRange` and stops when a window comes back empty. `readBytes` and `readByteRange` return raw bytes with no decoding, and neither compares the result against the file's real size.

`listDir` asks each entry for a name, a type, a resolved child target and, for files and directories only, a version and size. It classifies an entry by `isDirectory()` or `isFile()` alone, so a symlink entry becomes `other` and loses both version and size; the path-shaped `lstat` is the only probe that can report `symlink`.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `SftpFileSystem`, the `toFsError` mapper, and every overridden seam member |
| [`tests/index.spec.ts`](tests/index.spec.ts) | constructor, `processPath` and `contains` only |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [fs](../../fs/fs/README.md) — the seam this package extends, including the guard semantics it cannot honor.
- [ssh-native](../ssh-native/README.md) — the SSH connection and SFTP operations behind every call.
- [subprocess-ssh-exec](../subprocess-ssh-exec/README.md) — the sibling remote subprocess provider in the same realm.
- [SSH subsystem](../../../docs/subsystems/ssh.md) — shared connection ownership and provider composition.
- [Filesystem subsystem](../../../docs/subsystems/filesystem.md) — the exhaustive provider contract and error taxonomy.

-----

<a id="model-experience"></a>
## Model Experience

### Filesystem consumers

#### What the model sees

The backend registers no tool, prompt section or result of its own. Consumers of `ctx.fs` render every model-visible value, and each of them reaches whichever host realm resolved `fs`, so this package contributes no text of its own to any request.

#### Token effect

Mounting the backend adds no model-visible input and changes no request-prefix text; the backend owns no token budget of its own.

#### KV Cache effect

The backend contributes no request-prefix content, so request prefixes stay as the consumers compose them, and remote file content reaches the cache only through whatever a consumer already renders.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Guarded edits are not atomic and carry no lock** — `editText` reads, applies the replacement in memory, and writes; a concurrent write between the read and the write is not detected, and no filesystem lock exists to serialize it. The `expected` version guard on `writeText` and `editText` is discarded, so `FS_STALE_VERSION` and `FS_NOT_OBSERVED` are never produced.
- **Byte reads are bounded by the window, not the file** — `readBytes(target, signal, maxBytes)` reads `maxBytes` bytes and returns whatever comes back, so a larger file yields a truncated prefix instead of the `FS_TOO_LARGE` the seam contract promises. `readText` is capped by ssh-native's `maxSftpReadBytes`, and that rejection surfaces as `FS_IO_ERROR`, not `FS_TOO_LARGE`.
- **No watching** — `watch` is not overridden, so a consumer inherits the base class rejection `FS_IO_ERROR` with "Filesystem watching is not supported by this provider." SFTP over this connection offers no change notification to build on.
- **No mode, ownership, rename, delete, or link mutation** — the seam exposes no such primitive and this backend overrides none, even though `sshNative` offers `sftpChmod`, `sftpChown`, `sftpRename`, `sftpUnlink`, `sftpSymlink` and `sftpReadlink`; permission bits, ownership and symlinks are unreachable through `ctx.fs`. `FS_NOT_DIRECTORY` is therefore never raised, including when `mkdir` targets an existing file.
- **Symlinks degrade in listings** — `listDir` classifies by `isDirectory()` and `isFile()` alone, so a symlink entry becomes `other` and loses both version and size; only `lstat` reports `symlink`, and `resolve`, `stat` and every read follow a link.
- **Two unrelated version scales** — `stat`, `lstat` and `listDir` derive `FsVersion(mtime:size)`, while `writeText` and `editText` derive `FsVersion(Date.now():charCount)`, so a consumer cannot correlate the version a mutation returns with a later observation.
- **Error codes are re-derived from message text** — `toFsError` drops the code on any incoming `FsError`, so the `FS_NOT_FOUND` and `FS_NOT_REGULAR_FILE` that `streamText` constructs inside its own `try` reach callers as `FS_IO_ERROR`; only `editText` re-throws its `FS_EDIT_NOT_FOUND` unchanged. `FS_NOT_TEXT`, `FS_AMBIGUOUS_EDIT`, `FS_SANDBOX_DENIED`, `FS_TOO_LARGE` and `FS_NOT_DIRECTORY` are never produced by this backend, so callers cannot branch on any of them.
- **The advertised default sandbox mode is not enforced** — `sandboxMode` reports `sandboxPolicy.defaultMode`, which the tool layer reads to advertise escalation, while the per-call `SandboxExecutionPolicy` handed to `mkdir`, `writeText` and `editText` is discarded and no harness-side confinement runs; the remote account's own permissions are the only enforcement.
- **No test drives an SFTP operation** — the suite covers the constructor, `processPath` and `contains`, all pure; nothing exercises a remote round-trip, so every error-mapping claim on this page is read from source rather than observed.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

No invariant companion is published: there is no `invariant/` directory, and `tsconfig.json` references no `runtime-diagnostics/invariants` project. There is nothing here to reconcile — each operation is one SFTP round-trip whose result is returned to the caller, so no owned relation has two independent observations that could diverge.

The module header still describes guarded edits as "compare-and-swap via read-then-write with a lockfile". The implementation contains no lock and no compare-and-swap, only the read-modify-write in `editText`; treat the phrase as a stale aspiration until a lock actually lands.

</details>
