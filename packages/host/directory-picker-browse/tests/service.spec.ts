/** Behavior of the browse backend over real temporary directory trees. */

import { access, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, join, posix } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { DirectoryPickerError } from '@deepseek-ai/dsh-host-directory-picker'
import type { DirectoryPickerBrowseCapability } from '@deepseek-ai/dsh-host-directory-picker'
import type { FileSystem, FsDirEntry, FsInfo, FsTarget } from '@deepseek-ai/dsh-fs'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import BrowseDirectoryPicker, { boundedInsert, fullyQualified, raceAbort } from '../src/index.ts'
import type { ListingCandidate } from '../src/index.ts'

let root: string
let remoteRoot: string
let capability: DirectoryPickerBrowseCapability
let dispose: () => Promise<void>
const disposals: Array<() => Promise<void>> = []

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-browse-'))
  await mkdir(join(root, 'projects'))
  await mkdir(join(root, 'projects', 'harness'))
  await mkdir(join(root, '.hidden-dir'))
  await writeFile(join(root, 'notes.txt'), 'not a directory')
  await symlink(join(root, 'projects'), join(root, 'linked'), 'junction')
  await symlink(join(root, 'gone'), join(root, 'broken'), 'junction')
  try {
    await symlink(join(root, 'notes.txt'), join(root, 'file-link'))
  } catch {
    // Windows denies unprivileged file symlinks; the file-link row only
    // feeds the POSIX lanes' coverage of the symlink-to-file arm, and every
    // assertion below expects it to be filtered out anyway.
  }

  // A second directory tree stands in for one remote realm's filesystem: the
  // same real backend rooted elsewhere, exactly as an SSH realm mounts it.
  remoteRoot = await mkdtemp(join(tmpdir(), 'dsh-browse-remote-'))
  await mkdir(join(remoteRoot, 'deploy'))
  await mkdir(join(remoteRoot, '.cache'))
  await writeFile(join(remoteRoot, 'readme.md'), 'not a directory')

  const backend = await openBackend()
  capability = backend.capability
  dispose = backend.dispose
  disposals.push(dispose)
})

afterAll(async () => {
  for (const stop of disposals.splice(0)) await stop()
  await rm(root, { recursive: true, force: true })
  await rm(remoteRoot, { recursive: true, force: true })
})

/**
 * One composed browse backend over `cwd`, optionally carrying a `ctx.remoteHosts`
 * double, disposed by the caller.
 * @param options - backend root and the host registry double to provide.
 * @returns the context, its browse capability, and the disposer.
 */
async function openBackend(
  options: { cwd?: string; remoteHosts?: unknown } = {},
): Promise<{ ctx: Context; capability: DirectoryPickerBrowseCapability; dispose: () => Promise<void> }> {
  const ctx = new Context()
  const fsFiber = ctx.plugin(LocalFileSystem, { cwd: options.cwd ?? root })
  await fsFiber.await()
  if (options.remoteHosts !== undefined) ctx.provide('remoteHosts', options.remoteHosts as never)
  const fiber = ctx.plugin(BrowseDirectoryPicker)
  await fiber.await()
  const picked = ctx.get('directoryPicker')!.capability()
  if (picked.kind !== 'browse') throw new Error('browse backend must advertise the browse capability')
  return {
    ctx,
    capability: picked,
    dispose: async () => {
      await fiber.dispose()
      await fsFiber.dispose()
    },
  }
}

/**
 * One isolated local filesystem rooted at `cwd`, standing in for a remote realm.
 * @param cwd - the directory the world resolves relative paths against.
 * @returns the world's filesystem and its disposer.
 */
async function openRemoteWorld(cwd: string): Promise<{ fs: FileSystem; dispose: () => Promise<void> }> {
  const ctx = new Context()
  const realm = ctx.isolate('fs', Symbol('browse remote realm'))
  const fiber = await realm.plugin(LocalFileSystem, { cwd })
  return { fs: realm.fs, dispose: async () => { await fiber.dispose() } }
}

/**
 * A `ctx.remoteHosts` double exposing only the worlds it is given, keyed by
 * host id exactly as the registry's `get` does.
 * @param open - host id to open handle map.
 * @returns the registry double.
 */
function openHosts(open: Readonly<Record<string, unknown>>): unknown {
  return { get: (id: string) => open[id] }
}

/** One open handle's execution world, the only member a listing reads. */
function handle(fs: FileSystem): unknown {
  return { world: { fs } }
}

/** One resolved target of a stub world: the path is its own identity. */
function stubTarget(displayPath: string): FsTarget {
  return { displayPath, targetKey: displayPath } as unknown as FsTarget
}

/** One stub listing row, typed as the caller declares it (the link included). */
function stubChild(name: string, type: string): FsDirEntry {
  return { name, type, target: stubTarget(`/world/${name}`) } as unknown as FsDirEntry
}

/**
 * One composed browse backend over a caller-supplied filesystem double, so a
 * backend that reports the link itself — rather than the target its listing
 * followed, which is all this host's own backend reports — can be exercised.
 * @param fs - the filesystem the local browse world resolves through.
 * @returns the browse capability and its disposer.
 */
async function openStubBackend(fs: FileSystem): Promise<{ capability: DirectoryPickerBrowseCapability; dispose: () => Promise<void> }> {
  const ctx = new Context()
  ctx.provide('fs', fs as never)
  const fiber = ctx.plugin(BrowseDirectoryPicker)
  await fiber.await()
  const picked = ctx.get('directoryPicker')!.capability()
  if (picked.kind !== 'browse') throw new Error('browse backend must advertise the browse capability')
  return { capability: picked, dispose: async () => { await fiber.dispose() } }
}

/**
 * A filesystem double whose listing reports each child with the type it was
 * given and whose probe is the caller's.
 * @param children - the level the double reports, in the order it reports them.
 * @param stat - the probe result for one target.
 * @returns the double and the two calls a listing makes on it.
 */
function linkListingFs(
  children: FsDirEntry[],
  stat: (target: FsTarget) => Promise<FsInfo | undefined>,
): { fs: FileSystem; resolve: ReturnType<typeof vi.fn>; stat: ReturnType<typeof vi.fn> } {
  const resolve = vi.fn(async (path: string) => stubTarget(path))
  const listDir = vi.fn(async () => children)
  const probe = vi.fn(stat)
  return { fs: { resolve, listDir, stat: probe } as unknown as FileSystem, resolve, stat: probe }
}

describe('BrowseDirectoryPicker', () => {
  it('lists directories only, flags hidden rows, follows symlinks, skips broken links, sorts by name', async () => {
    const listing = await capability.list(root)
    expect(listing.path).toBe(root)
    expect(listing.home).toBe(homedir())
    expect(listing.entries.map(entry => entry.name)).toEqual(['.hidden-dir', 'linked', 'projects'])
    expect(listing.entries.map(entry => entry.hidden)).toEqual([true, false, false])
    // Every entry path is absolute and host-joined — clients never join segments.
    expect(listing.entries.every(entry => entry.path === join(root, entry.name))).toBe(true)
    // Well under the default bound: the complete level, not a cut one.
    expect(listing.truncated).toBe(false)
  })

  it('cuts a level at maxEntries keeping the name-sorted head, and flags the cut', async () => {
    const ctx = new Context()
    const fsFiber = ctx.plugin(LocalFileSystem, { cwd: root })
    await fsFiber.await()
    const fiber = ctx.plugin(BrowseDirectoryPicker, { maxEntries: 1 })
    await fiber.await()
    const bounded = ctx.get('directoryPicker')!.capability()
    if (bounded.kind !== 'browse') throw new Error('browse backend must advertise the browse capability')
    try {
      const cut = await bounded.list(root)
      expect(cut.entries.map(entry => entry.name)).toEqual(['.hidden-dir'])
      expect(cut.truncated).toBe(true)
      // Exactly at the bound is complete, not truncated.
      const exact = await bounded.list(join(root, 'projects'))
      expect(exact.entries.map(entry => entry.name)).toEqual(['harness'])
      expect(exact.truncated).toBe(false)
      // A level that fits the window but exceeds the bound (two rows, bound
      // one): the in-window extra row proves the cut without any eviction.
      await mkdir(join(root, 'projects', 'harness', 'a'))
      await mkdir(join(root, 'projects', 'harness', 'b'))
      const inWindow = await bounded.list(join(root, 'projects', 'harness'))
      expect(inWindow.entries.map(entry => entry.name)).toEqual(['a'])
      expect(inWindow.truncated).toBe(true)
    } finally {
      await fiber.dispose()
      await fsFiber.dispose()
    }
  })

  it('stops the scan with the caller: an aborted signal rejects with its own reason', async () => {
    const gone = new AbortController()
    gone.abort(new Error('caller left'))
    // The abort surfaces as-is, not dressed as an unreadable directory —
    // and rejects even before any level row is read.
    await expect(capability.list(root, undefined, gone.signal)).rejects.toThrow('caller left')
    // Aborted against a missing target: the abandoned resolve rejects with
    // the caller's own reason too.
    await expect(capability.list(join(root, 'no-such-dir'), undefined, gone.signal)).rejects.toThrow('caller left')
    // A live signal leaves a normal listing untouched — the reads race it
    // without ever losing.
    const live = new AbortController()
    const complete = await capability.list(root, undefined, live.signal)
    expect(complete.truncated).toBe(false)
    expect(complete.entries.map(entry => entry.name)).toContain('linked')
    // A live signal changes nothing about ordinary failures.
    const missing = join(root, 'no-such-dir')
    const failure = await capability.list(missing, undefined, live.signal).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(DirectoryPickerError)
    expect((failure as DirectoryPickerError).code).toBe('directory-unreadable')
  })

  it('raceAbort follows the operation until the signal wins, and swallows the abandoned settlement', async () => {
    // No signal / settled operations: plain passthrough, listener removed.
    await expect(raceAbort(Promise.resolve('ok'), undefined)).resolves.toBe('ok')
    const live = new AbortController()
    await expect(raceAbort(Promise.resolve('ok'), live.signal)).resolves.toBe('ok')
    // Failure passthrough keeps the operation's own error.
    await expect(raceAbort(Promise.reject(new Error('raw failure')), live.signal)).rejects.toThrow('raw failure')
    // The abort wins over a pending operation and carries its own reason;
    // the operation's late rejection is swallowed, never unhandled.
    const rejections: unknown[] = []
    const onUnhandled = (reason: unknown): void => { rejections.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    try {
      let rejectLate!: (reason: unknown) => void
      const pending = new Promise<never>((_resolve, reject) => { rejectLate = reject })
      const controller = new AbortController()
      const raced = raceAbort(pending, controller.signal)
      // A bare-string abort reason exercises the Error wrap.
      controller.abort('caller left')
      await expect(raced).rejects.toThrow('caller left')
      rejectLate(new Error('late read failure'))
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(rejections).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('boundedInsert keeps the window name-sorted and bounded, reporting evictions', () => {
    const candidate = (name: string): ListingCandidate => ({ name, path: `/${name}` })
    const window: ListingCandidate[] = []
    expect(boundedInsert(window, candidate('m'), 2)).toBe(false)
    expect(boundedInsert(window, candidate('z'), 2)).toBe(false)
    // A smaller name lands in place and pushes the current largest out.
    expect(boundedInsert(window, candidate('a'), 2)).toBe(true)
    expect(window.map(entry => entry.name)).toEqual(['a', 'm'])
    // A name at or beyond the full window's tail rejects on one comparison.
    expect(boundedInsert(window, candidate('t'), 2)).toBe(true)
    expect(window.map(entry => entry.name)).toEqual(['a', 'm'])
    expect(boundedInsert(window, candidate('m'), 2)).toBe(true)
    expect(window.map(entry => entry.name)).toEqual(['a', 'm'])
  })

  it('reports the ancestry as jump-target crumbs ending at the listed directory', async () => {
    const listing = await capability.list(join(root, 'projects'))
    const tail = listing.crumbs.at(-1)!
    expect(tail).toMatchObject({ name: 'projects', path: join(root, 'projects'), hidden: false })
    expect(listing.crumbs.at(-2)!.path).toBe(root)
    expect(listing.crumbs.at(-2)!.name).toBe(basename(root))
    // The chain starts at the filesystem root, whose crumb is labeled by its full path.
    expect(listing.crumbs[0]!.name).toBe(listing.crumbs[0]!.path)
  })

  it('lists the home directory when no path is given', async () => {
    const listing = await capability.list()
    expect(listing.path).toBe(homedir())
  })

  it('throws directory-unreadable for a missing target', async () => {
    const missing = join(root, 'no-such-dir')
    const failure = await capability.list(missing).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(DirectoryPickerError)
    expect((failure as DirectoryPickerError).code).toBe('directory-unreadable')
    expect((failure as DirectoryPickerError).path).toBe(missing)
  })

  it('throws directory-unreadable with the requested path when resolution itself fails', async () => {
    // A regular file in the ancestor chain: the path can never be resolved.
    const throughFile = join(root, 'notes.txt', 'child')
    const failure = await capability.list(throughFile).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(DirectoryPickerError)
    expect((failure as DirectoryPickerError).code).toBe('directory-unreadable')
    expect((failure as DirectoryPickerError).path).toBe(throughFile)
  })

  it('classifies fully qualified paths per platform (drive-less rooted Windows forms rejected)', () => {
    expect(fullyQualified('/home/x', 'linux')).toBe(true)
    expect(fullyQualified('x/y', 'darwin')).toBe(false)
    expect(fullyQualified('C:\\projects', 'win32')).toBe(true)
    expect(fullyQualified('C:/projects', 'win32')).toBe(true)
    expect(fullyQualified('\\\\server\\share', 'win32')).toBe(true)
    expect(fullyQualified('//server/share/deep', 'win32')).toBe(true)
    // Rooted but drive-less: isAbsolute accepts these, yet resolve() would
    // inject the process's current drive.
    expect(fullyQualified('\\foo', 'win32')).toBe(false)
    expect(fullyQualified('/foo', 'win32')).toBe(false)
    expect(fullyQualified('C:relative', 'win32')).toBe(false)
    // Incomplete UNC prefixes collapse to drive-relative roots under resolve().
    expect(fullyQualified('\\\\', 'win32')).toBe(false)
    expect(fullyQualified('\\\\server', 'win32')).toBe(false)
    expect(fullyQualified('\\\\server\\', 'win32')).toBe(false)
  })

  it('rejects non-absolute paths instead of rebasing them under the process cwd', async () => {
    for (const relative of ['', 'projects', './projects', '..']) {
      const listFailure = await capability.list(relative).catch((error: unknown) => error)
      expect(listFailure).toBeInstanceOf(DirectoryPickerError)
      expect((listFailure as DirectoryPickerError).code).toBe('directory-unreadable')
      expect((listFailure as DirectoryPickerError).path).toBe(relative)
      const createFailure = await capability.createDirectory(relative, 'child').catch((error: unknown) => error)
      expect(createFailure).toBeInstanceOf(DirectoryPickerError)
      expect((createFailure as DirectoryPickerError).code).toBe('directory-create-failed')
      expect((createFailure as DirectoryPickerError).path).toBe(relative)
    }
  })

  it('creates one child directory and surfaces it in the next listing', async () => {
    const created = await capability.createDirectory(root, 'fresh')
    expect(created).toBe(join(root, 'fresh'))
    const listing = await capability.list(root)
    expect(listing.entries.map(entry => entry.name)).toContain('fresh')
  })

  it('refuses an existing child with directory-exists', async () => {
    const failure = await capability.createDirectory(root, 'projects').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(DirectoryPickerError)
    expect((failure as DirectoryPickerError).code).toBe('directory-exists')
  })

  it('refuses non-segment names and other filesystem failures with directory-create-failed', async () => {
    for (const name of ['', '  ', '.', '..', 'a/b', 'a\\b']) {
      const failure = await capability.createDirectory(root, name).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(DirectoryPickerError)
      expect((failure as DirectoryPickerError).code).toBe('directory-create-failed')
    }
    // Missing parent is a real failure, not a level to invent.
    const missingParent = await capability.createDirectory(join(root, 'no-such-dir'), 'child').catch((error: unknown) => error)
    expect((missingParent as DirectoryPickerError).code).toBe('directory-create-failed')
  })
})

describe('BrowseDirectoryPicker host addressing', () => {
  it('lists the addressed remote world instead of the Harness host filesystem', async () => {
    const remote = await openRemoteWorld(remoteRoot)
    const backend = await openBackend({ remoteHosts: openHosts({ alpha: handle(remote.fs) }) })
    const localResolve = vi.spyOn(backend.ctx.fs, 'resolve')
    const localListDir = vi.spyOn(backend.ctx.fs, 'listDir')
    try {
      const listing = await backend.capability.list(remoteRoot, 'alpha')
      expect(listing.path).toBe(remoteRoot)
      // A remote realm exposes no account home; the picker roots at the realm's POSIX root.
      expect(listing.home).toBe('/')
      expect(listing.entries.map(entry => entry.name)).toEqual(['.cache', 'deploy'])
      expect(listing.entries.map(entry => entry.path)).toEqual([join(remoteRoot, '.cache'), join(remoteRoot, 'deploy')])
      expect(listing.crumbs.at(-1)!.path).toBe(remoteRoot)
      expect(listing.crumbs[0]).toMatchObject({ name: '/', path: '/' })
      expect(localResolve).not.toHaveBeenCalled()
      expect(localListDir).not.toHaveBeenCalled()
    } finally {
      await backend.dispose()
      await remote.dispose()
    }
  })

  it('roots an addressed realm with no requested path at its filesystem root', async () => {
    const remote = await openRemoteWorld(remoteRoot)
    const backend = await openBackend({ remoteHosts: openHosts({ alpha: handle(remote.fs) }) })
    try {
      const listing = await backend.capability.list(undefined, 'alpha')
      expect(listing.path).toBe('/')
      expect(listing.home).toBe('/')
      expect(listing.crumbs.map(crumb => crumb.path)).toEqual(['/'])
    } finally {
      await backend.dispose()
      await remote.dispose()
    }
  })

  it('treats the built-in local identity as the Harness host filesystem', async () => {
    const backend = await openBackend()
    const localListDir = vi.spyOn(backend.ctx.fs, 'listDir')
    try {
      const listing = await backend.capability.list(root, 'local')
      expect(listing.home).toBe(homedir())
      expect(listing.entries.map(entry => entry.name)).toContain('projects')
      // The local world is the composed `ctx.fs`, not a second local I/O path.
      expect(localListDir).toHaveBeenCalled()
    } finally {
      await backend.dispose()
    }
  })

  it('fails loud with the host id when the registry has no open world for it', async () => {
    const backend = await openBackend({ remoteHosts: openHosts({}) })
    try {
      const failure = await backend.capability.list(root, 'ghost').catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(DirectoryPickerError)
      expect((failure as DirectoryPickerError).code).toBe('directory-unreadable')
      expect((failure as DirectoryPickerError).path).toBe('ghost')
      expect((failure as DirectoryPickerError).message).toContain('host "ghost" has no open execution world')
    } finally {
      await backend.dispose()
    }
  })

  it('fails loud with the host id when no host registry is composed', async () => {
    const backend = await openBackend()
    try {
      expect(backend.ctx.get('remoteHosts')).toBeUndefined()
      const failure = await backend.capability.list(root, 'beta').catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(DirectoryPickerError)
      expect((failure as DirectoryPickerError).code).toBe('directory-unreadable')
      expect((failure as DirectoryPickerError).message).toContain('host "beta" has no open execution world')
    } finally {
      await backend.dispose()
    }
  })

  it('refuses a path that is not fully qualified in the addressed realm', async () => {
    const remote = await openRemoteWorld(remoteRoot)
    const backend = await openBackend({ remoteHosts: openHosts({ alpha: handle(remote.fs) }) })
    try {
      const failure = await backend.capability.list('srv/deploy', 'alpha').catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(DirectoryPickerError)
      expect((failure as DirectoryPickerError).code).toBe('directory-unreadable')
      expect((failure as DirectoryPickerError).path).toBe('srv/deploy')
      expect((failure as DirectoryPickerError).message).toContain('not a fully qualified path')
    } finally {
      await backend.dispose()
      await remote.dispose()
    }
  })

  it('maps an unreadable addressed directory to directory-unreadable', async () => {
    const remote = await openRemoteWorld(remoteRoot)
    const backend = await openBackend({ remoteHosts: openHosts({ alpha: handle(remote.fs) }) })
    try {
      const missing = join(remoteRoot, 'no-such-dir')
      const failure = await backend.capability.list(missing, 'alpha').catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(DirectoryPickerError)
      expect((failure as DirectoryPickerError).code).toBe('directory-unreadable')
      expect((failure as DirectoryPickerError).path).toBe(missing)
    } finally {
      await backend.dispose()
      await remote.dispose()
    }
  })

  it('creates the child in the addressed realm and surfaces it in the next remote listing', async () => {
    const remote = await openRemoteWorld(remoteRoot)
    const backend = await openBackend({ remoteHosts: openHosts({ alpha: handle(remote.fs) }) })
    const localMkdir = vi.spyOn(backend.ctx.fs, 'mkdir')
    try {
      const created = await backend.capability.createDirectory(remoteRoot, 'created-here', 'alpha')
      expect(created).toBe(join(remoteRoot, 'created-here'))
      const listing = await backend.capability.list(remoteRoot, 'alpha')
      expect(listing.entries.map(entry => entry.name)).toContain('created-here')
      // The realm's own filesystem took the write, never the Harness host's.
      expect(localMkdir).not.toHaveBeenCalled()
    } finally {
      await backend.dispose()
      await remote.dispose()
    }
  })

  it('reports an already-existing child in the addressed realm as directory-exists', async () => {
    const remote = await openRemoteWorld(remoteRoot)
    const backend = await openBackend({ remoteHosts: openHosts({ alpha: handle(remote.fs) }) })
    try {
      const failure = await backend.capability.createDirectory(remoteRoot, 'deploy', 'alpha')
        .catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(DirectoryPickerError)
      expect((failure as DirectoryPickerError).code).toBe('directory-exists')
      expect((failure as DirectoryPickerError).path).toBe(join(remoteRoot, 'deploy'))
      expect((failure as DirectoryPickerError).message).toContain('already exists')
    } finally {
      await backend.dispose()
      await remote.dispose()
    }
  })

  it('fails loud with the host id instead of creating on the Harness host filesystem', async () => {
    const backend = await openBackend({ remoteHosts: openHosts({}) })
    try {
      const failure = await backend.capability.createDirectory(root, 'ghost-child', 'ghost')
        .catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(DirectoryPickerError)
      expect((failure as DirectoryPickerError).code).toBe('directory-unreadable')
      expect((failure as DirectoryPickerError).path).toBe('ghost')
      expect((failure as DirectoryPickerError).message).toContain('host "ghost" has no open execution world')
      // No fallback: nothing was created on the Harness host either.
      await expect(access(join(root, 'ghost-child'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await backend.dispose()
    }
  })

  it('refuses a parent that is not fully qualified in the addressed realm', async () => {
    const remote = await openRemoteWorld(remoteRoot)
    const backend = await openBackend({ remoteHosts: openHosts({ alpha: handle(remote.fs) }) })
    try {
      const failure = await backend.capability.createDirectory('srv/deploy', 'child', 'alpha')
        .catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(DirectoryPickerError)
      expect((failure as DirectoryPickerError).code).toBe('directory-create-failed')
      expect((failure as DirectoryPickerError).path).toBe('srv/deploy')
      expect((failure as DirectoryPickerError).message).toContain('not a fully qualified parent path')
    } finally {
      await backend.dispose()
      await remote.dispose()
    }
  })

  it('refuses non-segment names in the addressed realm with the resolved POSIX target', async () => {
    const remote = await openRemoteWorld(remoteRoot)
    const backend = await openBackend({ remoteHosts: openHosts({ alpha: handle(remote.fs) }) })
    try {
      for (const name of ['', '  ', '.', '..', 'a/b', 'a\\b']) {
        const failure = await backend.capability.createDirectory(remoteRoot, name, 'alpha')
          .catch((error: unknown) => error)
        expect(failure).toBeInstanceOf(DirectoryPickerError)
        expect((failure as DirectoryPickerError).code).toBe('directory-create-failed')
        expect((failure as DirectoryPickerError).path).toBe(posix.join(remoteRoot, name))
        expect((failure as DirectoryPickerError).message).toContain('is not a single path segment')
      }
    } finally {
      await backend.dispose()
      await remote.dispose()
    }
  })

  it('maps a parent the addressed realm cannot resolve to directory-create-failed', async () => {
    const remote = await openRemoteWorld(remoteRoot)
    const backend = await openBackend({ remoteHosts: openHosts({ alpha: handle(remote.fs) }) })
    try {
      // A regular file in the ancestor chain: the parent can never be resolved.
      const throughFile = join(remoteRoot, 'readme.md', 'child')
      const failure = await backend.capability.createDirectory(throughFile, 'child', 'alpha')
        .catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(DirectoryPickerError)
      expect((failure as DirectoryPickerError).code).toBe('directory-create-failed')
      expect((failure as DirectoryPickerError).path).toBe(throughFile)
      expect((failure as DirectoryPickerError).message).toContain('cannot create under')
    } finally {
      await backend.dispose()
      await remote.dispose()
    }
  })

  it('maps a rejected realm creation to directory-create-failed', async () => {
    const remote = await openRemoteWorld(remoteRoot)
    const backend = await openBackend({ remoteHosts: openHosts({ alpha: handle(remote.fs) }) })
    try {
      // The parent is a regular file, so the realm's own primitive refuses.
      const failure = await backend.capability.createDirectory(join(remoteRoot, 'readme.md'), 'child', 'alpha')
        .catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(DirectoryPickerError)
      expect((failure as DirectoryPickerError).code).toBe('directory-create-failed')
      expect((failure as DirectoryPickerError).path).toBe(join(remoteRoot, 'readme.md', 'child'))
      expect((failure as DirectoryPickerError).message).toContain('cannot create')
    } finally {
      await backend.dispose()
      await remote.dispose()
    }
  })

  it('fails loud when no filesystem is composed for the local world', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(BrowseDirectoryPicker)
    await fiber.await()
    const picked = ctx.get('directoryPicker')!.capability()
    if (picked.kind !== 'browse') throw new Error('browse backend must advertise the browse capability')
    try {
      await expect(picked.list(root)).rejects.toThrow('no filesystem is composed')
    } finally {
      await fiber.dispose()
    }
  })
})

describe('BrowseDirectoryPicker link rows', () => {
  it('lists a linked directory a link-reporting backend names, skipping broken links and plain files', async () => {
    const children = [
      stubChild('real', 'directory'),
      stubChild('linked', 'symlink'),
      stubChild('broken', 'symlink'),
      stubChild('file-link', 'symlink'),
      stubChild('notes.txt', 'file'),
    ]
    const { fs, resolve, stat } = linkListingFs(children, async (target) => {
      if (target.displayPath === '/world/linked') return { type: 'directory' } as FsInfo
      if (target.displayPath === '/world/file-link') return { type: 'file' } as FsInfo
      // A broken or cyclic link: the probe is what proves it cannot be entered.
      return undefined
    })
    const backend = await openStubBackend(fs)
    try {
      const listing = await backend.capability.list('/world')
      expect(listing.entries.map(entry => entry.name)).toEqual(['linked', 'real'])
      expect(listing.entries.map(entry => entry.path)).toEqual(['/world/linked', '/world/real'])
      // The probe reuses the entry's own target and runs for link rows only:
      // the level is resolved once and a directory or file row is never probed.
      expect(resolve).toHaveBeenCalledTimes(1)
      expect(stat.mock.calls.map(call => (call[0] as FsTarget).displayPath))
        .toEqual(['/world/linked', '/world/broken', '/world/file-link'])
    } finally {
      await backend.dispose()
    }
  })

  it('skips a link whose probe rejects, and keeps the caller reason when the abort lands mid-probe', async () => {
    // A cyclic link rejects its own probe: with no caller signal that is
    // simply "not enterable", and the level still lists.
    const cyclic = linkListingFs(
      [stubChild('real', 'directory'), stubChild('loop', 'symlink')],
      async () => { throw new Error('ELOOP: too many symbolic links encountered') },
    )
    const rejected = await openStubBackend(cyclic.fs)
    try {
      const listing = await rejected.capability.list('/world')
      expect(listing.entries.map(entry => entry.name)).toEqual(['real'])
    } finally {
      await rejected.dispose()
    }

    // A probe that never settles: the caller's abort wins with its own reason,
    // never reading as an unenterable row.
    let settleProbe!: (value: FsInfo | undefined) => void
    const hanging = linkListingFs(
      [stubChild('real', 'directory'), stubChild('linked', 'symlink')],
      () => new Promise<FsInfo | undefined>((resolve) => { settleProbe = resolve }),
    )
    const backend = await openStubBackend(hanging.fs)
    const controller = new AbortController()
    try {
      const pending = backend.capability.list('/world', undefined, controller.signal)
      await vi.waitFor(() => { expect(hanging.stat).toHaveBeenCalledTimes(1) })
      controller.abort(new Error('caller left'))
      await expect(pending).rejects.toThrow('caller left')
      // The abandoned probe's late settlement is swallowed, not unhandled.
      settleProbe(undefined)
      await new Promise(resolve => setTimeout(resolve, 10))
    } finally {
      await backend.dispose()
    }
  })
})
