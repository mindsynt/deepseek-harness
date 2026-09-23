/**
 * Browse backend of the directory-picker seam: registers `ctx.directoryPicker`
 * with the `browse` capability — one-level directory listing and child-directory
 * creation over a host filesystem through the filesystem capability, so the
 * local execution world and an open remote host's realm share one listing and
 * creation path.
 * Nothing renders on the host display, so this backend serves remote clients
 * the dialog backend cannot. Policy decisions (hidden entries flagged but
 * returned, symlinks followed, whole-filesystem scope) are recorded in the
 * directory-picker seam Agent Note.
 * @module @deepseek-ai/dsh-host-directory-picker-browse
 */

import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, posix, resolve, win32 } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-fs'
import type { FileSystem, FsDirEntry } from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-ssh-host-registry'
import type { RemoteHostId } from '@deepseek-ai/dsh-ssh-host-registry'
import z from '@deepseek-ai/schemastery'
import {
  DirectoryPicker, DirectoryPickerError,
} from '@deepseek-ai/dsh-host-directory-picker'
import type {
  DirectoryEntry, DirectoryListing, DirectoryPickerCapability,
} from '@deepseek-ai/dsh-host-directory-picker'

/**
 * Identity of the Harness host's own execution world, matching `LOCAL_HOST_ID`
 * in `@deepseek-ai/dsh-workspace`. Duplicated because this backend addresses
 * hosts, not workspaces; the workspace domain owns the canonical value.
 */
const LOCAL_HOST_ID = 'local'

/**
 * Breadcrumb anchor of a remote realm. An SSH execution world exposes no
 * account home through `ctx.fs`, so the picker roots its breadcrumbs at the
 * realm's POSIX filesystem root, the one directory every realm has.
 */
const REMOTE_ANCHOR = '/'

/**
 * One addressed execution world: the filesystem every listing and creation
 * step runs against, plus the path facts only that world owns.
 */
interface AddressedWorld {
  /** Filesystem backend serving the listing (the Harness host's own, or a remote realm's). */
  readonly fs: FileSystem
  /** Breadcrumb anchor the client labels "Home". */
  readonly home: string
  /** Parent of one path in this world's flavor. */
  readonly dirname: (path: string) => string
  /** Last segment of one path in this world's flavor. */
  readonly basename: (path: string) => string
  /** Whether a path names one fixed location in this world rather than a process-relative form. */
  readonly qualifies: (path: string) => boolean
  /** Join one validated single segment under a parent in this world's flavor. */
  readonly join: (parent: string, segment: string) => string
  /** The path a creation call resolves its parent to in this world. */
  readonly resolveParent: (path: string) => Promise<string>
  /** Create `target` non-recursively; false when it already exists as a directory. */
  readonly mkdir: (target: string) => Promise<boolean>
}

/**
 * Ancestor chain from the filesystem root to `target` inclusive — the
 * breadcrumb rows of a listing, every one a jump target.
 */
function ancestryCrumbs(target: string, world: AddressedWorld): DirectoryEntry[] {
  const crumbs: DirectoryEntry[] = []
  let current = target
  for (;;) {
    const parent = world.dirname(current)
    // basename of a root is '' — label the root crumb by its full path ('/', 'C:\').
    crumbs.unshift({ name: parent === current ? current : world.basename(current), path: current, hidden: false })
    if (parent === current) return crumbs
    current = parent
  }
}

/**
 * True when the path names one fixed filesystem location regardless of
 * process state: POSIX-absolute on POSIX; on Windows only drive-qualified
 * (`C:\…`) or complete UNC (`\\server\share…`) forms. Rooted drive-less
 * forms (`\foo`, `/foo`) and incomplete UNC prefixes (`\\`, `\\server`)
 * pass `isAbsolute` yet still resolve against the process's current drive.
 * @param path - candidate path.
 * @param platform - replaces `process.platform` for deterministic tests.
 * @returns whether the path is fully qualified on the platform.
 */
export function fullyQualified(path: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32'
    ? win32.isAbsolute(path) && /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/]+[^\\/]+)/.test(path)
    : posix.isAbsolute(path)
}

/** One listing candidate: the row facts the window needs, nothing else retained. */
export interface ListingCandidate {
  /** Base name within the listed level. */
  name: string
  /** Absolute path of the candidate in its world. */
  path: string
}

/**
 * Insert a candidate into the name-sorted bounded window, evicting the
 * name-largest candidate when the window exceeds `keep`. The window keeps the
 * name-sorted head at O(keep) retained candidates no matter how many children
 * the addressed filesystem reports, so an oversized level costs no more than
 * the backend's own listing plus the window.
 * @param window - the name-ascending window, mutated in place.
 * @param candidate - the candidate to place.
 * @param keep - the window bound.
 * @returns true when an eviction happened (the level has candidates beyond the window).
 */
export function boundedInsert(window: ListingCandidate[], candidate: ListingCandidate, keep: number): boolean {
  // Full window, name at or beyond the tail: one comparison rejects, so an
  // oversized level costs O(1) per candidate past the head instead of a
  // window scan (100k children against a 1,001 window must not approach
  // 10^8 comparisons).
  // oxlint-disable-next-line typescript/no-non-null-assertion -- a full window (length === keep >= 1) has a tail
  if (window.length === keep && candidate.name.localeCompare(window[window.length - 1]!.name) >= 0) return true
  // Binary insertion keeps a retained candidate at O(log keep) comparisons.
  let lo = 0
  let hi = window.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    // oxlint-disable-next-line typescript/no-non-null-assertion -- bounded by the loop condition
    if (candidate.name.localeCompare(window[mid]!.name) < 0) hi = mid
    else lo = mid + 1
  }
  window.splice(lo, 0, candidate)
  if (window.length <= keep) return false
  window.pop()
  return true
}

/**
 * Await `operation`, but reject with the signal's reason the moment it
 * aborts. Filesystem reads are not retractable, so the operation itself keeps
 * running against a world the caller then abandons — its late settlement is
 * swallowed here so an abandoned read cannot surface as an unhandled
 * rejection.
 * @param operation - the in-flight filesystem step.
 * @param signal - caller lifetime; absent means plain awaiting.
 * @returns the operation's value.
 */
export function raceAbort<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return operation
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      operation.catch(() => {
        // Abandoned read: its result is discarded by the abort, and the abort
        // reason already carried the outcome.
      })
      reject(asError(signal.reason))
    }
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (reason: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(asError(reason))
      },
    )
  })
}

/** The thrown value as an Error (wire/abort reasons may be anything). */
function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason))
}

/** Message text of an unknown thrown value. */
function messageOf(error: unknown): string {
  /* v8 ignore next -- a filesystem backend rejects with Error instances; the String arm only satisfies the unknown narrowing. */
  return error instanceof Error ? error.message : String(error)
}

/**
 * Create one directory on the Harness host's own filesystem, reporting whether
 * this call made it. Creation is non-recursive: the parent is the directory the
 * browser is showing, so a missing parent is a real failure rather than a level
 * to invent, and an already-existing child reports the `directory-exists`
 * outcome instead of an error.
 * @param target - absolute directory to create.
 * @returns true when this call created the directory.
 */
async function createLocalDirectory(target: string): Promise<boolean> {
  try {
    await mkdir(target)
    return true
  } catch (error: unknown) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST') return false
    throw error
  }
}

/** Validated plugin configuration. */
export interface Config {
  /** Complete-result bound of one listing level; see {@link BrowseDirectoryPicker.Config}. */
  maxEntries: number
}

/** The `ctx.directoryPicker` browse implementation (stable capability object per service life). */
export default class BrowseDirectoryPicker extends DirectoryPicker {
  /**
   * `maxEntries` bounds the complete listing level a single `list` call may
   * materialize and put on the wire: at most this many child-directory rows
   * (hidden rows included), with `truncated` flagging a cut level. The
   * default follows GitHub's web UI, which truncates directory listings at
   * 1,000 entries.
   */
  static Config: z<Config> = z.object({
    maxEntries: z.natural().min(1).default(1000),
  })

  private readonly browseCapability: DirectoryPickerCapability = {
    kind: 'browse',
    list: (path, hostId, signal) => this.list(path, hostId, signal),
    createDirectory: (path, name, hostId) => this.createDirectory(path, name, hostId),
  }

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx)
  }

  /**
   * The browse interaction capability.
   * @returns the stable `browse` capability object.
   */
  capability(): DirectoryPickerCapability {
    return this.browseCapability
  }

  /**
   * The execution world one request addresses. An omitted or built-in local
   * identity is this Harness host; any other identity is that remote host's
   * open realm, resolved through `ctx.remoteHosts` at call time so a
   * composition without the registry still serves the local filesystem.
   */
  private worldFor(hostId: string | undefined): AddressedWorld {
    if (hostId === undefined || hostId === LOCAL_HOST_ID) {
      // Read through `get`, not the declared-injection proxy: the local
      // filesystem is required to list but not to register this backend, so a
      // composition that mounts the browse capability without one still
      // activates and fails at the first listing instead of staying pending.
      const fs = this.ctx.get('fs')
      if (fs === undefined) {
        throw new Error('directory picker: no filesystem is composed; the local browse world needs ctx.fs')
      }
      return {
        fs,
        home: homedir(),
        dirname,
        basename,
        qualifies: path => fullyQualified(path),
        join,
        resolveParent: path => Promise.resolve(resolve(path)),
        mkdir: createLocalDirectory,
      }
    }
    const registry = this.ctx.get('remoteHosts')
    const handle = registry?.get(brandString<RemoteHostId>(hostId))
    if (handle === undefined) {
      throw new DirectoryPickerError(
        'directory-unreadable',
        hostId,
        `host "${hostId}" has no open execution world on this Host; open the host before browsing its directories`,
      )
    }
    // A remote realm is POSIX-only, so its paths use the POSIX flavor on every
    // Harness host platform; the local world keeps the process platform's.
    const realm = handle.world.fs
    return {
      fs: realm,
      home: REMOTE_ANCHOR,
      dirname: path => posix.dirname(path),
      basename: path => posix.basename(path),
      qualifies: path => posix.isAbsolute(path),
      join: (parent, segment) => posix.join(parent, segment),
      resolveParent: async path => (await realm.resolve(path)).displayPath,
      // Creation is the realm's own filesystem primitive, so the remote fence
      // and error taxonomy stay the ones every other remote mutation uses.
      mkdir: async target => (await realm.mkdir(await realm.resolve(target))).created,
    }
  }

  private async list(path?: string, hostId?: string, signal?: AbortSignal): Promise<DirectoryListing> {
    const world = this.worldFor(hostId)
    // The seam contract takes fully qualified paths only; a relative or empty
    // wire value must never resolve against the backend's cwd (or, for rooted
    // drive-less Windows forms, its current drive).
    if (path !== undefined && !world.qualifies(path)) {
      throw new DirectoryPickerError('directory-unreadable', path, `cannot list "${path}": not a fully qualified path`)
    }
    const requested = path ?? world.home
    // The subject of a failure is the resolved path once resolution succeeded,
    // and the requested path when resolution itself failed.
    let targetPath = requested
    let children: FsDirEntry[] = []
    try {
      // Every filesystem await races the caller's signal: a stalled network
      // directory must not keep a departed caller's scan alive, and an
      // already-aborted request rejects even when the level is empty.
      const target = await raceAbort(world.fs.resolve(requested), signal)
      targetPath = target.displayPath
      children = await raceAbort(world.fs.listDir(target), signal)
    } catch (error: unknown) {
      // An abort is the caller's own reason, not an unreadable directory.
      signal?.throwIfAborted()
      throw new DirectoryPickerError('directory-unreadable', targetPath, `cannot list ${targetPath}: ${messageOf(error)}`)
    }
    // The addressed filesystem returns one level whole, so the name-sorted
    // window applies the complete-result bound to the rows this call keeps:
    // the window keeps the name-sorted head, and the +1 slot lets an
    // in-window extra row prove the cut. Hidden rows count toward the bound.
    const keep = this.config.maxEntries + 1
    const window: ListingCandidate[] = []
    let evicted = false
    for (const child of children) {
      // Only rows a browser could enter contend for the window. A listing that
      // follows links reports the target's own type, so a directory row needs
      // no probe; a link-preserving listing — the entry discriminant is read
      // as a string because the seam's `symlink` vocabulary is wider than the
      // declared entry type — is enterable only when the entry's own target
      // resolves to a directory, and a broken or cyclic link is skipped
      // silently.
      const kind: string = child.type
      let enterable = kind === 'directory'
      if (!enterable && kind === 'symlink') {
        try {
          // The probe reuses the entry's own target and races the caller like
          // every other filesystem await, so a stalled link target cannot keep
          // a departed caller's scan alive.
          enterable = (await raceAbort(world.fs.stat(child.target), signal))?.type === 'directory'
        } catch {
          // A departed caller keeps its own reason; anything else is a
          // broken or cyclic link, whose failed probe is the verdict.
          signal?.throwIfAborted()
          continue
        }
      }
      if (!enterable) continue
      if (boundedInsert(window, { name: child.name, path: child.target.displayPath }, keep)) evicted = true
    }
    const entries: DirectoryEntry[] = []
    let truncated = evicted
    for (const candidate of window) {
      // A caller that departed between the listing and this window still stops
      // before the rows are assembled.
      signal?.throwIfAborted()
      if (entries.length === this.config.maxEntries) {
        truncated = true
        break
      }
      // POSIX hidden convention; Windows' hidden attribute is not exposed by
      // dirents (Known Limitations). The client owns whether hidden rows show.
      entries.push({ name: candidate.name, path: candidate.path, hidden: candidate.name.startsWith('.') })
    }
    return { path: targetPath, home: world.home, crumbs: ancestryCrumbs(targetPath, world), entries, truncated }
  }

  private async createDirectory(path: string, name: string, hostId?: string): Promise<string> {
    // The create addresses its world exactly as list does: the same single
    // resolution point, so a named host with no open realm fails loud here too
    // and never directs the write at the Harness host's own filesystem.
    const world = this.worldFor(hostId)
    // Same fully-qualified fence as list, in the addressed world's flavor: never
    // rebase a parent under the cwd or the current drive.
    if (!world.qualifies(path)) {
      throw new DirectoryPickerError('directory-create-failed', path, `cannot create under "${path}": not a fully qualified parent path`)
    }
    let parent: string
    try {
      parent = await world.resolveParent(path)
    } catch (error: unknown) {
      throw new DirectoryPickerError('directory-create-failed', path, `cannot create under ${path}: ${messageOf(error)}`)
    }
    // The backend owns segment validation; the Remote controller also refuses
    // invalid wire input, but direct service consumers must hit the same fence.
    if (name.trim() === '' || name === '.' || name === '..' || /[/\\]/.test(name)) {
      throw new DirectoryPickerError('directory-create-failed', world.join(parent, name), `"${name}" is not a single path segment`)
    }
    const target = world.join(parent, name)
    try {
      // A child that already exists is the `directory-exists` outcome, wherever
      // it was created: the local world reports it from the platform's own
      // EEXIST, an addressed realm from the primitive's `created: false`.
      // Non-recursive locally — the parent is the directory the browser is
      // showing, so a missing parent is a real failure, not a level to invent.
      if (await world.mkdir(target)) return target
      throw new DirectoryPickerError('directory-exists', target, `${target} already exists`)
    } catch (error: unknown) {
      if (error instanceof DirectoryPickerError) throw error
      throw new DirectoryPickerError('directory-create-failed', target, `cannot create ${target}: ${messageOf(error)}`)
    }
  }
}
