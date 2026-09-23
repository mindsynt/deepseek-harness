/**
 * Tests for the durable Session-to-host sidecar: recording a Session's host,
 * reading it back, the legacy fallback order (record → Workspace → local),
 * loud failures for an unusable store, and durability across a new store
 * instance over the same medium.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { LOCAL_HOST_ID, SessionHostStore } from '../src/session-hosts.ts'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

interface StoreOptions {
  /** Omit the storage domain to exercise the unusable-store path. */
  storage?: boolean
  /** Omit the Workspace registry to exercise the unusable-store path. */
  registry?: boolean
  workspaces?: readonly Workspace[]
}

/** Boot one store over a pooled in-memory medium. */
async function store(pool: MemoryMediaPool, options: StoreOptions = {}): Promise<SessionHostStore> {
  const ctx = new Context()
  contexts.push(ctx)
  if (options.storage !== false) {
    await ctx.plugin(Storage)
    ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
    const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
    ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)
  }
  if (options.registry !== false) {
    ctx.provide('workspaceRegistry', {
      list: () => options.workspaces ?? [],
      get: () => undefined,
    } as never)
  }
  return new SessionHostStore(ctx)
}

function workspace(id: string, hostId: string, sessionIds: readonly string[]): Workspace {
  return { id, hostId, sessionIds } as unknown as Workspace
}

describe('SessionHostStore', () => {
  it('records a session host once and reads it back', async () => {
    const hosts = await store(new MemoryMediaPool())
    const id = SessionId('recorded')
    expect(await hosts.hostOf(id)).toBeUndefined()

    await hosts.remember(id, 'remote-1')
    expect(await hosts.hostOf(id)).toBe('remote-1')
    expect(await hosts.resolveHost(id)).toBe('remote-1')

    // Re-recording the same host is an idempotent no-op.
    await hosts.remember(id, 'remote-1')
    expect(await hosts.hostOf(id)).toBe('remote-1')
  })

  it('refuses to replace a recorded host with a different one', async () => {
    const hosts = await store(new MemoryMediaPool())
    const id = SessionId('conflicted')
    await hosts.remember(id, 'remote-1')

    await expect(hosts.remember(id, 'remote-2'))
      .rejects.toThrow('session "conflicted" already belongs to host "remote-1", not "remote-2"')
    expect(await hosts.hostOf(id)).toBe('remote-1')
  })

  it('resolves a legacy session through its Workspace and then to the built-in host', async () => {
    const id = SessionId('legacy')
    const accounted = await store(new MemoryMediaPool(), {
      workspaces: [workspace('w', 'remote-9', [id])],
    })
    expect(await accounted.resolveHost(id)).toBe('remote-9')

    const unrelated = await store(new MemoryMediaPool(), {
      workspaces: [workspace('other', 'remote-8', [SessionId('another')])],
    })
    expect(await unrelated.resolveHost(id)).toBe(LOCAL_HOST_ID)
  })

  it('fails loud when the record cannot be written', async () => {
    const pool = new MemoryMediaPool()
    const hosts = await store(pool)
    const id = SessionId('unwritable')

    pool.failNextWrites = 1
    await expect(hosts.remember(id, 'remote-1')).rejects.toThrow('injected write failure')
    expect(await hosts.hostOf(id)).toBeUndefined()
  })

  it('normalizes an empty stored host to the built-in local host when the domain reopens', async () => {
    const pool = new MemoryMediaPool()
    const first = await store(pool)
    const id = SessionId('empty-host')
    await first.remember(id, '')

    // The durable boundary normalizes on read, so a record reopened from the
    // medium never yields an empty host identity.
    const reopened = await store(pool)
    expect(await reopened.hostOf(id)).toBe(LOCAL_HOST_ID)
  })

  it('reads a record written by an earlier store over the same medium', async () => {
    const pool = new MemoryMediaPool()
    const first = await store(pool)
    const id = SessionId('durable')
    await first.remember(id, 'remote-3')

    const second = await store(pool)
    expect(await second.hostOf(id)).toBe('remote-3')
  })

  it('fails loud without a storage domain or a Workspace registry', async () => {
    const withoutStorage = await store(new MemoryMediaPool(), { storage: false })
    await expect(withoutStorage.hostOf(SessionId('no-domain')))
      .rejects.toThrow('requires the storage-domain service')

    const withoutRegistry = await store(new MemoryMediaPool(), { registry: false })
    await expect(withoutRegistry.resolveHost(SessionId('no-registry')))
      .rejects.toThrow('requires the Workspace registry')
  })

  it('closes an unopened domain and tolerates a failed open on disposal', async () => {
    const unusedCtx = new Context()
    const unused = new SessionHostStore(unusedCtx)
    expect(unused).toBeInstanceOf(SessionHostStore)
    await expect(unusedCtx.fiber.dispose()).resolves.toBeUndefined()

    const failingCtx = new Context()
    contexts.push(failingCtx)
    failingCtx.provide('storageDomain', {
      open: () => Promise.reject(new Error('domain unavailable')),
    } as never)
    const failing = new SessionHostStore(failingCtx)
    await expect(failing.hostOf(SessionId('failed-open'))).rejects.toThrow('domain unavailable')
    await expect(failingCtx.fiber.dispose()).resolves.toBeUndefined()
  })
})
