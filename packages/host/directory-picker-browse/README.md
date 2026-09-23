---
description: "In-app browsing backend of the directory-picker seam: one-level directory listing and child-directory creation for the web GUI host, serving remote clients too."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-directory-picker-browse

English | [中文](README.zh.md)

## Summary

Users who cannot reach an OS chooser still pick a workspace directory through `dsh-host-directory-picker-browse`: it lists one directory level and creates child directories, renders nothing on the host display, and runs listings through the composed filesystem, so it serves the remote clients the native backend cannot reach from either the local world or an open remote host's realm. Listings return directories only, name-sorted, following symlinks to directories, with a host-owned `hidden` flag; creation is non-recursive and validates one path segment. One composition row also fills the workspace flow's directory holes with the in-app **Select Workspace Directory** dialog.

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

Compose this backend when a workspace directory must be chosen without an OS chooser — remote browsers, SSH-forwarded sessions, or unattended hosts. The workspace flow drives `directoryPicker/list` and `directoryPicker/createDirectory`; both answer from the filesystem of the host the request addresses.

### Listing a directory

`list(path?, hostId?)` returns one directory level: name-sorted child directories with their absolute paths, a `hidden` flag (dot-prefixed on POSIX), a `home` anchor, and `crumbs` — the root-to-target ancestor chain where every crumb is a jump target and the root is labeled by its full path. An omitted or built-in local `hostId` addresses the Harness host, whose absent path lists the account home; any other `hostId` addresses that remote host's open execution world, whose absent path lists its filesystem root, and an id with no open world fails loud with the id. One call returns at most `maxEntries` rows (config, default 1,000 — the bound GitHub's web UI applies to directory listings), and a cut level reports `truncated: true` so the client can say the level is incomplete. Symlinks to directories are followed; broken and cyclic links are skipped.

### Creating a directory

`createDirectory(path, name, hostId?)` creates one child directory under an existing parent in the addressed execution world, resolved through the same point `list` uses: a named host with no open world fails `directory-unreadable` carrying that id and never creates on the Harness host. The local world creates non-recursively with the platform's own `mkdir` — a missing parent is a real failure, not a level to invent — and reads `EEXIST` as `directory-exists`; an addressed realm delegates to `FileSystem.mkdir`, which creates missing parents, and reads `created: false` as the same `directory-exists` outcome. Both reject anything but a single non-blank path segment (`name` must not contain separators and must not be `.` or `..`).

### Observable failures

Both primitives refuse a path that is not fully qualified — relative forms, and on Windows the rooted drive-less forms (`\foo`, `/foo`) and incomplete UNC prefixes that `isAbsolute` accepts — with `directory-unreadable` or `directory-create-failed`, instead of resolving it under the host process working directory. A request that names a host with no open execution world answers `directory-unreadable` carrying that id, never the Harness host's directories and never a creation there. Creation of an existing child answers `directory-exists`. A caller's `AbortSignal` stops an in-flight scan, so a disconnect or timeout does not leave the scan outliving the caller.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `maxEntries` | `1,000` | Complete-result bound of one listing level; hidden rows count toward it |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-host-directory-picker-browse) is the exhaustive source for every accepted field and its JSDoc.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

The backend lists one directory level in the addressed execution world and applies a bounded name-sorted window to the rows it returns: a cut level keeps the name-sorted head, hidden rows count against the bound, and the level reports `truncated: true`. Window insertion is binary with an O(1) full-window tail rejection, so an oversized level costs O(1) per candidate past the head instead of a window scan.

### The addressed world

One resolution point picks the filesystem a request runs against: an omitted or built-in local `hostId` reads the composed `ctx.fs` (this Harness host), any other id the open execution world of that remote host through `ctx.remoteHosts`. Both worlds then run the same steps through that world's own flavor — `resolve` for the requested path, `listDir` plus the response window for a listing, and the world's `mkdir` for a creation — so local and remote differ only in which filesystem answers. A remote realm is POSIX on every Harness host platform, so its paths, fence, and breadcrumbs use the POSIX flavor; the local world keeps the process platform's.

### The fully-qualified fence

`fullyQualified` rejects any path that does not name one fixed filesystem location regardless of process state: POSIX-absolute on POSIX; on Windows only drive-qualified (`C:\…`) or complete UNC (`\\server\share…`) forms. Rooted drive-less forms and incomplete UNC prefixes pass `isAbsolute` yet still resolve against the process's current drive, so the backend refuses them rather than rebasing a wire value. An addressed realm applies the same rule with POSIX semantics.

### Abort and probing

Every filesystem await races the caller's signal (`raceAbort`), so a stalled network filesystem cannot keep a departed caller's request alive; an abandoned read's late settlement is swallowed. Child types and targets come from the addressed filesystem's own listing. A backend that follows links reports the target's own type, so a directory row enters the window unprobed; one that reports the link itself is probed through `stat` on the entry's own target — raced like every other await — and is kept only when that target is a directory, so a broken or cyclic link is skipped silently and an abort keeps the caller's own reason.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `BrowseDirectoryPicker` service: listing, creation, bounded window, error mapping |
| — | No runtime invariant companion is published; each list/create is one stateless filesystem round trip; the filesystem itself is the authoritative state. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these when the backend contract is not enough: the seam definition first, then the decision record and the native alternative.

- [Directory-picker seam](../directory-picker/README.md) — the `browse` capability contract and the typed error vocabulary.
- [Directory-picker capability seam decision](../../../.agents/notes/archived/architecture/2026-07-28-directory-picker-capability-seam.md) — the policy decisions behind listing and creation.
- [Native backend](../directory-picker-native/README.md) — the OS-chooser alternative for local operators.
- [Adaptive chooser](../directory-picker-auto/README.md) — boot-time resolution between the two backends.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-host-directory-picker-browse) — every accepted config field and its source declaration.

-----

<a id="model-experience"></a>
## Model Experience

None, as the GUI-host picking backend registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define where the browse interaction is incomplete or intentionally unscoped. They are current package constraints, not a task backlog.

- **Windows hidden attribute is not read** — Node dirents do not expose `FILE_ATTRIBUTE_HIDDEN`, so `hidden` means dot-prefixed on every platform until a native probe is worth its cost.
- **No drive-root enumeration** — on Windows the ancestry stops at the drive root; crossing drives waits for the browser UI's path-entry affordance rather than an enumeration primitive here.
- **Whole-filesystem scope** — there is no per-deployment browse-root restriction; `workspace.create` accepts arbitrary paths, so a root here would be UX scoping rather than a security boundary.
- **Remote creation inherits the realm's own creation policy** — an addressed realm creates through `FileSystem.mkdir`, which the SSH filesystem fences by the per-call policy it resolves itself; this backend passes no policy, so the realm's default decides and a picker cannot mint a directory outside it.
- **One addressed level is materialized** — `FileSystem.listDir` reports the complete level, so peak memory follows that backend's own listing; the bounded window limits only the rows the response retains.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
