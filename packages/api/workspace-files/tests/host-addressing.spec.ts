/**
 * Host addressing: every read operation and the change feed run against the
 * execution world the request scope names, and a scope naming no open world
 * fails loud instead of falling back to the Harness host's filesystem.
 *
 * The remote world is a real local backend rooted at a second temp directory,
 * isolated under its own `fs` label exactly as the host registry isolates one
 * realm per host, so these cases exercise the same routing the SSH world uses
 * without a connection.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FsObservation } from '@deepseek-ai/dsh-fs'
import { FsVersion } from '@deepseek-ai/dsh-fs'
import { LOCAL_HOST_ID } from '@deepseek-ai/dsh-workspace'
import { failureOf, openRemoteWorld, openWorkspace, signal, type Harness } from './harness.ts'

let harness: Harness
const worlds: Array<{ root: string; dispose: () => Promise<void> }> = []

beforeEach(async () => {
  harness = await openWorkspace('dsh-workspace-files-host-')
})

afterEach(async () => {
  try {
    for (const world of worlds.splice(0)) await world.dispose()
    await harness.dispose()
  } finally {
    vi.restoreAllMocks()
  }
})

/** One open world rooted at a fresh temp directory, disposed with the test. */
async function remoteWorld(): Promise<{ root: string; fs: Awaited<ReturnType<typeof openRemoteWorld>>['fs'] }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-workspace-files-remote-'))
  const world = await openRemoteWorld(harness.ctx, root)
  worlds.push({
    root,
    dispose: async () => {
      await world.dispose()
      await rm(root, { recursive: true, force: true })
    },
  })
  return { root, fs: world.fs }
}

/** A `ctx.remoteHosts` double exposing the worlds that are open, keyed by host id. */
function openHosts(open: Readonly<Record<string, unknown>>): unknown {
  return {
    get: (id: string) => {
      const fs = open[id]
      return fs === undefined ? undefined : { world: { fs } }
    },
  }
}

/** Every filesystem entry point a read gate could reach through the Harness host's own backend. */
const ROOT_FS_ENTRY_POINTS = [
  'resolve', 'lstat', 'stat', 'streamText', 'readBytes', 'readByteRange', 'listDir', 'contains', 'processPath', 'fileUrl',
] as const

/** Spies on every root-backend entry point, so a case can prove none of them ran. */
function watchRootFs(): ReturnType<typeof vi.spyOn>[] {
  return ROOT_FS_ENTRY_POINTS.map(method => vi.spyOn(harness.ctx.fs, method))
}

/** A remote-session scope: the world's root on the world named by `hostId`. */
function remoteScope(root: string, hostId: string) {
  return { sessionId: harness.scope.sessionId, workspaceRoot: root, hostId }
}

describe('workspaceFiles — the addressed host world', () => {
  it('reads every endpoint through the addressed world and never the Harness host filesystem', async () => {
    const remote = await remoteWorld()
    await writeFile(join(harness.workspace, 'notes.txt'), 'local\n', 'utf8')
    await mkdir(join(remote.root, 'src'), { recursive: true })
    await writeFile(join(remote.root, 'notes.txt'), 'remote\n', 'utf8')
    await writeFile(join(remote.root, 'src', 'deep.txt'), 'deep\n', 'utf8')
    harness.ctx.provide('remoteHosts', openHosts({ alpha: remote.fs }) as never)
    const scope = remoteScope(remote.root, 'alpha')
    const rootFs = watchRootFs()
    const service = harness.endpoint()

    await expect(service.read(scope, 'notes.txt', {}, signal())).resolves.toMatchObject({ text: 'remote', bytes: 7 })
    await expect(service.readBytes(scope, 'notes.txt', { offset: 0, length: 5 }, signal()))
      .resolves.toMatchObject({ data: Buffer.from('remot').toString('base64') })
    await expect(service.readAll(scope, 'notes.txt', signal()))
      .resolves.toMatchObject({ data: Buffer.from('remote\n').toString('base64') })
    await expect(service.readRelated(scope, 'src/deep.txt', '../notes.txt', signal()))
      .resolves.toMatchObject({ data: Buffer.from('remote\n').toString('base64') })
    await expect(service.stat(scope, 'notes.txt', signal())).resolves.toMatchObject({ bytes: 7 })
    await expect(service.list(scope, remote.root, signal())).resolves.toMatchObject({
      path: '',
      entries: [{ name: 'notes.txt' }, { name: 'src' }],
    })

    for (const entry of rootFs) expect(entry).not.toHaveBeenCalled()
  })

  it('serves change observations from the addressed world', async () => {
    const remote = await remoteWorld()
    harness.ctx.provide('remoteHosts', openHosts({ alpha: remote.fs }) as never)
    const controller = new AbortController()
    const iterator = harness.endpoint()
      .changes(remoteScope(remote.root, 'alpha'), controller.signal)[Symbol.asyncIterator]()
    try {
      await expect(iterator.next()).resolves.toEqual({ done: false, value: { kind: 'ready' } })
      const pending = iterator.next()
      const target = await remote.fs.resolve(join(remote.root, 'watched.txt'))
      const observation: FsObservation = { kind: 'present', version: FsVersion('v1') }
      harness.ctx.emit('fs/observed', target, observation, undefined)
      expect(await pending).toEqual({
        done: false,
        value: {
          kind: 'change',
          change: { absolutePath: remote.fs.processPath(target), version: 'v1' },
        },
      })
    } finally {
      controller.abort()
      await iterator.return?.(undefined)
    }
  })

  it('treats the workspace domain local host identity as this Harness host', async () => {
    await writeFile(join(harness.workspace, 'notes.txt'), 'local\n', 'utf8')
    // Pins the duplicated local-host spelling to the workspace domain's owner.
    await expect(harness.endpoint().read({ ...harness.scope, hostId: LOCAL_HOST_ID }, 'notes.txt', {}, signal()))
      .resolves.toMatchObject({ text: 'local' })
    await expect(harness.endpoint().stat({ ...harness.scope, hostId: LOCAL_HOST_ID }, 'notes.txt', signal()))
      .resolves.toMatchObject({ bytes: 6 })
  })
})

describe('workspaceFiles — an unopen host', () => {
  it('fails loud with the host id when the registry has no open world for it', async () => {
    harness.ctx.provide('remoteHosts', openHosts({}) as never)
    const failure = await failureOf(harness.endpoint().read(
      { ...harness.scope, hostId: 'alpha' }, 'notes.txt', {}, signal(),
    ))
    expect(failure.code).toBe('workspace-file/host-unavailable')
    expect(failure.details).toEqual({ hostId: 'alpha' })
    await expect(harness.endpoint().stat({ ...harness.scope, hostId: 'alpha' }, 'notes.txt', signal()))
      .rejects.toThrow('host "alpha" has no open execution world')
  })

  it('fails loud with the host id when no host registry is composed', async () => {
    expect(harness.ctx.get('remoteHosts')).toBeUndefined()
    const failure = await failureOf(harness.endpoint().list(
      { ...harness.scope, hostId: 'beta' }, harness.workspace, signal(),
    ))
    expect(failure.code).toBe('workspace-file/host-unavailable')
    expect(failure.details).toEqual({ hostId: 'beta' })
    // `changes` is not async: the addressing refusal escapes it synchronously.
    expect(() => harness.endpoint().changes({ ...harness.scope, hostId: 'beta' }, signal()))
      .toThrow('host "beta" has no open execution world')
  })

  it('does not fall back to the Harness host filesystem', async () => {
    await writeFile(join(harness.workspace, 'notes.txt'), 'local\n', 'utf8')
    harness.ctx.provide('remoteHosts', openHosts({}) as never)
    const rootFs = watchRootFs()
    await expect(harness.endpoint().read({ ...harness.scope, hostId: 'alpha' }, 'notes.txt', {}, signal()))
      .rejects.toMatchObject({ code: 'workspace-file/host-unavailable' })
    for (const entry of rootFs) expect(entry).not.toHaveBeenCalled()
  })
})

describe('workspaceFiles — a host whose world is closed later', () => {
  it('reports the removed world as unopen rather than reading the Harness host', async () => {
    const remote = await remoteWorld()
    await writeFile(join(remote.root, 'notes.txt'), 'remote\n', 'utf8')
    const open: Record<string, unknown> = { alpha: remote.fs }
    harness.ctx.provide('remoteHosts', openHosts(open) as never)
    await expect(harness.endpoint().read(remoteScope(remote.root, 'alpha'), 'notes.txt', {}, signal()))
      .resolves.toMatchObject({ text: 'remote' })
    delete open['alpha']
    const failure = await failureOf(harness.endpoint().read(remoteScope(remote.root, 'alpha'), 'notes.txt', {}, signal()))
    expect(failure.code).toBe('workspace-file/host-unavailable')
    expect(failure.details).toEqual({ hostId: 'alpha' })
  })
})
